/**
 * Guards on the CP15 decoder.
 *
 * ⛔ These matter more than they look. The conclusion "the stock boot chain contains NO CNTFRQ
 * write, therefore our AArch32 device tree must carry clock-frequency" rests entirely on this
 * decoder being right. A decoder that silently fails to recognise the encoding would report an
 * absence that is really a blind spot — and absence is exactly what the argument leans on.
 * So each vector below is computed by hand from the ARM ARM field layout, not from the code.
 *
 * MCR/MRC: cond(4) 1110 opc1(3) L CRn(4) Rt(4) coproc(4) opc2(3) 1 CRm(4)
 */
import { test, expect } from "bun:test";
import { decodeMcr, scan } from "./scan-cp15.ts";

test("MCR p15,0,r0,c14,c0,0 decodes as a CNTFRQ WRITE", () => {
  // E     E     0|0   E     0     F     000|1 0
  // cond  op    opc1L CRn   Rt    cp15  opc2  CRm
  const d = decodeMcr(0xee0e0f10)!;
  expect(d).not.toBeNull();
  expect(d.dir).toBe("write");
  expect(d.crn).toBe(14);
  expect(d.crm).toBe(0);
  expect(d.opc1).toBe(0);
  expect(d.opc2).toBe(0);
  expect(d.rt).toBe(0);
  expect(d.name).toContain("CNTFRQ");
});

test("MRC p15,0,r0,c14,c0,0 decodes as a CNTFRQ READ (L bit only)", () => {
  const d = decodeMcr(0xee1e0f10)!;
  expect(d.dir).toBe("read");
  expect(d.name).toContain("CNTFRQ");
});

test("the Rt field is decoded, not confused with the register pattern", () => {
  expect(decodeMcr(0xee0e3f10)!.rt).toBe(3);
  expect(decodeMcr(0xee0eaf10)!.rt).toBe(10);
  // Changing Rt must NOT change which register is addressed.
  expect(decodeMcr(0xee0eaf10)!.name).toContain("CNTFRQ");
});

test("SCTLR is distinguished from CNTFRQ", () => {
  const d = decodeMcr(0xee010f10)!;
  expect(d.crn).toBe(1);
  expect(d.name).toContain("SCTLR");
});

test("a non-CP15 coprocessor is rejected", () => {
  // coproc nibble 14 instead of 15 — a VFP/NEON access, not a system register.
  expect(decodeMcr(0xee0e0e10)).toBeNull();
});

test("the fixed bit-4 and the 0b1111 condition are enforced", () => {
  expect(decodeMcr(0xee0e0f00)).toBeNull();   // bit 4 clear => not MCR/MRC
  expect(decodeMcr(0xfe0e0f10)).toBeNull();   // cond 0b1111 is not a condition here
});

test("scan finds the encoding in BOTH instruction sets, at the right offset", () => {
  const buf = new Uint8Array(16);
  // ARM: little-endian word 0xEE0E0F10 at offset 4.
  buf.set([0x10, 0x0f, 0x0e, 0xee], 4);
  const arm = scan(buf).filter((h) => h.name.includes("CNTFRQ") && h.iset === "arm");
  expect(arm.length).toBe(1);
  expect(arm[0].offset).toBe(4);
  expect(arm[0].dir).toBe("write");

  // Thumb-2: the same word stored as two LE halfwords, i.e. halves swapped.
  const t = new Uint8Array(16);
  t.set([0x0e, 0xee, 0x10, 0x0f], 8);
  const th = scan(t).filter((h) => h.name.includes("CNTFRQ") && h.iset === "thumb");
  expect(th.length).toBe(1);
  expect(th[0].offset).toBe(8);
});

test("an empty or all-zero buffer yields nothing (no false positives on padding)", () => {
  expect(scan(new Uint8Array(0)).length).toBe(0);
  expect(scan(new Uint8Array(4096)).length).toBe(0);
});
