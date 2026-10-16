#!/usr/bin/env python3
"""Summarise GPIO-ops-table calls per function in a disassembly of the stock Q10 Pro kernel
keyled driver (objdump -D ARM output, virtual addresses).

The stock driver calls through a gpio ops table: [ops+4]=DirSetBit(pin,v) [ops+8]=ReadBit(pin)
[ops+12]=WriteBit(pin,v)  (offset meaning INFERRED from usage; pin = bank*8+bit).
usage: decode-keyled-gpio-ops.py <disasm.s> [from-hex-vaddr to-hex-vaddr]
"""
import re, sys
L = [l.rstrip() for l in open(sys.argv[1]) if re.match(r'^[0-9a-f]{8}:', l)]
lo = int(sys.argv[2], 16) if len(sys.argv) > 2 else 0
hi = int(sys.argv[3], 16) if len(sys.argv) > 3 else 1 << 32
name = {4: 'DIR', 8: 'RD ', 12: 'WR '}
fn = None; ops = []
def flush():
    if fn is not None and ops: print(f'{fn}: ' + ' '.join(ops))
for i, l in enumerate(L):
    a = int(l[:8], 16)
    if not lo <= a <= hi: continue
    if re.search(r'push\s+\{.*\blr, pc\}', l) or 'mov\tip, sp' in l:
        if 'mov\tip, sp' in l: flush(); fn = f'{a:08x}'; ops = []
    m = re.search(r'blx\tr3', l)
    if m:
        off = pin = val = None
        for w in L[max(0, i - 8):i]:
            mo = re.search(r'ldr\tr3, \[r3, #(\d+)\]', w)
            if mo: off = int(mo.group(1))
            mp = re.search(r'mov\tr0, #(\d+)', w)
            if mp: pin = int(mp.group(1))
            mv = re.search(r'mov(ne|eq)?\tr1, #(\d+)', w)
            if mv: val = ('?' if mv.group(1) else '') + mv.group(2)
            if re.search(r'mov\tr1, r\d', w): val = 'var'
        if off in name: ops.append(f'{name[off]}({pin},{val})')
        elif 'movt\tr0, #16' in ' '.join(L[max(0, i - 4):i]): ops.append('delay')
flush()
