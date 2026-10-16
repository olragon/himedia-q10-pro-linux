#!/usr/bin/env python3
"""Recover the symbol table (kallsyms) from the decompressed stock Q10 Pro kernel.

The stock image is linux-3.18 ARM with absolute kallsyms (no base-relative table), virtual base
0xc0008000. Layout: kallsyms_addresses[N] (u32, sorted), kallsyms_num_syms, kallsyms_names
(len byte + token indexes), kallsyms_markers[], kallsyms_token_table (256 C strings),
kallsyms_token_index[256] (u16). Each section is 4-byte aligned on 32-bit ARM (ALGN .balign 4;
this script also tries 8 / 16 for safety).

usage: stock-kallsyms.py <vmlinux.bin> [--grep REGEX] [--at HEXADDR]
  prints "addr type name" lines; --at prints the symbol containing that address.
"""
import re, struct, sys

BASE = 0xc0008000

def main():
    d = open(sys.argv[1], 'rb').read()
    args = sys.argv[2:]
    u32 = lambda o: struct.unpack_from('<I', d, o)[0]
    # 1. longest run of sorted kernel addresses = kallsyms_addresses
    best = (0, 0); o = 0; n = len(d) // 4
    i = 0
    while i < n - 1:
        v = u32(i * 4)
        if 0xc0000000 <= v < 0xc2000000:
            j = i
            while j + 1 < n and 0xc0000000 <= u32((j + 1) * 4) < 0xc2000000 and u32((j + 1) * 4) >= u32(j * 4):
                j += 1
            if j - i > best[1] - best[0]:
                best = (i, j)
            i = j + 1
        else:
            i += 1
    a0, a1 = best[0] * 4, best[1] * 4 + 4
    addrs = [u32(x) for x in range(a0, a1, 4)]
    # num_syms follows (maybe after alignment padding)
    for pad in (0, 4, 8, 12):
        if u32(a1 + pad) == len(addrs) or abs(u32(a1 + pad) - len(addrs)) < 4:
            num = u32(a1 + pad); p = a1 + pad + 4; break
    else:
        sys.exit(f'num_syms not found after table at file 0x{a0:x} (n={len(addrs)})')
    addrs = addrs[-num:] if len(addrs) >= num else addrs
    while p % 4: p += 1
    # names
    p = (p + 15) & ~15 if u32(p) == 0 else p
    names_off = p; q = p
    entries = []
    for _ in range(num):
        L = d[q]; entries.append(d[q + 1:q + 1 + L]); q += 1 + L
    q = (q + 3) & ~3
    q += ((num + 255) // 256) * 4      # markers
    q = (q + 3) & ~3
    # token_table: 256 C strings, followed (aligned) by token_index[256] u16 holding each
    # string's offset. Search forward for the start whose offsets match that index exactly.
    toks = None
    for tt in range(q, q + 0x4000):
        r = tt; offs = []; tl = []
        ok = True
        for _ in range(256):
            e = d.find(b'\0', r)
            if e < 0 or e - r > 64: ok = False; break
            offs.append(r - tt); tl.append(d[r:e]); r = e + 1
        if not ok: continue
        for al in (2, 4, 8, 16):
            ti = (r + al - 1) & ~(al - 1)
            if all(struct.unpack_from('<H', d, ti + 2 * k)[0] == offs[k] for k in range(256)):
                toks = tl; break
        if toks: break
    if toks is None: sys.exit('token_table/token_index not found')
    names = []
    for e in entries:
        s = b''.join(toks[b] for b in e).decode('latin1')
        names.append((s[0], s[1:]))
    pat = None; at = None
    if '--grep' in args: pat = re.compile(args[args.index('--grep') + 1])
    if '--at' in args: at = int(args[args.index('--at') + 1], 16)
    print(f'# {num} symbols, table at file 0x{a0:x}, token_table at 0x{tt:x}', file=sys.stderr)
    if at is not None:
        best = None
        for a, (t, s) in zip(addrs, names):
            if a <= at: best = (a, t, s)
        print(f'{best[0]:08x} {best[1]} {best[2]} +0x{at - best[0]:x}')
        return
    for a, (t, s) in zip(addrs, names):
        if pat is None or pat.search(s):
            print(f'{a:08x} {t} {s}')

main()
