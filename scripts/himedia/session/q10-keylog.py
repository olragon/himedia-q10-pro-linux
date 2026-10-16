#!/usr/bin/python3
"""q10-keylog [secs=180] — log every key event (code, value 1=down 0=up 2=repeat, timestamp) from
every input device, to stdout and /var/log/q10/keylog.txt. Answers "what does this key really send?"
(e.g. a front-panel touch key: one code per touch, or held with repeats?)."""
import sys, time, selectors
from evdev import InputDevice, list_devices, ecodes as e
secs = float(sys.argv[1]) if len(sys.argv) > 1 else 180
sel = selectors.DefaultSelector()
for p in list_devices():
    d = InputDevice(p)
    if e.EV_KEY in d.capabilities():
        sel.register(d, selectors.EVENT_READ)
        print("watching", p, d.name, flush=True)
out = open("/var/log/q10/keylog.txt", "a"); t0 = time.monotonic()
while time.monotonic() - t0 < secs:
    for key, _ in sel.select(timeout=1):
        for ev in key.fileobj.read():
            if ev.type == e.EV_KEY:
                line = "%.3f %s %s %s" % (ev.timestamp(), key.fileobj.name, e.KEY.get(ev.code, ev.code), ev.value)
                print(line, flush=True); out.write(line + "\n"); out.flush()
