#!/usr/bin/env bun
/**
 * Step 3: dump the Q10 Pro's eMMC — the recovery path for everything that follows.
 *
 * ⛔ This script only ever READS the box. Nothing is written to the device.
 *
 * Why it is the gate for the whole project: the firmware installed on this unit
 * (2020-08-18) is NEWER than the only archive that still exists on a mirror (2.1.4,
 * 2019-05-31), so the mirror is a fallback, not a restore of the current state. And
 * several partitions are DEVICE-UNIQUE — `deviceinfo`, `baseparam`, `securestore`,
 * `trustedcore`, `private` plausibly hold the MAC address, calibration and keys. Those
 * cannot be recovered from any generic image, by anyone, ever. If this dump is not taken
 * first, a bad flash is permanent.
 *
 * Verification is two-ended: sha256 computed ON the device and again locally, and a dump
 * counts as good only when both the byte count AND the hash agree. Size agreement is not
 * verification.
 *
 * Usage:
 *   bun run himedia:dump                 # critical set (~2.1 GiB) — skips cache + userdata
 *   bun run himedia:dump --all           # everything, including userdata (~14.6 GiB)
 *   bun run himedia:dump --verify        # re-verify what is already on disk, dump nothing
 *   bun run himedia:dump --only kernel,fastboot
 *
 * ref: docs/261010-himedia-q10-pro-recon-findings.md
 */
import { WORK_ROOT, DEVICE, dumpVerdict } from "./lib.ts";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";

const DIR = `${WORK_ROOT}/emmc-dump`;
const MANIFEST = `${DIR}/manifest.json`;

/**
 * Partitions that cannot be reconstructed from a generic firmware image. Losing these is
 * unrecoverable, so they are never skipped regardless of flags.
 */
const DEVICE_UNIQUE = new Set(["deviceinfo", "baseparam", "securestore", "trustedcore", "private", "pqparam"]);
/** Regenerable by Android itself, and large. Skipped unless --all. */
const SKIP_BY_DEFAULT = new Set(["cache", "userdata"]);

type Part = { dev: string; name: string; blocks: number };

async function adb(serial: string, args: string[], timeoutMs = 60_000) {
  const p = Bun.spawn(["adb", "-s", serial, ...args], { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(t);
  return { out: out.replace(/\r/g, ""), err, code };
}

/** Map `/proc/partitions` onto the names in `blkdevparts`, in order. */
export function mapPartitions(procPartitions: string, cmdline: string): Part[] {
  const names: string[] = [];
  const m = cmdline.match(/blkdevparts=([^\s]+)/);
  if (m) for (const g of m[1].split(";")) {
    const i = g.indexOf(":");
    if (i < 0) continue;
    for (const part of g.slice(i + 1).split(",")) {
      const pm = part.match(/^([^(]+)\(([^)]+)\)$/);
      if (pm) names.push(pm[2]);
    }
  }
  const devs: Array<{ dev: string; blocks: number; idx: number }> = [];
  for (const line of procPartitions.split("\n")) {
    const g = line.trim().match(/^\d+\s+\d+\s+(\d+)\s+(mmcblk0p(\d+))$/);
    if (g) devs.push({ dev: g[2], blocks: Number(g[1]), idx: Number(g[3]) });
  }
  devs.sort((a, b) => a.idx - b.idx);
  /*
   * ⛔ Pair by PARTITION INDEX (mmcblk0pN -> names[N-1]), never by position in this list.
   * Positional pairing silently shifts every later label if one partition device is absent,
   * and a mislabelled device-unique image is a backup that restores the wrong bytes to the
   * wrong place. An index with no name keeps its device name rather than borrowing a
   * neighbour's.
   */
  return devs.map((d) => ({ dev: d.dev, blocks: d.blocks, name: names[d.idx - 1] ?? d.dev }));
}

async function deviceSha(serial: string, path: string): Promise<string | null> {
  const r = await adb(serial, ["shell", `busybox sha256sum ${path}`], 1_800_000);
  const g = r.out.trim().match(/^([0-9a-f]{64})/);
  return g ? g[1] : null;
}

async function localSha(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) h.update(chunk);
  return h.digest("hex");
}

async function main() {
  if (!Bun.which("adb")) { console.error("adb not found"); process.exit(2); }
  const argv = process.argv.slice(2);
  const all = argv.includes("--all");
  const verifyOnly = argv.includes("--verify");
  const oi = argv.indexOf("--only");
  const only = oi >= 0 ? new Set(argv[oi + 1].split(",")) : null;

  const dl = await adb("", ["devices"]).catch(() => null);
  const devs = (dl?.out ?? "").split("\n").slice(1)
    .map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device").map((p) => p[0]);
  const si = argv.indexOf("--serial");
  const serial = si >= 0 ? argv[si + 1] : devs[0];
  if (!serial) { console.error("no adb device — see `bun run himedia:recon` for the TCC note"); process.exit(1); }

  // Root is required to read the raw block devices. This box is an eng build, so
  // `adb root` restarts adbd as root without modifying anything.
  const id = await adb(serial, ["shell", "id"]);
  if (!/uid=0\(root\)/.test(id.out)) {
    console.log("[local] not root — asking adbd to restart as root (no change is made to the box)");
    await adb(serial, ["root"], 30_000);
    await new Promise((r) => setTimeout(r, 2500));
    const again = await adb(serial, ["shell", "id"]);
    if (!/uid=0\(root\)/.test(again.out)) {
      console.error("⛔ still not root. The raw partitions are root-only, so the dump cannot proceed.");
      console.error("   `ro.build.type` should be `eng` and `ro.debuggable` 1 for `adb root` to work.");
      process.exit(1);
    }
  }
  if (!await deviceSha(serial, "/dev/null")) {
    console.error("⛔ `busybox sha256sum` not usable on the device — cannot verify a dump end to end.");
    console.error("   Refusing to take an unverifiable dump: that is a false sense of backup.");
    process.exit(1);
  }

  const [pp, cl] = await Promise.all([
    adb(serial, ["shell", "cat /proc/partitions"]),
    adb(serial, ["shell", "cat /proc/cmdline"]),
  ]);
  const parts = mapPartitions(pp.out, cl.out);
  if (!parts.length) { console.error("⛔ could not enumerate partitions"); process.exit(1); }

  // eMMC boot areas + RPMB are separate from the 19 user partitions and are cheap insurance.
  const extras: Part[] = [];
  for (const e of ["mmcblk0boot0", "mmcblk0boot1"]) {
    const r = await adb(serial, ["shell", `cat /sys/block/${e}/size 2>/dev/null`]);
    const n = Number(r.out.trim());
    if (Number.isFinite(n) && n > 0) extras.push({ dev: e, name: e, blocks: n / 2 });
  }

  const chosen = [...parts, ...extras].filter((p) => {
    if (only) return only.has(p.name) || only.has(p.dev);
    if (DEVICE_UNIQUE.has(p.name)) return true;
    return all || !SKIP_BY_DEFAULT.has(p.name);
  });

  const totalMiB = chosen.reduce((a, p) => a + p.blocks, 0) / 1024;
  console.log(`[local->adb:${serial}] ${DEVICE.model} eMMC dump`);
  console.log(`[local] ${chosen.length} of ${parts.length + extras.length} partitions, ${totalMiB.toFixed(0)} MiB -> ${DIR}`);
  if (!all && !only) {
    const skipped = [...parts, ...extras].filter((p) => !chosen.includes(p)).map((p) => p.name);
    if (skipped.length) console.log(`[local] skipped (regenerable, pass --all to include): ${skipped.join(", ")}`);
  }
  console.log();

  mkdirSync(DIR, { recursive: true });
  const prev = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : { parts: {} };
  const out: Record<string, any> = prev.parts ?? {};
  let failed = 0;

  for (const p of chosen) {
    const file = `${DIR}/${p.name}.img`;
    const expectBytes = p.blocks * 1024;
    const tag = DEVICE_UNIQUE.has(p.name) ? " [device-unique]" : "";

    if (existsSync(file) && out[p.name]?.verified && statSync(file).size === expectBytes && !verifyOnly) {
      console.log(`  skip      ${p.name.padEnd(14)} already dumped and verified${tag}`);
      continue;
    }

    if (!verifyOnly) {
      process.stdout.write(`  dumping   ${p.name.padEnd(14)} ${(expectBytes / 1048576).toFixed(0)} MiB${tag} … `);
      const fh = Bun.file(file).writer();
      /*
       * ⛔ `cat`, NOT `dd`. This box's toybox dd writes its "N+0 records in" stats to
       * STDOUT, so `exec-out dd` returns the partition plus 91 trailing junk bytes — an
       * image that is almost the right size and silently corrupt. It also rejects
       * `bs=1M` as an "illegal number" and reports THAT on stdout too, yielding a 36-byte
       * file that looks like a short read. `cat` returns exactly the partition bytes.
       */
      const proc = Bun.spawn(["adb", "-s", serial, "exec-out", "cat", `/dev/block/${p.dev}`],
        { stdout: "pipe", stderr: "pipe" });
      for await (const chunk of proc.stdout) fh.write(chunk);
      await fh.end();
      const code = await proc.exited;
      if (code !== 0) { console.log(`FAILED (dd exit ${code})`); failed++; continue; }
    } else if (!existsSync(file)) {
      console.log(`  missing   ${p.name.padEnd(14)} nothing to verify`); failed++; continue;
    } else {
      process.stdout.write(`  verifying ${p.name.padEnd(14)}${tag} … `);
    }

    const localBytes = statSync(file).size;
    const [dSha, lSha] = await Promise.all([deviceSha(serial, `/dev/block/${p.dev}`), localSha(file)]);
    if (!dSha) { console.log("FAILED (no device hash)"); failed++; continue; }

    const v = dumpVerdict({ bytes: expectBytes, sha256: dSha }, { bytes: localBytes, sha256: lSha });
    out[p.name] = { dev: p.dev, bytes: localBytes, expectedBytes: expectBytes, sha256: lSha, deviceSha256: dSha,
                    verified: v.ok, deviceUnique: DEVICE_UNIQUE.has(p.name), at: new Date().toISOString() };
    if (v.ok) console.log(`ok  ${lSha.slice(0, 16)}…`);
    else { console.log(`⛔ ${v.reason}`); failed++; }
  }

  writeFileSync(MANIFEST, JSON.stringify({
    device: DEVICE.model, soc: DEVICE.soc, serial,
    firmwareOnBox: null, at: new Date().toISOString(), parts: out,
  }, null, 2));

  const good = Object.values(out).filter((p: any) => p.verified).length;
  const uniq = Object.entries(out).filter(([, v]: any) => v.deviceUnique && v.verified).length;
  console.log(`\n→ ${MANIFEST}`);
  console.log(`   ${good} partition(s) verified end to end; ${uniq} of them device-unique.`);

  writeFileSync(`${DIR}/RESTORE.md`, [
    `# Restoring the ${DEVICE.model} from this dump`, "",
    `Taken ${new Date().toISOString()} from adb serial \`${serial}\`.`, "",
    "⛔ **Every image here was verified by comparing a sha256 computed on the device against",
    "one computed locally.** Re-check before relying on it:", "",
    "```", "bun run himedia:dump --verify", "```", "",
    "## Order of restore",
    "",
    "1. Prefer the vendor path first: the stock `update.zip` on a FAT32 USB stick with the",
    "   RESTORE pinhole held at power-on. It is the only path that needs no console.",
    "2. If the box still boots to adb, write a single partition back:",
    "",
    "```",
    "adb root",
    "adb push <name>.img /data/local/tmp/<name>.img",
    "adb shell dd if=/data/local/tmp/<name>.img of=/dev/block/<dev> bs=1M",
    "```",
    "",
    "3. If it does not boot at all, the UART is the only rescue known to work on this model.",
    "",
    "## ⛔ Device-unique partitions",
    "",
    "These hold per-unit data (MAC address, calibration, keys) and **cannot be recovered from",
    "any generic firmware image**. If one is lost without a dump, it is lost permanently:", "",
    ...Object.entries(out).filter(([, v]: any) => v.deviceUnique)
      .map(([k, v]: any) => `- \`${k}\` → \`/dev/block/${v.dev}\` — ${v.bytes} B, sha256 \`${v.sha256}\`${v.verified ? "" : " ⚠️ NOT VERIFIED"}`),
    "",
    "## All images",
    "",
    "| partition | device | bytes | verified | sha256 |",
    "|---|---|---:|---|---|",
    ...Object.entries(out).map(([k, v]: any) =>
      `| \`${k}\` | \`${v.dev}\` | ${v.bytes} | ${v.verified ? "yes" : "**no**"} | \`${v.sha256.slice(0, 24)}…\` |`),
  ].join("\n"));
  console.log(`→ ${DIR}/RESTORE.md`);

  if (failed) { console.error(`\n⛔ ${failed} partition(s) failed. This is NOT a usable backup yet.`); process.exit(1); }
  console.log("\n✅ every selected partition is dumped and verified on both ends.");
}

if (import.meta.main) await main();
