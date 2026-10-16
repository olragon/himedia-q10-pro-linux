import { test, expect } from "bun:test";
import { decodeArmImm12, findMovtPairs, findThumbMovtPairs, thumbExpandImm, constantPresent, constantPresentAnyISA } from "./arm-const.ts";

const w = (...ws: number[]) => {
  const b = new Uint8Array(ws.length * 4 + 8);
  const dv = new DataView(b.buffer);
  ws.forEach((x, i) => dv.setUint32(i * 4, x >>> 0, true));
  return b;
};

/*
 * ⛔ These are the exact bytes read out of init/main.o on 2026-10-10, the ones a movw-only
 * search declared missing. 0x03 ror 18 == 0xC000 and 0x6e ror 24 == 0x6E00.
 */
test("decodes the rotated-immediate form GCC actually emitted", () => {
  expect(decodeArmImm12(0x903)).toBe(0xc000);
  expect(decodeArmImm12(0xc6e)).toBe(0x6e00);
  expect(decodeArmImm12(0x003)).toBe(3);        // rot 0 is the identity
});

test("finds the SP805 base built as mov+movt", () => {
  const pairs = findMovtPairs(w(0xe3a04903, 0xe34f48a2));
  expect(pairs.some((p) => p.value === 0xf8a2c000)).toBe(true);
});

test("finds a constant built as movw+movt", () => {
  const pairs = findMovtPairs(w(0xe30e7551, 0xe3417acc));
  expect(pairs.some((p) => p.value === 0x1acce551)).toBe(true);
});

test("finds checkpoint K's load value, which a movw-only search missed", () => {
  // mov r3,#0xc6e ; movt r3,#0x1e0a  ->  0x1E0A6E00 == 21s * 24MHz
  expect(constantPresent(w(0xe3a03c6e, 0xe3413e0a), 21 * 24_000_000)).toBe(true);
});

test("a movt for a DIFFERENT register does not count", () => {
  //                 mov r3,#0xc6e   movt r4,#0x1e0a
  const pairs = findMovtPairs(w(0xe3a03c6e, 0xe3414e0a));
  expect(pairs.some((p) => p.value === 0x1e0a6e00)).toBe(false);
});

test("a literal-pool word counts as present", () => {
  expect(constantPresent(w(0xdeadbeef, 504_000_000), 504_000_000)).toBe(true);
});

test("an absent constant is reported absent", () => {
  expect(constantPresent(w(0xe3a03c6e, 0xe3413e0a), 999_999_999)).toBe(false);
});

/*
 * ⛔ These are the exact halfwords llvm-objdump showed in the initramfs's PID 1 on
 * 2026-10-10, which an ARM-only scan declared missing. The binary is Thumb-2 while the
 * kernel in the same image is ARM.
 */
const hw = (...hs: number[]) => {
  const b = new Uint8Array(hs.length * 2 + 8);
  const dv = new DataView(b.buffer);
  hs.forEach((x, i) => dv.setUint16(i * 2, x & 0xffff, true));
  return b;
};

test("decodes the Thumb-2 unlock constant PID 1 actually uses", () => {
  // f24e 5551  movw r5,#0xe551   /   f6c1 25cc  movt r5,#0x1acc
  const p = findThumbMovtPairs(hw(0xf24e, 0x5551, 0xf6c1, 0x25cc));
  expect(p.some((x) => x.value === 0x1acce551 && x.rd === 5)).toBe(true);
});

test("a Thumb-2 constant is invisible to the ARM scan, and that was the bug", () => {
  const b = hw(0xf24e, 0x5551, 0xf6c1, 0x25cc);
  expect(constantPresent(b, 0x1acce551)).toBe(false);      // the false negative
  expect(constantPresentAnyISA(b, 0x1acce551)).toBe(true); // the fix
});

test("a Thumb-2 movt for a different register does not count", () => {
  //                        movt r6,#0x1acc
  const p = findThumbMovtPairs(hw(0xf24e, 0x5551, 0xf6c1, 0x26cc));
  expect(p.some((x) => x.value === 0x1acce551)).toBe(false);
});

test("constantPresentAnyISA still finds ARM-encoded constants", () => {
  const b = new Uint8Array(16);
  new DataView(b.buffer).setUint32(0, 0xe3a03c6e, true);
  new DataView(b.buffer).setUint32(4, 0xe3413e0a, true);
  expect(constantPresentAnyISA(b, 21 * 24_000_000)).toBe(true);
});

test("decodes ThumbExpandImm, the form GCC used for the load value", () => {
  // f44f 5118 = mov.w r1,#0x2600 -> imm12 0xD18 -> ROR(0x98, 26) = 0x2600
  expect(thumbExpandImm(0xd18)).toBe(0x2600);
  expect(thumbExpandImm(0x018)).toBe(0x18);          // top bits zero: plain byte
});

test("finds R's load value, built as MOV.W + MOVT", () => {
  // f44f 5118  mov.w r1,#0x2600  /  f2c9 6134  movt r1,#0x9634  -> 105s * 24MHz
  const b = hw(0xf44f, 0x5118, 0xf2c9, 0x6134);
  expect(constantPresentAnyISA(b, 105 * 24_000_000)).toBe(true);
  expect(constantPresent(b, 105 * 24_000_000)).toBe(false);   // ARM-only scan: the bug
});
