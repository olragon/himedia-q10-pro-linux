#!/usr/bin/env bun
/**
 * Step 1 of the Q10 Pro conversion: READ-ONLY recon over adb.
 *
 * ⛔ Every command this runs is a read. No property sets, no writes, no reboot. A read
 * must never be a write.
 *
 * Writes a timestamped report to $HIMEDIA_ROOT/recon/ so the next session has the facts
 * even if the box is later reflashed.
 *
 * Usage:
 *   bun run himedia:recon                 # auto-pick the single connected device
 *   bun run himedia:recon --serial <id>   # name the device explicitly
 *   bun run himedia:recon --list          # just list adb devices
 *
 * ref: docs/261009-sota-himedia-q10-pro-linux-summary.md
 */
import { RECON, WORK_ROOT, DEVICE, parseBlkDevParts } from "./lib.ts";
import { mkdirSync, writeFileSync } from "node:fs";

async function sh(cmd: string[], timeoutMs = 20_000): Promise<{ out: string; code: number }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  // Bun.spawnSync's `timeout` option DOES NOT FIRE — kill explicitly instead.
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(t);
  return { out: (out + (err && !out ? err : "")).trimEnd(), code };
}

async function devices(): Promise<string[]> {
  const { out } = await sh(["adb", "devices"]);
  return out.split("\n").slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length >= 2 && p[1] === "device")
    .map((p) => p[0]);
}

async function main() {
  const argv = process.argv.slice(2);
  if (!Bun.which("adb")) {
    console.error("adb not found. `brew install android-platform-tools`");
    process.exit(2);
  }

  const found = await devices();
  if (argv.includes("--list")) {
    console.log(found.length ? found.join("\n") : "(no devices in `device` state)");
    return;
  }

  const i = argv.indexOf("--serial");
  const serial = i >= 0 ? argv[i + 1] : found[0];
  if (!serial) {
    console.error(
      "No adb device.\n" +
      "  • enable ADB in the box's settings (Android 7 stock exposes it)\n" +
      "  • over the network: adb connect <box-ip>:5555\n" +
      "  ⛔ From a tmux-rooted shell a LAN `adb connect` is denied by macOS Local Network\n" +
      "     TCC and reports the misleading 'No route to host'. Run it from Terminal.app:\n" +
      "     bun run shell:via-terminal \"adb connect <box-ip>:5555\" --name adb-connect",
    );
    process.exit(1);
  }
  if (found.length > 1 && i < 0) {
    console.error(`Several devices (${found.join(", ")}) — name one with --serial`);
    process.exit(1);
  }

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").replace(/\..*$/, "");
  const dir = `${WORK_ROOT}/recon`;
  mkdirSync(dir, { recursive: true });

  console.log(`[local->adb:${serial}] ${DEVICE.model} — read-only recon, ${RECON.length} probes\n`);
  const results: Record<string, { cmd: string; why: string; out: string; code: number }> = {};

  for (const step of RECON) {
    const { out, code } = await sh(["adb", "-s", serial, "shell", step.cmd]);
    results[step.key] = { cmd: step.cmd, why: step.why, out, code };
    const first = out.split("\n")[0] ?? "";
    const status = code === 0 && out ? "ok " : "·  ";
    console.log(`  ${status} ${step.key.padEnd(11)} ${first.slice(0, 92)}`);
  }

  // The two questions this whole step exists to answer.
  const cpu = results.soc?.out ?? "";
  const crypto = /\b(aes|sha1|sha2|pmull)\b/i.test(cpu);
  // ⚠️ A 32-bit (AArch32) kernel on a 64-bit core reports AArch32 features, and an old
  // vendor kernel may not probe the crypto ID registers at all. So on such a kernel the
  // absence of aes/sha is SUGGESTIVE, never proof — only an arm64 kernel settles it.
  const aarch32 = /ARMv7|CPU architecture:\s*7/i.test(cpu);
  const parts = parseBlkDevParts(results.cmdline?.out ?? "");
  const rooted = /uid=0\(root\)/.test(results.root?.out ?? "");

  console.log("\n— findings —");
  console.log(`  ARMv8 crypto extensions : ${crypto ? "PRESENT" : aarch32
    ? "not advertised — but this is a 32-bit kernel, so INCONCLUSIVE"
    : "not advertised in /proc/cpuinfo"}`);
  if (aarch32) console.log(`  kernel is AArch32        : the 64-bit core is running a 32-bit kernel`);
  console.log(`  eMMC partitions parsed  : ${parts.length || "none (cmdline carried no blkdevparts)"}`);
  console.log(`  root on stock           : ${rooted ? "YES — the eMMC dump can proceed" : "no — root over LAN is documented for Android 7.0"}`);
  for (const p of parts) console.log(`      ${p.device} ${p.size.padStart(5)}  ${p.name}`);

  const json = `${dir}/${stamp}-recon.json`;
  writeFileSync(json, JSON.stringify({ device: DEVICE, serial, at: new Date().toISOString(), results, parts, crypto, rooted }, null, 2));

  const md = `${dir}/${stamp}-recon.md`;
  writeFileSync(md, [
    `# ${DEVICE.model} — read-only recon`, "",
    `**When:** ${new Date().toISOString()} · **adb serial:** \`${serial}\``, "",
    `- ARMv8 crypto extensions: **${crypto ? "present" : "not advertised"}**`,
    `- root on stock firmware: **${rooted ? "yes" : "no"}**`,
    `- eMMC partitions parsed from cmdline: **${parts.length}**`, "",
    ...RECON.map((s) => {
      const r = results[s.key];
      return [`## ${s.key}`, "", `_why:_ ${s.why}`, "", "```", `$ adb shell ${s.cmd}`, r.out || "(no output)", "```", ""].join("\n");
    }),
  ].join("\n"));

  console.log(`\n→ ${md}\n→ ${json}`);
  if (!rooted) console.log("\nNext: get root over LAN (documented for Android 7.0), then `bun run himedia:dump`.");
}

if (import.meta.main) await main();
