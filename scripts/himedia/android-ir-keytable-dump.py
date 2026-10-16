#!/usr/bin/env python3
"""Dump the KEY_* name -> Linux code table embedded in the stock Android `android_ir_user` (ARM32 ELF),
and join it with /etc/key.xml (IR scancode -> name). Read-only; inputs are extracted files.
usage: python3 -I android-ir-keytable-dump.py <android_ir_user> <key.xml>
Layout: inline records {char name[stride-4]; u32 code}; stride = distance between the first two names."""
import re, struct, sys
b = open(sys.argv[1], 'rb').read()
# table layout (verified by reading the binary): array of { char name[N]; u32 code } records, name NUL-padded.
ms = list(re.finditer(rb'KEY_[A-Z0-9_]+\x00', b))
stride = None
if len(ms) > 2: stride = ms[1].start() - ms[0].start()
tbl = []
for m in ms:
    o = m.start() + stride - 4
    if o + 4 <= len(b): tbl.append((m.group()[:-1].decode(), struct.unpack_from('<I', b, o)[0], o))
code = {}
for n, c, o in tbl: code.setdefault(n, c)
print(f'# {len(code)} name->code pairs from {sys.argv[1]}', file=sys.stderr)
x = open(sys.argv[2]).read()
for m in re.finditer(r'<key value="(0[xX][0-9a-fA-F]+)"\s+name="(KEY_[A-Z0-9_]+)"', x):
    v = int(m.group(1), 16); n = m.group(2)
    print(f'{v:08x} {n:20s} linux={code.get(n, "?")}')
