#!/usr/bin/env bun
/**
 * Build and verify a SET of candidate images ahead of a desk session.
 *
 * ⭐ Why a set: each flash costs a physical trip, and the box is the only place the device tree
 * and early boot can be exercised. Building several single-variable images now turns a desk
 * session into flash-and-read instead of build-and-wait.
 *
 * ⛔ One variable per candidate. An image that changes two things cannot tell us which one
 * mattered, and this project has already spent rounds on exactly that kind of ambiguity.
 *
 * Every candidate is verified the way the box will NOT verify it (the stock env sets
 * `verify = n`): uImage magic, header CRC, data CRC, arch == 2, and the checkpoint load values
 * that make the reboot period readable.
 *
 * Usage:
 *   bun run himedia:candidates --list
 *   bun run himedia:candidates            # build every candidate, then verify
 *   bun run himedia:candidates --only load-high
 */
import { WORK_ROOT } from "./lib.ts";
import { readUImage } from "./simulate-boot.ts";
import { CHECKPOINTS, APB_HZ } from "./checkpoints.ts";
import { existsSync, readFileSync } from "node:fs";

const ROOT = `${WORK_ROOT}/kernel-build-arm32`;

type Candidate = { id: string; out: string; args: string[]; hypothesis: string };

export const CANDIDATES: Candidate[] = [
  {
    id: "baseline",
    out: "uImage",
    args: ["--checkpoints"],
    hypothesis:
      "the current image: multi_v7_defconfig, EFI_STUB on, load 0x2000000. Its decompressed " +
      "kernel is 30.5 MiB and ends only 1.5 MiB below the running code (vendor leaves 22 MiB).",
  },
  {
    id: "load-high",
    out: "uImage-load4000",
    args: ["--checkpoints", "--load", "0x4000000"],
    hypothesis:
      "raise the load address to 0x4000000, turning 1.5 MiB of decompression margin into " +
      "33.5 MiB. AUTO_ZRELADDR masks with 0xf8000000, so the kernel still lands at " +
      "TEXT_OFFSET and nothing else moves. No bootcmd change: bootm copies to the header's " +
      "load address by itself.",
  },
  {
    id: "no-efi",
    out: "uImage-noefi",
    args: ["--checkpoints", "--no-efi"],
    hypothesis:
      "drop CONFIG_EFI_STUB. It replaces the decompressor's 8 leading nops with a PE/COFF " +
      "'MZ' header — ours begins 0xe2255a4d where the vendor's begins with 8 real nops — and " +
      "this is a vendor U-Boot of unknown tolerance. Nothing we need uses EFI.",
  },
  {
    id: "load-high-no-efi",
    out: "uImage-load4000-noefi",
    args: ["--checkpoints", "--load", "0x4000000", "--no-efi"],
    hypothesis:
      "both of the above. Only worth flashing if each single-variable image still hangs — a " +
      "combined image cannot attribute a success to one change.",
  },
];

async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  return await p.exited;
}

/** Verify an image the way the box will not. Returns the failure reasons. */
export function verify(path: string): string[] {
  const bad: string[] = [];
  if (!existsSync(path)) return [`missing: ${path}`];
  const buf = readFileSync(path);
  const u = readUImage(buf);
  if (!u.magicOk) bad.push("bad uImage magic");
  if (!u.hcrcOk) bad.push("header CRC FAILED");
  if (!u.dcrcOk) bad.push("data CRC FAILED");
  if (u.arch !== 2) bad.push(`arch=${u.arch}, the 32-bit loader needs 2`);
  if (u.comp !== 0) bad.push(`comp=${u.comp}, expected 0`);

  // The four decompressor checkpoints live in the UNCOMPRESSED decompressor, so each one's
  // movw of its own load value must be findable. B is inside the compressed payload.
  const movw4 = (imm: number) => 0xe3004000 | ((imm >> 12) << 16) | (imm & 0xfff);
  for (const c of CHECKPOINTS) {
    if (c.file.includes("compressed")) {
      const w = movw4((c.seconds * APB_HZ) & 0xffff);
      const needle = Buffer.alloc(4);
      needle.writeUInt32LE(w >>> 0);
      if (buf.indexOf(needle) < 0) bad.push(`checkpoint ${c.id} load value not in the image`);
    }
  }
  return bad;
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.indexOf("--only") >= 0 ? argv[argv.indexOf("--only") + 1] : "";
  const set = only ? CANDIDATES.filter((c) => c.id === only) : CANDIDATES;

  /**
   * ⚠️ --verify checks images that already exist, WITHOUT rebuilding. `--only` runs a full
   * build, which is minutes per image — easy to reach for when you only wanted a check.
   */
  if (argv.includes("--verify")) {
    let bad = 0;
    for (const c of CANDIDATES) {
      const errs = verify(`${ROOT}/${c.out}`);
      if (errs.length) { bad++; console.log(`  ⛔ ${c.id.padEnd(18)} ${c.out}`); for (const e of errs) console.log(`       ${e}`); }
      else {
        const u = readUImage(readFileSync(`${ROOT}/${c.out}`));
        console.log(`  ok  ${c.id.padEnd(18)} ${c.out}  ${u.size} B  load 0x${u.load.toString(16)}`);
      }
    }
    process.exit(bad ? 1 : 0);
  }

  if (argv.includes("--list")) {
    for (const c of CANDIDATES) {
      console.log(`\n${c.id}  ->  ${c.out}`);
      console.log(`  args: ${c.args.join(" ")}`);
      console.log(`  ${c.hypothesis}`);
    }
    return;
  }
  if (!set.length) { console.error(`no candidate named '${only}'`); process.exit(2); }

  const results: Array<[string, string[]]> = [];
  for (const c of set) {
    console.log(`\n\n######## building ${c.id} -> ${c.out}`);
    const code = await sh(["bun", `${import.meta.dir}/build-kernel-arm32.ts`,
      ...c.args, "--out", c.out]);
    if (code !== 0) { results.push([c.id, [`build failed (exit ${code})`]]); continue; }
    results.push([c.id, verify(`${ROOT}/${c.out}`)]);
  }

  console.log(`\n\n======== candidate summary ========`);
  let bad = 0;
  for (const [id, errs] of results) {
    const c = CANDIDATES.find((x) => x.id === id)!;
    if (errs.length) {
      bad++;
      console.log(`  ⛔ ${id.padEnd(18)} ${c.out}`);
      for (const e of errs) console.log(`       ${e}`);
    } else {
      const u = readUImage(readFileSync(`${ROOT}/${c.out}`));
      console.log(`  ok  ${id.padEnd(18)} ${c.out}  ${u.size} B  load 0x${u.load.toString(16)}`);
    }
  }
  console.log(`\n  flash one with:  bun run himedia:usb --disk <diskN> --kernel --apply \\`);
  console.log(`                     --image ${ROOT}/<name>`);
  process.exit(bad ? 1 : 0);
}

if (import.meta.main) await main();
