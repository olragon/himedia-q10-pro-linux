#!/usr/bin/env python3
"""reg-diff.py <mainline.txt> <android.txt> [window...] — diff two android-reg-dump.sh outputs.

Mainline lines are "aaaaaaaa: 0xVVVVVVVV" (devmem); Android lines are himd.l rows
"OOOO:  w0 w1 w2 w3" relative to the window base. Prints every 32-bit word that differs, per
window, so a working stock state (Android) can be compared with ours (2026-10-11: WiFi, HDMI).
"""
import re, sys

def parse(path):
    win, base, out = None, 0, {}
    for line in open(path, errors="replace"):
        m = re.match(r"## (\S+) (0x[0-9a-fA-F]+) (0x[0-9a-fA-F]+)", line)
        if m:
            win, base = m.group(1), int(m.group(2), 16); out[win] = {}; continue
        if win is None:
            continue
        m = re.match(r"([0-9a-fA-F]{8}): (0x[0-9a-fA-F]+)", line)          # mainline
        if m:
            out[win][int(m.group(1), 16)] = int(m.group(2), 16); continue
        m = re.match(r"([0-9a-fA-F]{4}):\s+((?:[0-9a-fA-F]{8}\s*)+)$", line.strip())  # himd.l
        if m:
            off = int(m.group(1), 16)
            for i, w in enumerate(m.group(2).split()):
                out[win][base + off + 4 * i] = int(w, 16)
    return out

a, b = parse(sys.argv[1]), parse(sys.argv[2])
only = set(sys.argv[3:])
for win in a:
    if only and win not in only:
        continue
    diffs = [(k, a[win][k], b.get(win, {}).get(k)) for k in sorted(a[win])
             if b.get(win, {}).get(k) is not None and a[win][k] != b[win][k]]
    print(f"== {win}: {len(diffs)} differing words (mainline -> android)")
    for k, x, y in diffs:
        print(f"   {k:08x}: {x:08x} -> {y:08x}   xor {x ^ y:08x}")
