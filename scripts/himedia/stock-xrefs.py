#!/usr/bin/env python3
"""Find ARM-mode BL/BLX(imm) callers and literal-pool references of given addresses in the
decompressed stock Q10 Pro kernel (raw image, virtual base 0xc0008000), naming each caller
with stock-kallsyms.py's symbol table.

usage: stock-xrefs.py <vmlinux.bin> <hexaddr> [<hexaddr> ...]
Limits: ARM (A32) only - Thumb-2 callers are not decoded (the 3.18 stock kernel is built ARM);
indirect calls through ops tables / function pointers show up only as literal-pool hits.
"""
import bisect, os, struct, subprocess, sys

BASE = 0xc0008000
img, targets = sys.argv[1], [int(a, 16) for a in sys.argv[2:]]
d = open(img, 'rb').read()
here = os.path.dirname(os.path.abspath(__file__))
syms = []
out = subprocess.run([sys.executable, '-I', os.path.join(here, 'stock-kallsyms.py'), img],
                     capture_output=True, text=True).stdout
for l in out.splitlines():
    a, t, n = l.split(' ', 2)
    if t in 'tTW': syms.append((int(a, 16), n))
syms.sort(); keys = [a for a, _ in syms]
def name(a):
    i = bisect.bisect_right(keys, a) - 1
    return f'{syms[i][1]}+0x{a - syms[i][0]:x}' if i >= 0 else '?'
tset = set(targets)
words = struct.unpack_from(f'<{len(d) // 4}I', d)
for i, w in enumerate(words):
    pc = BASE + 4 * i
    if (w >> 25) & 7 == 5 and (w >> 28) != 0xf:          # B/BL
        if not (w >> 24) & 1: continue                     # only BL
        off = w & 0xffffff
        if off & 0x800000: off -= 1 << 24
        t = pc + 8 + (off << 2)
        if t in tset: print(f'BL   {pc:08x} {name(pc):45s} -> {t:08x} {name(t)}')
    elif w in tset:
        print(f'LIT  {pc:08x} {name(pc):45s} -> {w:08x} {name(w)}')
