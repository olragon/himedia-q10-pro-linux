#!/usr/bin/env bun
/**
 * Unpack the Q10 Pro's stock `kernel` partition into a kit that `kexec` can boot.
 *
 *   kernel.img = ADVCA header (0x2000) | Android boot image ("ANDROID!", page 16 KiB)
 *                                         kernel page = U-Boot uImage( zImage + appended DTB )
 *                                         ramdisk page = gzip cpio
 *
 * Output (default $HIMEDIA_ROOT/stock-android-kexec/):
 *   zImage            raw zImage, uImage header AND appended DTB stripped
 *   stock.dtb         the vendor DTB, byte-exact as appended
 *   stock-android.dtb stock.dtb + /memory + /chosen/bootargs (what the box script passes)
 *   ramdisk.gz        Android boot ramdisk
 *   cmdline.txt       the cmdline the stock kernel ended up with, minus `initrd=`
 *   manifest.json     sizes, sha256s, CRC verdicts, analysis (the box script verifies against it)
 *
 * Read-only on the input. Never talks to the box. ref: docs/261012-himedia-stock-android-kexec.md
 *
 * ⭐ Why the DTB is stripped from the zImage: this decompressor HAS appended-DTB support (the
 * 0xedfe0dd0 literal is in the stub) and an appended DTB WINS over the one in r2 — so leaving it
 * on would silently discard the DTB that kexec passes. Without it, the stub sees four zero bytes
 * after _edata (kexec-tools writes them) and hands r2 through untouched.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { WORK_ROOT } from "../lib.ts";
import { parseEnv } from "../uboot-env.ts";

export const ADVCA_MAGIC = "Hisilicon_ADVCA_ImgHead_MagicNum";
export const ADVCA_HEADER_SIZE = 0x2000;
export const UIMAGE_MAGIC = 0x27051956;
export const ZIMAGE_MAGIC = 0x016f2818;
export const FDT_MAGIC = 0xd00dfeed;
/** The vendor kernel copies the DTB into a 32 KiB static buffer and complains above this. */
export const VENDOR_FDT_LIMIT = 16384;
/** Headroom kexec-tools needs: initrd props (2 x ~28 B) + a longer bootargs, with slack. */
export const FDT_HEADROOM = 512;

/**
 * What /proc/cmdline said on the running stock Android (adb shell, 2026-10-10). The stock
 * kernel never sees the bootloader's cmdline directly: the vendor kernel builds it from ATAGs at
 * physical 0x100. Provenance: bootargs + bootargs_2G from the U-Boot env (re-checked below)
 * plus the two things U-Boot appends at run time — `initrd=` and `HM3=2003`.
 */
export const STOCK_PROC_CMDLINE =
  "androidboot.selinux=disabled console=ttyAMA0,115200 blkdevparts=mmcblk0:1M(fastboot),1M(bootargs)," +
  "10M(recovery),2M(deviceinfo),8M(baseparam),8M(pqparam),20M(logo),20M(logobak),40M(fastplay)," +
  "40M(fastplaybak),40M(kernel),20M(misc),40M(trustedcore),1024M(system),1024M(cache),50M(private)," +
  "800M(backup),8M(securestore),-(userdata) hbcomp=/dev/block/mmcblk0p14 initrd=0x4000000,0x140D59 " +
  "mem=1993M mmz=ddr,0,0,56M vmalloc=600M HM3=2003";

export const MEMORY_BYTES = 1993 * 1024 * 1024; // mem=1993M; the top 55 MiB is mmz + the TEE

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
export const crc32 = (b: Uint8Array): number => Bun.hash.crc32(b) >>> 0;

export type Verdict = { ok: boolean; stored: number; computed: number };

export type AdvcaAndroid = {
  advcaMagic: string;
  androidOffset: number;
  kernelSize: number;
  kernelAddr: number;
  ramdiskSize: number;
  ramdiskAddr: number;
  tagsAddr: number;
  pageSize: number;
  cmdline: string;
  kernel: Uint8Array; // the uImage, header included
  ramdisk: Uint8Array;
};

const u32le = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, true);
const u32be = (b: Uint8Array, o: number) => new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(o, false);
const cstr = (b: Uint8Array) => {
  const z = b.indexOf(0);
  return Buffer.from(b.subarray(0, z < 0 ? b.length : z)).toString("latin1");
};
const alignUp = (n: number, a: number) => Math.ceil(n / a) * a;

/** ADVCA envelope -> Android boot image. Throws on anything that is not exactly that shape. */
export function parseAdvcaAndroid(img: Uint8Array): AdvcaAndroid {
  const advcaMagic = cstr(img.subarray(0, 0x20));
  if (advcaMagic !== ADVCA_MAGIC) throw new Error(`not a Hisilicon ADVCA image (magic "${advcaMagic}")`);
  const a = ADVCA_HEADER_SIZE;
  if (Buffer.from(img.subarray(a, a + 8)).toString("latin1") !== "ANDROID!")
    throw new Error(`no "ANDROID!" boot image at 0x${a.toString(16)} — this is not the layout measured on the Q10`);
  const kernelSize = u32le(img, a + 8);
  const kernelAddr = u32le(img, a + 12);
  const ramdiskSize = u32le(img, a + 16);
  const ramdiskAddr = u32le(img, a + 20);
  const secondSize = u32le(img, a + 24);
  const tagsAddr = u32le(img, a + 32);
  const pageSize = u32le(img, a + 36);
  if (![2048, 4096, 8192, 16384].includes(pageSize)) throw new Error(`implausible page size ${pageSize}`);
  if (secondSize !== 0) throw new Error(`second-stage image present (${secondSize} B) — layout not handled`);
  const kOff = a + pageSize;
  const rOff = kOff + alignUp(kernelSize, pageSize);
  if (rOff + ramdiskSize > img.length) throw new Error("image truncated: ramdisk runs past the end of the file");
  return {
    advcaMagic, androidOffset: a, kernelSize, kernelAddr, ramdiskSize, ramdiskAddr, tagsAddr, pageSize,
    cmdline: cstr(img.subarray(a + 64, a + 64 + 512)),
    kernel: img.subarray(kOff, kOff + kernelSize),
    ramdisk: img.subarray(rOff, rOff + ramdiskSize),
  };
}

export type UImage = {
  name: string; size: number; load: number; entry: number; os: number; arch: number; type: number; comp: number;
  headerCrc: Verdict; dataCrc: Verdict; data: Uint8Array;
};

/** U-Boot legacy image: validates both CRCs (header CRC is computed with its own field zeroed). */
export function parseUImage(buf: Uint8Array): UImage {
  if (buf.length < 64) throw new Error("uImage shorter than its header");
  const be = (o: number) => u32be(buf, o);
  if (be(0) !== UIMAGE_MAGIC) throw new Error(`bad uImage magic 0x${be(0).toString(16)}`);
  const hdr = Uint8Array.from(buf.subarray(0, 64));
  const storedH = be(4);
  hdr.fill(0, 4, 8);
  const size = be(12);
  if (64 + size > buf.length) throw new Error(`uImage data (${size}) runs past the buffer (${buf.length - 64})`);
  const data = buf.subarray(64, 64 + size);
  const computedH = crc32(hdr);
  const storedD = be(24);
  const computedD = crc32(data);
  return {
    name: cstr(buf.subarray(32, 64)), size, load: be(16), entry: be(20),
    os: buf[28], arch: buf[29], type: buf[30], comp: buf[31],
    headerCrc: { ok: storedH === computedH, stored: storedH, computed: computedH },
    dataCrc: { ok: storedD === computedD, stored: storedD, computed: computedD },
    data,
  };
}

export type ZImageInfo = {
  magicOk: boolean; start: number; end: number;
  /** offset where the appended FDT begins, or -1 */
  dtbOffset: number; dtbSize: number;
  /** the decompressor contains the 0xedfe0dd0 literal => ARM_APPENDED_DTB is compiled in */
  appendedDtbSupport: boolean;
  /** `fixed:<addr>` when the stub does `ldr r4,=zreladdr`; `auto` when it masks pc; else `unknown` */
  zreladdr: { kind: "fixed"; addr: number } | { kind: "auto" } | { kind: "unknown" };
};

const STUB_SCAN = 0x1000;

export function analyseZImage(z: Uint8Array): ZImageInfo {
  const magicOk = z.length > 0x30 && u32le(z, 0x24) === ZIMAGE_MAGIC;
  const start = magicOk ? u32le(z, 0x28) : 0;
  const end = magicOk ? u32le(z, 0x2c) : 0;
  const scan = Math.min(STUB_SCAN, z.length);
  let appendedDtbSupport = false;
  let zreladdr: ZImageInfo["zreladdr"] = { kind: "unknown" };
  for (let o = 0x34; o + 4 <= scan; o += 4) {
    const w = u32le(z, o);
    if (w === 0xedfe0dd0) appendedDtbSupport = true;
    // and rD, rN, #0xf8000000  (CONFIG_AUTO_ZRELADDR derives the base from pc)
    if (((w & 0xfff00fff) >>> 0) === 0xe20004f8) zreladdr = { kind: "auto" };
  }
  if (zreladdr.kind === "unknown") {
    // ldr r4, [pc, #imm]  — `ldr r4, =zreladdr` (fixed). Only trust it in the stub's first lines.
    for (let o = 0x34; o + 4 <= Math.min(0x400, scan); o += 4) {
      const w = u32le(z, o);
      if (((w & 0xfffff000) >>> 0) === 0xe59f4000) {
        const lit = o + 8 + (w & 0xfff);
        if (lit + 4 <= z.length) { zreladdr = { kind: "fixed", addr: u32le(z, lit) }; break; }
      }
    }
  }
  // The appended FDT: `end` is _edata. Verify the magic there; otherwise report none.
  let dtbOffset = -1, dtbSize = 0;
  if (magicOk && end > 0 && end + 8 <= z.length && u32be(z, end) === FDT_MAGIC) {
    dtbOffset = end;
    dtbSize = u32be(z, end + 4);
    if (end + dtbSize > z.length) throw new Error(`appended FDT (${dtbSize} B) runs past the zImage`);
  }
  return { magicOk, start, end, dtbOffset, dtbSize, appendedDtbSupport, zreladdr };
}

/** The cmdline the box should pass: the stock one without `initrd=` (kexec places the ramdisk and
 *  hands it over through /chosen/linux,initrd-*; a stale `initrd=` would WIN over those). */
export function kexecCmdline(stock: string): string {
  return stock.split(/\s+/).filter((t) => t && !t.startsWith("initrd=")).join(" ");
}

/** Prove the captured cmdline is the U-Boot env `bootargs` + `bootargs_2G` plus run-time extras. */
export function cmdlineProvenance(stock: string, env: Map<string, string>) {
  const base = env.get("bootargs") ?? "";
  const mem = env.get("bootargs_2G") ?? "";
  const toks = new Set(stock.split(/\s+/));
  const missing = [...base.split(/\s+/), ...mem.split(/\s+/)].filter((t) => t && !toks.has(t));
  const known = new Set([...base.split(/\s+/), ...mem.split(/\s+/)]);
  const extras = [...toks].filter((t) => t && !known.has(t));
  return { fromEnv: missing.length === 0, missing, extrasAddedAtRuntime: extras };
}

/** fdtput argv list that turns the vendor DTB into one that is complete on its own. */
export function fdtputSteps(dtb: string, cmdline: string, memBytes: number): string[][] {
  return [
    ["-c", dtb, "/memory"],
    ["-t", "s", dtb, "/memory", "device_type", "memory"],
    ["-t", "x", dtb, "/memory", "reg", "0", memBytes.toString(16)],
    ["-c", dtb, "/chosen"],
    ["-t", "s", dtb, "/chosen", "bootargs", cmdline],
  ];
}

/** Marker strings that prove the ATAG->FDT merge and PDM code are in the vendor kernel. */
export const VENDOR_MARKERS = [
  "pdm_tag", "pdm: Invalid PDM tag", "atags: %s: fdt size too big", "atags: %s: fdt open error",
  "Looking for initrd properties...", "linux,initrd-start", "HI_DRV_PDM_Init", "parse_param", "initmrd=",
];

export function inflateKernel(z: Uint8Array): { size: number; sha256: string; markers: Record<string, boolean>; version: string; image: Uint8Array } | null {
  // The piggy payload is a gzip stream after the decompressor stub; find the first header that inflates.
  for (let o = 0x1000; o < Math.min(z.length, 0x10000); o++) {
    if (z[o] !== 0x1f || z[o + 1] !== 0x8b || z[o + 2] !== 8) continue;
    try {
      const out = gunzipSync(z.subarray(o));
      if (out.length < 1 << 20) continue;
      const text = Buffer.from(out).toString("latin1");
      const markers = Object.fromEntries(VENDOR_MARKERS.map((m) => [m, text.includes(m)]));
      const v = /Linux version [^\n\0]*/.exec(text);
      return { size: out.length, sha256: sha256(out), markers, version: v ? v[0].slice(0, 120) : "", image: out };
    } catch { /* not the payload */ }
  }
  return null;
}

/** `sha256sum -c` format — the box has coreutils but no jq/python guarantee, so it verifies THIS, not the JSON. */
export function sha256sums(entries: Record<string, { sha256: string }>): string {
  return Object.entries(entries).map(([name, e]) => `${e.sha256}  ${name}`).join("\n") + "\n";
}

type Entry = { file: string; bytes: number; sha256: string };
const entry = (file: string, b: Uint8Array): Entry => ({ file, bytes: b.length, sha256: sha256(b) });

function runTool(argv: string[]): string {
  const p = Bun.spawnSync(argv);
  if (p.exitCode !== 0) throw new Error(`${argv.join(" ")} -> exit ${p.exitCode}: ${p.stderr.toString()}`);
  return p.stdout.toString();
}

export async function main(argv: string[]) {
  const arg = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const input = arg("--in", `${WORK_ROOT}/emmc-dump/kernel.img`);
  const envImg = arg("--env", `${WORK_ROOT}/emmc-dump/bootargs.img`);
  const out = arg("--out", `${WORK_ROOT}/stock-android-kexec`);

  const img = new Uint8Array(readFileSync(input));
  const ab = parseAdvcaAndroid(img);
  const ui = parseUImage(ab.kernel);
  const bad = [!ui.headerCrc.ok && "uImage header CRC", !ui.dataCrc.ok && "uImage data CRC"].filter(Boolean);
  if (bad.length) throw new Error(`refusing to extract: ${bad.join(" and ")} mismatch`);
  if (ui.comp !== 0) throw new Error(`uImage compression type ${ui.comp}: expected none (zImage self-decompresses)`);
  if (ui.arch !== 2) throw new Error(`uImage arch ${ui.arch}: expected 2 (ARM)`);

  const zfull = ui.data;
  const zi = analyseZImage(zfull);
  if (!zi.magicOk) throw new Error("no zImage magic 0x016f2818 at 0x24");
  if (zi.dtbOffset < 0) throw new Error("no appended DTB at the zImage's _edata");
  const zImage = zfull.subarray(0, zi.dtbOffset);
  const dtb = zfull.subarray(zi.dtbOffset, zi.dtbOffset + zi.dtbSize);
  if (zi.dtbOffset + zi.dtbSize !== zfull.length)
    console.error(`[local] note: ${zfull.length - zi.dtbOffset - zi.dtbSize} trailing bytes after the DTB are dropped`);
  if (u32be(ab.ramdisk, 0) >>> 16 !== 0x1f8b) throw new Error("ramdisk is not gzip");

  const cmdline = kexecCmdline(STOCK_PROC_CMDLINE);
  mkdirSync(out, { recursive: true });
  const w = (f: string, b: Uint8Array | string) => writeFileSync(`${out}/${f}`, b);
  w("zImage", zImage);
  w("stock.dtb", dtb);
  w("ramdisk.gz", ab.ramdisk);
  w("cmdline.txt", cmdline + "\n");

  // stock.dtb + /memory + /chosen via fdtput (dtc package); the DTB is binary-edited, never regenerated.
  let fixed: Entry | null = null, fdtSize = 0;
  const tmp = `${out}/stock-android.dtb`;
  writeFileSync(tmp, dtb);
  for (const step of fdtputSteps(tmp, cmdline, MEMORY_BYTES)) runTool(["fdtput", ...step]);
  const fb = new Uint8Array(readFileSync(tmp));
  fdtSize = u32be(fb, 4);
  if (fdtSize + FDT_HEADROOM > VENDOR_FDT_LIMIT)
    throw new Error(`fixed DTB is ${fdtSize} B; the vendor kernel limit is ${VENDOR_FDT_LIMIT} with ${FDT_HEADROOM} B kexec headroom`);
  // Read it back: a binary edit that "succeeded" is not an edit that landed.
  const mem = runTool(["fdtget", "-t", "x", tmp, "/memory", "reg"]).trim();
  const got = runTool(["fdtget", "-t", "s", tmp, "/chosen", "bootargs"]).trim();
  if (mem !== `0 ${MEMORY_BYTES.toString(16)}` || got !== cmdline) throw new Error(`fdtput read-back mismatch: reg="${mem}"`);
  fixed = entry("stock-android.dtb", fb);

  const env = existsSync(envImg) ? parseEnv(Buffer.from(readFileSync(envImg))) : null;
  const inflated = inflateKernel(zImage);
  // The raw Image is what stock-dis.py / stock-kallsyms.py read (virtual base 0xc0008000).
  if (inflated) w("vmlinux.bin", inflated.image);
  const kernel = inflated && { ...inflated, image: undefined, file: "vmlinux.bin" };

  const manifest = {
    generated: new Date().toISOString(),
    source: { file: input, bytes: img.length, sha256: sha256(img) },
    envCrcOk: env?.crcOk ?? null,
    android: {
      kernelAddr: ab.kernelAddr, ramdiskAddr: ab.ramdiskAddr, tagsAddr: ab.tagsAddr, pageSize: ab.pageSize,
      embeddedCmdline: ab.cmdline,
    },
    uImage: {
      name: ui.name, load: ui.load, entry: ui.entry, headerCrc: ui.headerCrc, dataCrc: ui.dataCrc,
    },
    zImage: {
      start: zi.start, end: zi.end, appendedDtbSupportInStub: zi.appendedDtbSupport, zreladdr: zi.zreladdr,
      strippedDtbBytes: zi.dtbSize,
    },
    kernel,
    cmdline: {
      stockProc: STOCK_PROC_CMDLINE, passed: cmdline,
      provenance: env ? cmdlineProvenance(STOCK_PROC_CMDLINE, env.vars) : null,
    },
    fdt: { stockBytes: dtb.length, fixedBytes: fdtSize, vendorLimit: VENDOR_FDT_LIMIT },
    files: {
      zImage: entry("zImage", zImage),
      "stock.dtb": entry("stock.dtb", dtb),
      "stock-android.dtb": fixed,
      "ramdisk.gz": entry("ramdisk.gz", ab.ramdisk),
      "cmdline.txt": entry("cmdline.txt", Buffer.from(cmdline + "\n")),
    },
  };
  w("manifest.json", JSON.stringify(manifest, null, 2) + "\n");
  w("SHA256SUMS", sha256sums(manifest.files));
  console.log(JSON.stringify(manifest, null, 2));
}

if (import.meta.main) await main(process.argv.slice(2));
