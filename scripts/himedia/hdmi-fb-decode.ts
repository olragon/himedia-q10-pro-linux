#!/usr/bin/env bun
/**
 * Decode `busybox devmem` reads of the Hi3798CV200 VDP graphics layer G0 into a simple-framebuffer
 * DT node. Register layout: vendor kernel 4.4.35 drivers/common/include/hi3798cv200/hi_reg_vdp.h
 * (see docs/261011-himedia-hdmi-simplefb-research.md). Pure decode; touches no hardware.
 *
 *   bun scripts/himedia/hdmi-fb-decode.ts G0_CTRL=0x.. G0_ADDR=0x.. G0_STRIDE=0x.. G0_IRESO=0x.. \
 *        [G0_NADDR=0x..] [DHD0_CTRL=0x..] [DHD0_VSYNC=0x..] [DHD0_HSYNC1=0x..]
 */
export const IFMT: Record<number, { dt: string; bpp: number }> = {
  0x42: { dt: "r5g6b5", bpp: 16 },
  0x49: { dt: "a1r5g5b5", bpp: 16 },
  0x50: { dt: "r8g8b8", bpp: 24 },
  0x60: { dt: "x8r8g8b8", bpp: 32 },
  0x68: { dt: "a8r8g8b8", bpp: 32 },
};

export function decode(r: Record<string, number>) {
  const out: Record<string, unknown> = {};
  if (r.G0_CTRL !== undefined) {
    const ifmt = r.G0_CTRL & 0xff;
    out.surface_en = (r.G0_CTRL >>> 31) & 1;
    out.ifmt = "0x" + ifmt.toString(16);
    out.format = IFMT[ifmt]?.dt ?? "UNKNOWN (not in table; do not guess)";
    out.read_mode_progressive_if0 = (r.G0_CTRL >>> 26) & 1;
  }
  if (r.G0_ADDR !== undefined) out.addr = "0x" + (r.G0_ADDR >>> 0).toString(16);
  if (r.G0_STRIDE !== undefined) out.stride = r.G0_STRIDE & 0xffff;
  if (r.G0_IRESO !== undefined) {
    out.width = (r.G0_IRESO & 0xfff) + 1; // iw/ih are "value - 1" in vendor code: VERIFY on hardware
    out.height = ((r.G0_IRESO >>> 12) & 0xfff) + 1;
  }
  if (r.DHD0_CTRL !== undefined) {
    out.dhd0_intf_en = (r.DHD0_CTRL >>> 31) & 1;
    out.dhd0_iop_progressive = (r.DHD0_CTRL >>> 4) & 1;
  }
  if (r.DHD0_VSYNC !== undefined) out.dhd0_vact = (r.DHD0_VSYNC & 0xfff) + 1;
  if (r.DHD0_HSYNC1 !== undefined) out.dhd0_hact = (r.DHD0_HSYNC1 & 0xffff) + 1;
  const bpp = IFMT[(r.G0_CTRL ?? 0) & 0xff]?.bpp;
  if (out.stride && out.width && bpp && (out.stride as number) < (out.width as number) * (bpp / 8))
    out.WARNING = "stride < width*bpp/8: stride unit is not bytes, or width is wrong";
  if (out.addr && out.stride && out.height) {
    const size = (out.stride as number) * (out.height as number);
    out.size = "0x" + size.toString(16);
    out.dt =
      `reserved-memory { fb@${(out.addr as string).slice(2)} { reg = <${out.addr} ${out.size}>; no-map; }; };\n` +
      `framebuffer@${(out.addr as string).slice(2)} { compatible = "simple-framebuffer"; reg = <${out.addr} ${out.size}>; ` +
      `width = <${out.width}>; height = <${out.height}>; stride = <${out.stride}>; format = "${out.format}"; };`;
  }
  return out;
}

if (import.meta.main) {
  const r: Record<string, number> = {};
  for (const a of Bun.argv.slice(2)) {
    const [k, v] = a.split("=");
    if (!k || !v) throw new Error(`bad arg ${a}; want NAME=0xVALUE`);
    r[k] = Number(v);
  }
  console.log(JSON.stringify(decode(r), null, 2));
}
