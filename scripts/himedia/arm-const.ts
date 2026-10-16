#!/usr/bin/env bun
/**
 * Find 32-bit constants materialised by ARM code, whatever encoding the compiler chose.
 *
 * ⛔ Why this exists. Verifying a checkpoint by searching for `movw`+`movt` of its load value
 * reported MISS for all five C checkpoints on 2026-10-10, and the image was fine — GCC had
 * built the low half with `mov rD, #<rotated imm8>` instead of `movw`. Hand-written searches
 * keep assuming one encoding; ARM has three, and the compiler picks per constant:
 *
 *   1. mov  rD, #imm12   where imm12 = (rot<<8)|imm8  =>  imm8 ror (2*rot)
 *   2. movw rD, #imm16
 *   3. a literal-pool word loaded with `ldr rD, [pc, #n]`
 *
 * A near-miss here is expensive: it reads as "the checkpoint is not in the image", which
 * invites a rebuild of something that was already correct, or — worse — a flash of an image
 * believed to be instrumented when it is not.
 */

/** Decode an ARM data-processing immediate (imm8 rotated right by 2*rot). */
export function decodeArmImm12(imm12: number): number {
  const rot = (imm12 >> 8) & 0xf;
  const imm8 = imm12 & 0xff;
  const s = 2 * rot;
  return s === 0 ? imm8 : (((imm8 >>> s) | (imm8 << (32 - s))) >>> 0);
}

export type Materialised = { offset: number; rd: number; value: number };

/**
 * Collect every constant built as a (low-half, movt) pair. Both `mov rD,#imm` and
 * `movw rD,#imm16` count as the low half, and the `movt` must target the same register and
 * follow within `window` bytes — adjacency alone is too strict once the scheduler moves things.
 */
export function findMovtPairs(buf: Uint8Array, window = 24): Materialised[] {
  const out: Materialised[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const word = (i: number) => dv.getUint32(i, true);
  for (let i = 0; i + 4 <= buf.length - 4; i += 4) {
    const w = word(i);
    let rd = -1, lo = -1;
    if ((w & 0x0ff00000) === 0x03000000) {            // movw
      rd = (w >> 12) & 0xf;
      lo = (((w >> 4) & 0xf000) | (w & 0xfff)) >>> 0;
    } else if ((w & 0x0fef0000) === 0x03a00000) {     // mov (immediate)
      rd = (w >> 12) & 0xf;
      lo = decodeArmImm12(w & 0xfff);
      if (lo > 0xffff) continue;                       // not a low half
    } else continue;
    for (let j = i + 4; j < Math.min(i + 4 + window, buf.length - 3); j += 4) {
      const v = word(j);
      if ((v & 0x0ff00000) !== 0x03400000) continue;   // movt
      if (((v >> 12) & 0xf) !== rd) continue;
      const hi = (((v >> 4) & 0xf000) | (v & 0xfff)) >>> 0;
      out.push({ offset: i, rd, value: (((hi << 16) >>> 0) + lo) >>> 0 });
      break;
    }
  }
  return out;
}

/** Every way a constant can appear: a movt pair, or a literal-pool word. */
export function constantPresent(buf: Uint8Array, value: number, pairs?: Materialised[]): boolean {
  if ((pairs ?? findMovtPairs(buf)).some((p) => p.value === (value >>> 0))) return true;
  const le = new Uint8Array(4);
  new DataView(le.buffer).setUint32(0, value >>> 0, true);
  outer: for (let i = 0; i + 4 <= buf.length; i++) {
    for (let k = 0; k < 4; k++) if (buf[i + k] !== le[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * Thumb-2 ThumbExpandImm: the Thumb analogue of ARM's rotated imm12, and the form GCC chose
 * for the load value (`mov.w r1, #0x2600`). Top two bits zero selects four byte-replication
 * patterns; otherwise it is an 8-bit value with its MSB forced set, rotated right.
 */
export function thumbExpandImm(imm12: number): number {
  if ((imm12 & 0xc00) === 0) {
    const b = imm12 & 0xff;
    switch ((imm12 >> 8) & 3) {
      case 0: return b;
      case 1: return ((b << 16) | b) >>> 0;
      case 2: return ((b << 24) | (b << 8)) >>> 0;
      default: return ((b << 24) | (b << 16) | (b << 8) | b) >>> 0;
    }
  }
  const v = 0x80 | (imm12 & 0x7f);
  const r = (imm12 >> 7) & 0x1f;
  return (((v >>> r) | (v << (32 - r))) >>> 0);
}

/**
 * Thumb-2 MOVW (T3) / MOVT (T1). Both are two halfwords:
 *
 *   hw1 = 0xF240 | (i << 10) | imm4      (MOVW)   0xF2C0 | ... (MOVT)
 *   hw2 = (imm3 << 12) | (Rd << 8) | imm8
 *   imm16 = imm4:i:imm3:imm8
 *
 * ⚠️ Halfword-aligned, not word-aligned — Thumb instructions are 2 or 4 bytes, so a scan that
 * steps 4 misses half of them.
 */
export function findThumbMovtPairs(buf: Uint8Array, window = 24): Materialised[] {
  const out: Materialised[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hw = (i: number) => dv.getUint16(i, true);
  const imm16 = (a: number, b: number) =>
    ((((a & 0xf) << 12) | (((a >> 10) & 1) << 11) | (((b >> 12) & 7) << 8) | (b & 0xff)) >>> 0);
  for (let i = 0; i + 8 <= buf.length; i += 2) {
    const a = hw(i);
    const b = hw(i + 2);
    let rd: number, lo: number;
    if ((a & 0xfbf0) === 0xf240) {                    // MOVW T3
      rd = (b >> 8) & 0xf;
      lo = imm16(a, b);
    } else if ((a & 0xfbef) === 0xf04f) {             // MOV.W T2 (immediate)
      rd = (b >> 8) & 0xf;
      lo = thumbExpandImm((((a >> 10) & 1) << 11) | (((b >> 12) & 7) << 8) | (b & 0xff));
      if (lo > 0xffff) continue;                      // not usable as a low half
    } else continue;
    for (let j = i + 4; j + 4 <= Math.min(i + 4 + window, buf.length); j += 2) {
      const c = hw(j);
      if ((c & 0xfbf0) !== 0xf2c0) continue;          // MOVT T1
      const d = hw(j + 2);
      if (((d >> 8) & 0xf) !== rd) continue;
      out.push({ offset: i, rd, value: ((((imm16(c, d) << 16) >>> 0) + lo) >>> 0) });
      break;
    }
  }
  return out;
}

/**
 * Is `value` materialised anywhere, by any of the encodings, in either instruction set?
 * Use this rather than `constantPresent` when the target's instruction set is not known —
 * a static userspace binary and the kernel in the same image do not have to agree.
 */
export function constantPresentAnyISA(buf: Uint8Array, value: number): boolean {
  return constantPresent(buf, value) ||
    findThumbMovtPairs(buf).some((p) => p.value === (value >>> 0));
}
