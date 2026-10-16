#!/usr/bin/env python3
"""h264-nal-scan.py — list the NAL units of an Annex-B H.264 file with the facts a
stateless-decoder bring-up needs: size, emulation-prevention bytes (EPB) and where
they sit inside the NAL (as a fraction of its length), and how many RBSP patterns
`00 00 0x` (x<=3) the RBSP contains after EPB removal (a hardware EPB stripper fed
RBSP would mangle those).  usage: h264-nal-scan.py <file.h264> [max_nals]"""
import sys

def nals(data):
    i, n = 0, len(data)
    starts = []
    while i < n - 3:
        if data[i] == 0 and data[i+1] == 0 and data[i+2] == 1:
            starts.append(i + 3); i += 3
        else:
            i += 1
    for k, s in enumerate(starts):
        e = starts[k+1] - 3 if k + 1 < len(starts) else n
        while e > s and data[e-1] == 0:   # trailing_zero_8bits / 4-byte start code
            e -= 1
        yield s, data[s:e]

def epb(nal):
    pos, z, out = [], 0, bytearray()
    for i, b in enumerate(nal):
        if z >= 2 and b == 3 and i + 1 < len(nal) and nal[i+1] <= 3:
            pos.append(i); z = 0; continue
        out.append(b); z = z + 1 if b == 0 else 0
    return pos, bytes(out)

def rbsp_hazards(r):
    return [i for i in range(len(r) - 2) if r[i] == 0 and r[i+1] == 0 and r[i+2] <= 3]

data = open(sys.argv[1], 'rb').read()
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 12
names = {1: 'slice', 5: 'IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD'}
for k, (off, nal) in enumerate(nals(data)):
    if k >= limit:
        break
    t = nal[0] & 31
    p, r = epb(nal)
    hz = rbsp_hazards(r)
    print(f'#{k:3d} off={off:8d} type={t:2d} {names.get(t, "?"):5s} size={len(nal):7d} '
          f'epb={len(p):3d} epb_at={[round(x/len(nal), 3) for x in p[:6]]} '
          f'rbsp_00000x={len(hz)} at={[round(x/len(r), 3) for x in hz[:6]]}')
