#!/usr/bin/env bun
/**
 * Find the Q10 Pro on the LAN by MAC, not by a hoped-for IP.
 *
 * ⛔ Why this exists: an ICMP reply proves something answered, never that OUR box answered —
 * 192.168.1.55 was an IP camera and five build-and-boot rounds rested on its replies. And the
 * inverse is just as misleading: silence at an address we chose says nothing about whether the
 * box is on the network. ARP sits below IP, so a NIC that is up and has an address shows here
 * even when ICMP goes nowhere.
 *
 * ⭐ It also carries its own POSITIVE CONTROL. A sweep that finds nothing is worthless unless we
 * know the sweep works, so a known-live host must answer before any absence is reported. That is
 * the same discipline the CP15 scan needed: an absence is only as good as its control.
 *
 * Usage:
 *   bun run himedia:find-box [--subnet 192.168.1] [--mac 02:00:00:00:10:01]
 */
const BOX_MAC = process.env.Q10_MAC ?? "02:00:00:00:10:01";
/** Hosts that are always up here; at least one MUST answer or the sweep is not trustworthy. */
const CONTROLS = (process.env.Q10_ARP_CONTROLS ?? "192.168.1.1").split(",");

const norm = (m: string) =>
  m.toLowerCase().split(":").map((o) => o.padStart(2, "0")).join(":");

async function run(cmd: string[], ms = 4000) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill("SIGKILL"), ms);
  const out = await new Response(p.stdout).text();
  const code = await p.exited;
  clearTimeout(t);
  return { out, code };
}

const alive = async (ip: string) => (await run(["ping", "-c", "1", "-W", "700", ip], 3000)).code === 0;

/** Parse `arp -an` lines: `? (192.168.1.1) at ac:84:c6:... on en0 ifscope [ethernet]` */
export function parseArp(text: string): Array<{ ip: string; mac: string }> {
  const out: Array<{ ip: string; mac: string }> = [];
  for (const line of text.split("\n")) {
    const m = line.match(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]{11,17})/i);
    if (m && !/incomplete/i.test(line)) out.push({ ip: m[1], mac: norm(m[2]) });
  }
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const pick = (f: string, d: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const net = pick("--subnet", "192.168.1");
  const want = norm(pick("--mac", BOX_MAC));

  // ⛔ Control first. Reporting "not found" from a sweep that cannot reach anything is the bug.
  const ctl = await Promise.all(CONTROLS.map(async (ip) => [ip, await alive(ip)] as const));
  const okCtl = ctl.filter(([, a]) => a).map(([ip]) => ip);
  console.log(`[local] control: ${okCtl.length}/${ctl.length} known hosts replied — ${okCtl.join(", ") || "NONE"}`);
  if (okCtl.length === 0) {
    console.log(`⛔ no control host answered, so this sweep proves NOTHING about the box.`);
    console.log(`   Check the Mac's own link and subnet before reading anything into a silence.`);
    process.exit(2);
  }

  // Sweep to populate the ARP cache. ICMP may be ignored; the ARP exchange still happens.
  process.stdout.write(`[local] sweeping ${net}.1-254 to populate ARP … `);
  const ips = Array.from({ length: 254 }, (_, i) => `${net}.${i + 1}`);
  for (let i = 0; i < ips.length; i += 64) {
    await Promise.all(ips.slice(i, i + 64).map((ip) => alive(ip)));
  }
  console.log("done");

  const table = parseArp((await run(["arp", "-an"], 8000)).out);
  const hit = table.filter((e) => e.mac === want);

  console.log(`\n[local] ${table.length} hosts in ARP`);
  if (hit.length) {
    console.log(`\n✅ THE BOX IS ON THE NETWORK — MAC ${want}`);
    for (const h of hit) console.log(`     ${h.ip}`);
    console.log(`   So its NIC is up and it has an address. If that address is not one of`);
    console.log(`   .56/.57/.58, the kernel booted but ip= did not take effect.`);
  } else {
    console.log(`\n⛔ MAC ${want} is NOT in ARP after a full sweep.`);
    console.log(`   The control passed, so the sweep works. That means the box is not reachable`);
    console.log(`   at the link layer: it is powered off, the cable/port is down, or the kernel`);
    console.log(`   never brought the GbE up at all. It does NOT tell us which.`);
  }

  // A changed OUI is worth seeing — mainline picked a random MAC once before.
  console.log(`\n--- hosts in ARP (for comparison) ---`);
  for (const e of table.sort((a, b) => Number(a.ip.split(".")[3]) - Number(b.ip.split(".")[3]))) {
    const tag = e.mac === want ? "  <== THE BOX" : "";
    console.log(`  ${e.ip.padEnd(15)} ${e.mac}${tag}`);
  }
  process.exit(hit.length ? 0 : 1);
}

if (import.meta.main) await main();
