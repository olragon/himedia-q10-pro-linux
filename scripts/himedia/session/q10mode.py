#!/usr/bin/env python3
"""q10-mode: pick which ONE session owns the screen (desktop | audio | kodi | web | android | stock-android).

  list | status | get-default | set-default <s> | switch <s> | menu | boot | exited <s>

Installed as /usr/local/sbin/q10-mode (NOT q10-session: /usr/local/bin/q10-session is the X
session script that q10-desktop.service runs). Exit codes: 0 ok, 1 failed, 2 unknown/unavailable,
3 cancelled.
"""
import argparse
import glob
import os
import time
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from q10common import (BOOTABLE, SESSIONS, UNIT_SESSIONS, log, state_dir, systemctl_bin,  # noqa: E402
                       try_lock)

DESCRIPTIONS = {
    "desktop": "Windows-style desktop (LXQt)",
    "audio": "Music: hi-res player, AirPlay 2, Spotify Connect, UPnP",
    "kodi": "Kodi media center (GBM, hardware decode)",
    "web": "Web (Chromium on Wayland, hardware video)",
    "android": "Android 13 (Waydroid, full screen)",
    "stock-android": "Original Android 7 via kexec",
}
VIDEO_STACK = "q10-video-stack.service"


# ---------- pure parts ----------

def parse_cmdline_session(cmdline):
    """q10.session=<s> from a kernel command line. Last one wins; unknown names are ignored."""
    want = None
    for tok in cmdline.split():
        if tok.startswith("q10.session="):
            v = tok.split("=", 1)[1].strip()
            if v in BOOTABLE:
                want = v
    return want


def get_default():
    try:
        with open(os.path.join(state_dir(), "default")) as f:
            v = f.read().strip()
        if v in BOOTABLE:
            return v
    except OSError:
        pass
    return "desktop"


def set_default(name):
    if name not in BOOTABLE:
        raise ValueError("default must be one of %s (stock-android would boot-loop)" % ", ".join(BOOTABLE))
    os.makedirs(state_dir(), exist_ok=True)
    path = os.path.join(state_dir(), "default")
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        f.write(name + "\n")
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def availability(exists=os.path.exists, which=None, executable=None):
    """{session: (ok, reason)}. Dependencies injected so tests need no box."""
    if which is None:
        import shutil
        which = shutil.which
    if executable is None:
        executable = lambda p: os.path.isfile(p) and os.access(p, os.X_OK)  # noqa: E731
    kodi_bin = os.environ.get("Q10_KODI_BIN", "/usr/local/bin/kodi-v4l2req")
    stock = os.environ.get("Q10_STOCK_SCRIPT", "/usr/local/sbin/q10-stock-android")
    manifest = os.environ.get("Q10_STOCK_MANIFEST", "/var/lib/q10/stock-android/manifest.json")
    unit_dir = os.environ.get("Q10_UNIT_DIR", "/etc/systemd/system")
    out = {}
    out["desktop"] = ((True, "") if exists(os.path.join(unit_dir, UNIT_SESSIONS["desktop"]))
                      else (False, "q10-desktop.service not installed"))
    nowplaying = os.environ.get("Q10_NOWPLAYING", "/usr/local/lib/q10-audio/q10-nowplaying")
    if not which("mpd"):
        out["audio"] = (False, "mpd not installed")
    elif not executable(nowplaying):
        out["audio"] = (False, "audio mode not installed")
    else:
        out["audio"] = (True, "")
    out["kodi"] = (True, "") if executable(kodi_bin) else (False, "Kodi not installed")
    out["web"] = (True, "") if which("chromium") and which("cage") else (False, "chromium or cage missing")
    if not which("waydroid"):
        out["android"] = (False, "Waydroid not installed")
    elif not which("cage"):
        out["android"] = (False, "cage not installed")
    elif not exists(os.environ.get("Q10_WAYDROID_CFG", "/var/lib/waydroid/waydroid.cfg")):
        # the program without images is not Android: `waydroid init` never ran (or its image file
        # is not mounted) — offering it would start a session that can only fail
        out["android"] = (False, "Android images not installed")
    else:
        out["android"] = (True, "")
    if not executable(stock):
        out["stock-android"] = (False, "q10-stock-android script missing")
    elif not exists(manifest):
        out["stock-android"] = (False, "stock Android kit missing")
    elif not exists(os.environ.get("Q10_STOCK_ENABLE", "/etc/q10/stock-android.enable")):
        # Opt-in (2026-10-12): the vendor kernel boots by kexec, but the picture was stripe noise
        # and network bring-up was seen in 1 of 3 runs. docs/261012-himedia-stock-android-kexec.md
        out["stock-android"] = (False, "Experimental: touch /etc/q10/stock-android.enable")
    else:
        out["stock-android"] = (True, "")
    return out


def display_present(fb_exists, statuses):
    """No framebuffer -> no display. Connector status files, if any exist, must show one connected."""
    if not fb_exists:
        return False
    if not statuses:
        return True
    return any(s.strip() == "connected" for s in statuses)


def read_display():
    statuses = []
    for p in glob.glob("/sys/class/drm/card*-*/status"):
        try:
            with open(p) as f:
                statuses.append(f.read())
        except OSError:
            pass
    return display_present(bool(glob.glob("/dev/fb[0-9]*")), statuses)


# ---------- systemd ----------

def sysctl(*args, check_out=False):
    r = subprocess.run([systemctl_bin(), *args], capture_output=True, text=True)
    return r.stdout if check_out else r.returncode


def is_active(unit):
    return sysctl("is-active", "--quiet", unit) == 0


# ── Android pause (2026-10-12) ───────────────────────────────────────────────────────────────
# Android 13 cold-boots in ~100 s, so leaving it PAUSES it instead of stopping it: the container
# cgroup is frozen, its memory pushed to swap (zram, then the disk swap file), and the console is
# switched away from cage's VT — cage (built-in libseat, `-s`) then drops DRM master and the next
# session takes the screen. cage must stay alive: the container bind-mounted its Wayland socket at
# session start, and a NEW cage's socket is never seen (hwcomposer "Couldn't open Wayland display").
ANDROID_VT, HOME_VT, WEB_VT, AUDIO_VT = 9, 7, 10, 11
# cage sessions live on their own VT; audio draws its now-playing screen on tty11
SESSION_VT = {"android": ANDROID_VT, "web": WEB_VT, "audio": AUDIO_VT}
PAUSED = os.environ.get("Q10_ANDROID_PAUSED", "/run/q10/android.paused")
CGROUP = "/sys/fs/cgroup/lxc.payload.waydroid"


def android_paused():
    return os.path.exists(PAUSED) and is_active(UNIT_SESSIONS["android"])


def chvt(n):
    """Switch the active VT with the kernel ioctl — no dependency on kbd's chvt, which the stick's
    root image does not have (q10-mode crashed mid-switch there, 2026-10-13)."""
    import fcntl
    VT_ACTIVATE, VT_WAITACTIVE = 0x5606, 0x5607
    try:
        fd = os.open("/dev/tty0", os.O_RDWR | os.O_NOCTTY)
        try:
            fcntl.ioctl(fd, VT_ACTIVATE, n)
            fcntl.ioctl(fd, VT_WAITACTIVE, n)
        finally:
            os.close(fd)
    except OSError as e:
        log("chvt %s failed: %s" % (n, e))


def pause_android():
    t = time.monotonic()
    subprocess.run(["waydroid", "container", "freeze"], check=False)
    os.makedirs(os.path.dirname(PAUSED), exist_ok=True)
    open(PAUSED, "w").write("%d\n" % time.time())
    chvt(HOME_VT)
    # Push the frozen container's memory out in the background: the next session should not wait
    # for it (measured 5-7 s for ~350 MB into zram).
    subprocess.Popen(["nice", "-n", "10", "sh", "-c", "echo 1G > %s/memory.reclaim" % CGROUP],
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    log("android paused (frozen, console %d -> %d) in %.1f s" % (ANDROID_VT, HOME_VT, time.monotonic() - t))


def resume_android():
    t = time.monotonic()
    chvt(ANDROID_VT)
    subprocess.run(["waydroid", "container", "unfreeze"], check=False)
    try:
        os.unlink(PAUSED)
    except FileNotFoundError:
        pass
    log("android resumed in %.1f s" % (time.monotonic() - t))


def active_session():
    for name, unit in UNIT_SESSIONS.items():
        if is_active(unit) and not (name == "android" and android_paused()):
            return name
    return None


def has_job(unit):
    out = sysctl("list-jobs", "--no-legend", check_out=True) or ""
    return any(unit in l.split() for l in out.splitlines())


def has_stop_job(unit):
    out = sysctl("list-jobs", "--no-legend", check_out=True) or ""
    return any(unit in l and " stop" in l for l in out.splitlines())


def ensure_video_stack():
    """Blocks until the modules are loaded (oneshot, RemainAfterExit). A failure is logged, not fatal:
    the menu falls back to whatever /dev/fb0 exists (simpledrm)."""
    rc = sysctl("start", VIDEO_STACK)
    if rc != 0:
        log("WARN video stack failed (rc=%s); continuing with whatever framebuffer exists" % rc)
    return rc == 0


# ---------- actions ----------

def stop_sessions(pause_android_ok=True):
    """Free the screen. Android is paused, not stopped (unless pause_android_ok is False)."""
    units = []
    for name, u in UNIT_SESSIONS.items():
        if not is_active(u):
            continue
        if name == "android" and pause_android_ok:
            if not android_paused():
                pause_android()
            continue
        units.append(u)
    if units:
        sysctl("stop", *units)
    return units


def session_title(name):
    from q10menu import ENTRIES
    return next((t for n, t, _ in ENTRIES if n == name), name)


def splash_vt(vt, text):
    """Paint `text` on VT `vt` before a session takes it, so the gap shows no console; falls back to a
    plain VT switch if drawing fails (a splash is cosmetic, the switch is not)."""
    try:
        from q10menu import splash
        splash(vt, text)
    except Exception as e:  # noqa: BLE001
        log("splash on vt %s failed: %s" % (vt, e))
        chvt(vt)


def switch(target, verb="Starting"):
    if target not in SESSIONS:
        log("switch: unknown session %r" % target)
        return 2
    ok, reason = availability()[target]
    if not ok:
        log("switch %s refused: %s" % (target, reason))
        return 2
    prev = active_session()
    if target != "stock-android" and prev == target:
        log("switch %s: already active" % target)
        return 0
    log("switch %s -> %s" % (prev or "none", target))
    stop_sessions()
    if target == "android" and android_paused():
        resume_android()
        return 0
    if target == "stock-android":
        script = os.environ.get("Q10_STOCK_SCRIPT", "/usr/local/sbin/q10-stock-android")
        rc = subprocess.run([script]).returncode  # on success the box kexecs away and never returns
        log("stock-android script returned rc=%s (kexec did not happen)" % rc)
        if rc != 0 and prev:
            sysctl("start", UNIT_SESSIONS[prev])
        return 1 if rc != 0 else 0
    if target in SESSION_VT:
        # cage's built-in seat only takes DRM master on the ACTIVE VT; the splash fills the 1-2 s before
        # the session draws (the bare console showed there, 2026-10-13)
        splash_vt(SESSION_VT[target], "%s %s\u2026" % (verb, session_title(target)))
    rc = sysctl("start", UNIT_SESSIONS[target])
    if rc != 0:
        log("start %s failed rc=%s" % (UNIT_SESSIONS[target], rc))
        if prev and prev != target:
            sysctl("start", UNIT_SESSIONS[prev])
        return 1
    return 0


AUDIO_SETTINGS = "audio-settings"   # a menu row, not a session (q10menu.ENTRIES)


def audio_page_path():
    return os.environ.get("Q10_AUDIO_PAGE", "/usr/local/lib/q10-audio/q10-audio-page")


def run_audio_page():
    """The remote-driven audio settings page on the menu's VT; returns when it is closed."""
    r = subprocess.run([sys.executable, audio_page_path()], check=False)
    if r.returncode != 0:
        log("audio settings page ended rc=%s" % r.returncode)


def run_menu(default, active, countdown, cancel_ok):
    ensure_video_stack()
    cmd = [os.environ.get("Q10_MENU_PY", os.path.join(os.path.dirname(os.path.realpath(__file__)), "q10menu.py")),
           "--default", default, "--countdown", str(countdown)]
    if active:
        cmd += ["--active", active]
    if cancel_ok:
        cmd.append("--cancel-ok")
    for name, (ok, reason) in availability().items():
        if not ok:
            cmd += ["--unavailable", "%s=%s" % (name, reason)]
    if not os.path.exists(audio_page_path()):
        cmd += ["--unavailable", "%s=audio mode not installed" % AUDIO_SETTINGS]
    r = subprocess.run([sys.executable] + cmd, stdout=subprocess.PIPE, text=True)
    return r.returncode, r.stdout.strip()


def fallback_session():
    avail = availability()
    d = get_default()
    if avail[d][0]:
        return d
    for s in BOOTABLE:
        if avail[s][0]:
            return s
    return None


def cmd_menu(_a):
    lock = try_lock("menu.lock")
    if lock is None:
        log("menu already up; ignoring")
        return 0
    prev = active_session()
    log("menu (previous session: %s)" % (prev or "none"))
    stop_sessions()  # the menu is drawn on fbdev; a running session owns the CRTC and hides it
    while True:
        rc, choice = run_menu(get_default(), prev, 0, cancel_ok=bool(prev))
        if rc == 0 and choice == AUDIO_SETTINGS:
            run_audio_page()     # then the menu again: the page is a detour, not a destination
            continue
        break
    if rc == 0 and choice in SESSIONS:
        return switch(choice)
    log("menu ended without a choice (rc=%s)" % rc)
    target = prev or fallback_session()
    if target:
        return switch(target) if target in UNIT_SESSIONS else 0
    return 1


def cmd_boot(_a):
    if active_session():
        log("boot: a session is already active; nothing to do")
        return 0
    want = parse_cmdline_session(open(os.environ.get("Q10_CMDLINE", "/proc/cmdline")).read())
    avail = availability()
    if want:
        if avail[want][0]:
            log("boot: kernel cmdline q10.session=%s" % want)
            return switch(want)
        log("boot: cmdline asked for %s but it is unavailable (%s)" % (want, avail[want][1]))
    if not read_display():
        d = fallback_session()
        log("boot: no display; starting %s" % d)
        return switch(d) if d else 1
    rc, choice = run_menu(get_default(), None, 10, cancel_ok=False)
    if rc == 0 and choice in SESSIONS:
        return switch(choice)
    d = fallback_session()
    log("boot: menu gave no choice (rc=%s); starting default %s" % (rc, d))
    return switch(d) if d else 1


def cmd_exited(a):
    """ExecStopPost hook: the session ended by itself (user quit) -> show the menu, else a black screen."""
    unit = UNIT_SESSIONS.get(a.session)
    if not unit or os.environ.get("SERVICE_RESULT", "success") != "success":
        return 0  # failures belong to Restart=/OnFailure=
    if has_stop_job(unit) or has_stop_job("shutdown.target") or sysctl("is-system-running", check_out=True).strip() == "stopping":
        return 0  # we (or shutdown) stopped it: not a quit
    if any(has_job(u) for u in UNIT_SESSIONS.values()):
        # A `systemctl restart`, or a switch starting the next session: not a quit. Opening the menu
        # here left it running INVISIBLY behind the restarted session, and every later hotkey press
        # was a no-op start of an already-active unit (2026-10-12, Android).
        return 0
    log("exited: %s quit by itself; opening the menu" % a.session)
    sysctl("--no-block", "start", "q10-session-menu.service")
    return 0


def cmd_list(_a):
    act, dflt = active_session(), get_default()
    for s in SESSIONS:
        ok, reason = availability()[s]
        print("%s\t%s\t%s\t%s%s" % (s, "available" if ok else "unavailable", reason or "-",
                                    DESCRIPTIONS[s], " [active]" if s == act else "") + (" [default]" if s == dflt else ""))
    return 0


def cmd_status(_a):
    print("active: %s" % (active_session() or "none"))
    print("default: %s" % get_default())
    print("display: %s" % ("yes" if read_display() else "no"))
    for s, (ok, reason) in availability().items():
        print("%s: %s" % (s, "available" if ok else "unavailable (%s)" % reason))
    return 0


def main(argv=None):
    p = argparse.ArgumentParser(prog="q10-mode")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list")
    sub.add_parser("status")
    sub.add_parser("get-default")
    sd = sub.add_parser("set-default"); sd.add_argument("session")
    sw = sub.add_parser("switch"); sw.add_argument("session")
    sub.add_parser("menu")
    sub.add_parser("boot")
    ex = sub.add_parser("exited"); ex.add_argument("session")
    a = p.parse_args(argv)
    if a.cmd == "get-default":
        print(get_default())
        return 0
    if a.cmd == "set-default":
        try:
            set_default(a.session)
        except ValueError as e:
            print(e, file=sys.stderr)
            return 2
        log("default set to %s" % a.session)
        return 0
    if a.cmd == "switch":
        return switch(a.session)
    return {"list": cmd_list, "status": cmd_status, "menu": cmd_menu, "boot": cmd_boot, "exited": cmd_exited}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
