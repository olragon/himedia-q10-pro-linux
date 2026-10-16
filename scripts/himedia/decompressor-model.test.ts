/**
 * Guards on the decompressor placement model.
 *
 * ⛔ A model that cannot explain the WORKING case explains nothing. The vendor's 3.18 image
 * boots on this exact hardware, so the model must put it on the in-place path with a wide
 * margin — otherwise it is not modelling the thing we think it is.
 */
import { test, expect } from "bun:test";
import { model, TEXT_OFFSET, AUTO_ZRELADDR_MASK } from "./decompressor-model.ts";

const base = {
  loadAddr: 0x2000000,
  zImageSize: 12_984_832,
  inflatedSize: 31_942_040,
  wontOverwriteOffset: 0x600,
  dtbSize: 13_576,
};

test("AUTO_ZRELADDR derives the RAM base from the load address, not the device tree", () => {
  // 0x02000000 & 0xf8000000 == 0, so the kernel lands at TEXT_OFFSET.
  expect(model(base).zreladdr).toBe(TEXT_OFFSET);
  // A load address inside a higher 128 MiB bank would move it — the mask is what matters.
  expect(model({ ...base, loadAddr: 0xf8000000 }).zreladdr).toBe(0xf8000000 + TEXT_OFFSET);
  expect(AUTO_ZRELADDR_MASK).toBe(0xf8000000);
});

test("our real image takes the IN-PLACE path, on a thin margin", () => {
  const v = model(base);
  expect(v.check1).toBe(false);              // the kernel lands far below the image
  expect(v.check2).toBe(true);               // ...and ends below the running code
  expect(v.relocates).toBe(false);
  expect(v.kernelEnd).toBe(0x1e7e598);
  expect(v.marginBytes).toBe(0x2000000 - 0x1e7e598);
  expect(v.warnings.join(" ")).toContain("only 1.5 MiB");
});

test("the VENDOR image, which works on this box, is also in-place but with 22 MiB spare", () => {
  const v = model({ ...base, zImageSize: 9_118_467, inflatedSize: 10 << 20, dtbSize: 0 });
  expect(v.relocates).toBe(false);
  expect(v.check2).toBe(true);
  expect(v.marginBytes).toBeGreaterThan(20 << 20);
  expect(v.warnings).toEqual([]);            // no thin-margin alarm for the working case
});

test("growing the kernel past the load address flips check 2 and forces relocation", () => {
  const v = model({ ...base, inflatedSize: 34 << 20 });
  expect(v.check2).toBe(false);
  expect(v.relocates).toBe(true);
  expect(v.marginBytes).toBeLessThan(0);
  expect(v.warnings.join(" ")).toContain("RELOCATION PATH");
});

test("raising the load address buys margin without moving the kernel", () => {
  const hi = model({ ...base, loadAddr: 0x4000000 });
  expect(hi.zreladdr).toBe(TEXT_OFFSET);     // ⭐ unchanged: 0x04000000 & 0xf8000000 is still 0
  expect(hi.marginBytes).toBeGreaterThan(33 << 20);
  expect(hi.warnings).toEqual([]);
});

test("the appended DTB grows the image end, which can only make check 1 harder", () => {
  const withDtb = model(base);
  const without = model({ ...base, dtbSize: 0 });
  expect(withDtb.check1).toBe(false);
  expect(without.check1).toBe(false);
  // The dtb does not move the kernel, so check 2 and the margin are unaffected.
  expect(withDtb.marginBytes).toBe(without.marginBytes);
});

test("the 16k page directory sits below the kernel and must fit", () => {
  expect(model(base).pgdir).toBe(TEXT_OFFSET - 0x4000);
  expect(model({ ...base, loadAddr: 0 }).warnings.join(" ")).not.toContain("page directory");
});
