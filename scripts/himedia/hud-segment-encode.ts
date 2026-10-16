#!/usr/bin/env bun
/**
 * Encode a string into the 16 display-RAM bytes the STOCK Q10 Pro keyled_tm1628.c TM1629 path writes.
 * Source: docs/261011-himedia-hud-segment-map.md (font @0xc0d6351c, transpose loop in c09fe87c).
 * usage: hud-segment-encode.ts <text up to 4 chars> [--colon] [--verify <vmlinux.bin>]
 * Prints the `q10-panel raw` command. Pure encoding; touches no hardware.
 */
import { readFileSync } from "node:fs";

const CHARS = "0123456789-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz ";
export const FONT = [
  0x3f,0x06,0x5b,0x4f,0x66,0x6d,0x7d,0x07,0x7f,0x6f,0x40,
  0x77,0x7c,0x39,0x5e,0x79,0x71,0x6f,0x76,0x06,0x0e,0x00,0x38,0x00,0x37,0x3f,0x73,0x67,0x31,0x6d,0x78,0x3e,0x00,0x00,0x00,0x6e,0x5b,
  0x77,0x7c,0x58,0x5e,0x79,0x71,0x6f,0x74,0x06,0x0e,0x00,0x38,0x00,0x54,0x5c,0x73,0x67,0x31,0x6d,0x78,0x1c,0x62,0x00,0x00,0x6e,0x5b,0x00,
];

/** Mirror of c09fe87c: src[n] bit ci -> dest[ci] bit n (n<5); RAM = dest[k] at byte 2k, 0 at 2k+1, k<7. */
export function encode(text: string, colon: boolean): number[] {
  const src = [0, 0, 0, 0, colon ? 0x10 : 0];
  for (let i = 0; i < Math.min(4, text.length); i++) {
    const idx = CHARS.indexOf(text[i]);
    if (idx < 0) throw new Error(`no glyph for '${text[i]}'`);
    src[i] = FONT[idx];
  }
  const ram = new Array(16).fill(0);
  for (let ci = 0; ci < 7; ci++) for (let n = 0; n < 5; n++) ram[2 * ci] |= ((src[n] >> ci) & 1) << n;
  return ram;
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const vi = a.indexOf("--verify");
  if (vi >= 0) {
    const d = readFileSync(a[vi + 1]);
    const off = 0xc0d6351c - 0xc0008000;
    const ok = FONT.length === 64 && FONT.every((b, i) => d[off + i] === b);
    console.log(ok ? "font matches kernel image" : "FONT MISMATCH");
    process.exit(ok ? 0 : 1);
  }
  const text = a.find((x) => !x.startsWith("--")) ?? "1234";
  const ram = encode(text, a.includes("--colon"));
  console.log("q10-panel raw " + ram.map((b) => b.toString(16).padStart(2, "0")).join(" "));
}
