#!/usr/bin/env python3
"""q10-menu: full-screen TV boot menu drawn straight to /dev/fb0 (no DRM master, no X).

Prints the chosen session on stdout. Exit 0 chosen, 3 cancelled (--cancel-ok), 1 error.
  q10-menu --default kodi --countdown 10 --unavailable android="Waydroid not installed"
  q10-menu --screenshot out.png [...]      render the frame to a PNG, touch nothing else

Runs on its own VT (tty8) in KD_GRAPHICS mode so fbcon text cannot overwrite it, and restores the
previous VT / text mode / cursor on the way out.
"""
import argparse
import fcntl
import glob
import math
import os
import selectors
import signal
import struct
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from q10common import CODE_TO_NAME, SESSIONS  # noqa: E402

W, H = 1920, 1080
ENTRIES = [  # name, title, one-line description
    ("desktop", "Desktop", "Windows-style desktop: start menu, files, browser"),
    ("audio", "Music", "Hi-res player to your DAC, AirPlay 2, Spotify Connect"),
    ("kodi", "Kodi", "Media center with hardware video decoding"),
    ("web", "Web", "Chromium, full screen, hardware video"),
    ("android", "Android 13", "Waydroid (LineageOS 20), full screen"),
    ("stock-android", "Original Android 7", "Experimental. Returns here after ~3 min"),
    # Not a session: q10mode opens the audio settings page, then this menu again (any boot mode).
    ("audio-settings", "Audio settings", "Output, RCA / optical / HDMI, channel trim, music source"),
]
MENU_NAMES = tuple(e[0] for e in ENTRIES)
CONFIRM_TEXT = {"stock-android": ("Restart into Android 7?", "Box will restart into Android 7. Reboot returns here.")}
GRACE = 0.4        # ignore keys this long after start (the long-press that opened us may still be bouncing)
DEDUPE = 0.06      # same key from two devices within this window counts once
REPEAT_KEYS = ("UP", "DOWN")


# ---------- state machine (pure) ----------

class MenuState:
    def __init__(self, unavailable=None, default="desktop", active=None, countdown=10.0,
                 cancel_ok=False, now=0.0):
        self.unavailable = dict(unavailable or {})
        self.names = [e[0] for e in ENTRIES]
        self.default = default
        self.active = active
        self.cancel_ok = cancel_ok
        self.start = now
        self.deadline = now + countdown if countdown and countdown > 0 else None
        self.sel = self.names.index(self._first_ok(default))
        self.confirming = None
        self.message = ""
        self.done = False
        self.result = None      # chosen session, or None if cancelled
        self._last = (None, -1.0)

    def _first_ok(self, preferred):
        if preferred in self.names and preferred not in self.unavailable:
            return preferred
        for n in self.names:
            if n not in self.unavailable:
                return n
        return self.names[0]

    def remaining(self, now):
        return None if self.deadline is None else max(0, math.ceil(self.deadline - now))

    def selected(self):
        return self.names[self.sel]

    def _finish(self, result):
        self.done, self.result = True, result

    def tick(self, now):
        """Countdown. Returns True when the frame must be redrawn."""
        if self.done or self.deadline is None:
            return False
        if now >= self.deadline:
            self.deadline = None
            self._finish(self._first_ok(self.default))
            return True
        return True  # cheap: caller redraws only when the displayed second changes (see run_loop)

    def key(self, name, now, repeat=False):
        """Feed one key press. Returns True if the picture changed."""
        if self.done or name is None or now - self.start < GRACE:
            return False
        if name == "EXIT":              # CEC <Exit> (the TV remote's Back) is this menu's cancel key
            name = "BACK"
        if repeat and name not in REPEAT_KEYS:
            return False
        if not repeat and self._last[0] == name and now - self._last[1] < DEDUPE:
            return False
        self._last = (name, now)
        if name not in ("UP", "DOWN", "ENTER", "KPENTER", "OK", "SPACE", "BACK", "ESC"):
            return False
        self.deadline = None            # any real key stops the countdown
        self.message = ""
        if self.confirming:
            if name in ("ENTER", "KPENTER", "OK", "SPACE"):
                self._finish(self.confirming)
            elif name in ("BACK", "ESC"):
                self.confirming = None
            return True
        if name == "UP":
            self.sel = (self.sel - 1) % len(self.names)
        elif name == "DOWN":
            self.sel = (self.sel + 1) % len(self.names)
        elif name in ("BACK", "ESC"):
            if self.cancel_ok:
                self._finish(None)
        else:  # select
            n = self.selected()
            if n in self.unavailable:
                self.message = "Not available: %s" % self.unavailable[n]
            elif n in CONFIRM_TEXT:
                self.confirming = n
            else:
                self._finish(n)
        return True


# ---------- rendering ----------

FONT_DIRS = ["/usr/share/fonts/truetype/dejavu/", "/usr/share/fonts/truetype/liberation/",
             "/System/Library/Fonts/Supplemental/", "/Library/Fonts/"]
FONT_REG = ["DejaVuSans.ttf", "LiberationSans-Regular.ttf", "Arial.ttf"]
FONT_BOLD = ["DejaVuSans-Bold.ttf", "LiberationSans-Bold.ttf", "Arial Bold.ttf"]


def load_font(bold, size):
    from PIL import ImageFont
    env = os.environ.get("Q10_FONT_BOLD" if bold else "Q10_FONT")
    cands = [env] if env else [d + f for f in (FONT_BOLD if bold else FONT_REG) for d in FONT_DIRS]
    for p in cands:
        if p and os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                pass
    return ImageFont.load_default(size=size)


BG = (14, 18, 26)
ROW = (28, 34, 46)
ROW_OFF = (21, 26, 35)
SEL = (47, 128, 237)
TXT = (240, 244, 250)
TXT_SEL = (255, 255, 255)
DESC = (156, 166, 182)
DESC_SEL = (222, 234, 255)
OFF = (96, 105, 120)
TAG = (52, 211, 153)
WARN = (251, 191, 36)


def _triangle(d, x, cy, size, up, fill):
    h = size
    if up:
        pts = [(x, cy + h // 2), (x + h, cy + h // 2), (x + h // 2, cy - h // 2)]
    else:
        pts = [(x, cy - h // 2), (x + h, cy - h // 2), (x + h // 2, cy + h // 2)]
    d.polygon(pts, fill=fill)


def footer_parts(state, now):
    if state.confirming:
        return [("text", "OK confirm  ·  BACK cancel")]
    parts = [("tri", True), ("tri", False)]
    t = " select  ·  OK start"
    if state.cancel_ok:
        t += "  ·  BACK cancel"
    r = state.remaining(now)
    if r is not None:
        t += "  ·  default in %d s" % r
    parts.append(("text", t))
    return parts


def render(state, now=0.0, size=(W, H)):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    f_title, f_sub = load_font(True, 96), load_font(False, 40)
    f_row, f_desc, f_tag, f_foot = load_font(True, 60), load_font(False, 36), load_font(True, 26), load_font(False, 40)
    mx = 120
    d.text((mx, 64), "Q10 Pro", font=f_title, fill=TXT)
    d.text((mx, 178), "Choose a session", font=f_sub, fill=DESC)
    # Rows share the space between the subtitle and the footer (250..960): 4 entries keep the 160 px
    # cards, 5 (with Web) shrink to ~129 px, 6 (with Music) to ~107 px — each tier with smaller type,
    # so the title never runs into its description (it did at 6 rows with the 5-row type, 2026-10-12).
    y, gap = 250, 16
    rh = min(160, (960 - y - (len(ENTRIES) - 1) * gap) // len(ENTRIES))
    title_top, desc_up = 20, 62
    if rh < 100:      # 7 rows (~87 px): the 6-row type would put the description over the title
        f_row, f_desc, title_top, desc_up = load_font(True, 36), load_font(False, 24), 8, 34
    elif rh < 120:
        f_row, f_desc, title_top, desc_up = load_font(True, 42), load_font(False, 28), 12, 42
    elif rh < 150:
        f_row, f_desc, title_top, desc_up = load_font(True, 50), load_font(False, 32), 12, 50
    for i, (name, title, desc) in enumerate(ENTRIES):
        off = name in state.unavailable
        sel = i == state.sel
        top = y + i * (rh + gap)
        fill = SEL if (sel and not off) else (ROW_OFF if off else ROW)
        d.rounded_rectangle((mx, top, W - mx, top + rh), radius=22, fill=fill)
        if sel and off:
            d.rounded_rectangle((mx, top, W - mx, top + rh), radius=22, outline=OFF, width=5)
        tc = OFF if off else (TXT_SEL if sel else TXT)
        dc = OFF if off else (DESC_SEL if sel else DESC)
        d.text((mx + 48, top + title_top), title, font=f_row, fill=tc)
        d.text((mx + 48, top + rh - desc_up), "Unavailable: " + state.unavailable[name] if off else desc, font=f_desc, fill=dc)
        tags = (["RUNNING"] if name == state.active else []) + (["DEFAULT"] if name == state.default else [])
        tx = W - mx - 40
        for t in tags:
            w = d.textlength(t, font=f_tag)
            d.rounded_rectangle((tx - w - 28, top + 24, tx, top + 70), radius=12, outline=TAG if not off else OFF, width=3)
            d.text((tx - w - 14, top + 31), t, font=f_tag, fill=TAG if not off else OFF)
            tx -= w + 28 + 16
    fy = 1000
    if state.message:
        d.text((mx, fy - 62), state.message, font=f_foot, fill=WARN)
    x = mx
    for kind, val in footer_parts(state, now):
        if kind == "tri":
            _triangle(d, x, fy + 24, 26, val, DESC)
            x += 36
        else:
            d.text((x, fy), val, font=f_foot, fill=DESC)
    if state.confirming:
        head, body = CONFIRM_TEXT[state.confirming]
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 190))
        img = Image.alpha_composite(img.convert("RGBA"), ov).convert("RGB")
        d = ImageDraw.Draw(img)
        bx0, by0, bx1, by1 = 260, 330, W - 260, 750
        d.rounded_rectangle((bx0, by0, bx1, by1), radius=28, fill=(30, 38, 54), outline=SEL, width=6)
        d.text((bx0 + 60, by0 + 60), head, font=load_font(True, 72), fill=TXT_SEL)
        d.text((bx0 + 60, by0 + 190), body, font=load_font(False, 42), fill=DESC_SEL)
        d.text((bx0 + 60, by0 + 300), "OK confirm  ·  BACK cancel", font=load_font(True, 42), fill=TAG)
    if size != (W, H):
        img = img.resize(size)
    return img


def render_splash(title, sub="", size=(W, H)):
    """One centred line (and an optional second): what the TV shows while a session starts, or the
    box enters or leaves standby — never the bare text console."""
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    f_t, f_s = load_font(True, 88), load_font(False, 44)
    d.text(((W - d.textlength(title, font=f_t)) / 2, H / 2 - 110), title, font=f_t, fill=TXT)
    if sub:
        d.text(((W - d.textlength(sub, font=f_s)) / 2, H / 2 + 20), sub, font=f_s, fill=DESC)
    return img.resize(size) if size != (W, H) else img


def active_vt():
    try:
        v = open("/sys/class/tty/tty0/active").read().strip()
        return int(v[3:]) if v.startswith("tty") and v[3:].isdigit() else None
    except OSError:
        return None


def splash(vt, title, sub="", timeout=3.0):
    """Show one frame on VT `vt` with no console text in between.
    Order matters, both ways: the target goes to graphics mode BEFORE it is activated (fbcon then never
    paints it), and the VT we leave goes back to TEXT before the switch — the kernel silently ignores a
    switch away from a KD_GRAPHICS VT (change_console(), VT_AUTO), and VT_WAITACTIVE then waits forever
    (q10-power hung on wake, 2026-10-13). Its text screen is cleared first, so leaving it shows black.
    The wait is a bounded poll, never VT_WAITACTIVE. An empty title paints black."""
    cur = active_vt()
    fd = os.open("/dev/tty%d" % vt, os.O_RDWR | os.O_NOCTTY)
    try:
        fcntl.ioctl(fd, KDSETMODE, KD_GRAPHICS)
        if cur and cur != vt:
            cfd = os.open("/dev/tty%d" % cur, os.O_RDWR | os.O_NOCTTY)
            try:
                mode = bytearray(4)
                fcntl.ioctl(cfd, KDGETMODE, mode)
                if mode[0] == KD_GRAPHICS:
                    os.write(cfd, b"\033[2J\033[H\033[?25l")
                    fcntl.ioctl(cfd, KDSETMODE, KD_TEXT)
            finally:
                os.close(cfd)
        fcntl.ioctl(fd, VT_ACTIVATE, vt)
    finally:
        os.close(fd)
    end = time.monotonic() + timeout
    while active_vt() != vt and time.monotonic() < end:
        time.sleep(0.05)
    if active_vt() != vt:
        raise RuntimeError("vt %d did not become active (still %s)" % (vt, active_vt()))
    fb = pick_fb()
    info = read_fbinfo(fb)
    img = render_splash(title, sub, (info["xres"], info["yres"])) if title else None
    write_frame(fb, encode_frame(img, info) if img else bytes(info["stride"] * info["yres"]), info)


# ---------- framebuffer ----------

FBIOGET_VSCREENINFO = 0x4600
VAR_FMT = "<8I" + "3I" * 4   # xres yres xres_v yres_v xoff yoff bpp gray, then red green blue transp


def parse_var(buf):
    v = struct.unpack_from(VAR_FMT, buf)
    return {"xres": v[0], "yres": v[1], "xres_virtual": v[2], "yres_virtual": v[3], "yoffset": v[5],
            "bpp": v[6], "red": v[8:11], "green": v[11:14], "blue": v[14:17]}


def pick_fb(root="/sys/class/graphics"):
    """The TV's framebuffer is the VDP's fbdev. Which /dev/fbN that is depends on whether
    histb_vdp evicted simpledrm at load: fb0 on one boot, fb1 (simpledrm still fb0, and invisible)
    on another (k18, 2026-10-12 — the menu drew to fb0 and the TV stayed black). Pick by name."""
    names = {}
    for d in sorted(glob.glob(root + "/fb[0-9]*")):
        try:
            names[os.path.basename(d)] = open(d + "/name").read().strip()
        except OSError:
            pass
    for fb, name in names.items():
        if "histb-vdp" in name:
            return "/dev/" + fb
    return "/dev/fb0"


def read_fbinfo(dev="/dev/fb0", sysfs=None):
    sysfs = sysfs or "/sys/class/graphics/" + os.path.basename(dev)
    fd = os.open(dev, os.O_RDWR)
    try:
        # A mutable buffer is filled IN PLACE and ioctl() returns 0 — parse the buffer, not the result.
        var = bytearray(160)
        fcntl.ioctl(fd, FBIOGET_VSCREENINFO, var)
        info = parse_var(bytes(var))
    finally:
        os.close(fd)
    try:
        info["stride"] = int(open(sysfs + "/stride").read())
    except (OSError, ValueError):
        info["stride"] = info["xres_virtual"] * info["bpp"] // 8
    return info


def _rgb565(img):
    """No Pillow packer and no numpy on the box: build both bytes of each LE pixel with LUTs + adds.
    low = ggg bbbbb, high = rrrrr ggg."""
    from PIL import Image, ImageChops
    r, g, b = img.split()
    low = ImageChops.add(g.point(lambda v: ((v >> 2) & 7) << 5), b.point(lambda v: v >> 3))
    high = ImageChops.add(r.point(lambda v: v & 0xF8), g.point(lambda v: v >> 5))
    return Image.merge("LA", (low, high)).tobytes()


def encode_frame(img, info):
    """PIL RGB image (xres x yres) -> bytes in the framebuffer's pixel format, rows padded to stride."""
    bpp = info["bpp"]
    if img.size != (info["xres"], info["yres"]):
        img = img.resize((info["xres"], info["yres"]))
    r, g, b = info["red"], info["green"], info["blue"]
    if bpp == 32:
        letters = ["X"] * 4
        for ch, off in (("R", r[0]), ("G", g[0]), ("B", b[0])):
            letters[off // 8] = ch
        raw = img.tobytes("raw", "".join(letters))
    elif bpp == 16 and (r[:2], g[:2], b[:2]) == ((11, 5), (5, 6), (0, 5)):
        raw = _rgb565(img)
    else:
        raise RuntimeError("unsupported framebuffer format: %s" % (info,))
    row = info["xres"] * bpp // 8
    if info["stride"] == row:
        return raw
    pad = b"\0" * (info["stride"] - row)
    return b"".join(raw[i:i + row] + pad for i in range(0, len(raw), row))


def write_frame(dev, data, info):
    fd = os.open(dev, os.O_WRONLY)
    try:
        os.lseek(fd, info.get("yoffset", 0) * info["stride"], os.SEEK_SET)
        mv = memoryview(data)
        while len(mv):
            n = os.write(fd, mv)
            mv = mv[n:]
    finally:
        os.close(fd)


# ---------- console (own VT, graphics mode, no cursor) ----------

KDSETMODE, KDGETMODE, KD_TEXT, KD_GRAPHICS = 0x4B3A, 0x4B3B, 0, 1
VT_ACTIVATE, VT_WAITACTIVE = 0x5606, 0x5607
CURSOR_BLINK = "/sys/class/graphics/fbcon/cursor_blink"


class Console:
    def __init__(self, vt=8):
        self.vt, self.fd, self.prev_vt, self.prev_blink = vt, None, None, None

    def _rd(self, p):
        try:
            return open(p).read().strip()
        except OSError:
            return None

    def enter(self):
        try:
            act = self._rd("/sys/class/tty/tty0/active") or ""
            self.prev_vt = int(act[3:]) if act.startswith("tty") and act[3:].isdigit() else None
            self.fd = os.open("/dev/tty%d" % self.vt, os.O_RDWR | os.O_NOCTTY)
            fcntl.ioctl(self.fd, VT_ACTIVATE, self.vt)
            fcntl.ioctl(self.fd, VT_WAITACTIVE, self.vt)
            fcntl.ioctl(self.fd, KDSETMODE, KD_GRAPHICS)
            os.write(self.fd, b"\033[?25l")
        except OSError as e:
            print("q10-menu: console setup failed (%s); drawing anyway" % e, file=sys.stderr)
        self.prev_blink = self._rd(CURSOR_BLINK)
        try:
            open(CURSOR_BLINK, "w").write("0")
        except OSError:
            pass

    def leave(self):
        if self.prev_blink is not None:
            try:
                open(CURSOR_BLINK, "w").write(self.prev_blink)
            except OSError:
                pass
        if self.fd is None:
            return
        try:
            fcntl.ioctl(self.fd, KDSETMODE, KD_TEXT)
            os.write(self.fd, b"\033[?25h\033[2J\033[H")
            if self.prev_vt and self.prev_vt != self.vt:
                fcntl.ioctl(self.fd, VT_ACTIVATE, self.prev_vt)
        except OSError:
            pass
        finally:
            os.close(self.fd)
            self.fd = None


# ---------- input + loop ----------

def run_loop(state, dev, now=time.monotonic):
    import evdev
    from evdev import ecodes
    sel = selectors.DefaultSelector()
    devs = {}

    def rescan():
        for path in evdev.list_devices():
            if path in devs:
                continue
            try:
                d = evdev.InputDevice(path)   # never d.grab(): the session underneath must keep its keys
                if ecodes.EV_KEY in d.capabilities():
                    devs[path] = d
                    sel.register(d, selectors.EVENT_READ, path)
                else:
                    d.close()
            except OSError:
                pass

    def drop(path):
        d = devs.pop(path, None)
        if d:
            try:
                sel.unregister(d)
                d.close()
            except (OSError, KeyError, ValueError):
                pass

    info = read_fbinfo(dev)
    shown, next_scan = None, 0.0
    while not state.done:
        t = now()
        if t >= next_scan:
            rescan()
            next_scan = t + 2.0
        state.tick(t)
        sig = (state.sel, state.remaining(t), state.confirming, state.message)
        if sig != shown:
            write_frame(dev, encode_frame(render(state, t), info), info)
            shown = sig
        for k, _ in sel.select(timeout=0.2):
            try:
                for e in k.fileobj.read():
                    if e.type == ecodes.EV_KEY and e.value in (1, 2):
                        if state.key(CODE_TO_NAME.get(e.code), now(), repeat=e.value == 2):
                            shown = None
            except OSError:
                drop(k.data)


def parse_unavailable(items):
    out = {}
    for it in items or []:
        name, _, reason = it.partition("=")
        if name not in MENU_NAMES:
            raise SystemExit("q10-menu: unknown menu entry %r" % name)
        out[name] = reason or "unavailable"
    return out


def main(argv=None):
    p = argparse.ArgumentParser(prog="q10-menu")
    p.add_argument("--default", default="desktop", choices=SESSIONS)
    p.add_argument("--active", choices=SESSIONS)
    p.add_argument("--countdown", type=float, default=10)
    p.add_argument("--cancel-ok", action="store_true")
    p.add_argument("--unavailable", action="append", metavar="NAME=REASON")
    p.add_argument("--fb", default=None, help="default: the VDP fbdev, found by name (pick_fb)")
    p.add_argument("--vt", type=int, default=8)
    p.add_argument("--screenshot", metavar="PNG")
    p.add_argument("--select", choices=MENU_NAMES, help="screenshot only: highlight this entry")
    p.add_argument("--confirm", action="store_true", help="screenshot only: show the confirm dialog")
    a = p.parse_args(argv)
    a.fb = a.fb or pick_fb()
    state = MenuState(parse_unavailable(a.unavailable), a.default, a.active, a.countdown, a.cancel_ok, now=0.0)
    if a.screenshot:
        if a.select:
            state.sel = state.names.index(a.select)
        if a.confirm:
            state.confirming = state.selected()
        render(state, now=2.0 if state.deadline else 0.0).save(a.screenshot)
        print(a.screenshot)
        return 0
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(1))
    con = Console(a.vt)
    con.enter()
    try:
        state.start = state.start + time.monotonic()
        if state.deadline is not None:
            state.deadline += time.monotonic()
        run_loop(state, a.fb)
        # black the screen before handing back so no stale menu shows through the next session's start
        info = read_fbinfo(a.fb)
        write_frame(a.fb, bytes(info["stride"] * info["yres"]), info)
    except Exception as e:  # noqa: BLE001
        import traceback
        print("q10-menu: %s" % e, file=sys.stderr)
        traceback.print_exc()  # the one-line message alone hid a bytes/int bug (2026-10-12)
        return 1
    finally:
        con.leave()
    if state.result is None:
        return 3
    print(state.result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
