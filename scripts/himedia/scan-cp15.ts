#!/usr/bin/env bun
/**
 * Scan an ARM binary for CP15 (system control coprocessor) accesses, and name the registers.
 *
 * ⭐ Why this exists: the one question that decides whether our AArch32 device tree needs
 * `clock-frequency` on the timer node is "does the stock 32-bit U-Boot program CNTFRQ?".
 * Under AArch64 the firmware does it at EL3, which is why upstream Poplar omits the property.
 * We enter from a 32-bit U-Boot instead. That is answerable from the eMMC backup alone, with
 * no hardware and no boot — the instruction either exists in the image or it does not.
 *
 * ⚠️ This is a PATTERN SCAN, not a disassembler. It reports that an encoding appears at an
 * offset; it cannot prove the instruction is reachable, or that it executes before our kernel.
 * An absence is therefore much stronger evidence than a presence: you cannot execute an
 * instruction that is not in the image.
 *
 * Both instruction sets are covered. ARM and Thumb-2 use the same 32-bit encoding, but Thumb
 * stores it as two little-endian halfwords, so the bytes are swapped in pairs; scanning both
 * orders costs nothing and missing one would produce a false "absent".
 *
 * Usage:
 *   bun run himedia:cp15 <binary> [--reg CNTFRQ] [--all]
 */
import { readFileSync } from "node:fs";

/** CP15 registers worth naming, keyed `opc1,CRn,CRm,opc2`. */
const REGS: Record<string, string> = {
  "0,0,0,0": "MIDR (main id)",
  "0,1,0,0": "SCTLR (system control)",
  "0,1,0,1": "ACTLR (aux control)",
  "0,1,0,2": "CPACR (coproc access)",
  "0,2,0,0": "TTBR0",
  "0,12,0,0": "VBAR (vector base)",
  "0,14,0,0": "CNTFRQ (generic timer frequency)",
  "0,14,1,0": "CNTKCTL",
  "0,14,2,0": "CNTP_TVAL",
  "0,14,2,1": "CNTP_CTL",
  "4,14,0,0": "CNTVOFF (hyp)",
  "0,15,0,0": "impl-defined (often L2/aux)",
};

export type Hit = {
  offset: number; dir: "write" | "read"; iset: "arm" | "thumb";
  opc1: number; crn: number; crm: number; opc2: number; rt: number; name: string;
};

/**
 * Decode one 32-bit MCR/MRC word, or return null if it is not one.
 *
 * MCR/MRC: cond(4) 1110 opc1(3) L CRn(4) Rt(4) coproc(4) opc2(3) 1 CRm(4)
 * We require coproc == 15 and the fixed `1` bit, which is what makes this specific enough to
 * scan raw bytes with an acceptable false-positive rate.
 */
export function decodeMcr(w: number): Omit<Hit, "offset" | "iset"> | null {
  if (((w >>> 24) & 0x0f) !== 0x0e) return null;        // the 1110 op field
  if (((w >>> 8) & 0x0f) !== 0x0f) return null;         // coproc 15
  if (((w >>> 4) & 1) !== 1) return null;               // fixed bit
  const cond = (w >>> 28) & 0xf;
  if (cond === 0xf) return null;                        // 0b1111 is not a condition here
  const opc1 = (w >>> 21) & 0x7;
  const L = (w >>> 20) & 1;
  const crn = (w >>> 16) & 0xf;
  const rt = (w >>> 12) & 0xf;
  const opc2 = (w >>> 5) & 0x7;
  const crm = w & 0xf;
  const key = `${opc1},${crn},${crm},${opc2}`;
  return {
    dir: L ? "read" : "write", opc1, crn, crm, opc2, rt,
    name: REGS[key] ?? `c${crn},c${crm} opc1=${opc1} opc2=${opc2}`,
  };
}

export function scan(buf: Uint8Array): Hit[] {
  const out: Hit[] = [];
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i + 4 <= buf.length; i += 2) {
    const le = dv.getUint32(i, true);
    // Thumb-2 keeps the same word but as two LE halfwords, i.e. the halves are swapped.
    const sw = ((le & 0xffff) << 16) | (le >>> 16);
    for (const [w, iset] of [[le, "arm"], [sw, "thumb"]] as const) {
      const d = decodeMcr(w >>> 0);
      if (d) out.push({ offset: i, iset, ...d });
    }
  }
  return out;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) { console.error("usage: himedia:cp15 <binary> [--reg NAME] [--all]"); process.exit(2); }
  const ri = argv.indexOf("--reg");
  const want = ri >= 0 ? argv[ri + 1] : "";
  const buf = readFileSync(file);
  const hits = scan(buf);

  console.log(`[local] ${file} — ${buf.length} bytes, ${hits.length} CP15 encodings found\n`);

  const byName = new Map<string, Hit[]>();
  for (const h of hits) byName.set(h.name, [...(byName.get(h.name) ?? []), h]);

  const rows = [...byName.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [name, hs] of rows) {
    if (want && !name.toUpperCase().includes(want.toUpperCase())) continue;
    const w = hs.filter((h) => h.dir === "write").length;
    console.log(`  ${String(hs.length).padStart(4)}x  ${name}`);
    console.log(`        ${w} write, ${hs.length - w} read`);
    if (want || argv.includes("--all")) {
      for (const h of hs.slice(0, 12)) {
        console.log(`        0x${h.offset.toString(16).padStart(6, "0")}  ${h.dir.padEnd(5)} r${h.rt}  (${h.iset})`);
      }
    }
  }

  // ⛔ The question this tool was built for. An absence is the strong answer.
  const cnt = hits.filter((h) => h.name.startsWith("CNTFRQ"));
  const writes = cnt.filter((h) => h.dir === "write");
  console.log(`\n--- CNTFRQ verdict ---`);
  if (writes.length === 0) {
    console.log(`  NO CNTFRQ WRITE anywhere in this image (${cnt.length} reads).`);
    console.log(`  => It cannot program the generic timer frequency, so a kernel entered from`);
    console.log(`     it has CNTFRQ at whatever reset left behind (commonly 0). An AArch32`);
    console.log(`     device tree MUST therefore carry clock-frequency on the timer node.`);
  } else {
    console.log(`  ${writes.length} CNTFRQ WRITE encoding(s) present:`);
    for (const h of writes) console.log(`     0x${h.offset.toString(16)}  r${h.rt} (${h.iset})`);
    console.log(`  => Presence is NOT proof of execution — a pattern scan cannot show reachability.`);
  }
}
