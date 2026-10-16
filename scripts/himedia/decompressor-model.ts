#!/usr/bin/env bun
import { WORK_ROOT } from "./lib";
/**
 * Model the ARM zImage decompressor's placement decision offline, with the real numbers.
 *
 * ⭐ Why this is worth a script: the hang is INSIDE the decompressor (measured — checkpoint A
 * fires at ~22 s, stext never does), and the decompressor's overwrite/relocation decision is
 * PURE ARITHMETIC over the image size, the load address and the memory layout. So it can be
 * computed here instead of guessed at, and compared against the vendor image that demonstrably
 * works on this exact SoC.
 *
 * The logic being modelled, verbatim from arch/arm/boot/compressed/head.S:
 *
 *   r4  = final kernel address (zreladdr)
 *   r9  = size of the DECOMPRESSED image
 *   r10 = end of this image, including bss/stack/malloc
 *
 *     add r10, r10, #16384
 *     cmp r4, r10
 *     bhs wont_overwrite          @ (1) r4 >= r10 + 16k            -> OK
 *     add r10, r4, r9
 *     adr r9, wont_overwrite
 *     cmp r10, r9
 *     bls wont_overwrite          @ (2) r4 + r9 <= &wont_overwrite -> OK
 *     ...relocate past the decompressed kernel, then restart
 *
 * ⚠️ This models the DECISION, not the execution. It cannot prove the decompression succeeds;
 * it tells us which path is taken and how much room that path leaves.
 */

export const TEXT_OFFSET = 0x8000;
/** Mask used by CONFIG_AUTO_ZRELADDR to derive the RAM base from the running pc. */
export const AUTO_ZRELADDR_MASK = 0xf8000000;
export const MALLOC_SIZE = 0x10000;   // 64k, per MALLOC_SIZE in the decompressor
export const PGDIR_SIZE = 0x4000;     // the 16k page directory __setup_mmu puts below r4

export type Inputs = {
  /** Where the bootloader puts the zImage (uImage `load`). */
  loadAddr: number;
  /** Size of the zImage, INCLUDING any appended DTB. */
  zImageSize: number;
  /** Size of the decompressed kernel, i.e. arch/arm/boot/Image. */
  inflatedSize: number;
  /** Runtime offset of the `wont_overwrite` label within the zImage. */
  wontOverwriteOffset: number;
  /** Size of the appended DTB, 8-byte aligned, or 0. */
  dtbSize?: number;
};

export type Verdict = {
  /** r4 — where the kernel will be decompressed to. */
  zreladdr: number;
  /** r9 */
  inflated: number;
  /** The decompressed kernel's last byte. */
  kernelEnd: number;
  /** Address of the page directory cache_on will build. */
  pgdir: number;
  check1: boolean;
  check2: boolean;
  relocates: boolean;
  /** Gap between the end of the decompressed kernel and the running zImage. */
  marginBytes: number;
  /** Where a relocation would copy this image to. */
  relocTarget: number;
  warnings: string[];
};

export function model(i: Inputs): Verdict {
  const dtb = i.dtbSize ?? 0;
  /*
   * AUTO_ZRELADDR: the RAM base comes from the running pc, not from the device tree.
   * ⚠️ `>>> 0` is load-bearing. JavaScript's `&` operates on SIGNED int32, so a load address
   * at or above 0x80000000 comes back NEGATIVE and every downstream comparison silently
   * inverts. This board loads at 0x2000000 so it never bit us here, but a model that is wrong
   * for half the address space is a model that cannot be trusted for the other half.
   */
  const zreladdr = ((i.loadAddr & AUTO_ZRELADDR_MASK) >>> 0) + TEXT_OFFSET;
  const kernelEnd = zreladdr + i.inflatedSize;

  // r10 = end of image + malloc, grown by the appended dtb size, then +16k.
  const imageEnd = i.loadAddr + i.zImageSize + MALLOC_SIZE + dtb;
  const check1 = zreladdr >= imageEnd + 16384;
  const check2 = kernelEnd <= i.loadAddr + i.wontOverwriteOffset;
  const relocates = !check1 && !check2;

  const warnings: string[] = [];
  const margin = i.loadAddr - kernelEnd;
  if (!check1 && margin > 0 && margin < 4 << 20) {
    warnings.push(
      `only ${(margin / 1048576).toFixed(1)} MiB between the end of the decompressed kernel ` +
      `(0x${kernelEnd.toString(16)}) and the running zImage (0x${i.loadAddr.toString(16)}). ` +
      `Check 2 passes on a thin margin that shrinks every time the kernel or initramfs grows.`);
  }
  if (margin <= 0) {
    warnings.push(
      `the decompressed kernel would REACH PAST the load address — check 2 fails and the ` +
      `decompressor must relocate itself first.`);
  }
  if (relocates) {
    warnings.push(
      `RELOCATION PATH: this image copies itself to 0x${kernelEnd.toString(16)} and restarts. ` +
      `That path is exercised far less than the in-place one.`);
  }
  if (zreladdr < PGDIR_SIZE) {
    warnings.push(`zreladdr 0x${zreladdr.toString(16)} leaves no room for the 16k page directory.`);
  }
  return {
    zreladdr, inflated: i.inflatedSize, kernelEnd,
    pgdir: zreladdr - PGDIR_SIZE,
    check1, check2, relocates, marginBytes: margin,
    relocTarget: kernelEnd, warnings,
  };
}

const MiB = (n: number) => `${(n / 1048576).toFixed(1)} MiB`;
const H = (n: number) => `0x${(n >>> 0).toString(16)}`;

export function report(name: string, i: Inputs): string {
  const v = model(i);
  const L: string[] = [`=== ${name}`];
  L.push(`  load 0x${i.loadAddr.toString(16)}  zImage ${MiB(i.zImageSize)}  inflated ${MiB(i.inflatedSize)}`);
  L.push(`  zreladdr (r4)       ${H(v.zreladdr)}   page dir at ${H(v.pgdir)}`);
  L.push(`  decompressed kernel ${H(v.zreladdr)} .. ${H(v.kernelEnd)}  (${MiB(v.inflated)})`);
  L.push(`  running zImage      ${H(i.loadAddr)} .. ${H(i.loadAddr + i.zImageSize)}`);
  L.push(`  check 1 (r4 above the image)      ${v.check1 ? "pass" : "fail"}`);
  L.push(`  check 2 (kernel ends below code)  ${v.check2 ? "pass" : "fail"}` +
    (v.check2 ? `  by ${MiB(v.marginBytes)}` : ""));
  L.push(`  => ${v.relocates ? "RELOCATES, then restarts" : "decompresses IN PLACE, no relocation"}`);
  for (const w of v.warnings) L.push(`  ⚠️  ${w}`);
  return L.join("\n");
}

if (import.meta.main) {
  const { statSync, existsSync } = await import("node:fs");
  const K = `${WORK_ROOT}/kernel-build-arm32/linux-6.18.55/arch/arm/boot`;
  const sz = (p: string) => (existsSync(p) ? statSync(p).size : 0);

  // ⚠️ wont_overwrite sits early in the decompressor; 0x600 is a conservative UNDER-estimate,
  // which makes check 2 harder to pass, never easier. Reading the real symbol would only widen
  // the margin, so an alarm raised here is not an artefact of the estimate.
  const WO = 0x600;

  console.log(report("OURS (multi_v7_defconfig + embedded initramfs)", {
    loadAddr: 0x2000000,
    zImageSize: sz(`${K}/zImage`),
    inflatedSize: sz(`${K}/Image`),
    wontOverwriteOffset: WO,
    dtbSize: 13576,
  }));

  console.log();
  // The vendor image works on this hardware, so its numbers are the reference.
  // Its inflated size is not directly available; 3.18 with vendor drivers is ~10 MiB and the
  // conclusion does not turn on the exact figure.
  console.log(report("VENDOR 3.18.24 (works on this box)", {
    loadAddr: 0x2000000,
    zImageSize: 9118467,
    inflatedSize: 10 << 20,
    wontOverwriteOffset: WO,
  }));

  console.log();
  console.log("--- what shrinking the kernel buys ---");
  for (const mb of [20, 12, 8]) {
    const v = model({
      loadAddr: 0x2000000, zImageSize: sz(`${K}/zImage`),
      inflatedSize: mb << 20, wontOverwriteOffset: WO, dtbSize: 13576,
    });
    console.log(`  inflated ${String(mb).padStart(2)} MiB -> margin ${MiB(v.marginBytes).padStart(9)}` +
      `  check2 ${v.check2 ? "pass" : "FAIL"}`);
  }
}
