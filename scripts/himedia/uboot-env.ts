#!/usr/bin/env bun
/**
 * Read and rewrite the Q10 Pro's U-Boot environment — the no-disassembly route to booting
 * our own kernel.
 *
 * ⭐ Why this exists. The stock loader's console is serial-only (`stdin/stdout=serial`) and
 * `bootdelay=0`, so autoboot cannot be interrupted even WITH a UART. But the loader does
 * have full USB host + FAT support (`usb start`, `usb dev/part/read`, `fatload`). It simply
 * is not configured to use it. So one small change to the environment turns the box into
 * something that tries a USB stick first and falls back to the stock eMMC boot.
 *
 * ⭐ That trade is the whole point: ONE small reversible write buys unlimited risk-free
 * iteration afterwards. Every later experiment is just a different file on a USB stick, and
 * a failure falls through to Android instead of needing a rescue.
 *
 * Three independent fallbacks, by construction:
 *   1. a failed `fatload`/`bootm` falls through to the original eMMC commands, which are
 *      appended verbatim — so no stick, or a bad kernel, simply boots Android;
 *   2. a CORRUPT env makes U-Boot print "bad CRC" and use its compiled-in defaults, which
 *      also boot from eMMC;
 *   3. `bootargs.img` is dumped and hash-verified, so the original env can be written back.
 *
 * ⛔ Dry run by default. `--apply` is the only thing that writes to the box.
 *
 * Usage:
 *   bun run himedia:env show                     # decode the dumped env
 *   bun run himedia:env plan                     # show the new env + exact diff (no writes)
 *   bun run himedia:env plan --apply             # write it to the box, then read back
 *   bun run himedia:env restore --apply          # put the original env back
 */
import { WORK_ROOT } from "./lib.ts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const DUMP = `${WORK_ROOT}/emmc-dump/bootargs.img`;
const OUT = `${WORK_ROOT}/emmc-dump/bootargs.patched.img`;
/** Verified against the dump: CRC32 covers 0x10000-4 bytes after the 4-byte CRC. */
export const ENV_SIZE = 0x10000;
const ENV_DEV = "/dev/block/mmcblk0p2";

/** Load address the stock bootcmd already uses for the kernel — reuse it rather than invent one. */
const LOAD_ADDR = "0x1FFBFC0";

export function parseEnv(buf: Buffer): { crc: number; vars: Map<string, string>; crcOk: boolean } {
  const crc = buf.readUInt32LE(0);
  const body = buf.subarray(4, ENV_SIZE);
  const end = body.indexOf(Buffer.from([0, 0]));
  const vars = new Map<string, string>();
  for (const chunk of body.subarray(0, end < 0 ? body.length : end).toString("latin1").split("\0")) {
    if (!chunk) continue;
    const i = chunk.indexOf("=");
    if (i > 0) vars.set(chunk.slice(0, i), chunk.slice(i + 1));
  }
  return { crc, vars, crcOk: crc32(body) === crc };
}

/** U-Boot uses plain zlib CRC32 over the env body. */
export function crc32(buf: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

export function buildEnv(vars: Map<string, string>): Buffer {
  const text = [...vars].map(([k, v]) => `${k}=${v}`).join("\0") + "\0\0";
  const body = Buffer.alloc(ENV_SIZE - 4, 0x00);
  const t = Buffer.from(text, "latin1");
  if (t.length > body.length) throw new Error(`env too large: ${t.length} > ${body.length}`);
  t.copy(body);
  const out = Buffer.alloc(ENV_SIZE);
  out.writeUInt32LE(crc32(body), 0);
  body.copy(out, 4);
  return out;
}

/**
 * Insert a USB attempt into the stock boot sequence — AFTER the TEE, before the kernel.
 *
 * ⛔ The stock bootcmd has TWO stages and the order matters:
 *     mmc read 0 0x7E700000 0x69000 0x4000; bootm 0x7E700000;   <- blk 0x69000 = 210 MiB
 *                                                                  = trustedcore, the TEE
 *     mmc read 0 0x1FFBFC0 0x4B000 0xC800;  bootm 0x1FFBFC0     <- blk 0x4B000 = 150 MiB
 *                                                                  = the kernel
 *
 * An earlier version prepended the USB attempt in front of BOTH, so anything booted from
 * USB never got the TEE. That broke two different kernels and looked like two unrelated
 * bugs: the STOCK kernel reached Android's UI and then hung (no keystore/DRM), and our
 * mainline kernel hung during init — because `trustedcore` is where **BL31** lives, and BL31
 * is what provides **PSCI**. Our device tree asks for `enable-method = "psci"` on all four
 * CPUs, so with no TEE there is nothing to answer the SMP bring-up call.
 *
 * ⇒ Keep stage one, slot the USB attempt in, then fall through to the stock kernel.
 *
 * ⚠️ Separated by `;` deliberately, NOT `&&`: U-Boot only has `&&` with the hush parser, and
 * with `;` a failed load simply continues to the next command. The fallback is the shell's
 * natural behaviour rather than something we rely on.
 */
export function usbFirstBootcmd(original: string): string {
  const usb = [
    "usb start",
    `fatload usb 0:1 ${LOAD_ADDR} uImage`,
    `bootm ${LOAD_ADDR}`,
  ].join("; ");

  // Split before the SECOND `mmc read` — the kernel load. Everything before it is the TEE
  // stage and must run first.
  const parts = [...original.matchAll(/mmc read/g)].map((m) => m.index!);
  if (parts.length >= 2) {
    const cut = parts[1];
    const teeStage = original.slice(0, cut).replace(/;\s*$/, "");
    const kernelStage = original.slice(cut);
    return `${teeStage}; ${usb}; ${kernelStage}`;
  }
  // Only one stage: nothing to preserve ahead of us.
  return `${usb}; ${original}`;
}

async function adbSh(cmd: string, timeoutMs = 120_000) {
  const p = Bun.spawn(["adb", "shell", cmd], { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(t);
  return { out: out.replace(/\r/g, ""), err, code };
}

async function main() {
  const [action = "show"] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const apply = process.argv.includes("--apply");

  if (!existsSync(DUMP)) {
    console.error(`⛔ ${DUMP} missing. Run \`bun run himedia:dump\` first — the original env`);
    console.error("   is the thing that makes this reversible, so it is required, not optional.");
    process.exit(1);
  }
  const orig = readFileSync(DUMP);
  const env = parseEnv(orig);

  if (action === "show") {
    console.log(`[local] ${DUMP}`);
    console.log(`[local] stored CRC 0x${env.crc.toString(16).padStart(8, "0")} · recomputed ${env.crcOk ? "MATCHES ✅" : "MISMATCH ⛔"} · ${env.vars.size} vars\n`);
    for (const [k, v] of env.vars) console.log(`  ${k}=${v.length > 120 ? v.slice(0, 120) + "…" : v}`);
    console.log(`\nThe three that decide the route:`);
    console.log(`  bootdelay = ${env.vars.get("bootdelay")}   (0 = autoboot cannot be interrupted, even over serial)`);
    console.log(`  stdin     = ${env.vars.get("stdin")}  (serial only — no HDMI console, no USB keyboard)`);
    console.log(`  bootcmd   = eMMC only; the loader never looks at USB as shipped`);
    return;
  }

  if (!env.crcOk) { console.error("⛔ the dumped env fails its own CRC — refusing to build from it"); process.exit(1); }

  const vars = new Map(env.vars);
  if (action === "plan") {
    const before = vars.get("bootcmd")!;
    if (before.includes("usb start")) {
      console.log("ℹ️  the dumped env ALREADY tries USB first — nothing to change.");
      return;
    }
    vars.set("bootcmd", usbFirstBootcmd(before));
  } else if (action !== "restore") {
    console.error(`unknown action: ${action}`); process.exit(2);
  }

  const built = action === "restore" ? orig.subarray(0, ENV_SIZE) : buildEnv(vars);
  writeFileSync(OUT, built);

  console.log(`[local] action: ${action}${apply ? "" : "  (DRY RUN — nothing written to the box)"}\n`);
  if (action === "plan") {
    console.log(`  bootcmd BEFORE:\n    ${env.vars.get("bootcmd")}\n`);
    console.log(`  bootcmd AFTER:\n    ${vars.get("bootcmd")}\n`);
    console.log("  Fallbacks, in order:");
    console.log("    1. no stick / no uImage / bad kernel  -> falls through to the stock eMMC boot");
    console.log("    2. corrupt env                        -> U-Boot uses compiled-in defaults, also eMMC");
    console.log("    3. anything else                      -> `himedia:env restore --apply`\n");
  }
  console.log(`  image: ${OUT} (${built.length} B, CRC 0x${built.readUInt32LE(0).toString(16)})`);

  if (!apply) {
    console.log(`\nTo apply (writes ${ENV_SIZE} B to ${ENV_DEV}):`);
    console.log(`  bun run himedia:env ${action} --apply`);
    return;
  }

  // ⛔ The only writing path in this file.
  console.log(`\n[local->adb] writing ${ENV_SIZE} B to ${ENV_DEV}`);
  // Ask adbd to restart as root rather than failing with an instruction. This is an eng
  // build, so it costs nothing and changes nothing on the box.
  let id = await adbSh("id");
  if (!/uid=0\(root\)/.test(id.out)) {
    const p = Bun.spawn(["adb", "root"], { stdout: "pipe", stderr: "pipe" });
    await p.exited;
    await new Promise((r) => setTimeout(r, 2500));
    id = await adbSh("id");
  }
  if (!/uid=0\(root\)/.test(id.out)) { console.error("⛔ cannot get root; the env partition is root-only"); process.exit(1); }

  const push = Bun.spawn(["adb", "push", OUT, "/data/local/tmp/env.img"], { stdout: "inherit", stderr: "inherit" });
  if (await push.exited !== 0) { console.error("⛔ push failed"); process.exit(1); }
  const w = await adbSh(`cat /data/local/tmp/env.img > ${ENV_DEV} && sync`);
  if (w.code !== 0) { console.error(`⛔ write failed: ${w.err}`); process.exit(1); }

  // Read back and compare — a write that is not verified is not a write.
  const rb = Bun.spawn(["adb", "exec-out", "cat", ENV_DEV], { stdout: "pipe", stderr: "pipe" });
  const got = Buffer.from(await new Response(rb.stdout).arrayBuffer());
  await rb.exited;
  const same = got.subarray(0, ENV_SIZE).equals(built);
  await adbSh("rm -f /data/local/tmp/env.img");
  console.log(same ? "✅ read back and byte-identical." : "⛔ read-back MISMATCH — restore before rebooting.");
  if (!same) process.exit(1);
  console.log("\n⛔ Do not reboot until a recovery path has been PROVEN on this box.");
}

if (import.meta.main) await main();
