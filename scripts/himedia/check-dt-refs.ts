#!/usr/bin/env bun
/**
 * Statically verify that every clock a device tree asks the CRG for is actually REGISTERED
 * by the mainline clock driver — offline, with no hardware.
 *
 * This exists because of a concrete trap found while planning the Q10 Pro port: the
 * reference NAS board's device tree asks for SATA clocks 51-54, and mainline's
 * `crg-hi3798cv200.c` does not register them and `histb-clock.h` does not even name them.
 * A device tree can reference a clock index that does not exist; nothing complains at
 * build time, `dtc` is perfectly happy, and the only symptom is that the controller never
 * probes at boot. That is a silent failure on hardware we cannot yet rescue.
 *
 * ⚠️ `dtc` checks SYNTAX. `dt-validate` checks a node against its binding SCHEMA. Neither
 * checks that a provider actually supplies the index a consumer names. That gap is what
 * this closes.
 *
 * Usage:
 *   bun run himedia:check-dt <file.dts|file.dtb> [--kernel <linux-src>] [--refresh]
 *
 * ref: docs/261009-sota-himedia-q10-pro-linux-summary.md
 */
import { WORK_ROOT } from "./lib.ts";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const CACHE = `${WORK_ROOT}/kernel-refs`;
const SOURCES = {
  "histb-clock.h": "https://raw.githubusercontent.com/torvalds/linux/master/include/dt-bindings/clock/histb-clock.h",
  "crg-hi3798cv200.c": "https://raw.githubusercontent.com/torvalds/linux/master/drivers/clk/hisilicon/crg-hi3798cv200.c",
} as const;

/** HISTB_* / HI3798CV200_* macro -> numeric id. */
export function parseDefines(src: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of src.split("\n")) {
    const g = line.match(/^#define\s+((?:HISTB|HI3798CV200)_\w+)\s+(\d+)/);
    if (g) m.set(g[1], Number(g[2]));
  }
  return m;
}

/**
 * IDs the driver actually registers. Every clock table entry is a brace-initialised struct
 * whose first field is the id macro, so that first field is the registration evidence.
 */
export function parseRegistered(src: string): Set<string> {
  const out = new Set<string>();
  for (const g of src.matchAll(/\{\s*((?:HISTB|HI3798CV200)_\w+)\s*,/g)) out.add(g[1]);
  return out;
}

/** Every `<&crg N ...>` reference in a DTS, with the property it came from. */
export function parseCrgRefs(dts: string): Array<{ prop: string; ids: number[] }> {
  const refs: Array<{ prop: string; ids: number[] }> = [];
  // clocks = <&crg 0x2b>, <&crg 0x2c>;  |  resets = <&crg 0xa8 0x8>;
  for (const g of dts.matchAll(/(\w[\w-]*)\s*=\s*((?:<[^>]*>\s*,?\s*)+);/g)) {
    const prop = g[1];
    if (!/^(clocks|assigned-clocks|assigned-clock-parents|resets)$/.test(prop)) continue;
    const ids: number[] = [];
    for (const cell of g[2].matchAll(/<\s*&crg\s+([^>]+)>/g)) {
      const nums = cell[1].trim().split(/\s+/);
      // A clock reference is <&crg ID>. A reset is <&crg OFFSET BIT> — the offset is a
      // register address, NOT a clock id, so it must never be checked as one.
      if (/^(clocks|assigned-clocks|assigned-clock-parents)$/.test(prop) && nums.length >= 1) {
        const v = Number(nums[0]);
        if (Number.isFinite(v)) ids.push(v);
      }
    }
    if (ids.length) refs.push({ prop, ids });
  }
  return refs;
}

/** Read the header+driver from a local kernel tree instead of mainline. */
function localRefs(dir: string): { header: string; driver: string } {
  const h = `${dir}/include/dt-bindings/clock/histb-clock.h`;
  const d = `${dir}/drivers/clk/hisilicon/crg-hi3798cv200.c`;
  for (const f of [h, d]) if (!existsSync(f)) throw new Error(`not in tree: ${f}`);
  return { header: readFileSync(h, "utf8"), driver: readFileSync(d, "utf8") };
}

async function ensureRefs(refresh: boolean): Promise<{ header: string; driver: string }> {
  mkdirSync(CACHE, { recursive: true });
  const read = async (name: keyof typeof SOURCES) => {
    const p = `${CACHE}/${name}`;
    if (!refresh && existsSync(p)) return readFileSync(p, "utf8");
    const r = await fetch(SOURCES[name]);
    if (!r.ok) throw new Error(`fetch ${name}: HTTP ${r.status}`);
    const t = await r.text();
    writeFileSync(p, t);
    return t;
  };
  return { header: await read("histb-clock.h"), driver: await read("crg-hi3798cv200.c") };
}

async function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: bun run himedia:check-dt <file.dts|file.dtb> [--refresh]");
    process.exit(2);
  }
  if (!existsSync(file)) { console.error(`no such file: ${file}`); process.exit(2); }

  let dts: string;
  if (file.endsWith(".dtb")) {
    if (!Bun.which("dtc")) { console.error("dtc not found (brew install dtc)"); process.exit(2); }
    const p = Bun.spawn(["dtc", "-I", "dtb", "-O", "dts", file], { stdout: "pipe", stderr: "pipe" });
    dts = await new Response(p.stdout).text();
    if (await p.exited !== 0) { console.error("dtc failed to decompile"); process.exit(1); }
  } else dts = readFileSync(file, "utf8");

  const ki = argv.indexOf("--kernel");
  const kdir = ki >= 0 ? argv[ki + 1] : undefined;
  let header: string, driver: string;
  if (kdir) {
    try { ({ header, driver } = localRefs(kdir)); }
    catch (e) { console.error(`${e}`); process.exit(2); }
    console.log(`[local] refs from ${kdir}`);
  } else {
    ({ header, driver } = await ensureRefs(argv.includes("--refresh")));
  }
  const defines = parseDefines(header + "\n" + driver);
  const registered = parseRegistered(driver);

  // id -> the macro names that denote it, and whether any is registered.
  const byId = new Map<number, { names: string[]; registered: boolean }>();
  for (const [name, id] of defines) {
    const e = byId.get(id) ?? { names: [], registered: false };
    e.names.push(name);
    if (registered.has(name)) e.registered = true;
    byId.set(id, e);
  }

  const refs = parseCrgRefs(dts);
  console.log(`[local] ${file}`);
  console.log(`[local] mainline: ${defines.size} ids named, ${registered.size} registered by crg-hi3798cv200.c\n`);

  const missing: number[] = [];
  const unregistered: number[] = [];
  const seen = new Set<number>();

  for (const r of refs) {
    for (const id of r.ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = byId.get(id);
      if (!e) { missing.push(id); console.log(`  ⛔ ${r.prop.padEnd(24)} 0x${id.toString(16).padStart(2, "0")} (${id})  NOT NAMED in histb-clock.h`); }
      else if (!e.registered) { unregistered.push(id); console.log(`  ⚠️  ${r.prop.padEnd(24)} 0x${id.toString(16).padStart(2, "0")} (${id})  ${e.names[0]} — named but NOT registered`); }
      else console.log(`  ok  ${r.prop.padEnd(24)} 0x${id.toString(16).padStart(2, "0")} (${id})  ${e.names[0]}`);
    }
  }

  console.log();
  // ⛔ Zero references is NOT a pass. A device tree rendered back from a .dtb carries bare
  // phandle numbers (`<0x07 0x33>`) instead of `&crg`, so this parser legitimately finds
  // nothing — and reporting that as success is a false green. Check the SOURCE (or the
  // cpp-preprocessed) tree, where the `&crg` labels still exist.
  if (!refs.length) {
    console.error("⛔ no `&crg` clock references found in this file — nothing was verified.");
    console.error("   If this came from `dtc -I dtb`, its phandles are numeric and the labels");
    console.error("   are gone. Point this at the source .dts or the cpp output instead.");
    process.exit(2);
  }

  if (missing.length || unregistered.length) {
    console.log(`⛔ ${missing.length + unregistered.length} clock reference(s) will NOT resolve on mainline.`);
    console.log("   The consumer silently fails to probe — no build error, and dtc stays happy.");
    console.log("   Fix: add the ids to include/dt-bindings/clock/histb-clock.h AND register them");
    console.log("   in drivers/clk/hisilicon/crg-hi3798cv200.c, taking register offsets and bits");
    console.log("   from the VENDOR device tree (bun run himedia:inspect) — not from a guess.");
    process.exit(1);
  }
  console.log("✅ every CRG clock this device tree references is registered by mainline.");
}

if (import.meta.main) await main();
