#!/usr/bin/env bun
/**
 * Read the mainline kernel's boot log back out of RAM, through stock Android.
 *
 * Mainline keeps its console in a pstore/ramoops region at 0x7A800000 (see the DT). After a
 * watchdog reset, pull the stick so the box boots Android, then run this: it dumps the region
 * with the vendor's `himd.l` (via /dev/hi_mem — the vendor kernel has no /dev/mem driver) and
 * decodes each persistent_ram_buffer zone.
 *
 *   bun run himedia:ramoops [--serial 192.168.1.200:5555]
 *
 * ⛔ READ-ONLY: only himd.l (display) is ever run, never himm (modify).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { WORK_ROOT } from "./lib.ts";

export const BASE = 0x7a800000;
export const SIZE = 0x100000;
export const RECORD = 0x20000;
export const CONSOLE = 0x80000;
const SIG = 0x43474244; // "DBGC", fs/pstore/ram_core.c PERSISTENT_RAM_SIG

/** Parse `himd.l` output ("0010:  aabbccdd ..." — 32-bit words, little-endian in memory). */
export function parseHimd(text: string): Uint8Array {
  const words: number[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^([0-9a-fA-F]{4,8}):\s+((?:[0-9a-fA-F]{8}\s*)+)$/);
    if (!m) continue;
    for (const w of m[2].trim().split(/\s+/)) words.push(parseInt(w, 16) >>> 0);
  }
  const out = new Uint8Array(words.length * 4);
  const dv = new DataView(out.buffer);
  words.forEach((w, i) => dv.setUint32(i * 4, w, true));
  return out;
}

export type Zone = { name: string; offset: number; valid: boolean; text: string };

/** Decode one persistent_ram_buffer: {sig, start, size, data[]}, circular when full. */
export function decodeZone(buf: Uint8Array, offset: number, zoneSize: number, name: string): Zone {
  const dv = new DataView(buf.buffer, buf.byteOffset + offset, Math.min(zoneSize, buf.length - offset));
  if (dv.byteLength < 12) return { name, offset, valid: false, text: "" };
  const sig = dv.getUint32(0, true), start = dv.getUint32(4, true), size = dv.getUint32(8, true);
  const cap = zoneSize - 12;
  // pstore XORs the zone type into the signature; console and dmesg are small type values.
  const valid = ((sig ^ SIG) >>> 0) < 16 && start <= cap && size <= cap;
  if (!valid) return { name, offset, valid: false, text: "" };
  const data = buf.subarray(offset + 12, offset + 12 + cap);
  const bytes = size < cap ? data.subarray(0, size)
    : new Uint8Array([...data.subarray(start), ...data.subarray(0, start)]);
  return { name, offset, valid: true, text: new TextDecoder("latin1").decode(bytes) };
}

export function decodeAll(buf: Uint8Array): Zone[] {
  const zones: Zone[] = [];
  const records = (SIZE - CONSOLE) / RECORD;
  for (let i = 0; i < records; i++) zones.push(decodeZone(buf, i * RECORD, RECORD, `dmesg-${i}`));
  zones.push(decodeZone(buf, SIZE - CONSOLE, CONSOLE, "console"));
  return zones;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const si = argv.indexOf("--serial");
  const serial = si >= 0 ? argv[si + 1] : "192.168.1.200:5555";
  const p = Bun.spawn(["adb", "-s", serial, "shell", `himd.l 0x${BASE.toString(16)} 0x${SIZE.toString(16)}`],
    { stdout: "pipe", stderr: "pipe" });
  const raw = await new Response(p.stdout).text();
  await p.exited;
  const buf = parseHimd(raw);
  if (buf.length < SIZE) {
    console.error(`⛔ got ${buf.length} of ${SIZE} bytes from himd.l — is adb connected and rooted?`);
    process.exit(1);
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const dir = `${WORK_ROOT}/ramoops`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${stamp}-raw.bin`, buf);
  let md = `# mainline boot log via ramoops — ${stamp}\n`;
  for (const z of decodeAll(buf)) {
    console.log(`  ${z.valid ? "ok  " : "--  "} ${z.name.padEnd(9)} ${z.valid ? `${z.text.length} chars` : "no DBGC header"}`);
    if (z.valid) md += `\n## ${z.name}\n\n\`\`\`\n${z.text}\n\`\`\`\n`;
  }
  writeFileSync(`${dir}/${stamp}-log.md`, md);
  console.log(`\n${dir}/${stamp}-log.md`);
}
