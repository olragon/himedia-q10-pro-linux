#!/usr/bin/env bun
/**
 * Download the Vietnamese-distributor firmware set for the Q10 Pro.
 *
 * ⭐ Provenance matters here: this unit was sold in Vietnam and runs a VN build
 * (`2020-08-18.140128`), which is NEWER than the newest GLOBAL official (2.1.4, 2019-05-31).
 * So the global archive is a fallback, not a match, and the VN chain is the right lineage to
 * hold locally.
 *
 * ⚠️ None of these is the installed build either — the VN sources top out at 2.1.1 (2018).
 * They are kept because they are the official upgrade chain for this unit's lineage, and
 * because the downgrade package is a recovery tool in its own right.
 *
 * ⛔ Output to $HIMEDIA_ROOT, never the repo. Each file is hashed and recorded; a re-run
 * verifies instead of re-downloading.
 *
 * Usage:
 *   bun run himedia:vn-firmware              # download everything missing, then verify
 *   bun run himedia:vn-firmware --verify     # verify what is on disk, download nothing
 *   bun run himedia:vn-firmware --only 2.1.1-stock
 */
import { WORK_ROOT } from "./lib.ts";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";

const DIR = `${WORK_ROOT}/firmware/vn`;
const MANIFEST = `${DIR}/manifest.json`;

/**
 * Catalogue from hieuhien.vn (published 2019-12-13), which is the most complete VN listing
 * found. `note` records the vendor's own upgrade constraint — these packages are NOT
 * interchangeable and installing one out of order is how boxes get bricked.
 */
export const CATALOGUE = [
  /*
   * ⭐ THE EXACT BUILD INSTALLED ON THIS UNIT. Its metadata fingerprint is byte-identical to
   * what the box reports:
   *   HiSTBAndroidV6/Hi3798CV200/Hi3798CV200:7.0/HMD-2.1.7/2020-08-18.140128:eng/release-keys
   * Mediafire rather than Drive, so it needs a resolved tokenised URL — see himedia:usb notes.
   * ⚠️ A widely-cited page for this build links the Q30 package by mistake; the per-model
   * links came from the vendor's own 2.1.7 changelog.
   */
  { id: "2.1.7-q10pro-themed", android: "7.0", mediafire: "1bqf7zcpejcjw96",
    note: "⭐ HMD-2.1.7 / 2020-08-18.140128 — themed, Kodi 18.2. EXACT match for this unit." },
  { id: "2.1.1-stock", android: "7.0", drive: "1bp7ypv1E_YqSCCEBmeNGJOrywutI8soa",
    note: "Stock 2.1.1 — requires the box to be on 2.0.4 or later already" },
  { id: "2.1.1-googletv", android: "7.0", drive: "1MyVRtprvbUminOAVG_D7cvBdjLZE2jcB",
    note: "Google TV launcher variant of 2.1.1 — same constraint as above" },
  { id: "2.0.4-from-android7", android: "7.0", drive: "1XFN4zCDLnoxHOpic-bI0O0QKF8KhVpUw",
    note: "Stock 2.0.4 for boxes already running Android 7 — the stepping stone to 2.1.1" },
  { id: "downgrade-a7-to-a5.1", android: "5.1", drive: "0B1gM7Kl0YigwcUNSdURJc0I2ZTA",
    note: "⭐ Downgrades Android 7 back to 5.1. A full-image package, so it is also the most capable recovery tool in this set." },
  { id: "1.1.0-stock", android: "5.1", drive: "0B1gM7Kl0YigwMHo3c0tUd0pFeHc",
    note: "Oldest stock here; kept for completeness" },
] as const;

/**
 * Google Drive serves a confirmation interstitial for large files instead of the bytes.
 * The token must be scraped from that HTML and replayed with the same cookie jar.
 * ⚠️ A quota block arrives as a 200-shaped HTML page, not an HTTP error — so the only
 * reliable test is whether the body is HTML rather than an archive.
 */
async function driveDownload(id: string, dest: string): Promise<{ ok: boolean; reason: string }> {
  const jar = `${DIR}/.cookies-${id}`;
  const base = ["curl", "-sSL", "--compressed", "-m", "1800", "-c", jar, "-b", jar];
  const url = `https://drive.google.com/uc?export=download&id=${id}`;

  const probe = Bun.spawn([...base, "-D", `${DIR}/.hdr-${id}`, "-o", `${dest}.part`, url],
    { stdout: "pipe", stderr: "pipe" });
  if (await probe.exited !== 0) return { ok: false, reason: "curl failed on the first request" };

  const head = Buffer.from(await Bun.file(`${dest}.part`).slice(0, 4096).arrayBuffer()).toString("latin1");
  if (/^\s*<|<!DOCTYPE|<html/i.test(head)) {
    if (/quota|too many users|downloadQuotaExceeded/i.test(head)) {
      return { ok: false, reason: "Google Drive quota exceeded for this public file (200-shaped block)" };
    }
    const tok = head.match(/confirm=([0-9A-Za-z_-]+)/) ?? head.match(/name="confirm"\s+value="([^"]+)"/);
    const uuid = head.match(/name="uuid"\s+value="([^"]+)"/);
    if (!tok) return { ok: false, reason: "interstitial returned but no confirm token found" };
    const confirmUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=${tok[1]}`
      + (uuid ? `&uuid=${uuid[1]}` : "");
    const second = Bun.spawn([...base, "-o", `${dest}.part`, confirmUrl], { stdout: "pipe", stderr: "pipe" });
    if (await second.exited !== 0) return { ok: false, reason: "curl failed on the confirm request" };
    const h2 = Buffer.from(await Bun.file(`${dest}.part`).slice(0, 2048).arrayBuffer()).toString("latin1");
    if (/^\s*<|<!DOCTYPE|<html/i.test(h2)) return { ok: false, reason: "still HTML after confirm — likely quota or auth-walled" };
  }

  const size = statSync(`${dest}.part`).size;
  if (size < 1024 * 1024) return { ok: false, reason: `only ${size} B — too small to be a firmware package` };
  await Bun.spawn(["mv", `${dest}.part`, dest]).exited;
  return { ok: true, reason: "" };
}

async function sha256(p: string) {
  const h = new Bun.CryptoHasher("sha256");
  for await (const c of Bun.file(p).stream()) h.update(c);
  return h.digest("hex");
}

async function main() {
  const argv = process.argv.slice(2);
  const verifyOnly = argv.includes("--verify");
  const oi = argv.indexOf("--only");
  const only = oi >= 0 ? argv[oi + 1] : null;
  mkdirSync(DIR, { recursive: true });

  const prev = existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")).files ?? {} : {};
  const out: Record<string, any> = { ...prev };
  let failed = 0;

  for (const fw of CATALOGUE) {
    if (only && fw.id !== only) continue;
    const dest = `${DIR}/${fw.id}.zip`;

    if (!existsSync(dest)) {
      if (verifyOnly) { console.log(`  missing   ${fw.id}`); failed++; continue; }
      process.stdout.write(`  fetching  ${fw.id.padEnd(22)} … `);
      const r = await driveDownload(fw.drive, dest);
      if (!r.ok) { console.log(`⛔ ${r.reason}`); failed++; continue; }
    } else process.stdout.write(`  checking  ${fw.id.padEnd(22)} … `);

    const bytes = statSync(dest).size;
    const hash = await sha256(dest);
    const was = prev[fw.id];
    if (was && was.sha256 !== hash) {
      console.log(`⛔ CHANGED since the manifest (${was.sha256.slice(0, 12)} -> ${hash.slice(0, 12)})`);
      failed++;
    } else {
      console.log(`ok  ${(bytes / 1048576).toFixed(0)} MiB  ${hash.slice(0, 16)}…`);
    }
    out[fw.id] = { ...fw, bytes, sha256: hash, at: new Date().toISOString() };
  }

  writeFileSync(MANIFEST, JSON.stringify({
    source: "hieuhien.vn/tong-hop-firmware-rom-cua-android-box-himedia-q10-pro (published 2019-12-13)",
    installedOnBox: "2020-08-18.140128 — NEWER than anything in this set; none of these is an exact match",
    upgradeProcedure: [
      "Copy the package to the ROOT of a USB stick, named exactly `update.zip`.",
      "Do NOT rename it and do NOT unzip it.",
      "On the box: Settings -> Upgrade -> Local Upgrade, then pick the update.zip on the USB stick.",
      "It takes roughly 5 minutes and reboots itself. Do not interrupt it.",
      "⛔ Respect the version constraints in each entry's `note`; these packages are not interchangeable.",
    ],
    at: new Date().toISOString(), files: out,
  }, null, 2));

  console.log(`\n→ ${MANIFEST}`);
  if (failed) { console.error(`⛔ ${failed} entr(ies) failed.`); process.exit(1); }
  console.log("✅ all requested packages present and hash-stable.");
}

if (import.meta.main) await main();
