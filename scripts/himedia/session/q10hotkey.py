#!/usr/bin/env python3
"""q10-hotkey: long-press (>= 1.5 s) or double-tap KEY_SETUP / KEY_MENU on any input device -> open the session menu.

Non-exclusive (never grabs), so the running session still gets every key. The menu is started as the
unit q10-session-menu.service: systemd ignores a start of an already-active unit, and `q10-mode menu`
holds a flock, so the hotkey cannot fire while the menu is up.
Keys: env Q10_HOTKEYS="SETUP,MENU" (names from q10common.KEYS), Q10_HOTKEY_SECS=1.5.
"""
import os
import selectors
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
from q10common import KEYS, log  # noqa: E402


class LongPress:
    """Pure: feed key events, learn when a long press completes. Fires once per press."""

    def __init__(self, codes, threshold=1.5):
        self.codes, self.threshold, self.down = set(codes), threshold, {}

    def feed(self, code, value, now):
        if code not in self.codes:
            return False
        if value == 0:
            fired = self.down.pop(code, None)
            return fired is not None and fired[1] is False and now - fired[0] >= self.threshold
        if code not in self.down:        # value 1 (or a first 2): start timing
            self.down[code] = [now, False]
        return self.poll(now)

    def poll(self, now):
        for code, st in self.down.items():
            if not st[1] and now - st[0] >= self.threshold:
                st[1] = True
                return True
        return False


class DoubleTap:
    """Pure: two short presses of a watched key within `window` s -> fire. A touch key or a remote
    whose hold is awkward still gets to the menu (Tim, 2026-10-12)."""

    def __init__(self, codes, window=0.7, short=0.5):
        self.codes, self.window, self.short = set(codes), window, short
        self.down_at, self.last_tap = {}, {}

    def feed(self, code, value, now):
        if code not in self.codes:
            return False
        if value == 1:
            self.down_at[code] = now
            return False
        if value != 0:
            return False
        t = self.down_at.pop(code, None)
        if t is None or now - t > self.short:
            self.last_tap.pop(code, None)  # a hold is not a tap
            return False
        prev = self.last_tap.get(code)
        if prev is not None and now - prev <= self.window:
            self.last_tap.pop(code, None)
            return True
        self.last_tap[code] = now
        return False


def open_menu(why):
    """Restart, not start: if a menu is somehow already running but hidden behind a session (a
    `start` of an active unit is a silent no-op), the press must still bring it up."""
    log("hotkey: %s -> menu" % why, "q10-hotkey")
    active = subprocess.run(["systemctl", "is-active", "--quiet", "q10-session-menu.service"]).returncode == 0
    subprocess.run(["systemctl", "--no-block", "restart" if active else "start", "q10-session-menu.service"], check=False)


def main():
    import evdev
    from evdev import ecodes
    names = [n.strip() for n in os.environ.get("Q10_HOTKEYS", "SETUP,MENU").split(",") if n.strip()]
    codes = [KEYS[n] for n in names]
    secs = float(os.environ.get("Q10_HOTKEY_SECS", "1.5"))
    lp = LongPress(codes, secs)
    dt = DoubleTap(codes)
    sel, devs, next_scan = selectors.DefaultSelector(), {}, 0.0
    log("hotkey: long-press %s for %.1f s opens the session menu" % ("/".join(names), secs), "q10-hotkey")
    while True:
        t = time.monotonic()
        if t >= next_scan:
            next_scan = t + 3.0
            for path in evdev.list_devices():
                if path in devs:
                    continue
                try:
                    d = evdev.InputDevice(path)
                    if ecodes.EV_KEY in d.capabilities():
                        devs[path] = d
                        sel.register(d, selectors.EVENT_READ, path)
                    else:
                        d.close()
                except OSError:
                    pass
        fire = "long press" if lp.poll(time.monotonic()) else None
        for k, _ in sel.select(timeout=0.25):
            try:
                for e in k.fileobj.read():
                    if e.type == ecodes.EV_KEY:
                        now = time.monotonic()
                        if lp.feed(e.code, e.value, now):
                            fire = "long press"
                        if dt.feed(e.code, e.value, now):
                            fire = "double tap"
            except OSError:
                try:
                    sel.unregister(k.fileobj)
                    k.fileobj.close()
                except (OSError, KeyError, ValueError):
                    pass
                devs.pop(k.data, None)
        if fire:
            open_menu(fire)


if __name__ == "__main__":
    main()
