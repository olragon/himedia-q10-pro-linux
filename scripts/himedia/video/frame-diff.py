#!/usr/bin/env python3
"""frame-diff.py <hw.nv12> <sw.nv12> <w> <h> : per-frame PSNR(Y,UV) and best vertical/horizontal shift of hw vs sw."""
import sys, numpy as np
a, b, w, h = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
fs = w * h * 3 // 2
A = np.fromfile(a, np.uint8); B = np.fromfile(b, np.uint8)
def psnr(x, y):
    m = np.mean((x.astype(float) - y.astype(float)) ** 2); return 99 if m == 0 else 10 * np.log10(255 ** 2 / m)
for i in range(min(len(A), len(B)) // fs):
    fa, fb = A[i*fs:(i+1)*fs], B[i*fs:(i+1)*fs]
    ya, yb = fa[:w*h].reshape(h, w), fb[:w*h].reshape(h, w)
    ca, cb = fa[w*h:].reshape(h//2, w), fb[w*h:].reshape(h//2, w)
    def sh(dy, dx):
        return psnr(ya[max(0,dy):h-max(0,-dy), max(0,dx):w-max(0,-dx)], yb[max(0,-dy):h-max(0,dy), max(0,-dx):w-max(0,dx)])
    best = max((sh(dy, dx), dy, dx) for dy in range(-20, 21) for dx in range(-4, 5))
    rows = np.abs(ya.astype(int) - yb.astype(int)).mean(axis=1)
    print(f"frame {i}: Y {psnr(ya,yb):.1f} UV {psnr(ca,cb):.1f} | best shift dy={best[1]} dx={best[2]} -> {best[0]:.1f} dB | worst rows {np.argsort(rows)[-4:].tolist()} meanerr first/mid/last10 rows {rows[:10].mean():.1f}/{rows[h//2-5:h//2+5].mean():.1f}/{rows[-10:].mean():.1f}")
