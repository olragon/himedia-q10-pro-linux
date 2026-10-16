#!/usr/bin/python3
"""q10-keyinject KEY_X [KEY_Y ...] — press keys through a uinput keyboard, the way the IR remote's
evdev device delivers them (hix5hd2-ir). Lets a session's input path be tested without a person.
  q10-keyinject KEY_DOWN KEY_DOWN KEY_ENTER        (0.4 s between presses)
  q10-keyinject KEY_MENU:2.0                       (hold 2 s, with key repeats like the IR receiver)"""
import sys, time
from evdev import UInput, ecodes as e
spec = [(a.split(":")[0], float(a.split(":")[1]) if ":" in a else 0.08) for a in sys.argv[1:]]
keys = [getattr(e, k) for k, _ in spec]
if not keys: sys.exit(__doc__)
ui = UInput({e.EV_KEY: sorted(set(keys) | {e.KEY_A})}, name="q10-keyinject")
time.sleep(1.5)  # let the compositor (libinput hotplug) open the new device
for k, (_, hold) in zip(keys, spec):
    ui.write(e.EV_KEY, k, 1); ui.syn()
    t = time.monotonic()
    while time.monotonic() - t < hold - 0.11:      # rc-core repeats every ~110 ms while held
        time.sleep(0.11); ui.write(e.EV_KEY, k, 2); ui.syn()
    time.sleep(max(0.0, hold - (time.monotonic() - t)))
    ui.write(e.EV_KEY, k, 0); ui.syn(); time.sleep(0.4)
time.sleep(0.5); ui.close()
