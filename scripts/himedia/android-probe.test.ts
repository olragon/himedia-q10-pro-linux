import { test, expect } from "bun:test";
import { READS, reg } from "./android-probe.ts";

/* ⛔ The probe reads a working system we must not disturb: no writes, no eMMC, ever. */
test("every android-probe command is a read", () => {
  const banned = /\b(dd\s+of=|of=\/dev|>\s*\/(?!dev\/null)|\brm\b|\bmv\b|\bcp\b|\bsetprop\b|\breboot\b|\bmkfs|\bwrite\b|echo\s+[^"]*>\s*\/sys|devmem\s+\S+\s+\d+\s+\S+)/;
  for (const [section, , cmd] of READS) expect({ section, bad: banned.test(cmd) }).toEqual({ section, bad: false });
});

test("register reads go through dd if=/dev/mem with a word-aligned skip", () => {
  expect(reg(0xf8a2012c)).toBe(`dd if=/dev/mem bs=4 count=1 skip=${0xf8a2012c / 4} 2>/dev/null | od -An -tx4`);
  expect(Number.isInteger(0xf8a2012c / 4)).toBe(true);
});
