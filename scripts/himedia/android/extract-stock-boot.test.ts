import { describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import {
  ADVCA_MAGIC, STOCK_PROC_CMDLINE, analyseZImage, cmdlineProvenance, crc32, fdtputSteps, inflateKernel, kexecCmdline,
  parseAdvcaAndroid, parseUImage, sha256sums,
} from "./extract-stock-boot.ts";

const FDT = Uint8Array.from([0xd0, 0x0d, 0xfe, 0xed, 0, 0, 0, 16, 1, 2, 3, 4, 5, 6, 7, 8]); // totalsize 16, magic ok

function le32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function be32(n: number) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, false); return b; }
function cat(...p: Uint8Array[]) { const o = new Uint8Array(p.reduce((a, b) => a + b.length, 0)); let i = 0; for (const b of p) { o.set(b, i); i += b.length; } return o; }

/** A zImage-shaped blob: stub with `ldr r4,=0x8000` at 0xa0 (literal at 0x920), the 0xedfe0dd0 literal, magic/start/end. */
function fakeZImage(opts: { fixed?: number | null; auto?: boolean; dtb?: Uint8Array | null; padTo?: number } = {}) {
  const stubLen = opts.padTo ?? 0xa00;
  const z = new Uint8Array(stubLen);
  const dv = new DataView(z.buffer);
  dv.setUint32(0x24, 0x016f2818, true);
  dv.setUint32(0x28, 0, true);
  const payload = 0x1000;
  const body = new Uint8Array(payload);
  const edata = body.length;
  const all = new Uint8Array(edata + 4); // kexec-style: 4 zero bytes follow _edata
  all.set(z.subarray(0, Math.min(z.length, edata)));
  const dv2 = new DataView(all.buffer);
  dv2.setUint32(0x24, 0x016f2818, true);
  dv2.setUint32(0x2c, edata, true);
  dv2.setUint32(0x924, 0xedfe0dd0, true);
  if (opts.fixed !== null && !opts.auto) {
    dv2.setUint32(0xa0, 0xe59f4878, true); // ldr r4, [pc, #0x878]
    dv2.setUint32(0x920, opts.fixed ?? 0x8000, true);
  }
  if (opts.auto) dv2.setUint32(0xa0, 0xe20444f8, true); // and r4, r4, #0xf8000000 (imm12 0x4f8 = 0xf8 ror 8)
  return opts.dtb === null ? all.subarray(0, edata) : cat(all.subarray(0, edata), opts.dtb ?? FDT);
}

function fakeUImage(data: Uint8Array, over: { badData?: boolean; badHeader?: boolean; comp?: number } = {}) {
  const h = new Uint8Array(64);
  const dv = new DataView(h.buffer);
  dv.setUint32(0, 0x27051956, false);
  dv.setUint32(12, data.length, false);
  dv.setUint32(16, 0x02000000, false);
  dv.setUint32(20, 0x02000000, false);
  h[28] = 5; h[29] = 2; h[30] = 2; h[31] = over.comp ?? 0;
  h.set(new TextEncoder().encode("Linux-3.18.24_test"), 32);
  dv.setUint32(24, (crc32(data) ^ (over.badData ? 1 : 0)) >>> 0, false);
  const hc = crc32(h); // field 4..8 is still zero here
  dv.setUint32(4, (hc ^ (over.badHeader ? 1 : 0)) >>> 0, false);
  return cat(h, data);
}

function fakeKernelImg(uimg: Uint8Array, ramdisk: Uint8Array, page = 16384) {
  const al = (n: number) => Math.ceil(n / page) * page;
  const img = new Uint8Array(0x2000 + page + al(uimg.length) + al(ramdisk.length));
  img.set(new TextEncoder().encode(ADVCA_MAGIC));
  const a = 0x2000;
  img.set(new TextEncoder().encode("ANDROID!"), a);
  const dv = new DataView(img.buffer);
  dv.setUint32(a + 8, uimg.length, true);
  dv.setUint32(a + 12, 0x3008000, true);
  dv.setUint32(a + 16, ramdisk.length, true);
  dv.setUint32(a + 20, 0x4000000, true);
  dv.setUint32(a + 32, 0x3000100, true);
  dv.setUint32(a + 36, page, true);
  img.set(uimg, a + page);
  img.set(ramdisk, a + page + al(uimg.length));
  return img;
}

const RD = gzipSync(Buffer.from("cpio"));

describe("parseAdvcaAndroid", () => {
  test("splits kernel and ramdisk at page boundaries (16 KiB and 4 KiB)", () => {
    for (const page of [16384, 4096]) {
      const u = fakeUImage(fakeZImage());
      const r = parseAdvcaAndroid(fakeKernelImg(u, RD, page));
      expect(r.pageSize).toBe(page);
      expect(r.kernel.length).toBe(u.length);
      expect(Buffer.from(r.ramdisk).equals(RD)).toBe(true);
      expect(r.kernelAddr).toBe(0x3008000);
      expect(r.tagsAddr).toBe(0x3000100);
    }
  });
  test("rejects a missing ADVCA magic, a missing ANDROID! magic and a truncated ramdisk", () => {
    const good = fakeKernelImg(fakeUImage(fakeZImage()), RD);
    expect(() => parseAdvcaAndroid(new Uint8Array(0x10000))).toThrow(/ADVCA/);
    const noAnd = good.slice(); noAnd[0x2000] = 0x58;
    expect(() => parseAdvcaAndroid(noAnd)).toThrow(/ANDROID!/);
    expect(() => parseAdvcaAndroid(good.subarray(0, good.length - 40000))).toThrow(/truncated/);
  });
});

describe("parseUImage", () => {
  test("accepts valid CRCs and exposes the payload", () => {
    const z = fakeZImage();
    const u = parseUImage(fakeUImage(z));
    expect(u.headerCrc.ok && u.dataCrc.ok).toBe(true);
    expect(u.load).toBe(0x02000000);
    expect(u.name).toBe("Linux-3.18.24_test");
    expect(Buffer.from(u.data).equals(Buffer.from(z))).toBe(true);
  });
  test("flags a flipped data CRC and a flipped header CRC independently", () => {
    const d = parseUImage(fakeUImage(fakeZImage(), { badData: true }));
    expect([d.headerCrc.ok, d.dataCrc.ok]).toEqual([true, false]);
    const h = parseUImage(fakeUImage(fakeZImage(), { badHeader: true }));
    expect([h.headerCrc.ok, h.dataCrc.ok]).toEqual([false, true]);
  });
  test("detects corrupted payload bytes, not just a wrong stored CRC", () => {
    const b = fakeUImage(fakeZImage());
    b[64 + 500] ^= 0xff;
    expect(parseUImage(b).dataCrc.ok).toBe(false);
  });
  test("rejects a bad magic and a size field that runs past the buffer", () => {
    const b = fakeUImage(fakeZImage());
    const bad = b.slice(); bad[0] = 0;
    expect(() => parseUImage(bad)).toThrow(/magic/);
    expect(() => parseUImage(b.subarray(0, 100))).toThrow(/past the buffer/);
  });
});

describe("analyseZImage", () => {
  test("finds the appended DTB at _edata and the appended-DTB literal in the stub", () => {
    const z = analyseZImage(fakeZImage());
    expect(z.magicOk).toBe(true);
    expect(z.dtbOffset).toBe(0x1000);
    expect(z.dtbSize).toBe(16);
    expect(z.appendedDtbSupport).toBe(true);
  });
  test("reports no DTB when none is appended, rather than guessing", () => {
    expect(analyseZImage(fakeZImage({ dtb: null })).dtbOffset).toBe(-1);
  });
  test("bytes after _edata that are not an FDT are not reported as one", () => {
    expect(analyseZImage(fakeZImage({ dtb: new Uint8Array(16) })).dtbOffset).toBe(-1);
  });
  test("distinguishes a FIXED zreladdr (ldr r4,=addr) from AUTO_ZRELADDR (and #0xf8000000)", () => {
    expect(analyseZImage(fakeZImage({ fixed: 0x8000 })).zreladdr).toEqual({ kind: "fixed", addr: 0x8000 });
    expect(analyseZImage(fakeZImage({ fixed: 0x3008000 })).zreladdr).toEqual({ kind: "fixed", addr: 0x3008000 });
    expect(analyseZImage(fakeZImage({ auto: true })).zreladdr).toEqual({ kind: "auto" });
    expect(analyseZImage(fakeZImage({ fixed: null })).zreladdr).toEqual({ kind: "unknown" });
  });
  test("a non-zImage has magicOk=false", () => {
    expect(analyseZImage(new Uint8Array(0x2000)).magicOk).toBe(false);
  });
  test("an FDT whose size runs past the file is an error", () => {
    const lie = Uint8Array.from([0xd0, 0x0d, 0xfe, 0xed, 0, 0, 0xff, 0xff]);
    expect(() => analyseZImage(fakeZImage({ dtb: lie }))).toThrow(/past the zImage/);
  });
});

describe("cmdline", () => {
  test("drops initrd= (it would override the DT initrd) and nothing else", () => {
    const c = kexecCmdline(STOCK_PROC_CMDLINE);
    expect(c).not.toContain("initrd=");
    expect(c).toContain("mem=1993M mmz=ddr,0,0,56M vmalloc=600M HM3=2003");
    expect(c).toContain("hbcomp=/dev/block/mmcblk0p14");
    expect(c.split(" ").length).toBe(STOCK_PROC_CMDLINE.split(" ").length - 1);
  });
  test("provenance: env bootargs + bootargs_2G must all be present; extras are reported", () => {
    const env = new Map([["bootargs", "a=1 b=2"], ["bootargs_2G", "mem=1993M"]]);
    expect(cmdlineProvenance("a=1 b=2 initrd=0x1,0x2 mem=1993M HM3=2003", env))
      .toEqual({ fromEnv: true, missing: [], extrasAddedAtRuntime: ["initrd=0x1,0x2", "HM3=2003"] });
    expect(cmdlineProvenance("a=1 mem=1993M", env).missing).toEqual(["b=2"]);
  });
});

describe("fdtputSteps", () => {
  test("creates /memory with a hex reg and /chosen with the cmdline", () => {
    const s = fdtputSteps("x.dtb", "a b=c", 0x7c900000);
    expect(s).toContainEqual(["-t", "x", "x.dtb", "/memory", "reg", "0", "7c900000"]);
    expect(s).toContainEqual(["-t", "s", "x.dtb", "/chosen", "bootargs", "a b=c"]);
    // nodes are created before properties are set on them
    expect(s.findIndex((a) => a[0] === "-c" && a[2] === "/memory")).toBeLessThan(s.findIndex((a) => a.includes("reg")));
  });
});

describe("sha256sums", () => {
  test("emits `hash  name` lines in sha256sum -c format (two spaces, trailing newline)", () => {
    expect(sha256sums({ a: { sha256: "11" }, "b.bin": { sha256: "22" } })).toBe("11  a\n22  b.bin\n");
  });
});

describe("inflateKernel", () => {
  const payload = Buffer.concat([Buffer.from("Linux version 3.18.24_test (x)\0pdm_tag\0fdt_init_hisi\0"), Buffer.alloc(2 << 20, 0x41)]);
  test("finds the gzip piggy after the stub, reports size and which vendor markers are present", () => {
    const r = inflateKernel(Buffer.concat([Buffer.alloc(0x1800), gzipSync(payload), Buffer.alloc(56)]));
    expect(r?.size).toBe(payload.length);
    expect(r?.markers["pdm_tag"]).toBe(true);
    expect(r?.markers["HI_DRV_PDM_Init"]).toBe(false);
    expect(r?.version).toContain("Linux version 3.18.24_test");
  });
  test("returns null when there is no gzip payload, rather than a made-up size", () => {
    expect(inflateKernel(new Uint8Array(0x4000))).toBeNull();
  });
});
