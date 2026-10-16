/**
 * HPLL plan arithmetic for the Hi3798CV200 HDMI pixel clock, as a library the test imports.
 * Mirrors drivers/clk/hisilicon/clk-hi3798cv200-hdmi.c (patch 0015): pixel = 24 MHz * (fbdiv + frac/2^24)
 * / refdiv / (postdiv1 * postdiv2) / D, D = 4 up to 340 MHz and 2 above (VO_HD divider /2 or /1 behind
 * a fixed /2).  CRG 0x28 (ctrl0): [23:0] frac, [26:24] postdiv1, [30:28] postdiv2.  CRG 0x2c (ctrl1):
 * [11:0] fbdiv, [17:12] refdiv, [25] DSMPD.
 */
export interface Preset {
  request: number; rate: number; frac: number; fbdiv: number; refdiv: number;
  postdiv1: number; postdiv2: number; dsmpd: boolean;
  /** the "ctrl0/ctrl1" words the source comment claims */
  comment: { ctrl0: number; ctrl1: number };
}

export const PARENT_HZ = 24_000_000;

export function words(p: { frac: number; fbdiv: number; refdiv: number; postdiv1: number; postdiv2: number; dsmpd: boolean }) {
  const ctrl0 = ((p.postdiv2 << 28) | (p.postdiv1 << 24) | p.frac) >>> 0;
  const ctrl1 = (p.fbdiv | (p.refdiv << 12) | (p.dsmpd ? 1 << 25 : 0)) >>> 0;
  return { ctrl0, ctrl1 };
}

export function rateOf(ctrl0: number, ctrl1: number, voDiv: 2 | 1 = 2): number {
  const frac = ctrl1 & (1 << 25) ? 0 : ctrl0 & 0xffffff;
  const pd1 = (ctrl0 >>> 24) & 7, pd2 = (ctrl0 >>> 28) & 7;
  const fb = ctrl1 & 0xfff, ref = (ctrl1 >>> 12) & 0x3f;
  const d = voDiv === 2 ? 4 : 2;
  return (PARENT_HZ * (fb + frac / 2 ** 24)) / ref / (pd1 * pd2) / d;
}

/** Parse the preset rows out of the clock source (or the patch that adds it). */
export function parsePresets(src: string): Preset[] {
  const rows = [...src.matchAll(/^\+?\s*\{\s*(\d+),\s*(\d+),\s*(0x[0-9a-f]+|0),\s*(\d+),\s*(\d+),\s*(\d+),\s*(\d+),\s*(true|false)\s*\},\s*\/\*\s*([0-9a-f]{8})\/([0-9a-f]{8})\s*\*\//gm)];
  return rows.map((m) => ({
    request: +m[1], rate: +m[2], frac: Number(m[3]), fbdiv: +m[4], refdiv: +m[5],
    postdiv1: +m[6], postdiv2: +m[7], dsmpd: m[8] === "true",
    comment: { ctrl0: parseInt(m[9], 16), ctrl1: parseInt(m[10], 16) },
  }));
}
