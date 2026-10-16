#!/usr/bin/env bun
/**
 * Convert mainline's arm64 `hi3798cv200.dtsi` into a 32-bit ARM one.
 *
 * ⭐ Why 32-bit at all: the stock bootloader is a 32-bit U-Boot. Its `bootm` checks the
 * uImage architecture field and the stock kernel is `arch=2` (ARM), so it will reject an
 * arm64 image outright — and replacing the loader needs DDR timing we do not have plus a
 * serial console. A 32-bit kernel is the only route that keeps the box closed.
 *
 * ⭐ Why this is tractable: `soc@f0000000` already declares `#address-cells = <1>` with a
 * `ranges` translation, so every node inside it — the vast majority of the file — needs no
 * change at all. Only the root, the cpus container, the four cpu `reg`s and the GIC use
 * two-cell addresses.
 *
 * ⭐ SMP survives the move: the secure firmware provides PSCI (`trustedcore` exports
 * `hisi_psci_cpu_on`/`_off`/`_suspend` and references `bl31`), and PSCI has an AArch32 SMC
 * calling convention — so `enable-method = "psci"` keeps all four cores. The VENDOR kernel
 * does not use PSCI (its device tree has no psci node at all) and brings cores up through
 * BSP code that is not in mainline, so copying the vendor approach was never an option.
 *
 * This is a generator, not a hand edit: upstream will change, and a re-runnable conversion
 * can be re-applied and re-reviewed.
 *
 * Usage:
 *   bun run himedia:port-dtsi <in arm64 dtsi> <out arm dtsi>
 *   bun run himedia:port-dtsi --check <out>     # assert no 2-cell leftovers
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

export type Edit = { what: string; from: string; to: string; required: boolean };

/**
 * Every substitution, declared rather than applied inline, so the conversion is auditable
 * and a missing one is an error instead of a silent no-op.
 */
export const EDITS: Edit[] = [
  { what: "root address-cells 2 -> 1", required: true,
    from: '\tcompatible = "hisilicon,hi3798cv200";\n\tinterrupt-parent = <&gic>;\n\t#address-cells = <2>;\n\t#size-cells = <2>;',
    to:   '\tcompatible = "hisilicon,hi3798cv200";\n\tinterrupt-parent = <&gic>;\n\t#address-cells = <1>;\n\t#size-cells = <1>;' },

  { what: "cpus address-cells 2 -> 1", required: true,
    from: '\tcpus {\n\t\t#address-cells = <2>;\n\t\t#size-cells = <0>;',
    to:   '\tcpus {\n\t\t#address-cells = <1>;\n\t\t#size-cells = <0>;' },

  { what: "cpu@0 reg", required: true, from: '\t\t\treg = <0x0 0x0>;', to: '\t\t\treg = <0x0>;' },
  { what: "cpu@1 reg", required: true, from: '\t\t\treg = <0x0 0x1>;', to: '\t\t\treg = <0x1>;' },
  { what: "cpu@2 reg", required: true, from: '\t\t\treg = <0x0 0x2>;', to: '\t\t\treg = <0x2>;' },
  { what: "cpu@3 reg", required: true, from: '\t\t\treg = <0x0 0x3>;', to: '\t\t\treg = <0x3>;' },

  { what: "GIC reg (4 ranges)", required: true,
    from: '\t\treg = <0x0 0xf1001000 0x0 0x1000>,  /* GICD */\n\t\t      <0x0 0xf1002000 0x0 0x2000>,  /* GICC */\n\t\t      <0x0 0xf1004000 0x0 0x2000>,  /* GICH */\n\t\t      <0x0 0xf1006000 0x0 0x2000>;  /* GICV */',
    to:   '\t\treg = <0xf1001000 0x1000>,  /* GICD */\n\t\t      <0xf1002000 0x2000>,  /* GICC */\n\t\t      <0xf1004000 0x2000>,  /* GICH */\n\t\t      <0xf1006000 0x2000>;  /* GICV */' },

  // soc's own ranges/dma-ranges are expressed in the PARENT's cells, so they shrink too.
  { what: "soc ranges", required: true,
    from: '\t\tranges = <0x0 0x0 0xf0000000 0x10000000>;',
    to:   '\t\tranges = <0x0 0xf0000000 0x10000000>;' },
  { what: "soc dma-ranges", required: true,
    from: '\t\tdma-ranges = <0x0 0x0 0x0 0x40000000>;',
    to:   '\t\tdma-ranges = <0x0 0x0 0x40000000>;' },
];

/**
 * Leftover two-cell CPU addressing would compile fine and then fail at runtime.
 *
 * ⚠️ A PCI bus legitimately declares `#address-cells = <3>` with `#size-cells = <2>` — that
 * is PCI's own addressing and has nothing to do with the CPU's address width, so it must be
 * left alone. An earlier version of this check flagged the PCIe node and refused a perfectly
 * correct conversion; a guard that cannot tell a legitimate case from a broken one gets
 * switched off, which is worse than no guard.
 */
export function findTwoCellLeftovers(src: string): string[] {
  const bad: string[] = [];
  const lines = src.split("\n");
  lines.forEach((l, i) => {
    if (/#size-cells\s*=\s*<2>/.test(l)) {
      // Look back a couple of lines: paired with <3> address cells, this is a PCI bus.
      const near = lines.slice(Math.max(0, i - 3), i + 1).join("\n");
      if (/#address-cells\s*=\s*<3>/.test(near)) return;
      bad.push(`${i + 1}: ${l.trim()}`);
    } else if (/#address-cells\s*=\s*<2>/.test(l)) {
      bad.push(`${i + 1}: ${l.trim()}`);
    }
    // A root-level reg written as <0x0 ADDR 0x0 SIZE> — the 0x0 high words give it away.
    if (/reg\s*=\s*<0x0 0x[0-9a-f]+ 0x0 0x[0-9a-f]+>/.test(l)) bad.push(`${i + 1}: ${l.trim()}`);
  });
  return bad;
}

export function convert(src: string): { out: string; applied: string[]; missing: string[] } {
  let out = src;
  const applied: string[] = [], missing: string[] = [];
  for (const e of EDITS) {
    if (out.includes(e.from)) { out = out.replace(e.from, e.to); applied.push(e.what); }
    else if (out.includes(e.to)) applied.push(`${e.what} (already)`);
    else if (e.required) missing.push(e.what);
  }
  out = out.replace(
    "/*\n * dts file for Hisilicon Hi3798cv200 SoC",
    "/*\n * dts file for Hisilicon Hi3798cv200 SoC — 32-bit ARM (AArch32) port\n *\n" +
    " * Generated by scripts/himedia/port-dtsi-arm32.ts from the arm64 dtsi. Do not hand-edit:\n" +
    " * re-run the generator so the conversion stays reviewable against upstream.\n *\n" +
    " * The stock 32-bit U-Boot rejects an arm64 uImage, so AArch32 is the only way to boot a\n" +
    " * mainline kernel without replacing the bootloader.\n *\n * Original header follows.\n *\n * dts file for Hisilicon Hi3798cv200 SoC");
  return { out, applied, missing };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--check") {
    const f = argv[1];
    if (!f || !existsSync(f)) { console.error("usage: --check <file>"); process.exit(2); }
    const bad = findTwoCellLeftovers(readFileSync(f, "utf8"));
    if (bad.length) { console.error(`⛔ ${bad.length} two-cell leftover(s):`); bad.forEach((b) => console.error("   " + b)); process.exit(1); }
    console.log("✅ no two-cell addressing left.");
    return;
  }

  const [inp, outp] = argv.filter((a) => !a.startsWith("--"));
  if (!inp || !outp) { console.error("usage: bun run himedia:port-dtsi <in.dtsi> <out.dtsi>"); process.exit(2); }
  if (!existsSync(inp)) { console.error(`no such file: ${inp}`); process.exit(2); }

  const { out, applied, missing } = convert(readFileSync(inp, "utf8"));
  console.log(`[local] ${inp} -> ${outp}`);
  for (const a of applied) console.log(`  ok      ${a}`);
  for (const m of missing) console.log(`  ⛔ MISS  ${m}`);
  if (missing.length) {
    console.error(`\n⛔ ${missing.length} required edit(s) did not match — upstream has changed shape.`);
    console.error("   Refusing to write a half-converted tree; update EDITS and re-run.");
    process.exit(1);
  }
  writeFileSync(outp, out);
  const bad = findTwoCellLeftovers(out);
  if (bad.length) { console.error(`\n⛔ leftovers after conversion:`); bad.forEach((b) => console.error("   " + b)); process.exit(1); }
  console.log(`\n✅ converted, no two-cell addressing left (${out.split("\n").length} lines)`);
}

if (import.meta.main) await main();
