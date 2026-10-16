#!/usr/bin/env bun
/**
 * Step 2 of the Q10 Pro conversion: archive the stock firmware BEFORE touching the box.
 *
 * ⛔ Why this is urgent rather than routine: the vendor's own site (himediatech.com) has an
 * EXPIRED TLS CERTIFICATE and failed on every fetch rung including a real browser, so the
 * only remaining sources are third-party mirrors — and mirrors rot. Without this file the
 * box is not restorable, and the whole conversion stops being reversible.
 *
 * Downloads to $HIMEDIA_ROOT/firmware (off-repo — large artifacts never enter git),
 * records sha256 + size in a manifest, and on later runs VERIFIES against that manifest
 * instead of re-downloading.
 *
 * Usage:
 *   bun run himedia:firmware            # download if absent, else verify
 *   bun run himedia:firmware --verify   # verify only, never download
 *
 * ref: docs/261009-sota-himedia-q10-pro-linux-summary.md
 */
import { STOCK_FIRMWARE, WORK_ROOT, RESTORE_PROCEDURE, DEVICE } from "./lib.ts";
import { mkdirSync, existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";

const DIR = `${WORK_ROOT}/firmware`;
const MANIFEST = `${DIR}/manifest.json`;

/** Streamed: the archive is ~600 MB, so never hold it all in memory at once. */
async function sha256(path: string): Promise<string> {
  const h = new Bun.CryptoHasher("sha256");
  const stream = Bun.file(path).stream();
  for await (const chunk of stream) h.update(chunk);
  return h.digest("hex");
}

function archives(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => /\.(zip|rar|7z|img|tar\.gz|tgz)$/i.test(f))
    .map((f) => `${DIR}/${f}`);
}

/**
 * megadl writes `.megatmp.<id>` while downloading and renames on completion. That name
 * matches no archive extension, so without this check a second invocation would look at an
 * empty directory and cheerfully start a CONCURRENT download of the same 600 MB file.
 * Found the hard way.
 */
export function partials(): Array<{ path: string; bytes: number }> {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR)
    .filter((f) => f.startsWith(".megatmp") || f.endsWith(".part"))
    .map((f) => ({ path: `${DIR}/${f}`, bytes: statSync(`${DIR}/${f}`).size }));
}

/** Is some other process already pulling this file? */
async function downloadRunning(): Promise<boolean> {
  const p = Bun.spawn(["pgrep", "-f", "megadl"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out.trim().length > 0;
}

async function main() {
  const verifyOnly = process.argv.includes("--verify");
  mkdirSync(DIR, { recursive: true });

  let files = archives();

  const inFlight = partials();
  if (inFlight.length && !verifyOnly) {
    const running = await downloadRunning();
    for (const p of inFlight) {
      console.log(`  partial: ${p.path.split("/").pop()}  ${(p.bytes / 1024 / 1024).toFixed(1)} MB`);
    }
    if (running) {
      console.log("\nA megadl download is already running — not starting a second one.");
      console.log("Watch it with:  ls -la " + DIR);
      process.exit(0);
    }
    console.log("\nA partial download exists but no megadl is running. Re-run to resume it");
    console.log("(megadl resumes from .megatmp), or delete the partial to start clean.");
  }

  if (files.length === 0) {
    if (verifyOnly) {
      console.error(`Nothing to verify — no archive in ${DIR}`);
      process.exit(1);
    }
    if (!Bun.which("megadl")) {
      console.error("megadl not found. `brew install megatools`");
      process.exit(2);
    }
    console.log(`[local] ${DEVICE.model} stock firmware v${STOCK_FIRMWARE.version} (Android ${STOCK_FIRMWARE.android})`);
    console.log(`[local] mirror: ${STOCK_FIRMWARE.url}`);
    console.log(`[local] -> ${DIR}\n`);

    // The MEGA decryption key lives in the URL fragment — pass the URL whole and unquoted-safe.
    const p = Bun.spawn(["megadl", "--path", DIR, STOCK_FIRMWARE.url], { stdout: "inherit", stderr: "inherit" });
    const code = await p.exited;
    if (code !== 0) {
      console.error(`\nmegadl exited ${code}. The mirror may be gone — this is exactly the rot this script exists to beat.`);
      console.error(`Fallbacks: the 4PDA thread's firmware index (needs a login), or the futeko forum.`);
      process.exit(1);
    }
    files = archives();
    if (files.length === 0) {
      console.error(`megadl reported success but no archive landed in ${DIR}.`);
      console.error("A step that reports an outcome it did not verify is a ritual, not a gate.");
      process.exit(1);
    }
  }

  const prev: Record<string, { sha256: string; bytes: number }> =
    existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")).files ?? {} : {};
  const now: Record<string, { sha256: string; bytes: number }> = {};
  let drift = false;

  for (const f of files) {
    const name = f.split("/").pop()!;
    const bytes = statSync(f).size;
    const hash = await sha256(f);
    now[name] = { sha256: hash, bytes };
    const was = prev[name];
    if (was && (was.sha256 !== hash || was.bytes !== bytes)) {
      console.error(`  ⛔ ${name}: CHANGED since the manifest — was ${was.bytes}B/${was.sha256.slice(0, 12)}, now ${bytes}B/${hash.slice(0, 12)}`);
      drift = true;
    } else {
      console.log(`  ${was ? "verified" : "recorded"}  ${name}  ${(bytes / 1024 / 1024).toFixed(1)} MB  ${hash.slice(0, 16)}…`);
    }
  }

  writeFileSync(MANIFEST, JSON.stringify({
    device: DEVICE.model, soc: DEVICE.soc,
    firmware: { version: STOCK_FIRMWARE.version, android: STOCK_FIRMWARE.android, url: STOCK_FIRMWARE.url, source: STOCK_FIRMWARE.source },
    at: new Date().toISOString(), files: now,
    restoreProcedure: RESTORE_PROCEDURE,
  }, null, 2));

  console.log(`\n→ manifest: ${MANIFEST}`);
  console.log("\n— the vendor's documented restore path (best effort, NOT a proof of safety) —");
  RESTORE_PROCEDURE.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));
  console.log("\n⚠️  A documented brick exists in which this path did NOT recover the box.");
  console.log("    Treat the UART as the real rescue, and find it before any write to eMMC.");

  if (drift) process.exit(1);
}

if (import.meta.main) await main();
