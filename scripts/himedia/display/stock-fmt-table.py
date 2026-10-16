#!/usr/bin/env python3
"""Decode the stock vendor display-format table (DISP_FMT_CFG_S[]) out of the stock
Android kernel image: one row per format with the HPLL words the vendor programs.

Layout (36 words = 0x90 bytes, from vdp_v4_0 drv_disp_hal.h + vdp_define.h):
  ... VDP_DISP_SYNCINFO_S tail (Hpw @-28, Vpw @-24), enPllIndex @-4,
  u32Pll[2] @0/+4, DISP_HAL_ENCFMT_PARAM_S: eFmt @+8, OrgRect w/h @+28/+32,
  u32RefreshRate(1/100 Hz) @+60.
HPLL words: ctrl0 = postdiv2<<28 | postdiv1<<24 | frac24, ctrl1 = refdiv<<12 | fbdiv (| DSMPD<<25).
Usage: stock-fmt-table.py [vmlinux.bin] [--start 0xOFFSET]
"""
import os, struct, sys
path = os.path.join(os.environ.get('HIMEDIA_ROOT', os.path.expanduser('~/himedia-q10-pro')), 'stock-android-kexec/vmlinux.bin')
start = None
args = sys.argv[1:]
while args:
    a = args.pop(0)
    if a == '--start': start = int(args.pop(0), 0)
    else: path = a
d = open(path, 'rb').read()
W = lambda o: struct.unpack_from('<I', d, o)[0]
if start is None:
    pat = struct.pack('<II', 0x12000000, 0x2063)   # 1080p 148.5 MHz plan
    hits = []
    i = -1
    while (i := d.find(pat, i + 1)) >= 0: hits.append(i)
    if not hits: sys.exit('no anchor found')
    start = hits[0]
STRIDE = 0x90
def ok(o):  # a row has pllindex 0..2, a sane refresh and rect
    return 0 <= W(o - 4) <= 2 and 1000 <= W(o + 60) <= 12000 and 0 < W(o + 28) <= 4096 and 0 < W(o + 32) <= 2200
first = start
while ok(first - STRIDE): first -= STRIDE
o = first
print('table @ file offset 0x%x' % first)
print('fmt  size       Hz      ctrl0     ctrl1     refdiv fbdiv frac     pd1 pd2 dsmpd  Hpw Vpw  vco_MHz out_MHz(div4/2)')
while ok(o):
    c0, c1 = W(o), W(o + 4)
    fb, rd = c1 & 0xfff, (c1 >> 12) & 0x3f
    frac = c0 & 0xffffff; pd1 = (c0 >> 24) & 7; pd2 = (c0 >> 28) & 7; ds = (c1 >> 25) & 1
    vco = 24 * (fb + (0 if ds else frac / 2**24)) / rd if rd else 0
    div = (pd1 * pd2) or 1
    print('%3d  %4dx%-5d %6.2f  %08x  %08x  %5d %5d %06x  %d   %d   %d     %4d %3d  %8.2f %8.3f' % (
        W(o + 8), W(o + 28), W(o + 32), W(o + 60) / 100, c0, c1, rd, fb, frac, pd1, pd2, ds,
        W(o - 28), W(o - 24), vco, vco / div / 4))
    o += STRIDE
