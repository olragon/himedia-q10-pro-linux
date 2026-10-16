#!/usr/bin/env bun
/**
 * Validate the board device tree offline — the real kernel way: cpp, then dtc, then a
 * check that every CRG clock it names is actually registered by the driver.
 *
 * ⚠️ `dtc` alone CANNOT parse a kernel DTS: the `#include <dt-bindings/...>` lines and
 * macros like GIC_SPI are handled by the C preprocessor during the kernel build, so a bare
 * `dtc` run fails at line 1 of the includes and tells you nothing about your tree.
 *
 * This fetches the handful of upstream headers the tree needs into a cache, applies our
 * SATA-clock patch to the cached copy of histb-clock.h, then runs the same cpp + dtc
 * pipeline the kernel does. It therefore catches: syntax errors, undefined macros, bad
 * phandle references, and — via check-dt-refs — clocks the driver never registers.
 *
 * It deliberately proves the patch is load-bearing: run with --unpatched and the build
 * fails on HISTB_SATA_BUS_CLK, which is the gate working.
 *
 * Usage:
 *   bun run himedia:validate-dts                 # patched (expected to pass)
 *   bun run himedia:validate-dts --unpatched     # must FAIL — proves the patch is needed
 *   bun run himedia:validate-dts --refresh
 */
import { WORK_ROOT } from "./lib.ts";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const CACHE = `${WORK_ROOT}/kernel-tree`;
const RAW = "https://raw.githubusercontent.com/torvalds/linux/master";
const DTS = `${import.meta.dir}/kernel/hi3798cv200-himedia-q10-pro.dts`;
const PATCH = `${import.meta.dir}/kernel/0001-clk-hisilicon-crg-hi3798cv200-add-SATA-clocks.patch`;

/** Everything the board tree pulls in, transitively. */
const FILES = [
  "include/dt-bindings/gpio/gpio.h",
  "include/dt-bindings/phy/phy.h",
  "include/dt-bindings/clock/histb-clock.h",
  "include/dt-bindings/reset/ti-syscon.h",
  "include/dt-bindings/interrupt-controller/arm-gic.h",
  "include/dt-bindings/interrupt-controller/irq.h",
  "arch/arm64/boot/dts/hisilicon/hi3798cv200.dtsi",
  /* needed so --kernel can confirm the clocks are REGISTERED, not merely named */
  "drivers/clk/hisilicon/crg-hi3798cv200.c",
];

async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { out, err, code: await p.exited };
}

async function ensureTree(refresh: boolean) {
  for (const rel of FILES) {
    const dest = `${CACHE}/${rel}`;
    if (!refresh && existsSync(dest)) continue;
    mkdirSync(dest.split("/").slice(0, -1).join("/"), { recursive: true });
    const r = await fetch(`${RAW}/${rel}`);
    if (!r.ok) throw new Error(`fetch ${rel}: HTTP ${r.status}`);
    writeFileSync(dest, await r.text());
  }
}

/**
 * Apply just the header half of the patch to the cached tree. Done by re-deriving the
 * added lines rather than shelling out to `patch`, so it works on a pristine cache and is
 * idempotent.
 */
function applyPatch(): boolean {
  const patch = readFileSync(PATCH, "utf8");
  const plus = patch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));

  // --- header: the four ids ---
  const hdr = `${CACHE}/include/dt-bindings/clock/histb-clock.h`;
  let h = readFileSync(hdr, "utf8");
  if (!h.includes("HISTB_SATA_BUS_CLK")) {
    const ids = plus.filter((l) => /^#define HISTB_SATA_\w+\s+\d+/.test(l));
    if (ids.length !== 4) { console.error(`expected 4 SATA defines in the patch, found ${ids.length}`); return false; }
    const anchor = "#define HISTB_USB3_SUSPEND_CLK1\t\t50\n";
    if (!h.includes(anchor)) { console.error("anchor missing from cached header"); return false; }
    writeFileSync(hdr, h.replace(anchor, anchor + "\n" + ids.join("\n") + "\n"));
  }

  // --- driver: register them as gates ---
  const drv = `${CACHE}/drivers/clk/hisilicon/crg-hi3798cv200.c`;
  let d = readFileSync(drv, "utf8");
  if (!d.includes("HISTB_SATA_BUS_CLK")) {
    // Take the contiguous block of added driver lines (the gate entries + their comment).
    const start = plus.findIndex((l) => l.includes("/* SATA"));
    const gates = start >= 0 ? plus.slice(start).filter((l) => !/^#define/.test(l)) : [];
    if (gates.length < 8) { console.error(`expected the gate block in the patch, found ${gates.length} lines`); return false; }
    const anchor = `	{ HISTB_USB3_SUSPEND_CLK1, "clk_u3_suspend1", NULL,
		CLK_SET_RATE_PARENT, 0xb0, 18, 0 },
`;
    if (!d.includes(anchor)) { console.error("anchor missing from cached driver"); return false; }
    writeFileSync(drv, d.replace(anchor, anchor + gates.join("\n") + "\n"));
  }
  return true;
}

async function main() {
  for (const t of ["cc", "dtc"]) if (!Bun.which(t)) { console.error(`${t} not found`); process.exit(2); }
  const unpatched = process.argv.includes("--unpatched");
  const refresh = process.argv.includes("--refresh") || unpatched;

  await ensureTree(refresh);
  if (!unpatched && !applyPatch()) process.exit(1);

  console.log(`[local] ${unpatched ? "UNPATCHED (expecting failure)" : "patched"} kernel headers in ${CACHE}`);

  const pre = `${CACHE}/q10.pre.dts`;
  const inc = [`-I${CACHE}/include`, `-I${CACHE}/arch/arm64/boot/dts/hisilicon`];
  // The kernel preprocesses a DTS exactly like this.
  // ⚠️ `cc -E`, not `cpp`, and the INPUT must come before `-o`: macOS's `cpp` wrapper
  // answers "cc: error: no input files" for the `-o out in` order that gcc accepts.
  const cpp = await sh(["cc", "-E", "-nostdinc", ...inc, "-undef", "-D__DTS__", "-x", "assembler-with-cpp", DTS, "-o", pre]);
  if (cpp.code !== 0) {
    console.error(`⛔ cpp failed:\n${cpp.err.split("\n").slice(0, 8).join("\n")}`);
    process.exit(1);
  }

  const dtb = `${CACHE}/q10.dtb`;
  const d = await sh(["dtc", "-I", "dts", "-O", "dtb", "-@", "-o", dtb, pre]);
  const warnings = d.err.split("\n").filter((l) => l.trim());
  if (d.code !== 0) {
    console.error(`⛔ dtc failed:`);
    console.error(warnings.slice(0, 12).join("\n"));
    if (unpatched) {
      console.log("\n✅ …and that is the POINT: without the SATA clock patch the tree does not build.");
      process.exit(0);
    }
    process.exit(1);
  }

  if (unpatched) {
    console.error("⛔ the tree built WITHOUT the patch — the patch is then not load-bearing,");
    console.error("   which means the SATA clocks resolved some other way. Investigate.");
    process.exit(1);
  }

  console.log(`✅ cpp + dtc OK -> ${dtb}`);
  for (const w of warnings.slice(0, 10)) console.log(`   dtc: ${w}`);
  if (warnings.length > 10) console.log(`   … ${warnings.length - 10} more warnings`);

  // Now the check dtc cannot do: are the clocks actually supplied?
  // ⚠️ Run this on the CPP OUTPUT, not on a tree rendered back from the .dtb. cpp expands
  // the HISTB_* macros to numbers but leaves the `&crg` labels intact, which is exactly
  // what this check needs; a dtb round-trip replaces the labels with numeric phandles and
  // the check would then silently verify nothing.
  // Against OUR patched tree this must be fully green — that is the real gate.
  console.log(`\n[local] clock-provider check against the PATCHED tree:`);
  const ours = await sh(["bun", `${import.meta.dir}/check-dt-refs.ts`, pre, "--kernel", CACHE]);
  console.log((ours.out + ours.err).split("\n").filter((l) => /⛔|⚠️|✅|ok |NOT NAMED|not registered|not in tree/.test(l)).join("\n"));
  if (ours.code !== 0) {
    console.error("\n⛔ the device tree does not resolve even against our own patched tree.");
    if (ours.err.trim()) console.error(ours.err.trim().split("\n").slice(0, 5).join("\n"));
    process.exit(1);
  }

  // Against mainline it must FAIL on exactly the four SATA ids — which is what makes the
  // patch load-bearing rather than decorative.
  const up = await sh(["bun", `${import.meta.dir}/check-dt-refs.ts`, pre]);
  const missing = (up.out.match(/NOT NAMED/g) ?? []).length;
  console.log(`\n[local] against UNPATCHED mainline: ${missing} reference(s) unresolved` +
    (missing === 4 ? " — the four SATA clocks, as expected." : " ⚠️ expected exactly 4."));
}

if (import.meta.main) await main();
