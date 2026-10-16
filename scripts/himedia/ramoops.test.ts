import { test, expect } from "bun:test";
import { parseHimd, decodeZone, decodeAll, SIZE, CONSOLE } from "./ramoops.ts";

const zone = (sig: number, start: number, size: number, payload: string, cap = 64) => {
  const b = new Uint8Array(12 + cap);
  const dv = new DataView(b.buffer);
  dv.setUint32(0, sig, true); dv.setUint32(4, start, true); dv.setUint32(8, size, true);
  b.set(new TextEncoder().encode(payload).subarray(0, cap), 12);
  return b;
};

test("parses himd.l output as little-endian words", () => {
  const b = parseHimd("====dump memory 0X7A800000====\n0000:  43474244 00000000 00000005 64636261\n[END]\n");
  expect([...b.subarray(0, 4)]).toEqual([0x44, 0x42, 0x47, 0x43]);   // "DBGC"
  expect(new TextDecoder().decode(b.subarray(12, 16))).toBe("abcd");
});

test("decodes a zone that has not wrapped", () => {
  const z = decodeZone(zone(0x43474244, 5, 5, "hello"), 0, 12 + 64, "console");
  expect(z.valid).toBe(true);
  expect(z.text).toBe("hello");
});

test("decodes a wrapped zone oldest-first", () => {
  // cap 8, full, start 3: the oldest byte is at 3
  const z = decodeZone(zone(0x43474244, 3, 8, "FGHABCDE", 8), 0, 12 + 8, "console");
  expect(z.text).toBe("ABCDEFGH");
});

test("rejects RAM that is not a ramoops zone", () => {
  expect(decodeZone(zone(0x67666564, 0, 0, ""), 0, 12 + 64, "console").valid).toBe(false);
  expect(decodeZone(zone(0x43474244, 999, 5, ""), 0, 12 + 64, "console").valid).toBe(false);
});

test("the console zone sits after the four dump records", () => {
  const buf = new Uint8Array(SIZE);
  buf.set(zone(0x43474244, 4, 4, "boot"), SIZE - CONSOLE);
  const c = decodeAll(buf).find((z) => z.name === "console")!;
  expect(c.valid).toBe(true);
  expect(c.text).toBe("boot");
});
