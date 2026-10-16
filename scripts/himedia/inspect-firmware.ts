#!/usr/bin/env bun
/**
 * Cross-check the stock (and modified) Android firmware to extract GROUND TRUTH for the
 * Q10 Pro board — rather than inferring board facts from another board's device tree.
 *
 * Why this is the highest-value offline step: the vendor's own DTB states, authoritatively,
 *   • the real eMMC partition table,
 *   • which combo-PHY lane serves SATA vs USB3 vs PCIe on THIS board,
 *   • the SATA clock and reset indices — which mainline's CRG driver does NOT define,
 *     so they must be learned from here and ported,
 *   • GPIO/regulator/LED assignments, the UART node and baud,
 *   • whether Wi-Fi hangs off PCIe (which would contend with SATA on combphy1).
 *
 * ⛔ Treat the firmware as untrusted data: it is unpacked into its own directory and this
 * script only ever READS it. Nothing is executed from it.
 *
 * Usage:
 *   bun run himedia:inspect                      # inspect every archive under firmware/
 *   bun run himedia:inspect --file <path.zip>
 *   bun run himedia:inspect --diff A.zip B.zip   # official vs modified
 *
 * ref: docs/261009-sota-himedia-q10-pro-linux-summary.md
 */
import { WORK_ROOT } from "./lib.ts";
import { mkdirSync, existsSync, readdirSync, writeFileSync, statSync } from "node:fs";

const DTB_MAGIC = Buffer.from([0xd0, 0x0d, 0xfe, 0xed]);

async function sh(cmd: string[], timeoutMs = 120_000) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(t);
  return { out, err, code };
}

/**
 * A DTB can be a standalone file OR appended to a kernel image, so scan for the magic
 * rather than trusting filenames. Each hit's header carries totalsize, which both bounds
 * the blob and sanity-checks the hit.
 */
function findDtbs(buf: Buffer): Array<{ off: number; size: number }> {
  const hits: Array<{ off: number; size: number }> = [];
  let i = 0;
  while ((i = buf.indexOf(DTB_MAGIC, i)) !== -1) {
    const totalsize = buf.readUInt32BE(i + 4);
    const version = buf.readUInt32BE(i + 20);
    // A real DTB: plausible size, and version 16/17.
    if (totalsize > 0x100 && totalsize < 8 * 1024 * 1024 && i + totalsize <= buf.length && (version === 16 || version === 17)) {
      hits.push({ off: i, size: totalsize });
      i += totalsize;
    } else i += 4;
  }
  return hits;
}

const INTERESTING = [
  { re: /compatible\s*=\s*"([^"]*hi3798[^"]*)"/gi, label: "SoC compatible" },
  { re: /(ahci|sata)[^{]*\{/gi, label: "SATA/AHCI node" },
  { re: /xhci[^{]*\{/gi, label: "USB3/xHCI node" },
  { re: /combphy[^{]*\{/gi, label: "combo PHY" },
  { re: /blkdevparts\s*=\s*"?([^";]+)/gi, label: "eMMC partitions" },
  { re: /stdout-path\s*=\s*"([^"]+)"/gi, label: "console" },
];

async function inspectArchive(zip: string) {
  const name = zip.split("/").pop()!.replace(/\.[^.]+$/, "");
  const out = `${WORK_ROOT}/extracted/${name}`;
  mkdirSync(out, { recursive: true });

  console.log(`\n=== ${zip.split("/").pop()} (${(statSync(zip).size / 1024 / 1024).toFixed(1)} MB) ===`);

  // The vendor ships .rar as often as .zip, so pick an extractor that reads both.
  // ⛔ homebrew's 7z (p7zip) FAILS on RAR5 with "Unsupported Method" — and this firmware IS
  // RAR5 (signature `Rar!\x1a\x07\x01\x00`). bsdtar/libarchive has a RAR5 reader and also
  // handles zip and 7z, so it is the primary and 7z/unzip are fallbacks.
  const tool = Bun.which("bsdtar") ? "bsdtar" : Bun.which("7z") ? "7z" : "unzip";
  const lister = tool === "bsdtar" ? ["bsdtar", "-tf", zip]
    : tool === "7z" ? ["7z", "l", "-ba", zip] : ["unzip", "-l", zip];

  // List first — never blind-extract an archive of unknown shape.
  const list = await sh(lister);
  if (list.code !== 0) {
    console.log(`  unreadable as an archive: ${(list.err || list.out).split("\n")[0]}`);
    console.log(`  → check the download completed: a truncated .rar lists as corrupt`);
    return;
  }
  const entries = list.out.split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(Archive|Length|---|Path |Type |Method|Physical|Scanning|x |$)/.test(l));
  console.log(`  ${entries.length} entries`);
  for (const e of entries.slice(0, 40)) console.log(`    ${e}`);
  if (entries.length > 40) console.log(`    … ${entries.length - 40} more`);

  const ex = tool === "bsdtar" ? await sh(["bsdtar", "-xf", zip, "-C", out], 1_800_000)
    : tool === "7z" ? await sh(["7z", "x", "-y", `-o${out}`, zip], 1_800_000)
    : await sh(["unzip", "-o", "-q", zip, "-d", out], 1_800_000);
  if (ex.code !== 0) { console.log(`  extract failed (${tool}): ${(ex.err || ex.out).split("\n").slice(-3).join(" ")}`); return; }

  // A nested update.zip is the normal shape: the outer .rar is just the mirror's wrapper.
  for (const inner of readdirSync(out).filter((f) => /\.(zip|img)$/i.test(f))) {
    if (!/update/i.test(inner)) continue;
    console.log(`  ↳ nested ${inner} — extracting that too`);
    const sub = `${out}/_${inner.replace(/\.[^.]+$/, "")}`;
    mkdirSync(sub, { recursive: true });
    await sh(tool === "bsdtar" ? ["bsdtar", "-xf", `${out}/${inner}`, "-C", sub]
      : tool === "7z" ? ["7z", "x", "-y", `-o${sub}`, `${out}/${inner}`]
      : ["unzip", "-o", "-q", `${out}/${inner}`, "-d", sub], 1_800_000);
  }

  // Walk everything and hunt DTBs by magic.
  const stack = [out]; const files: string[] = [];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      e.isDirectory() ? stack.push(p) : files.push(p);
    }
  }
  console.log(`  extracted ${files.length} files -> ${out}`);

  const dtbDir = `${out}/_dtb`; mkdirSync(dtbDir, { recursive: true });
  let found = 0;
  for (const f of files) {
    const sz = statSync(f).size;
    if (sz > 64 * 1024 * 1024 || sz < 0x100) continue;
    const buf = Buffer.from(await Bun.file(f).arrayBuffer());
    for (const hit of findDtbs(buf)) {
      found++;
      const base = `${dtbDir}/${f.split("/").pop()}+0x${hit.off.toString(16)}`;
      await Bun.write(`${base}.dtb`, buf.subarray(hit.off, hit.off + hit.size));
      const dec = await sh(["dtc", "-I", "dtb", "-O", "dts", "-o", `${base}.dts`, `${base}.dtb`]);
      const okDts = existsSync(`${base}.dts`) && statSync(`${base}.dts`).size > 0;
      console.log(`  ⭐ DTB in ${f.replace(out + "/", "")} @0x${hit.off.toString(16)} (${hit.size}B) ${okDts ? "-> decompiled" : `-> dtc failed: ${dec.err.split("\n")[0]}`}`);
      if (!okDts) continue;

      const dts = await Bun.file(`${base}.dts`).text();
      for (const { re, label } of INTERESTING) {
        const m = [...dts.matchAll(re)].map((x) => (x[1] ?? x[0]).trim());
        if (m.length) console.log(`       ${label}: ${[...new Set(m)].slice(0, 4).join(" | ").slice(0, 150)}`);
      }
    }
  }
  if (!found) {
    console.log("  no DTB found by magic scan.");
    console.log("  → the kernel may be in a vendor container; check for a `kernel`/`boot.img` entry");
    console.log("    and re-scan it, or the DTB may live in a separate `*.dtb`/`dtbo` partition image.");
  }
  return { out, files: files.length, dtbs: found };
}

async function main() {
  for (const t of ["dtc"]) if (!Bun.which(t)) { console.error(`${t} not found`); process.exit(2); }

  if (!Bun.which("bsdtar") && !Bun.which("7z") && !Bun.which("unzip")) { console.error("need bsdtar, 7z or unzip"); process.exit(2); }

  const argv = process.argv.slice(2);
  const fi = argv.indexOf("--file");
  const di = argv.indexOf("--diff");

  let zips: string[];
  if (di >= 0) zips = [argv[di + 1], argv[di + 2]].filter(Boolean);
  else if (fi >= 0) zips = [argv[fi + 1]];
  else {
    const dir = `${WORK_ROOT}/firmware`;
    zips = existsSync(dir)
      ? readdirSync(dir).filter((f) => /\.(zip|rar|7z|img|tar\.gz|tgz)$/i.test(f)).map((f) => `${dir}/${f}`)
      : [];
  }
  if (!zips.length) {
    console.error(`No firmware archive found under ${WORK_ROOT}/firmware`);
    console.error("Run `bun run himedia:firmware` first.");
    process.exit(1);
  }

  const reports = [];
  for (const z of zips) reports.push({ zip: z, ...(await inspectArchive(z) ?? {}) });

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 15);
  mkdirSync(`${WORK_ROOT}/extracted`, { recursive: true });
  writeFileSync(`${WORK_ROOT}/extracted/${stamp}-inspect.json`, JSON.stringify(reports, null, 2));
  console.log(`\n→ ${WORK_ROOT}/extracted/${stamp}-inspect.json`);
  console.log("\nWhat to read out of the decompiled DTS, in priority order:");
  console.log("  1. the SATA/AHCI node's `clocks` and `resets` — mainline's CRG driver lacks these,");
  console.log("     so these indices are what must be ported into crg-hi3798cv200.c");
  console.log("  2. which combphy the SATA node points at (vs USB3 and PCIe) on THIS board");
  console.log("  3. `blkdevparts` — the authoritative eMMC partition map for the dump plan");
  console.log("  4. whether a Wi-Fi node sits on PCIe (it would contend with SATA on combphy1)");
}

if (import.meta.main) await main();
