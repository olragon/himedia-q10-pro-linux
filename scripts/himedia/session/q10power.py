#!/usr/bin/env python3
"""q10-power: the front/remote POWER key, like a TV box.

  short press  -> standby: the session stops (Android is paused), HDMI output off + CEC standby to
                  the TV, SATA disk spun down, dim clock on the panel. Press again -> wake into the
                  same session.
  hold >= 3 s  -> OFF: like standby, plus every disk synced and spun down and " OFF" on the panel —
                  safe to unplug. Any press from OFF boots the box fresh (a watchdog reboot).

Why OFF is not `systemctl poweroff`: mainline has no power-off for the Hi3798CV200, so poweroff
ends in a halted CPU that no key can reach (only unplugging brings it back) and that simpledrm
leaves showing console text on HDMI (Tim, 2026-10-13). A real poweroff stays available from the
shell and still ends SAVING -> OFF on the panel (q10-hud-shutdown + system-shutdown hook).
logind must ignore the key (/etc/systemd/logind.conf.d/q10-power.conf): this daemon owns it.

  q10-power                 daemon (q10-power.service)
  q10-power standby|wake|toggle|off|status
"""
import glob
import json
import os
import selectors
import shutil
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from q10common import log, run_dir  # noqa: E402
from q10menu import active_vt  # noqa: E402

KEY_POWER, KEY_WAKEUP = 116, 143
HOLD_SECS = 3.0
BOUNCE_SECS = 1.5   # ignore presses this soon after a standby/wake: the TV's CEC echo, a double hit


class PowerKey:
    """Pure: feed key events -> 'short' on release before HOLD_SECS, 'long' once while held past it,
    'wake' for KEY_WAKEUP. IR repeats (value 2) only extend the hold."""

    def __init__(self, hold=HOLD_SECS, bounce=BOUNCE_SECS):
        self.hold, self.bounce = hold, bounce
        self.down_at, self.fired, self.quiet_until = None, False, -1.0

    def feed(self, code, value, now):
        if code == KEY_WAKEUP:
            return "wake" if value == 1 and now >= self.quiet_until else None
        if code != KEY_POWER:
            return None
        if value in (1, 2) and self.down_at is None:
            self.down_at, self.fired = now, False
            return self.poll(now)
        if value == 2:
            return self.poll(now)
        if value == 0 and self.down_at is not None:
            held, fired = now - self.down_at, self.fired
            self.down_at = None
            if fired or held >= self.hold or now < self.quiet_until:
                return None
            return "short"
        return None

    def poll(self, now):
        if self.down_at is not None and not self.fired and now - self.down_at >= self.hold:
            self.fired = True
            return "long"
        return None

    def quiet(self, now):
        self.quiet_until = now + self.bounce


# What a key does depends on the power state. Pure: (state, key action) -> step name.
STEPS = {
    "on":      {"short": "standby", "long": "off", "wake": None},
    "standby": {"short": "wake",    "long": "off", "wake": "wake"},
    "off":     {"short": "boot",    "long": "boot", "wake": "boot"},
}


def step_for(state, act):
    return STEPS[state].get(act) if act else None


# ---------- actions ----------

def state_path():
    return os.path.join(run_dir(), "standby")


def power_state():
    """on | standby | off — the state file lives in /run, so a boot always starts "on"."""
    try:
        with open(state_path()) as f:
            return json.load(f).get("mode", "standby")
    except FileNotFoundError:
        return "on"
    except (OSError, ValueError):
        return "standby"


def in_standby():
    return power_state() != "on"


def sh(*cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=20).returncode
    except (OSError, subprocess.SubprocessError):
        return -1


def fb_blank(blank):
    """VDP fbdev blank: 4 = FB_BLANK_POWERDOWN (HDMI signal off), 0 = unblank."""
    for p in glob.glob("/sys/class/graphics/fb[0-9]*/blank"):
        try:
            with open(p, "w") as f:
                f.write("4" if blank else "0")
        except OSError:
            pass


def cec(*args):
    if shutil.which("cec-ctl") and glob.glob("/dev/cec*"):
        sh("cec-ctl", "-d", "0", "--to", "0", *args)


STANDBY_VT = 12   # tty7 X, 8 menu, 9 Android, 10 Web, 11 Music
PANEL = "/usr/local/sbin/q10-panel"


def black_screen():
    """Own VT, graphics mode, black frame. fb blank alone is not enough: simpledrm (the stick's kernel)
    ignores it, and the bare text console then shows through on HDMI (Tim, 2026-10-12)."""
    try:
        from q10menu import splash
        splash(STANDBY_VT, "")
    except Exception as e:  # noqa: BLE001 — a black screen is cosmetic; standby must still happen
        log("standby screen: %s" % e, "q10-power")


def panel(text, bright=7):
    """Front panel status. The clock (q10-hud) is stopped first or it overwrites the text in 1 s."""
    sh("systemctl", "stop", "q10-hud.service")
    sh(PANEL, "text", text, str(bright))


def sata_disks():
    out = []
    for b in glob.glob("/sys/block/sd*"):
        if "/ata" in os.path.realpath(b):
            out.append("/dev/" + os.path.basename(b))
    return out


def write_state(mode, **extra):
    os.makedirs(run_dir(), exist_ok=True)
    with open(state_path(), "w") as f:
        json.dump(dict(extra, mode=mode, at=time.time()), f)


def go_dark(label):
    """Shared by standby and OFF: the panel says so at once (stopping a session takes seconds and the
    TV is not told), then sessions stop, HDMI goes black, the TV is asked to sleep, disks spin down."""
    import q10mode
    panel(label, 7)
    q10mode.stop_sessions()          # Android is paused, not stopped
    black_screen()
    fb_blank(True)
    cec("--standby")
    for d in sata_disks():
        sh("hdparm", "-y", d)        # flushes the drive cache before it spins down
    panel(label, 0)                  # stays on, dimmed, for as long as the state lasts


def standby():
    if in_standby():
        return 0
    import q10mode
    prev, vt = q10mode.active_session(), active_vt()
    write_state("standby", session=prev, vt=vt)
    log("standby (session %s, vt %s)" % (prev or "none", vt), "q10-power")
    go_dark("STBY")
    return 0


def off():
    """Soft off: safe to unplug, and a key press boots it (a halted CPU could do neither)."""
    if power_state() == "off":
        return 0
    log("power key held: off (press to boot)", "q10-power")
    was_on = power_state() == "on"
    write_state("off")
    sh("sync")
    if was_on:
        go_dark(" OFF")
    else:                            # from standby everything is already dark and stopped
        panel(" OFF", 0)
    sh("sync")
    return 0


def boot():
    log("power key from off: rebooting", "q10-power")
    panel("BOOT", 7)
    return sh("systemctl", "reboot")   # q10-reset-on-reboot arms the SP805: mainline cannot restart


def wake():
    if power_state() != "standby":
        return 0
    try:
        with open(state_path()) as f:
            st = json.load(f)
    except (OSError, ValueError):
        st = {}
    prev, vt = st.get("session"), st.get("vt")
    os.unlink(state_path())
    import q10mode
    # Wake restores exactly what was there: no session before standby -> none after it (waking into
    # the default session put the stick's console user on the desktop, 2026-10-12).
    log("wake -> %s (vt %s)" % (prev or "no session", vt), "q10-power")
    panel("RESUME", 7)
    fb_blank(False)
    cec("--image-view-on")
    if prev:
        # The overlay goes up on the standby VT now, and switch() paints the session's own VT before
        # handing it over, so the console never shows (it did between wake and the session, 2026-10-13).
        try:
            from q10menu import splash
            splash(STANDBY_VT, "Resuming %s\u2026" % q10mode.session_title(prev))
        except Exception as e:  # noqa: BLE001
            log("resume overlay: %s" % e, "q10-power")
        rc = q10mode.switch(prev, verb="Resuming")
    else:
        rc = 0
        if vt and vt != STANDBY_VT:
            q10mode.chvt(vt)
    sh("systemctl", "start", "q10-hud.service")
    return rc


ACTIONS = {"standby": standby, "wake": wake, "off": off, "boot": boot}


def daemon():
    import evdev
    from evdev import ecodes
    sel, devs, pk = selectors.DefaultSelector(), {}, PowerKey()
    next_scan = 0.0
    log("power key: press = standby/wake, hold %.0f s = off, press from off = boot" % HOLD_SECS,
        "q10-power")
    while True:
        now = time.monotonic()
        if now >= next_scan:
            for path in evdev.list_devices():
                if path in devs:
                    continue
                try:
                    d = evdev.InputDevice(path)   # never grab(): other consumers keep their keys
                    keys = d.capabilities().get(ecodes.EV_KEY, [])
                    if KEY_POWER in keys or KEY_WAKEUP in keys:
                        devs[path] = d
                        sel.register(d, selectors.EVENT_READ, path)
                    else:
                        d.close()
                except OSError:
                    pass
            next_scan = now + 2.0
        act = pk.poll(time.monotonic())
        for k, _ in sel.select(timeout=0.2):
            try:
                for e in k.fileobj.read():
                    if e.type == ecodes.EV_KEY:
                        act = pk.feed(e.code, e.value, time.monotonic()) or act
            except OSError:
                d = devs.pop(k.data, None)
                if d:
                    try:
                        sel.unregister(d)
                        d.close()
                    except (OSError, KeyError, ValueError):
                        pass
        step = step_for(power_state(), act)
        if step:
            ACTIONS[step]()
            pk.quiet(time.monotonic())


def main(argv):
    cmd = argv[0] if argv else "daemon"
    if cmd == "daemon":
        return daemon()
    if cmd == "standby":
        return standby()
    if cmd == "wake":
        return wake()
    if cmd == "toggle":
        return wake() if in_standby() else standby()
    if cmd == "off":
        return off()
    if cmd == "status":
        print(power_state())
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
