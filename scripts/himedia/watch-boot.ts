#!/usr/bin/env bun
/**
 * Watch for the Q10 Pro's mainline kernel coming up, and pull its dmesg — over Ethernet,
 * with no serial console.
 *
 * ⛔ Why this is needed at all: mainline has no display driver for this SoC, so the
 * bootloader's logo stays frozen on HDMI and a healthy kernel is indistinguishable from a
 * hang. The kernel console goes to ttyAMA0, which is not wired up. So the kernel announces
 * itself instead: CONFIG_IP_PNP configures eth0 during kernel init, and an embedded
 * initramfs keeps it alive rather than panicking on a missing root.
 *
 * ⇒ A single ICMP reply carries a lot: the kernel booted, the GbE driver bound, and the
 * device tree is right about the MAC. Then telnet answers everything else.
 *
 * Usage:
 *   bun run himedia:watch-boot                 # wait for 192.168.1.55, then grab dmesg
 *   bun run himedia:watch-boot --timeout 180
 */
import { WORK_ROOT } from "./lib.ts";
import { mkdirSync, writeFileSync } from "node:fs";

/*
 * ⛔ 192.168.1.55 is NOT usable as a bring-up address: it is an IP camera on the LAN
 * (a Sigmastar OUI) and it answers ping permanently. Using it
 * cost five debugging rounds — every "the kernel booted" conclusion was a camera replying,
 * and the LAN sweep that would have shown it occupied had already been taken and not read.
 *
 * ⇒ The bring-up address must be verified free before use, and identity confirmed by MAC,
 * never by a ping reply. A reply proves something answered, not that YOUR thing answered.
 */
const IP = process.env.HIMEDIA_BRINGUP_IP ?? "192.168.1.56";
/**
 * The ladder, in rung order. Each is a DISTINCT address on a DISTINCT alias, so each answers
 * exactly one question: the kernel (ip=/IP_PNP, pre-userspace), init.c (ioctl on eth0:0),
 * init.sh (busybox ifconfig on eth0:1).
 *
 * ⛔ The wait loop used to watch ONLY `IP`. If ip= failed but init.c ran, .57 would be live and
 * this tool would report a total early-boot failure while userspace was up. Watch all of them.
 */
const LADDER = [IP, "192.168.1.57", "192.168.1.58"] as const;
/**
 * ⭐ Hosts that are always up on this LAN. At least one MUST answer, or a silence from the box
 * proves nothing at all — the Mac's own link, subnet or TCC state could be the thing that is
 * broken. An absence is only as good as its positive control.
 */
const CONTROLS = (process.env.Q10_ARP_CONTROLS ?? "192.168.1.1").split(",");
/** The MAC pinned in the device tree. The only trustworthy proof of identity. */
const EXPECT_MAC = process.env.Q10_MAC ?? "02:00:00:00:10:01";
const ANDROID = process.env.Q10_ANDROID_IP ?? "192.168.1.200";

/** `arp -an` prints `24:14:7:...`, so pad every octet before any comparison. */
export const normMac = (m: string) =>
  m.toLowerCase().split(":").map((o) => o.padStart(2, "0")).join(":");

async function cap(cmd: string[], ms = 20_000) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill("SIGKILL"), ms);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(t);
  return { out, err, code };
}

const alive = async (ip: string) => (await cap(["ping", "-c", "1", "-W", "900", ip], 5000)).code === 0;

/** busybox telnetd with `-l /bin/sh` drops straight to a shell, so a raw pipe is enough. */
async function shellCmd(ip: string, cmd: string, ms = 25_000): Promise<string> {
  const p = Bun.spawn(["nc", "-w", "8", ip, "23"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  // Answer the initial IAC negotiation with nothing, then just send the command.
  p.stdin.write(`${cmd}\nexit\n`);
  await p.stdin.end();
  const t = setTimeout(() => p.kill("SIGKILL"), ms);
  const out = await new Response(p.stdout).text();
  await p.exited;
  clearTimeout(t);
  // Strip telnet IAC bytes so the transcript is readable.
  return out.replace(/[\xff][\xfb-\xfe]./g, "").replace(/\r/g, "");
}

async function main() {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf("--timeout");
  const budget = (ti >= 0 ? Number(argv[ti + 1]) : 240) * 1000;

  console.log(`[local] waiting for the mainline kernel at ${IP} (budget ${budget / 1000}s)`);
  console.log(`[local] meanwhile: Android at ${ANDROID} should be SILENT — if it answers, the`);
  console.log(`        loader fell through to eMMC and our uImage was not taken.\n`);

  const started = Date.now();
  let got = false, androidCameBack = false, firstUp = "";
  while (Date.now() - started < budget) {
    for (const ip of LADDER) {
      if (await alive(ip)) { got = true; firstUp = ip; break; }
    }
    if (got) break;
    if (await alive(ANDROID)) { androidCameBack = true; break; }
    const s = Math.round((Date.now() - started) / 1000);
    process.stdout.write(`\r  ${s}s … no reply from ${LADDER.join(" / ")} yet`);
    await new Promise((r) => setTimeout(r, 2000));
  }
  process.stdout.write("\n");

  if (androidCameBack) {
    console.log(`⚠️  ${ANDROID} answered — Android booted, so the loader did NOT take the uImage.`);
    console.log(`    Check: is the stick in a USB port the loader enumerates, is the file named`);
    console.log(`    exactly 'uImage' at the FAT32 root, and is bootcmd still the patched one`);
    console.log(`    (bun run himedia:env show).`);
    process.exit(2);
  }
  if (!got) {
    /*
     * ⛔ This branch used to assert: "the loader took the uImage and the kernel did NOT reach a
     * working network. That is a real early-boot failure." BOTH claims were unwarranted.
     * A powered-off box, an unplugged cable, a dead switch port and a kernel that hung all
     * produce exactly this silence, and Android being quiet is equally explained by the box
     * being off. The tool cannot see power or link, so it must not claim to.
     */
    const ctl = await Promise.all(CONTROLS.map(async (ip) => [ip, await alive(ip)] as const));
    const okCtl = ctl.filter(([, a]) => a).map(([ip]) => ip);
    console.log(`control: ${okCtl.length}/${ctl.length} known-live hosts replied` +
      `${okCtl.length ? ` — ${okCtl.join(", ")}` : ""}`);

    if (okCtl.length === 0) {
      console.log(`\n⛔ NO control host answered, so this silence says NOTHING about the box.`);
      console.log(`   Check this machine's own link and subnet first: \`ifconfig en0\`,`);
      console.log(`   \`route -n get default\`. Do not touch the box on the strength of this run.`);
      process.exit(4);
    }

    // The sweep works. Now ask the link layer, which sits below ICMP.
    const arp = await cap(["arp", "-an"], 8000);
    /*
     * ⛔ macOS `arp` STRIPS LEADING ZEROS from each octet — the camera prints as
     * `2:0:0:0:55:1`, not `02:00:00:00:55:01`. So a literal match on
     * `02:00:00:00:10:01` can never fire, and the check would report "not in ARP" for a box
     * that is sitting right there. Normalise both sides before comparing.
     */
    const inArp = arp.out.split("\n").filter((l) => {
      const m = l.match(/at ([0-9a-f:]{11,17})/i);
      return m ? normMac(m[1]) === EXPECT_MAC : false;
    });

    console.log(`\n⛔ nothing on the ladder (${LADDER.join(", ")}) and Android is silent too.`);
    if (inArp.length) {
      console.log(`⚠️  BUT the box's MAC IS in ARP:`);
      for (const l of inArp) console.log(`      ${l.trim()}`);
      console.log(`   So its NIC is up with an address that is NOT on the ladder — the kernel`);
      console.log(`   booted and ip= did not take effect. Read the address above.`);
      process.exit(5);
    }
    console.log(`   The box's MAC (${EXPECT_MAC}) is NOT in ARP either, so it is absent at the`);
    console.log(`   LINK layer. The control passed, so the probe works. That narrows it to:`);
    console.log(`     • the box is powered off, or did not reach the point of enabling GbE`);
    console.log(`     • the cable or switch port is down`);
    console.log(`     • the kernel hung before the GbE driver probed`);
    console.log(`   ⛔ This run CANNOT distinguish those. Check HDMI and the switch port LED;`);
    console.log(`      both are outside anything this tool can see.`);
    process.exit(1);
  }

  if (firstUp && firstUp !== IP) {
    console.log(`⚠️  ${firstUp} answered BEFORE ${IP} did. A later rung up without the one below`);
    console.log(`    it means ip=/IP_PNP did not configure eth0, but userspace ran.`);
  }

  // ⛔ Confirm WHO answered. A ping reply is not identity.
  const arp = await cap(["arp", "-an"], 8000);
  const line = arp.out.split("\n").find((l) => l.includes(`(${IP})`)) ?? "";
  const mac = (line.match(/at ([0-9a-f:]+)/i)?.[1] ?? "").toLowerCase();
  const norm = normMac;
  const ours = mac && norm(mac) === EXPECT_MAC;
  console.log(ours
    ? `✅ ${IP} answers, and its MAC is ${norm(mac)} — that IS our box.`
    : `⛔ ${IP} answers but its MAC is ${mac ? norm(mac) : "unknown"}, NOT ${EXPECT_MAC}.\n` +
      `   Something ELSE on the LAN holds this address. This is exactly the trap that cost\n` +
      `   five rounds: a reply is not identity. Pick a free address and re-check by MAC.`);
  if (!ours) process.exit(3);
  console.log();

  /*
   * ⚠️ That reply proves the KERNEL ran, not that userspace did — eth0 is configured from
   * the `ip=` boot argument before any userspace exists.
   *
   * ⛔ This used to read `const INIT_PROOF = IP; const initRan = true`, i.e. it tested the
   * very address the kernel configures itself and then hardcoded the answer to "yes". It
   * could not distinguish "init is executing" from "init never started", which look
   * identical from outside: ping works, nothing listens. It reported init running for
   * several rounds in which init.sh was in fact a no-op.
   *
   * The rungs are distinct addresses on distinct aliases, so each one answers exactly one
   * question. Raised by: the kernel / init.c by ioctl / init.sh by busybox ifconfig.
   */
  const INIT_PROOF = "192.168.1.57";   // init.c   — our static PID 1 ran
  const SCRIPT_PROOF = "192.168.1.58"; // init.sh  — the busybox second stage ran
  const initRan = await alive(INIT_PROOF);
  const scriptRan = await alive(SCRIPT_PROOF);

  /*
   * ⚠️ A PANICKED kernel can still answer ping: ICMP echo replies are generated in softirq
   * context and panic() enables interrupts before spinning. So a steady reply is NOT proof
   * of health. With panic=5 a panic reboots instead, which shows up as the address going
   * away and coming back — so flapping is the panic signature and steadiness is good news.
   */
  let drops = 0;
  for (let i = 0; i < 8; i++) {
    if (!(await alive(IP))) drops++;
    await new Promise((r) => setTimeout(r, 1500));
  }
  console.log(drops === 0
    ? `   stability: 8/8 replies — steady, so the kernel is not in a panic-reboot loop.`
    : `   ⛔ stability: ${8 - drops}/8 replies — the address is FLAPPING, which with panic=5 means\n` +
      `      the kernel is panicking and rebooting. init is failing to exec, not merely failing.`);
  console.log(initRan
    ? `✅ ${INIT_PROOF} answers — init.c IS executing as PID 1.`
    : `⛔ ${INIT_PROOF} is silent — the kernel booted but init.c did NOT raise its alias.\n` +
      `   So this is not a daemon problem: userspace never started, or the initramfs is wrong.`);
  console.log(scriptRan
    ? `✅ ${SCRIPT_PROOF} answers — init.sh IS executing, so busybox exec'd and /dev works.`
    : `⛔ ${SCRIPT_PROOF} is silent — init.c ran but the busybox second stage did not get\n` +
      `   as far as its ifconfig. Suspect the exec, the busybox ELF arch, or /dev.`);
  console.log();

  const dir = `${WORK_ROOT}/bringup`;
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").replace(/\..*$/, "");

  /*
   * ⭐ Fetch over HTTP first. busybox httpd needs no pty, whereas telnetd allocates one and
   * dies silently without /dev/pts mounted — which is exactly what happened on the first
   * observable boot: the box answered ping while no port ever listened, and that reads as
   * "the shell is broken" rather than "the shell never started". Files served over HTTP have
   * neither failure mode, and they are snapshotted at a known point in boot.
   */
  let viaHttp = false;
  for (const [name, path] of [["dmesg", "/dmesg.txt"], ["info", "/info.txt"]] as const) {
    const r = await cap(["curl", "-fsS", "-m", "15", `http://${IP}${path}`], 20_000);
    if (r.code === 0 && r.out.length > 50) {
      writeFileSync(`${dir}/${stamp}-${name}.txt`, r.out);
      console.log(`  ok   ${name.padEnd(12)} ${r.out.length} B   (http)`);
      viaHttp = true;
    } else console.log(`  ·    ${name.padEnd(12)} no HTTP reply`);
  }

  if (!viaHttp && Bun.which("nc")) {
    console.log(`  (HTTP quiet — falling back to telnet)`);
    for (const [name, cmd] of [["dmesg", "dmesg"], ["cpuinfo", "cat /proc/cpuinfo"]] as const) {
      const out = await shellCmd(IP, cmd);
      writeFileSync(`${dir}/${stamp}-${name}.txt`, out);
      console.log(`  ${out.trim() ? "ok " : "·  "} ${name.padEnd(12)} ${out.length} B   (telnet)`);
    }
  }
  console.log(`\n→ ${dir}/${stamp}-*.txt`);

  const dmesg = await Bun.file(`${dir}/${stamp}-dmesg.txt`).text().catch(() => "");
  if (dmesg) {
    console.log(`\n— the lines that matter —`);
    for (const re of [/CPU[0-9]?:|SMP: Total of \d+/, /psci/i, /dw_mmc|mmc\d/i, /ahci|ata\d/i, /xhci|usb \d/i, /eth\d|hisi.*gmac/i, /combphy|phy/i]) {
      const hits = dmesg.split("\n").filter((l) => re.test(l)).slice(0, 3);
      for (const h of hits) console.log(`  ${h.trim().slice(0, 140)}`);
    }
  } else {
    console.log(`\n⚠️  ping works but the shell returned nothing — telnet ${IP} by hand.`);
  }
}

if (import.meta.main) await main();
