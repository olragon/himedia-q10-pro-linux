#!/usr/bin/env bun
/**
 * Prepare a FAT32 USB stick for the Q10 Pro's vendor recovery flow.
 *
 * Two modes, and the distinction is the whole point:
 *
 *   --probe    (default) writes a DELIBERATELY INVALID `update.zip`. This proves the
 *              recovery CHAIN — pinhole triggers recovery, recovery boots, it reads USB,
 *              it finds the file — while writing NOTHING to the box, because recovery
 *              rejects a bad package before it flashes anything.
 *
 *   --restore  writes the real stock `update.zip`. ⛔ This REFLASHES the box, including
 *              the bootloader, and the archived firmware (2.1.4, 2019) is OLDER than what
 *              this unit runs (2020-08-18) — so it is a DOWNGRADE. A full-firmware flash
 *              with a version change is exactly what produced the one documented brick on
 *              this model. Use it to recover, never to test.
 *
 * ⛔ Formatting is destructive, so the target is validated first: it must be a whole,
 * external, REMOVABLE USB disk of a plausible size. Anything internal, or not removable,
 * is refused regardless of flags.
 *
 * Usage:
 *   bun run himedia:usb --disk disk4            # dry run, shows what it would do
 *   bun run himedia:usb --disk disk4 --apply
 *   bun run himedia:usb --disk disk4 --restore --apply
 *   bun run himedia:usb --disk disk4 --kernel --image <uImage> --rootfs <img> --apply
 *     (--rootfs also lands the Debian root as rootfs.img; init.sh loop-mounts it)
 */
import { WORK_ROOT } from "./lib.ts";
import { existsSync, mkdirSync, writeFileSync, statSync, readdirSync } from "node:fs";

const FW = `${WORK_ROOT}/firmware`;
const LABEL = "Q10RECOV";

async function cap(cmd: string[], timeoutMs = 300_000) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(t);
  return { out, err, code };
}

export type DiskFacts = { whole: boolean; removable: boolean; internal: boolean; bytes: number; name: string };

export function parseDiskInfo(out: string): DiskFacts {
  const get = (k: string) => out.split("\n").find((l) => l.trim().startsWith(k))?.split(":").slice(1).join(":").trim() ?? "";
  const size = get("Disk Size").match(/\((\d+) Bytes\)/);
  return {
    whole: /^Yes/i.test(get("Whole")),
    removable: /^(Yes|Removable)/i.test(get("Removable Media")),
    internal: /^Yes/i.test(get("Internal")),
    bytes: size ? Number(size[1]) : 0,
    name: get("Device / Media Name"),
  };
}

/**
 * Refuse anything that is not plainly a removable external stick. A wrong device here
 * destroys a disk, so every condition must be satisfied — not merely most of them.
 */
export function validateTarget(f: DiskFacts): string[] {
  const bad: string[] = [];
  if (!f.whole) bad.push("not a whole disk (pass diskN, not diskNsM)");
  if (!f.removable) bad.push("media is not removable");
  if (f.internal) bad.push("disk is internal");
  if (f.bytes < 256 * 1024 ** 2) bad.push(`implausibly small (${f.bytes} B)`);
  if (f.bytes > 512 * 1024 ** 3) bad.push(`implausibly large for a stick (${f.bytes} B) — refusing in case this is storage`);
  return bad;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const disk = (arg("--disk") ?? "").replace(/^\/dev\//, "");
  const apply = argv.includes("--apply");
  const restore = argv.includes("--restore");

  if (!/^disk\d+$/.test(disk)) { console.error("usage: --disk disk4   (a whole disk, not a partition)"); process.exit(2); }

  const info = await cap(["diskutil", "info", disk]);
  if (info.code !== 0) { console.error(`⛔ diskutil info ${disk} failed`); process.exit(1); }
  const facts = parseDiskInfo(info.out);
  const bad = validateTarget(facts);

  console.log(`[local] target /dev/${disk} — "${facts.name}", ${(facts.bytes / 1024 ** 3).toFixed(1)} GB`);
  console.log(`[local] whole=${facts.whole} removable=${facts.removable} internal=${facts.internal}`);
  if (bad.length) {
    console.error(`\n⛔ refusing /dev/${disk}:`);
    for (const b of bad) console.error(`   • ${b}`);
    process.exit(1);
  }

  const kernel = argv.includes("--kernel");
  const mode = kernel ? "kernel" : restore ? "restore" : "probe";
  const stage = `${WORK_ROOT}/usb-stage`;
  mkdirSync(stage, { recursive: true });

  let payload: string;
  let destName = "update.zip";
  if (kernel) {
    /*
     * The patched bootcmd loads exactly `uImage` from `usb 0:1`, so the filename is fixed.
     * ⛔ Deliberately NOT named update.zip: a stick carrying both would be ambiguous, and a
     * stray update.zip is what the RESTORE path consumes. One purpose per stick.
     */
    /*
     * `--image <path>` selects a different uImage, which is how the bare-metal test stubs are
     * flashed (`himedia:stub`). Every check below still applies to it — a stub that fails the
     * CRC or carries the wrong arch field would produce a frozen logo and be misread as
     * "our code never ran", which is the exact answer the stub exists to establish.
     */
    const ii = argv.indexOf("--image");
    payload = ii >= 0 ? argv[ii + 1] : `${WORK_ROOT}/kernel-build-arm32/uImage`;
    destName = "uImage";
    if (!existsSync(payload)) {
      console.error(ii >= 0
        ? `⛔ ${payload} missing (from --image).`
        : `⛔ ${payload} missing. Run \`bun run himedia:build-arm32\` first.`);
      process.exit(1);
    }
    // Refuse to ship an image the stock 32-bit loader will reject.
    const h = Buffer.from(await Bun.file(payload).slice(0, 32).arrayBuffer());
    if (h.readUInt32BE(0) !== 0x27051956) { console.error("⛔ not a uImage"); process.exit(1); }
    if (h[29] !== 2) {
      console.error(`⛔ uImage arch=${h[29]}, expected 2 (ARM). The stock loader rejects anything else.`);
      process.exit(1);
    }
    console.log(`[local] mode: KERNEL — ${(statSync(payload).size / 1048576).toFixed(1)} MiB, arch=2 (ARM)`);
    console.log(`[local] a failed boot falls through to the stock eMMC boot, i.e. Android.`);
  } else if (restore) {
    // The real package lives inside the archived .rar; himedia:inspect already extracted it.
    const cands: string[] = [];
    const walk = (d: string) => { for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) walk(p); else if (e.name === "update.zip") cands.push(p);
    } };
    const ex = `${WORK_ROOT}/extracted`;
    if (existsSync(ex)) walk(ex);
    if (!cands.length) {
      console.error("⛔ no extracted update.zip found. Run `bun run himedia:inspect` first.");
      process.exit(1);
    }
    payload = cands.sort((a, b) => statSync(b).size - statSync(a).size)[0];
    console.log(`[local] mode: RESTORE — real package ${payload} (${(statSync(payload).size / 1048576).toFixed(0)} MiB)`);
    console.log(`\n⛔ THIS REFLASHES THE BOX, BOOTLOADER INCLUDED, AND IT IS A DOWNGRADE`);
    console.log(`   (archive 2.1.4 / 2019 vs the 2020-08-18 build installed).`);
    console.log(`   A full-firmware flash with a version change is what bricked another unit.`);
  } else {
    /*
     * An invalid package on purpose. Recovery must verify before it writes, so this
     * exercises the whole chain and stops at the verification step. If this somehow
     * flashes something, that is itself the most important finding available.
     */
    payload = `${stage}/update.zip`;
    writeFileSync(payload, Buffer.from(
      "This is NOT a firmware package.\n" +
      "It exists to prove the Q10 Pro recovery chain (RESTORE pinhole -> recovery -> USB ->\n" +
      "package found) without writing anything to the box. Recovery should reject it.\n", "utf8"));
    console.log(`[local] mode: PROBE — intentionally invalid update.zip (${statSync(payload).size} B)`);
    console.log(`[local] proves the chain works; cannot flash anything, by construction.`);
  }

  /*
   * ⛔ Formatting is NOT the default any more.
   *
   * The loader only needs one file at the root of a FAT32 partition, so erasing the whole
   * disk was never required — it was just convenient. It cost real data once: a device was
   * authorised by name, the name was wrong, and every structural check (whole, external,
   * removable, plausible size) legitimately passed because a USB card reader is
   * indistinguishable from a stick. The checks were not wrong; erasing by default was.
   *
   * So: reuse an existing FAT32 partition unless --format is given, and when --format IS
   * given, refuse a disk that holds user data unless --force-erase confirms it.
   */
  const wantFormat = argv.includes("--format");
  const existing = await cap(["diskutil", "info", `${disk}s1`]);
  const fat = /Windows_FAT_32|msdos|FAT32/i.test(existing.out);
  let mountPoint = (existing.out.split("\n").find((l) => l.trim().startsWith("Mount Point")) ?? "").split(":").slice(1).join(":").trim();

  if (!wantFormat && fat) {
    if (!mountPoint) {
      await cap(["diskutil", "mount", `${disk}s1`]);
      const again = await cap(["diskutil", "info", `${disk}s1`]);
      mountPoint = (again.out.split("\n").find((l) => l.trim().startsWith("Mount Point")) ?? "").split(":").slice(1).join(":").trim();
    }
    if (!mountPoint) { console.error(`⛔ ${disk}s1 is FAT32 but would not mount`); process.exit(1); }
    const kept = readdirSync(mountPoint).filter((f) => !f.startsWith(".") && f !== destName);
    console.log(`[local] reusing the existing FAT32 volume at ${mountPoint} (NOT formatting)`);
    if (kept.length) console.log(`[local] leaving ${kept.length} existing item(s) untouched: ${kept.slice(0, 5).join(", ")}${kept.length > 5 ? " …" : ""}`);
    if (!apply) {
      console.log(`\nDRY RUN. Would copy:\n  ${payload}\n  -> ${mountPoint}/${destName}`);
      console.log(`\nRe-run with --apply. (Pass --format only if the disk really should be erased.)`);
      return;
    }
    // ⭐ Byte-compare, not size-compare: a size match is what a truncated-then-padded copy
    // also gives, and U-Boot runs with verify=n, so a corrupt uImage executes, not rejects.
    const land = async (src: string, name: string) => {
      const dst = `${mountPoint}/${name}`;
      const c = await cap(["cp", src, dst], 900_000);
      await cap(["sync"]);
      const same = await cap(["cmp", src, dst], 900_000);
      if (c.code !== 0 || same.code !== 0) { console.error(`⛔ ${name} did not land byte-identical`); process.exit(1); }
      console.log(`✅ ${dst} (${statSync(dst).size} B, byte-identical)`);
    };
    await land(payload, destName);
    const rootfs = arg("--rootfs");
    if (kernel && rootfs) {
      if (!existsSync(rootfs)) { console.error(`⛔ ${rootfs} missing (from --rootfs)`); process.exit(1); }
      if (statSync(rootfs).size >= 4 * 1024 ** 3) { console.error("⛔ rootfs image >= 4 GiB: FAT32 cannot hold it"); process.exit(1); }
      await land(rootfs, "rootfs.img");
    }
    printNextSteps(mode, disk, destName);
    return;
  }

  if (wantFormat) {
    const vols = readdirSync("/Volumes").filter((v) => v !== "Macintosh HD");
    console.log(`[local] --format given: this ERASES /dev/${disk} entirely.`);
    if (!argv.includes("--force-erase")) {
      console.error(`⛔ refusing to erase without --force-erase.`);
      console.error(`   A disk authorised by name can be the wrong disk; name it AND confirm it.`);
      console.error(`   Mounted volumes right now: ${vols.join(", ") || "(none)"}`);
      process.exit(1);
    }
  }

  if (!apply) {
    console.log(`\nDRY RUN. Would:`);
    console.log(`  1. diskutil eraseDisk MS-DOS ${LABEL} MBRFormat /dev/${disk}`);
    console.log(`  2. copy ${payload} -> /Volumes/${LABEL}/${destName}`);
    console.log(`\nRe-run with --apply to do it.`);
    return;
  }

  console.log(`\n[local] erasing /dev/${disk} as FAT32 (MS-DOS), label ${LABEL} …`);
  const er = await cap(["diskutil", "eraseDisk", "MS-DOS", LABEL, "MBRFormat", `/dev/${disk}`]);
  if (er.code !== 0) { console.error(`⛔ erase failed:\n${er.out}${er.err}`); process.exit(1); }

  const mnt = `/Volumes/${LABEL}`;
  if (!existsSync(mnt)) { console.error(`⛔ ${mnt} did not appear after erase`); process.exit(1); }
  const dest = `${mnt}/${destName}`;
  await cap(["cp", payload, dest]);
  await cap(["sync"]);
  if (!existsSync(dest) || statSync(dest).size !== statSync(payload).size) {
    console.error("⛔ copy did not land with the expected size"); process.exit(1);
  }
  console.log(`✅ ${dest} (${statSync(dest).size} B)`);
  const fs = await cap(["diskutil", "info", `${disk}s1`]);
  console.log(`   filesystem: ${parseDiskInfo(fs.out).name || (fs.out.match(/Type \(Bundle\):\s*(\S+)/)?.[1] ?? "?")}`);

  console.log(`\nNow, on the box:`);
  console.log(`  1. Power it off and unplug the power.`);
  console.log(`  2. Insert this stick (a USB 2.0 port is the safer choice).`);
  console.log(`  3. Hold the RESTORE pinhole (rear panel, beside the DC jack) with a toothpick.`);
  console.log(`  4. Plug the power back in, keeping RESTORE held for ~5-10 s, then release.`);
  console.log(`  5. Watch the front LED and the HDMI output.`);
  printNextSteps(mode, disk, destName);
}

function printNextSteps(mode: string, disk: string, destName: string) {
  if (mode === "kernel") {
    console.log(`
Then on the box:
  1. Power off and unplug the power.
  2. Insert this stick (a USB 2.0 port is the safer choice).
  3. Plug the power back in. No button to hold — the patched bootcmd tries USB by itself.
  4. Watch HDMI and the front LED.

Expected:
  • if this image is the mainline kernel: it boots 6.18.55 (AArch32).
  • if it is a bare-metal test stub (himedia:stub): the box REBOOT-LOOPS, i.e. the logo
    redraws over and over. Stop it by UNPLUGGING THE STICK, then power-cycle.
  • either way, Android booting instead means the loader did not take the uImage.
⛔ Either way the box survives; nothing is written to eMMC.`);
    console.log(`\nAfterwards: diskutil eject /dev/${disk}`);
    return;
  }
  console.log(mode === "probe" ? `
Expected for PROBE — any of these means the chain WORKS:
  • an update/recovery screen appears, then an error about the package, or
  • the front LED changes from its normal clock/boot text, then it returns to Android.
⛔ If it flashes anyway, stop and tell me — that would mean recovery does not verify,
   which changes the risk of every later step.
⚠️ If NOTHING happens (it just boots Android normally), the pinhole or the USB read is not
   working, and that is the XDA failure mode. Then the UART really is needed first.` : `
Expected for RESTORE: the vendor update flow runs to completion. Do not interrupt it.`);
  console.log(`\nAfterwards: \`diskutil eject /dev/${disk}\``);
}

if (import.meta.main) await main();
