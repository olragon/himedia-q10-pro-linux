#!/usr/bin/env bun
/**
 * Simulate the box's boot decision tree offline, and verify the uImage U-Boot will NOT verify.
 *
 * ⛔ The finding that makes this necessary: the stock environment sets **`verify = n`**, so
 * `bootm` does NOT check the uImage header or data CRC. A truncated or corrupt image on the
 * USB stick is therefore JUMPED INTO rather than rejected — a bad flash does **not** fail safe
 * to Android, it hangs at the vendor logo and looks exactly like a kernel that booted and died.
 * Nothing on the box can tell those apart. So the CRC check has to happen here, before the
 * stick is ever carried to the box.
 *
 * It also models the fallback chain, because the ordering of that chain already caused one real
 * failure: putting the USB stage ahead of the TrustedCore load broke both the stock kernel and
 * ours (no PSCI provider). A chain is a program; read it as one.
 *
 * ⚠️ This is a MODEL of U-Boot's behaviour, not U-Boot. It cannot predict what the hardware
 * does; it checks that our commands are well-formed, that their sector offsets name real
 * partitions, and that the image we are about to boot is intact.
 *
 * Usage:
 *   bun run himedia:simulate                      # stock env + our built uImage
 *   bun run himedia:simulate --uimage <path> --env <bootargs.img>
 */
import { readFileSync, existsSync } from "node:fs";
import { WORK_ROOT } from "./lib.ts";

const DUMP = `${WORK_ROOT}/emmc-dump`;

// ---------- pure helpers ----------

export type Part = { name: string; startSector: number; sizeBytes: number };

/** Parse a HiSilicon `blkdevparts=mmcblk0:1M(fastboot),...` spec into absolute offsets. */
export function parseBlkdevparts(spec: string): Part[] {
  const body = spec.replace(/^.*?mmcblk0:/, "");
  const out: Part[] = [];
  let off = 0;
  for (const m of body.matchAll(/(\d+|-)([MK])?\((\w+)\)/g)) {
    // `-` means "the rest of the device" and has no computable size.
    const size = m[1] === "-" ? -1 : Number(m[1]) * (m[2] === "K" ? 1024 : 1024 * 1024);
    out.push({ name: m[3], startSector: off / 512, sizeBytes: size });
    if (size < 0) break;
    off += size;
  }
  return out;
}

/** Read a U-Boot environment block: LE CRC32 prefix, then NUL-separated key=value. */
export function parseEnv(buf: Uint8Array, block = 0x10000): { env: Record<string, string>; crcOk: boolean } {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const stored = dv.getUint32(0, true);
  const body = buf.subarray(4, block);
  const crcOk = crc32(body) === stored;
  const env: Record<string, string> = {};
  for (const chunk of Buffer.from(body).toString("latin1").split("\0")) {
    if (!chunk) break;
    const i = chunk.indexOf("=");
    if (i > 0) env[chunk.slice(0, i)] = chunk.slice(i + 1);
  }
  return { env, crcOk };
}

let TBL: number[] | null = null;
export function crc32(b: Uint8Array): number {
  if (!TBL) {
    TBL = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TBL[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = TBL[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export type UImage = {
  magicOk: boolean; hcrcOk: boolean; dcrcOk: boolean;
  size: number; actualDataLen: number; load: number; ep: number;
  os: number; arch: number; type: number; comp: number; name: string;
};

/**
 * Verify a uImage the way `bootm` would if `verify` were `y`.
 *
 * Header is 64 bytes BIG-endian: magic, hcrc, time, size, load, ep, dcrc, os, arch, type,
 * comp, name[32]. The header CRC is computed with the hcrc field itself zeroed.
 */
export function readUImage(buf: Uint8Array): UImage {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const magicOk = dv.getUint32(0, false) === 0x27051956;
  const hcrc = dv.getUint32(4, false);
  const size = dv.getUint32(12, false);
  const dcrc = dv.getUint32(24, false);

  const hdr = new Uint8Array(64);
  hdr.set(buf.subarray(0, 64));
  hdr[4] = hdr[5] = hdr[6] = hdr[7] = 0;              // zero hcrc before hashing
  const data = buf.subarray(64, 64 + size);

  return {
    magicOk,
    hcrcOk: crc32(hdr) === hcrc,
    dcrcOk: data.length === size && crc32(data) === dcrc,
    size, actualDataLen: buf.length - 64,
    load: dv.getUint32(16, false), ep: dv.getUint32(20, false),
    os: buf[28], arch: buf[29], type: buf[30], comp: buf[31],
    name: Buffer.from(buf.subarray(32, 64)).toString("latin1").replace(/\0.*$/, ""),
  };
}

export type Stage =
  | { kind: "mmc-read"; sector: number; count: number; addr: number; part?: string; raw: string }
  | { kind: "fatload"; file: string; addr: number; raw: string }
  | { kind: "bootm"; addr: number; raw: string }
  | { kind: "other"; raw: string };

/** Split a bootcmd into stages and resolve each `mmc read` sector to a partition name. */
export function parseBootcmd(cmd: string, parts: Part[]): Stage[] {
  return cmd.split(";").map((s) => s.trim()).filter(Boolean).map((raw): Stage => {
    let m = raw.match(/^mmc\s+read\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)$/);
    if (m) {
      const sector = Number(m[3]);
      return {
        kind: "mmc-read", addr: Number(m[2]), sector, count: Number(m[4]),
        part: parts.find((p) => p.startSector === sector)?.name, raw,
      };
    }
    m = raw.match(/^fatload\s+usb\s+\S+\s+(\S+)\s+(\S+)$/);
    if (m) return { kind: "fatload", addr: Number(m[1]), file: m[2], raw };
    m = raw.match(/^bootm\s+(\S+)$/);
    if (m) return { kind: "bootm", addr: Number(m[1]), raw };
    return { kind: "other", raw };
  });
}

const ARCH: Record<number, string> = { 2: "ARM (32-bit)", 22: "ARM64" };
const COMP: Record<number, string> = { 0: "none", 1: "gzip", 2: "bzip2" };

// ---------- the report ----------

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const pick = (f: string, d: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const envPath = pick("--env", `${DUMP}/bootargs.patched.img`);
  const uiPath = pick("--uimage", `${WORK_ROOT}/kernel-build-arm32/uImage`);

  if (!existsSync(envPath)) { console.error(`no env image at ${envPath}`); process.exit(2); }
  const { env, crcOk } = parseEnv(readFileSync(envPath));

  console.log(`[local] env ${envPath}`);
  console.log(`  CRC over the 64 KiB block: ${crcOk ? "VALID" : "INVALID"}`);
  if (!crcOk) {
    console.log(`  ⛔ U-Boot discards an env with a bad CRC and uses its COMPILED-IN defaults,`);
    console.log(`     silently. Android then boots and it looks like the stick was ignored.`);
  }
  console.log(`  verify = ${env.verify ?? "(unset)"}  bootdelay = ${env.bootdelay ?? "(unset)"}`);
  if ((env.verify ?? "").trim() === "n") {
    console.log(`  ⛔ verify=n: bootm does NOT check the uImage CRC. A corrupt image is EXECUTED,`);
    console.log(`     not rejected — so a bad flash does not fall through to Android. It hangs.`);
  }

  const parts = parseBlkdevparts(env.bootargs ?? "");
  console.log(`\n[local] ${parts.length} partitions parsed from blkdevparts`);

  const stages = parseBootcmd(env.bootcmd ?? "", parts);
  console.log(`\n--- boot chain (${stages.length} stages) ---`);
  let bootmSeen = 0;
  for (const [i, s] of stages.entries()) {
    const n = `${i + 1}`.padStart(2);
    if (s.kind === "mmc-read") {
      const mib = (s.count * 512) / (1024 * 1024);
      console.log(`  ${n}. mmc read  sector 0x${s.sector.toString(16)} (${mib} MiB) -> 0x${s.addr.toString(16)}`);
      console.log(`      partition: ${s.part ?? "⛔ NO PARTITION STARTS AT THIS SECTOR"}`);
    } else if (s.kind === "fatload") {
      console.log(`  ${n}. fatload  usb 0:1 '${s.file}' -> 0x${s.addr.toString(16)}`);
      console.log(`      on failure (no stick, no FAT32, no such file): continues to the next stage`);
    } else if (s.kind === "bootm") {
      bootmSeen++;
      console.log(`  ${n}. bootm    0x${s.addr.toString(16)}`);
      console.log(`      a TEE/secure payload RETURNS here; a Linux kernel never does`);
    } else {
      console.log(`  ${n}. ${s.raw}`);
    }
  }

  // ⛔ The ordering invariant that already cost one real failure.
  const firstMmc = stages.findIndex((s) => s.kind === "mmc-read" && s.part === "trustedcore");
  const firstUsb = stages.findIndex((s) => s.kind === "fatload");
  console.log(`\n--- ordering invariant ---`);
  if (firstMmc === -1) {
    console.log(`  ⛔ no TrustedCore load in this chain. The stock kernel needs it, and our`);
    console.log(`     kernel has no PSCI provider without it. Both break.`);
  } else if (firstUsb !== -1 && firstUsb < firstMmc) {
    console.log(`  ⛔ the USB stage (${firstUsb + 1}) runs BEFORE TrustedCore (${firstMmc + 1}). This is the`);
    console.log(`     bug that broke the stock kernel (Android UI then hang) and ours.`);
    process.exitCode = 1;
  } else {
    console.log(`  ok  TrustedCore (stage ${firstMmc + 1}) runs before the USB stage (stage ${firstUsb + 1 || "-"}).`);
  }

  // ---------- the uImage U-Boot will not check ----------
  console.log(`\n--- uImage ${uiPath} ---`);
  if (!existsSync(uiPath)) {
    console.log(`  (absent — nothing to verify)`);
  } else {
    const u = readUImage(readFileSync(uiPath));
    const row = (ok: boolean, s: string) => console.log(`  ${ok ? "ok " : "⛔ "} ${s}`);
    row(u.magicOk, `magic 0x27051956`);
    row(u.hcrcOk, `header CRC`);
    row(u.dcrcOk, `data CRC over ${u.size} bytes (file carries ${u.actualDataLen})`);
    row(u.arch === 2, `arch = ${u.arch} ${ARCH[u.arch] ?? "?"} — the loader is 32-bit and checks this`);
    row(true, `comp = ${u.comp} (${COMP[u.comp] ?? "?"}), load 0x${u.load.toString(16)}, entry 0x${u.ep.toString(16)}`);
    row(true, `name "${u.name}"`);
    if (!u.dcrcOk) {
      console.log(`\n  ⛔ DATA CRC FAILED. Do NOT boot this. With verify=n the box would execute it`);
      console.log(`     anyway and hang at the logo, which is indistinguishable from a kernel bug.`);
      process.exitCode = 1;
    }
    if (u.arch !== 2) {
      console.log(`\n  ⛔ arch is not 2. bootm will refuse it and fall through to Android.`);
      process.exitCode = 1;
    }
  }
}
