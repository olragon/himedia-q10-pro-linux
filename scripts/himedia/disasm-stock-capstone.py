#!/usr/bin/env python3
"""Disassemble a virtual-address range of the decompressed stock Q10 Pro kernel with capstone
(no docker). Virtual base 0xc0008000 (see disasm-stock-kernel-range.sh). Literal-pool words
(ldr rX,[pc,#n]) are resolved inline; .rodata strings at pool targets are printed when found.

usage: disasm-stock-capstone.py <vmlinux.bin> <start-va-hex> <stop-va-hex> [--thumb]
"""
import struct, sys
from capstone import Cs, CS_ARCH_ARM, CS_MODE_ARM, CS_MODE_THUMB

BASE = 0xc0008000

def main():
    d = open(sys.argv[1], 'rb').read()
    s, e = int(sys.argv[2], 16), int(sys.argv[3], 16)
    md = Cs(CS_ARCH_ARM, CS_MODE_THUMB if '--thumb' in sys.argv else CS_MODE_ARM)
    def cstr(va):
        o = va - BASE
        if not (0 <= o < len(d)): return None
        z = d.find(b'\0', o, o + 120)
        t = d[o:z] if z > 0 else b''
        return t.decode('latin1') if t and all(32 <= c < 127 or c in (9, 10) for c in t) and len(t) > 3 else None
    def insns():
        a = s
        while a < e:
            got = False
            for i in md.disasm(d[a - BASE:e - BASE], a):
                got = True; a = i.address + i.size; yield i
            if not got or a < e:
                if a >= e: break
                w = struct.unpack_from('<I', d, a - BASE)[0]
                yield type('D', (), dict(address=a, mnemonic='.word', op_str=f'0x{w:08x}', size=4))()
                a += 4
    for i in insns():
        note = ''
        if i.mnemonic.startswith('ldr') and 'pc' in i.op_str and '#' in i.op_str:
            try:
                off = int(i.op_str.split('#')[1].rstrip(']!'), 0)
                pa = i.address + 8 + off
                v = struct.unpack_from('<I', d, pa - BASE)[0]
                note = f'  ; =0x{v:08x}'
                if (c := cstr(v)): note += f' "{c}"'
            except Exception: pass
        print(f'{i.address:08x}: {i.mnemonic:8s} {i.op_str}{note}')

if __name__ == '__main__':
    main()
