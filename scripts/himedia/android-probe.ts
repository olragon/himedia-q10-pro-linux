#!/usr/bin/env bun
/**
 * Read the WORKING vendor system (stock Android, kernel 3.18.24) as a reference for mainline.
 *
 * Tim's question that prompted it, 2026-10-10: "why can't we use the android image to detect port
 * and boot sequence?" — we can, and it beats reset-timing: three NO_STICK boots and two USB fixes
 * that changed nothing, while the vendor kernel on the same hardware already drives the port and
 * the gigabit PHY correctly. Our own recon (this morning) shows the external USB ports hang off the
 * two xHCI controllers (an onboard Genesys 05e3:0608 hub on f98b0000), not off EHCI — which is all
 * we had enabled.
 *
 * ⛔ READ-ONLY by construction: every command is in READS below and a test asserts none of them
 * writes. Registers are read with `dd if=/dev/mem`, never written. Nothing touches eMMC.
 *
 * Usage (box booted into Android, stick plugged into its usual port):
 *   adb connect 192.168.1.200:5555   # once (TCC)
 *   bun run himedia:android-probe [--serial 192.168.1.200:5555]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { WORK_ROOT } from "./lib.ts";

/** A 32-bit physical register, read through /dev/mem. */
export const reg = (addr: number) =>
  `dd if=/dev/mem bs=4 count=1 skip=${addr / 4} 2>/dev/null | od -An -tx4`;

export const READS: [string, string, string][] = [
  // [section, why, command]
  ["usb-topology", "which controller/port the stick and every device hangs off",
    "cat /sys/kernel/debug/usb/devices 2>/dev/null || (mount -t debugfs none /sys/kernel/debug && cat /sys/kernel/debug/usb/devices)"],
  ["usb-sysfs", "bus-port paths with their drivers",
    "for d in /sys/bus/usb/devices/*; do echo \"$d $(cat $d/product 2>/dev/null) $(readlink $d/driver 2>/dev/null)\"; done"],
  ["block", "where the stick's disk appears", "ls -l /sys/block/ ; cat /proc/partitions"],
  ["dmesg-usb", "enumeration as the vendor kernel saw it",
    "dmesg | grep -iE 'usb|ehci|ohci|xhci|hub|sd[a-z]|scsi' | tail -80"],
  ["dmesg-eth", "how the vendor driver found the PHY",
    "dmesg | grep -iE 'eth|gmac|higmac|phy|mdio|rtl|realtek|link' | tail -60"],
  ["mdio", "PHY id and address the vendor kernel registered",
    "for d in /sys/bus/mdio_bus/devices/*; do echo \"$d id=$(cat $d/phy_id 2>/dev/null)\"; done; ls -l /sys/class/net/eth0/ 2>&1 | head -30"],
  ["eth0", "link state as the vendor sees it",
    "cat /sys/class/net/eth0/operstate /sys/class/net/eth0/carrier /sys/class/net/eth0/speed /sys/class/net/eth0/address 2>&1"],
  ["cmdline", "boot arguments", "cat /proc/cmdline"],
  ["regs", "USB/OTG/PHY/CRG/gmac registers in the WORKING state",
    [
      ["OTG/USB3 ctrl 0xf8a2012c", 0xf8a2012c], ["USB2 PHY0 ctrl 0xf8a20120", 0xf8a20120],
      ["USB2 PHY1 ctrl 0xf8a20124", 0xf8a20124], ["CRG USB2CTRL 0xf8a220b8", 0xf8a220b8],
      ["CRG USB2PHY 0xf8a220bc", 0xf8a220bc], ["CRG USB3 0xf8a220b0", 0xf8a220b0],
      ["CRG ETH 0xf8a220cc", 0xf8a220cc],
    ].map(([n, a]) => `echo "${n}: $(${reg(a as number)})"`).join("; ")],
];

async function sh(cmd: string[], timeoutMs = 30_000) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(t);
  return { out: out + err, code };
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const si = argv.indexOf("--serial");
  const list = (await sh(["adb", "devices"])).out.split("\n").filter((l) => /\tdevice$/.test(l)).map((l) => l.split("\t")[0]);
  const serial = si >= 0 ? argv[si + 1] : list[0];
  if (!serial) {
    console.error("⛔ no adb device. Connect once from a real app (macOS Local Network denies tmux):\n" +
      '   adb connect 192.168.1.200:5555');
    process.exit(1);
  }
  await sh(["adb", "-s", serial, "root"]);
  await Bun.sleep(1500);
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const dir = `${WORK_ROOT}/android-probe`;
  mkdirSync(dir, { recursive: true });
  let md = `# Q10 Pro — vendor Android probe ${stamp}\n\nserial \`${serial}\`\n`;
  for (const [section, why, cmd] of READS) {
    const r = await sh(["adb", "-s", serial, "shell", cmd]);
    md += `\n## ${section}\n_${why}_\n\n\`\`\`\n${r.out.trim()}\n\`\`\`\n`;
    console.log(`  ${r.code === 0 ? "ok " : "!! "} ${section}`);
  }
  const path = `${dir}/${stamp}-android-probe.md`;
  writeFileSync(path, md);
  console.log(`\n${path}`);
}
