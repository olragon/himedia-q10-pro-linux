#!/usr/bin/env bun
/**
 * Collect a detailed, timestamped evidence snapshot from the box — read-only.
 *
 * Standing instruction: always collect detailed logs for later debug. This box has no
 * serial console attached and, importantly, **no previous-boot kernel log**:
 * `/proc/last_kmsg` and `/sys/fs/pstore` are both ABSENT on the 3.18 vendor kernel. So the
 * only durable record of what happened across a reboot is what userspace wrote to disk,
 * and the one that matters is `/cache/recovery/last_log` — Android recovery's own account
 * of what it did.
 *
 * ⇒ Run this BEFORE a risky step to get a baseline, and again AFTER, then diff. A snapshot
 * taken only after a failure cannot tell you what changed.
 *
 * Usage:
 *   bun run himedia:logs --label baseline
 *   bun run himedia:logs --label after-probe
 *   bun run himedia:logs --diff baseline after-probe
 */
import { WORK_ROOT, DEVICE } from "./lib.ts";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";

const DIR = `${WORK_ROOT}/logs`;

/** Each is read-only. A collector that perturbs the thing it observes is worthless. */
const SHELL_SOURCES: Array<[string, string]> = [
  ["uptime", "cat /proc/uptime; date"],
  ["version", "cat /proc/version"],
  ["cmdline", "cat /proc/cmdline"],
  ["partitions", "cat /proc/partitions"],
  ["mounts", "cat /proc/mounts"],
  ["meminfo", "cat /proc/meminfo"],
  ["interrupts", "cat /proc/interrupts"],
  ["getprop", "getprop"],
  ["dmesg", "dmesg"],
  ["logcat", "logcat -b all -d -v threadtime"],
  ["net", "ls -l /sys/class/net/; ip addr 2>/dev/null || netcfg"],
  ["block", "ls -l /dev/block/"],
  ["scsi", "cat /proc/scsi/scsi 2>/dev/null"],
  ["usb-devices", "cat /sys/kernel/debug/usb/devices 2>/dev/null"],
  ["recovery-dir", "ls -la /cache/recovery/ 2>/dev/null"],
  ["recovery-last_log", "cat /cache/recovery/last_log 2>/dev/null"],
  ["recovery-last_install", "cat /cache/recovery/last_install 2>/dev/null"],
  ["recovery-last_kmsg", "cat /cache/recovery/last_kmsg 2>/dev/null"],
  ["tombstones", "ls -la /data/tombstones/ 2>/dev/null"],
  ["last_kmsg", "cat /proc/last_kmsg 2>/dev/null"],
  ["pstore", "ls -la /sys/fs/pstore/ 2>/dev/null; cat /sys/fs/pstore/* 2>/dev/null"],
];

async function adb(serial: string, args: string[], timeoutMs = 90_000) {
  const p = Bun.spawn(["adb", ...(serial ? ["-s", serial] : []), ...args], { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(t);
  return { out: out.replace(/\r/g, ""), err, code };
}

function snapshots(): string[] {
  if (!existsSync(DIR)) return [];
  return readdirSync(DIR).filter((d) => existsSync(`${DIR}/${d}/manifest.json`)).sort();
}

function findSnapshot(label: string): string | null {
  const m = snapshots().filter((d) => d.endsWith(`-${label}`));
  return m.length ? `${DIR}/${m[m.length - 1]}` : null;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (f: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };

  const di = argv.indexOf("--diff");
  if (di >= 0) {
    const [a, b] = [argv[di + 1], argv[di + 2]];
    const pa = a && findSnapshot(a), pb = b && findSnapshot(b);
    if (!pa || !pb) {
      console.error(`⛔ need two existing labels. Have: ${snapshots().join(", ") || "(none)"}`);
      process.exit(1);
    }
    console.log(`[local] diff ${pa.split("/").pop()}  ->  ${pb.split("/").pop()}\n`);
    const names = new Set([...readdirSync(pa), ...readdirSync(pb)].filter((f) => f.endsWith(".txt")));
    for (const n of [...names].sort()) {
      const fa = `${pa}/${n}`, fb = `${pb}/${n}`;
      const ta = existsSync(fa) ? readFileSync(fa, "utf8") : "";
      const tb = existsSync(fb) ? readFileSync(fb, "utf8") : "";
      if (ta === tb) continue;
      const la = ta.split("\n").length, lb = tb.split("\n").length;
      console.log(`  ~ ${n.padEnd(26)} ${la} -> ${lb} lines${!ta ? "  (NEW)" : !tb ? "  (GONE)" : ""}`);
      // Show appended tail for the sources where new content is the finding.
      if (tb.startsWith(ta) && tb.length > ta.length) {
        const added = tb.slice(ta.length).split("\n").filter((l) => l.trim()).slice(0, 12);
        for (const l of added) console.log(`      + ${l.slice(0, 150)}`);
      } else if (!ta && tb.trim()) {
        for (const l of tb.split("\n").filter((l) => l.trim()).slice(0, 20)) console.log(`      + ${l.slice(0, 150)}`);
      }
    }
    console.log(`\nFull text: ${pa}  and  ${pb}`);
    return;
  }

  const label = arg("--label") ?? "snap";
  const serial = arg("--serial") ?? "";

  const dl = await adb("", ["devices"]);
  const devs = dl.out.split("\n").slice(1).map((l) => l.trim().split(/\s+/)).filter((p) => p[1] === "device").map((p) => p[0]);
  const target = serial || devs[0];
  if (!target) {
    console.error("⛔ no adb device. If the box is mid-recovery it will not be reachable — that is");
    console.error("   expected; run this once it has booted back, when the logs are what matter.");
    process.exit(1);
  }

  // Root gives dmesg and /cache; without it most sources come back empty and that would
  // look like "nothing happened" rather than "not permitted".
  const id = await adb(target, ["shell", "id"]);
  const rooted = /uid=0\(root\)/.test(id.out);
  if (!rooted) {
    await adb(target, ["root"], 30_000);
    await new Promise((r) => setTimeout(r, 2500));
  }
  const id2 = await adb(target, ["shell", "id"]);
  const isRoot = /uid=0\(root\)/.test(id2.out);

  const stamp = new Date().toISOString().replace(/[-:T]/g, "").replace(/\..*$/, "");
  const out = `${DIR}/${stamp}-${label}`;
  mkdirSync(out, { recursive: true });

  console.log(`[local->adb:${target}] ${DEVICE.model} log snapshot "${label}"${isRoot ? "" : "  ⚠️ NOT ROOT — sources will be thin"}`);
  console.log(`[local] -> ${out}\n`);

  const got: Record<string, { cmd: string; bytes: number; lines: number }> = {};
  for (const [name, cmd] of SHELL_SOURCES) {
    const r = await adb(target, ["shell", cmd]);
    const text = r.out;
    writeFileSync(`${out}/${name}.txt`, text);
    got[name] = { cmd, bytes: text.length, lines: text ? text.split("\n").length : 0 };
    const mark = text.trim() ? "ok " : "·  ";
    console.log(`  ${mark} ${name.padEnd(24)} ${text.length} B`);
  }

  // The bootloader control block decides what recovery does next; the first 64 KiB is enough.
  const bcb = Bun.spawn(["adb", "-s", target, "exec-out", "cat", "/dev/block/mmcblk0p12"], { stdout: "pipe", stderr: "pipe" });
  const buf = Buffer.from(await new Response(bcb.stdout).arrayBuffer());
  await bcb.exited;
  if (buf.length) {
    writeFileSync(`${out}/misc-bcb.bin`, buf.subarray(0, 65536));
    const cmd = buf.subarray(0, 32).toString("latin1").replace(/\0+$/, "");
    const status = buf.subarray(32, 64).toString("latin1").replace(/\0+$/, "");
    writeFileSync(`${out}/misc-bcb.txt`, `command=${cmd}\nstatus=${status}\n`);
    console.log(`  ok  ${"misc-bcb".padEnd(24)} command="${cmd}" status="${status}"`);
    got["misc-bcb"] = { cmd: "cat mmcblk0p12 (BCB)", bytes: 65536, lines: 2 };
  }

  writeFileSync(`${out}/manifest.json`, JSON.stringify({
    device: DEVICE.model, label, serial: target, root: isRoot,
    at: new Date().toISOString(), sources: got,
    note: "/proc/last_kmsg and /sys/fs/pstore are ABSENT on this vendor kernel — there is no previous-boot kernel log. /cache/recovery/last_log is the durable cross-reboot record.",
  }, null, 2));

  const nonEmpty = Object.values(got).filter((g) => g.bytes > 0).length;
  console.log(`\n→ ${out}  (${nonEmpty}/${Object.keys(got).length} sources non-empty)`);
  const snaps = snapshots();
  if (snaps.length > 1) console.log(`\nCompare:  bun run himedia:logs --diff <labelA> <labelB>\n  have: ${snaps.map((s) => s.split("-").slice(-1)[0]).join(", ")}`);
}

if (import.meta.main) await main();
