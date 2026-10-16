#!/usr/bin/env python3
"""q10-key-capture — print every key and IR scancode event, with timestamps, from all input devices.
Answers "what does a HELD key really send?" (an IR touch key may send one frame, or repeats).
  q10-key-capture.py [seconds=120]
Lines: <t since start> <device> KEY <code name> <0 up|1 down|2 repeat>  |  SCAN 0x<scancode>"""
import selectors
import sys
import time

import evdev
from evdev import ecodes

secs = float(sys.argv[1]) if len(sys.argv) > 1 else 120
sel = selectors.DefaultSelector()
for p in evdev.list_devices():
    d = evdev.InputDevice(p)
    if ecodes.EV_KEY in d.capabilities():
        sel.register(d, selectors.EVENT_READ)
        print("watching %s %s" % (p, d.name), flush=True)
t0 = time.monotonic()
while time.monotonic() - t0 < secs:
    for k, _ in sel.select(timeout=0.5):
        for e in k.fileobj.read():
            t = time.monotonic() - t0
            if e.type == ecodes.EV_KEY:
                name = ecodes.KEY.get(e.code, e.code)
                print("%8.3f %-18s KEY %s %d" % (t, k.fileobj.name[:18], name, e.value), flush=True)
            elif e.type == ecodes.EV_MSC and e.code == ecodes.MSC_SCAN:
                print("%8.3f %-18s SCAN 0x%x" % (t, k.fileobj.name[:18], e.value), flush=True)
print("done", flush=True)
