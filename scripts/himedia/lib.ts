import { join } from "node:path";
import { homedir } from "node:os";
/**
 * Shared facts and pure helpers for the HiMedia Q10 Pro (Hi3798CV200) Linux conversion.
 *
 * Everything here is deliberately pure and testable. The effectful scripts
 * (fetch-stock-firmware.ts, recon.ts, dump-emmc.ts) import from here.
 *
 * ref: docs/261009-sota-himedia-q10-pro-linux-summary.md
 * ref: docs/261010-himedia-q10-pro-linux-vs-android.md
 */

/** Large artifacts never enter the repo. */
export const WORK_ROOT = process.env.HIMEDIA_ROOT ?? join(homedir(), "himedia-q10-pro");

export const DEVICE = {
  model: "HiMedia Q10 Pro",
  soc: "Hi3798CV200",
  /** The reference board whose mainline support we inherit. */
  referenceBoard: "poplar",
  /** Android 7.0 is the hard ceiling for this SoC — see the linux-vs-android doc. */
  lastOfficialFirmware: "2.1.4",
  /** Vendor BSP kernel. Long off kernel.org's supported list (5.10-7.2 as of 2026-10). */
  vendorKernel: "4.4.35",
} as const;

/**
 * Stock firmware, as published by a third-party mirror.
 *
 * ⛔ The vendor's own site (himediatech.com) has an EXPIRED TLS CERTIFICATE and failed on
 * every fetch rung including a real browser, so mirrors are the only remaining source and
 * they rot. Archive early; verify by hash forever after.
 */
export const STOCK_FIRMWARE = {
  version: "2.1.4",
  android: "7.0",
  /** MEGA public link — the decryption key lives in the URL fragment, so keep it intact. */
  url: "https://mega.nz/file/ezIjBISJ#3oCyPhpk15OAjRXoSlxAuNGldsaDTSfGcAjKn9ElhYo",
  source: "https://androidpctv.com/firmware-himedia-q10-pro-rom/",
  /**
   * Unknown until the first successful download. Recorded then, and checked on every
   * later run — a mirror that silently serves different bytes is exactly the failure a
   * hash catches. Byte count is not a content check.
   */
  sha256: null as string | null,
} as const;

/**
 * The vendor's own documented restore procedure.
 * This is the reversibility guarantee the whole project rests on — but note that a
 * documented brick exists in which this path did NOT recover the box, so it is a
 * best-effort restore, never a proof of safety.
 */
export const RESTORE_PROCEDURE = [
  "Extract the downloaded archive to obtain `update.zip` — do NOT unzip update.zip itself.",
  "Copy `update.zip` to the ROOT folder of a FAT32 USB stick.",
  "Connect the stick to any USB port on the box.",
  "Hold the RESTORE button (rear pinhole, beside the DC jack).",
  "Power on the box while still holding RESTORE.",
  "The Android logo appears and the update proceeds; do not interrupt it.",
] as const;

/** Partitions worth dumping, in the order a HiSilicon STB lays them out. */
export const CRITICAL_PARTITIONS = [
  "fastboot",
  "bootargs",
  "kernel",
  "recovery",
  "baseparam",
  "logo",
  "trustedcore",
] as const;

export type ReconFact = { key: string; cmd: string; why: string };

/**
 * Read-only recon, step 1 of the plan. Every command here must be SAFE on a stock box:
 * no writes, no property sets, no reboots. A read must never be a write.
 */
export const RECON: ReconFact[] = [
  { key: "soc", cmd: "cat /proc/cpuinfo", why: "confirm Cortex-A53 and look for ARMv8 crypto extensions (aes/sha) — decides whether restic or a VPN role is sane" },
  { key: "kernel", cmd: "cat /proc/version", why: "vendor kernel version actually shipped" },
  { key: "cmdline", cmd: "cat /proc/cmdline", why: "blkdevparts gives the eMMC partition map without root" },
  { key: "partitions", cmd: "cat /proc/partitions", why: "block device sizes for the dump plan" },
  { key: "mounts", cmd: "cat /proc/mounts", why: "what is mounted where" },
  { key: "mtd", cmd: "cat /proc/mtd", why: "present on some HiSilicon layouts" },
  { key: "meminfo", cmd: "cat /proc/meminfo", why: "confirm the usable RAM after the media reservation" },
  { key: "props", cmd: "getprop", why: "build fingerprint, board revision, firmware version" },
  { key: "board", cmd: "getprop ro.product.board", why: "board name for the device tree" },
  { key: "fwver", cmd: "getprop ro.build.version.incremental", why: "exact stock firmware build" },
  { key: "sata", cmd: "ls -l /dev/block/", why: "is the SATA bay a native block device (sd*) or behind a USB bridge?" },
  { key: "scsi", cmd: "cat /proc/scsi/scsi", why: "a native AHCI link shows here; a USB bridge shows differently" },
  { key: "usb", cmd: "cat /sys/kernel/debug/usb/devices", why: "spot a USB-SATA bridge chip if one exists" },
  { key: "pcie", cmd: "ls -l /sys/bus/pci/devices/", why: "is Wi-Fi on PCIe? That lane conflicts with SATA on combphy1" },
  { key: "wifi", cmd: "getprop wifi.interface; ls -l /sys/class/net/", why: "Wi-Fi chip and bus" },
  { key: "root", cmd: "id", why: "do we already have root? Gates the eMMC dump." },
];

/** `cat /proc/cmdline` carries `blkdevparts=mmcblk0:1M(fastboot),...`. Parse it into a plan. */
export function parseBlkDevParts(cmdline: string): Array<{ name: string; size: string; device: string }> {
  const out: Array<{ name: string; size: string; device: string }> = [];
  const m = cmdline.match(/blkdevparts=([^\s]+)/);
  if (!m) return out;
  // Form: mmcblk0:1M(fastboot),1M(bootargs),8M(kernel),-(system)
  for (const group of m[1].split(";")) {
    const idx = group.indexOf(":");
    if (idx < 0) continue;
    const device = group.slice(0, idx);
    for (const part of group.slice(idx + 1).split(",")) {
      const pm = part.match(/^([^(]+)\(([^)]+)\)$/);
      if (pm) out.push({ device, size: pm[1], name: pm[2] });
    }
  }
  return out;
}

/**
 * `-` means "the rest of the device", so its size is not knowable from the cmdline alone.
 * Returning null rather than a guess matters: a fabricated size would make a dump look
 * complete when it had been truncated.
 */
export function partitionSizeBytes(size: string): number | null {
  const m = size.match(/^(\d+)([KMG])$/);
  if (!m) return null;
  const n = Number(m[1]);
  return n * { K: 1024, M: 1024 ** 2, G: 1024 ** 3 }[m[2] as "K" | "M" | "G"];
}

/** A dump is verified only when both ends agree on a hash. Size agreement is not verification. */
export function dumpVerdict(a: { bytes: number; sha256: string }, b: { bytes: number; sha256: string }):
  { ok: boolean; reason: string } {
  if (a.bytes !== b.bytes) return { ok: false, reason: `size mismatch: ${a.bytes} vs ${b.bytes}` };
  if (a.bytes === 0) return { ok: false, reason: "zero-length dump — a file that exists is not a file with content" };
  if (a.sha256 !== b.sha256) return { ok: false, reason: "sha256 mismatch — the copy is corrupt" };
  return { ok: true, reason: "size and sha256 agree on both ends" };
}
