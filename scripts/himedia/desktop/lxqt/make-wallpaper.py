#!/usr/bin/env python3
"""make-wallpaper.py <out.png> — the Q10 desktop wallpaper: a Windows-11-like "bloom" (fanned,
translucent petals lit from inside) on a deep-blue gradient, drawn with PIL (no licensed art)."""
import sys, math
from PIL import Image, ImageDraw, ImageFilter, ImageChops
W, H = 1920, 1080
bg = Image.linear_gradient("L").resize((W, H)).transpose(Image.Transpose.FLIP_TOP_BOTTOM)
base = Image.merge("RGB", [bg.point(lambda v: 6 + v * 0.10), bg.point(lambda v: 14 + v * 0.22), bg.point(lambda v: 34 + v * 0.42)])
canvas = base.convert("RGBA")
cx, cy = W * 0.52, H * 0.60
for i, ang in enumerate(range(-80, 81, 20)):      # 9 petals fanned around the centre
    petal = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(petal)
    L, w = 430, 150
    t = (ang + 80) / 160                           # hue drift: azure -> cyan -> violet
    col = (int(60 + 110 * t), int(150 + 70 * (1 - abs(t - 0.5) * 2)), 255)
    for k in range(14):                            # bright core fading outwards
        s = 1 - k / 14
        a = int(26 + 60 * (k / 14))
        d.ellipse([cx - w * s, cy - L * s, cx + w * s, cy + 40 * s], fill=col + (a,))
    petal = petal.rotate(ang, center=(cx, cy + 20), resample=Image.Resampling.BICUBIC)
    canvas = Image.alpha_composite(canvas, petal.filter(ImageFilter.GaussianBlur(6)))
glow = canvas.filter(ImageFilter.GaussianBlur(40))
canvas = ImageChops.screen(canvas.convert("RGB"), glow.convert("RGB").point(lambda v: v * 0.45))
canvas.save(sys.argv[1] if len(sys.argv) > 1 else "wallpaper.png", optimize=True)
