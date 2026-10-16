#!/usr/bin/env python3
"""Turn the stock Android /etc/key.xml <himedia-key> section into an ir-keytable TOML (NEC).
Hisilicon value layout (read in drv_ir_nec.c: key.lower |= 1<<i, i = bit arrival order): byte0=addr, byte1=~addr,
byte2=cmd, byte3=~cmd, i.e. value = ~cmd<<24 | cmd<<16 | ~addr<<8 | addr. Mainline NEC scancode = addr<<8|cmd.
Vendor-only key names are mapped to mainline names via VENDOR_TO_MAINLINE (our choice, not from a file).
usage: python3 -I ir-keymap-to-toml.py <key.xml> <input-event-codes.h> [section=himedia-key]"""
import re, sys
xml, hdr = open(sys.argv[1]).read(), open(sys.argv[2]).read()
section = sys.argv[3] if len(sys.argv) > 3 else 'himedia-key'
valid = set(re.findall(r'#define\s+(KEY_[A-Z0-9_]+)\s', hdr))
VENDOR_TO_MAINLINE = {
 'KEY_RATIO':'KEY_ASPECT_RATIO','KEY_TIMER':'KEY_TIME','KEY_ONLINE':'KEY_WWW','KEY_GAME':'KEY_GAMES',
 'KEY_MUSIC':'KEY_AUDIO','KEY_VIDEOSEARCH':'KEY_SEARCH','KEY_CYCLE':'KEY_CYCLEWINDOWS','KEY_VFD':'KEY_DISPLAYTOGGLE',
 'KEY_IMAGEMODEL':'KEY_MODE','KEY_POWERON':'KEY_WAKEUP','KEY_HDR':'KEY_PROG1','KEY_3D':'KEY_3D_MODE','KEY_VIDEO':'KEY_VOD'}
body = re.search(rf'<{section}>(.*?)</{section}>', xml, re.S).group(1)
seen, out, bad = {}, [], []
for m in re.finditer(r'<key value="(0[xX][0-9a-fA-F]{8})"\s+name="(KEY_[A-Z0-9_]+)"', body):
    v = int(m.group(1), 16); n = VENDOR_TO_MAINLINE.get(m.group(2), m.group(2))
    a, na, c, nc = v & 255, (v >> 8) & 255, (v >> 16) & 255, v >> 24
    if a ^ na != 255 or c ^ nc != 255: bad.append(m.group(1)); continue
    if n not in valid: bad.append(f'{m.group(1)}:{n}'); continue
    sc = a << 8 | c
    if sc in seen: out.append(f'# duplicate 0x{sc:04x}: {m.group(2)} ignored, first = {seen[sc]}'); continue
    seen[sc] = n; out.append(f'0x{sc:04x} = "{n}"  # vendor {m.group(2)} raw {m.group(1).lower()}')
print('[[protocols]]\nname = "himedia_q10"\nprotocol = "nec"\nvariant = "nec"\n[protocols.scancodes]')
print('\n'.join(out))
if bad: print('REJECTED:', bad, file=sys.stderr)
