#!/usr/bin/env python3
"""make-start-icon.py <out.png> — the taskbar's Start logo: four rounded tiles with a blue gradient
(Windows-familiar, our own drawing). PNG on purpose: QIcon(<file>.svg) needs Qt's SVG icon-engine
plugin, which this install does not have, and the button then stays blank (2026-10-12)."""
import sys
from PIL import Image, ImageDraw
S = 128; img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
grad = Image.linear_gradient("L").resize((S, S)).rotate(45, expand=False)
top, bot = (98, 196, 255), (31, 122, 224)
fill = Image.merge("RGB", [grad.point(lambda v, a=a, b=b: a + (b - a) * v / 255) for a, b in zip(top, bot)])
mask = Image.new("L", (S, S), 0); d = ImageDraw.Draw(mask)
for x, y in [(12, 12), (68, 12), (12, 68), (68, 68)]:
    d.rounded_rectangle([x, y, x + 48, y + 48], radius=6, fill=255)
img.paste(fill, (0, 0), mask)
img.save(sys.argv[1] if len(sys.argv) > 1 else "q10-start.png")
