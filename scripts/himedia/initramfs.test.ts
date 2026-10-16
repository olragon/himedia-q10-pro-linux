/**
 * Guards on the initramfs second stage.
 *
 * ⛔ Why these exist: the bug they catch is INVISIBLE from outside the box. With no /dev/null
 * the first `2>/dev/null` redirection fails, POSIX says the command is then not executed, so
 * the devtmpfs mount never runs and every later line fails identically — the whole script is
 * a no-op while the kernel is perfectly healthy and answering ping. Nothing in the symptom
 * points at the script. Verified mechanically: `sh -c 'echo X 2>/nope'` prints nothing.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { USERSPACE, USERSPACE_PID1_SECONDS, NIC_VERDICT, fastReadings } from "./checkpoints.ts";

const DIR = `${import.meta.dir}/kernel/arm32/initramfs`;

const SH = readFileSync(`${import.meta.dir}/kernel/arm32/initramfs/init.sh`, "utf8");
const BUILD = readFileSync(`${import.meta.dir}/build-kernel-arm32.ts`, "utf8");

/** Statements in order, comments and blanks dropped. */
const stmts = () =>
  SH.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));

test("nothing redirects to /dev/null before /dev is mounted", () => {
  const lines = stmts();
  const mount = lines.findIndex((l) => /mount\s+-t\s+devtmpfs/.test(l));
  expect(mount).toBeGreaterThanOrEqual(0);
  const early = lines.slice(0, mount).filter((l) => l.includes("/dev/null"));
  expect(early).toEqual([]);
});

test("the devtmpfs mount itself carries no redirection", () => {
  const m = stmts().find((l) => /mount\s+-t\s+devtmpfs/.test(l))!;
  // A failed redirect would suppress the very command that makes redirects possible.
  expect(m).not.toMatch(/[12]?>/);
});

test("proc and sysfs mounts also run unredirected", () => {
  for (const fs of ["proc", "sysfs"]) {
    const m = stmts().find((l) => new RegExp(`mount\\s+-t\\s+${fs}\\b`).test(l))!;
    expect(m).toBeDefined();
    expect(m).not.toMatch(/[12]?>/);
  }
});

test("the build creates /dev/console, and asserts it is a character device", () => {
  expect(BUILD).toMatch(/mknod\s+-m\s*\d+\s+\\?\$IRD\/dev\/console\s+c\s+5\s+1/);
  expect(BUILD).toMatch(/-c\s+\\?\$IRD\/dev\/\\?\$n/);        // the [ -c ] loop
  expect(BUILD).toMatch(/grep -aq "dev\/console"/);           // and it reached the cpio
});

test("the initramfs is staged off the bind mount — APFS cannot hold device nodes", () => {
  expect(BUILD).toMatch(/^IRD=\/irfs$/m);
  expect(BUILD).not.toMatch(/^IRD=\/ws\//m);
  expect(BUILD).toMatch(/INITRAMFS_SOURCE \/irfs/);
});

test("the bring-up addresses are a ladder: distinct address AND distinct alias per rung", () => {
  const C = readFileSync(`${import.meta.dir}/kernel/arm32/initramfs/init.c`, "utf8");
  const kernelIp = BUILD.match(/const BRINGUP_IP = (?:process\.env\.Q10_STATIC_IP \?\? )?"([\d.]+)"/)![1];
  const cIp = C.match(/set_alias\("(eth0:\d)",\s*"([\d.]+)"/)!;
  const shIp = SH.match(/ifconfig\s+(eth0:\d)\s+([\d.]+)/)!;

  // ⛔ init.sh used to raise the KERNEL's address on init.c's alias: it proved nothing, and
  // running it would have deleted the rung below it.
  expect(new Set([kernelIp, cIp[2], shIp[2]]).size).toBe(3);
  expect(cIp[1]).not.toBe(shIp[1]);
});

/** ⚠️ Comments must come out first: this file's own prose QUOTES the old buggy code. */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("watch-boot probes the rungs separately instead of assuming", () => {
  const W = stripComments(readFileSync(`${import.meta.dir}/watch-boot.ts`, "utf8"));
  expect(W).not.toMatch(/initRan\s*=\s*true/);        // was hardcoded
  expect(W).not.toMatch(/INIT_PROOF\s*=\s*IP\b/);     // was the kernel's own address
  expect(W).toMatch(/initRan\s*=\s*await alive\(INIT_PROOF\)/);
  expect(W).toMatch(/scriptRan\s*=\s*await alive\(SCRIPT_PROOF\)/);
});

test("MAC comparison normalises macOS arp's stripped leading zeros", async () => {
  const { normMac } = await import("./watch-boot.ts");
  // ⛔ This is the real format `arp -an` emits — octets are NOT zero-padded.
  expect(normMac("2:0:0:0:55:1")).toBe("02:00:00:00:55:01");
  expect(normMac("2:0:0:0:10:1")).toBe("02:00:00:00:10:01");
  // Already-padded input must be unchanged, so the function is safe to apply twice.
  expect(normMac("02:00:00:00:10:01")).toBe("02:00:00:00:10:01");
});

test("watch-boot watches the whole ladder and gates its verdict on a control", () => {
  const raw = readFileSync(`${import.meta.dir}/watch-boot.ts`, "utf8");
  const W = stripComments(raw);   // ⚠️ the retraction comment QUOTES the banned phrase
  expect(W).toMatch(/const LADDER = \[IP, "192\.168\.1\.57", "192\.168\.1\.58"\]/);
  expect(W).toMatch(/const CONTROLS = \(process\.env\.Q10_ARP_CONTROLS/);
  expect(W).toMatch(/for \(const ip of LADDER\)/);        // the wait loop, not just IP
  // ⛔ The retracted overclaim must not come back.
  expect(W).not.toMatch(/That is a real early-boot failure/);
});

/*
 * ⛔ R's period lives in init.c, which the build patches for head.S but not for our own PID 1.
 * Two copies of one number drift silently, and the cost is a reading that looks valid and
 * means a different checkpoint — the exact failure the profile guards were written for.
 */
test("init.c's userspace checkpoint period matches the profile", () => {
  const src = readFileSync(`${DIR}/init.c`, "utf8");
  const m = src.match(/#define HIMEDIA_CP_SECONDS\s+(\d+)/);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBe(USERSPACE_PID1_SECONDS);
});

test("the userspace checkpoint is the first statement in main, before anything that can fail", () => {
  const src = stripComments(readFileSync(`${DIR}/init.c`, "utf8"));
  const body = src.slice(src.indexOf("int main(void)"));
  expect(body.indexOf("himedia_checkpoint(")).toBeLessThan(body.indexOf("set_alias("));
  expect(body.indexOf("himedia_checkpoint(")).toBeLessThan(body.indexOf("execl("));
});

test("the userspace checkpoint writes the same four SP805 registers", () => {
  const src = readFileSync(`${DIR}/init.c`, "utf8");
  expect(src).toContain("0xf8a2c000");
  expect(src).toContain("0x1acce551");
  expect(src).toMatch(/w\[0xc00 \/ 4\] = HIMEDIA_WDT_UNLOCK/);
  expect(src).toMatch(/w\[0xc00 \/ 4\] = 3u/);      // re-lock
});

/*
 * ⛔ The userspace checkpoint opens /dev/mem. The first version relied on the initramfs
 * carrying that node and the build only mknods console/null/zero/tty — so open() failed, the
 * checkpoint silently did nothing, and a boot that REACHED PID 1 was indistinguishable from
 * one that never exec'd it. A probe that cannot fire is not a probe.
 */
test("PID 1 creates /dev/mem itself before opening it", () => {
  const src = stripComments(readFileSync(`${DIR}/init.c`, "utf8"));
  expect(src).toMatch(/mknod\("\/dev\/mem"/);
  expect(src.indexOf('mknod("/dev/mem"')).toBeLessThan(src.indexOf('open("/dev/mem"'));
  expect(src).toContain("EEXIST");            // an existing node is success, not failure
});

test("the build also stages /dev/mem and asserts it is a character device", () => {
  const b = readFileSync(`${import.meta.dir}/build-kernel-arm32.ts`, "utf8");
  expect(b).toMatch(/mknod -m 600 \\\$IRD\/dev\/mem\s+c 1 1/);
  expect(b).toMatch(/for n in console null zero tty mem; do/);
});

/*
 * ⛔ The NIC verdict periods exist in two places (init.c #defines, checkpoints.ts) and drift
 * silently — a drifted value reads as a DIFFERENT verdict. They must also stay clear of every
 * ladder period and R, or one reading means two things.
 */
test("NIC verdict periods match between init.c and checkpoints.ts", () => {
  const src = readFileSync(`${DIR}/init.c`, "utf8");
  for (const [name, secs] of Object.entries(NIC_VERDICT)) {
    const m = src.match(new RegExp(`#define ${name}\\s+(\\d+)`));
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(secs);
  }
});

test("under FAST every outcome reads at least 18 s from every other", () => {
  // Tim, 2026-10-10: readings had grown to 7-9 minutes. FAST moves the verdicts to the short end
  // and collapses the kernel ladder to one period; this is the property that keeps it readable.
  const r = Object.entries(fastReadings());
  for (const [a, x] of r) for (const [b, y] of r) {
    if (a === b || (a.startsWith("KERNEL_REGRESSED") && b.startsWith("KERNEL_REGRESSED"))) continue;
    expect(Math.abs(x - y)).toBeGreaterThanOrEqual(18);
  }
  // and every failure outcome reads in under 4 minutes
  for (const [k, v] of r) if (k !== "CARRIER") expect(v).toBeLessThan(240);
});

test("the verdict runs AFTER R, so a crash in it can only ever read as R", () => {
  const src = stripComments(readFileSync(`${DIR}/init.c`, "utf8"));
  const body = src.slice(src.indexOf("int main(void)"));
  expect(body.indexOf("himedia_checkpoint(HIMEDIA_CP_SECONDS)"))
    .toBeLessThan(body.indexOf("himedia_checkpoint(nic_verdict())"));
  expect(body.indexOf("umount(\"/sys\")")).toBeLessThan(body.indexOf("execl("));
});

/*
 * ⛔ The USB log shares the stick with the uImage the box boots from. It must write only under
 * Q10LOG/, never touch uImage, and sync + umount after every write — a watchdog reset can land
 * at any moment and must not leave the FAT half-written. Every wait must be bounded, because a
 * hang here is a hang in PID 1.
 */
test("the USB log writes only under Q10LOG, syncs, unmounts, and is bounded", () => {
  const sh = SH.replace(/^\s*#.*$/gm, "");
  const fn = sh.slice(sh.indexOf("usb_log() {"), sh.indexOf("usb_log early"));
  expect(fn).toContain("/usb/Q10LOG");
  expect(fn).not.toMatch(/uImage/);
  expect(fn).not.toMatch(/\brm\b/);
  expect(fn.indexOf("$BB sync")).toBeLessThan(fn.indexOf("$BB umount /usb"));
  expect(fn).toMatch(/while \[ \$i -lt 30 \]/);          // bounded wait for the device
  // every failure path RETURNS (after naming its stage), never exits PID 1
  expect(fn).toMatch(/\|\| \{ cp_arm \$CP_MOUNT_FAIL; return 0; \}/);
  expect(fn).not.toMatch(/\bexit\b/);
});

test("the late USB write is backgrounded, so PID 1 still reaches its keep-alive loop", () => {
  const sh = SH.replace(/^\s*#.*$/gm, "");
  expect(sh).toMatch(/\( \$BB sleep 60; usb_log late \) &/);
  expect(sh.indexOf("usb_log early")).toBeLessThan(sh.indexOf("while : ; do $BB sleep 30 ; done"));
});

/*
 * ⛔ v1 of the verdict matched sysfs NAMES, and of_device_make_bus_id falls back to
 * "...ethernet@9841000" whenever reg does not translate — a name v1 could not see. So its
 * NO_DEVICE (4:30) could not separate "no device" from "a device I could not recognise".
 * Devices are identified by their of_node link now; a name match must not come back.
 */
test("the NIC verdict identifies devices by of_node, never by sysfs name", () => {
  const src = stripComments(readFileSync(`${DIR}/init.c`, "utf8"));
  expect(src).toContain('"/ethernet@9841000"');
  expect(src).toMatch(/readlink\(link/);
  expect(src).toContain("/of_node");
  expect(src).not.toContain("9841000.ethernet");
});

test("the verdict checks the live device tree before anything else", () => {
  const src = stripComments(readFileSync(`${DIR}/init.c`, "utf8"));
  const fn = src.slice(src.indexOf("static unsigned int nic_verdict"));
  expect(fn.indexOf("NIC_NO_DT_NODE")).toBeLessThan(fn.indexOf("find_by_node("));
});

/*
 * ⛔ The USB log failed twice in silence: every failure path returns quietly so it cannot hurt
 * PID 1. These stages make each path name itself through the watchdog, via busybox devmem.
 */
const stages = () => [...SH.matchAll(/^(CP_\w+)=(\d+)\s+#\s+(\d+) s/gm)]
  .map(([, name, load, secs]) => ({ name, load: Number(load), secs: Number(secs) }));

test("every shell checkpoint load is its seconds at 24 MHz", () => {
  const s = stages();
  expect(s.length).toBe(9);
  for (const x of s) expect(x.load).toBe(x.secs * 24_000_000);
});

test("devmem is only used after devtmpfs is mounted, and arms the same four registers", () => {
  const sh = SH.replace(/^\s*#.*$/gm, "");
  expect(sh.indexOf("mount -t devtmpfs")).toBeLessThan(sh.indexOf("devmem"));
  for (const reg of ["0xf8a2cc00 32 0x1acce551", "0xf8a2c000 32 $1", "0xf8a2c008 32 3", "0xf8a2cc00 32 3"])
    expect(sh).toContain(`$BB devmem ${reg}`);
});

test("each USB failure path arms its own stage before returning", () => {
  const sh = SH.replace(/^\s*#.*$/gm, "");
  expect(sh).toMatch(/\|\| \{ cp_arm \$CP_NO_USB_HOST; return 0; \}/);
  expect(sh).toMatch(/\|\| \{ usb_why; return 0; \}/);     // NO_STICK is now classified
  expect(sh).toMatch(/\|\| \{ cp_arm \$CP_MOUNT_FAIL; return 0; \}/);
  expect(sh.indexOf("$BB umount /usb")).toBeLessThan(sh.indexOf("cp_arm $CP_WRITTEN"));
});

test("shell stage readings stay >= 18 s from each other, from R and from a kernel regression", () => {
  // pre-time: init.sh starts ~20 s after power-on; NO_STICK adds the 30 s wait; MOUNT_FAIL spans
  // a stick found at once (~26 s) to one found at the end of the wait (~52 s).
  const pre: Record<string, number[]> = {
    CP_SH_STARTED: [15, 20], CP_NO_USB_HOST: [16, 21], CP_MOUNT_FAIL: [21, 52],
    CP_NS_NO_CONNECT: [47, 52], CP_NS_DEVICE_NO_DISK: [47, 52], CP_NS_EHCI_CONNECT: [47, 52],
    CP_NS_OHCI_CONNECT: [47, 52], CP_NS_UNPOWERED: [47, 52], CP_WRITTEN: [30, 55],
  };
  const r: [string, number][] = [];
  for (const x of stages()) for (const p of pre[x.name] ?? []) r.push([x.name, p + 2 * x.secs]);
  r.push(["R", 17 + 2 * USERSPACE_PID1_SECONDS], ["KERNEL", 11 + 2 * 100]);
  for (const [a, x] of r) for (const [b, y] of r)
    if (a !== b) expect(Math.abs(x - y)).toBeGreaterThanOrEqual(18);
});

test("exactly one reporter owns the watchdog: the NIC verdict XOR the shell stages", () => {
  const src = readFileSync(`${DIR}/init.c`, "utf8");
  const verdict = Number(src.match(/#define HIMEDIA_NIC_VERDICT (\d)/)![1]);
  const shell = Number(SH.match(/^CP_SHELL=(\d)/m)![1]);
  expect(src).toMatch(/#if HIMEDIA_NIC_VERDICT\s+if \(mount\("sysfs"/);
  expect(SH).toMatch(/cp_arm\(\) \{\n  \[ "\$CP_SHELL" = 1 \] \|\| return 0/);
  expect(verdict + shell).toBe(1);
});

/*
 * ⛔ A non-terminal stage's period must outlast the time until the NEXT stage arms, or the
 * watchdog fires while the box is healthy and the reading names the instrument, not the fault.
 * SH_STARTED had 5 s and reset the box 10 s into a 30 s wait for the stick (24.5 s, 2026-10-10).
 * Same rule the decompressor taught: D once armed 6 s while inflate needed longer.
 */
test("SH_STARTED outlasts the wait for the USB stick", () => {
  const sh = stages().find((x) => x.name === "CP_SH_STARTED")!;
  const worstGapToNextStage = 5 /* info + dmesg */ + 30 /* stick wait */ + 5 /* margin */;
  expect(2 * sh.secs).toBeGreaterThan(worstGapToNextStage);
});

/*
 * ⛔ EHCI port 0 is the OTG port, muxed by bit 28 of 0xf8a2012c (vendor hiotg.c DWC_OTG_SWITCH:
 * set = device controller, clear = host). Mainline has no driver for it, so the stick was never
 * routed to EHCI — root hubs up, no /dev/sd* (NO_STICK, 2026-10-10). The switch must happen
 * BEFORE the USB log waits for the stick, and must touch only bit 28.
 */
test("init.sh routes the OTG port to the host before waiting for the stick", () => {
  const sh = SH.replace(/^\s*#.*$/gm, "");
  expect(sh).toContain("$BB devmem 0xf8a2012c 32 $(( OTG_BEFORE & ~0x10000000 ))");
  expect(sh.indexOf("devmem 0xf8a2012c 32 $((")).toBeLessThan(sh.indexOf("usb_log early"));
  expect(sh.indexOf("mount -t devtmpfs")).toBeLessThan(sh.indexOf("devmem 0xf8a2012c"));
});

/*
 * ⛔ Three NO_STICK readings and two fixes that changed nothing: the box now classifies WHY from
 * the controllers' own registers instead of us guessing. Every branch must arm a verdict.
 */
test("usb_why classifies from the hardware and every branch arms a verdict", () => {
  const sh = SH.replace(/^\s*#.*$/gm, "");
  const fn = sh.slice(sh.indexOf("usb_why() {"), sh.indexOf("usb_dev() {"));
  for (const v of ["CP_NS_DEVICE_NO_DISK", "CP_NS_EHCI_CONNECT", "CP_NS_OHCI_CONNECT",
    "CP_NS_NO_CONNECT", "CP_NS_UNPOWERED"]) expect(fn).toContain(`cp_arm $${v}`);
  expect(fn).toContain("0xf9890000");               // EHCI capability base
  expect(fn).toContain("op + 0x44 + 4 * i");          // PORTSCn
  expect(fn).toContain("0xf9880054 + 4 * i");         // OHCI HcRhPortStatus[n]
});

/*
 * ⛔ The device test must not match root-hub interfaces ("1-0:1.0"), or DEVICE_NO_DISK fires
 * for an empty bus — which it did (5:25, 2026-10-10).
 */
test("the USB-device pattern matches devices, not root-hub interfaces", () => {
  const m = SH.match(/grep -qE '(\^\[0-9\]\+-\[0-9\.\]\+\$)'/);
  expect(m).not.toBeNull();
  const re = new RegExp(m![1]);
  for (const dev of ["1-1", "3-1", "5-1.2"]) expect(re.test(dev)).toBe(true);
  for (const notDev of ["usb1", "1-0:1.0", "3-1:1.0", "5-1.2:1.1"]) expect(re.test(notDev)).toBe(false);
});

/*
 * ⛔ CONFIG_IPV6_SIT=y means sit0 always exists and is always DOWN, and /sys/class/net is listed
 * in a pointer-seeded hash order — so "the first non-lo netdev" can be sit0, and every DOWN
 * verdict may have measured a tunnel. The verdict must read the netdev UNDER the gmac device.
 */
test("the NIC verdict reads the netdev under the gmac device, never a /sys/class/net scan", () => {
  const src = stripComments(readFileSync(`${DIR}/init.c`, "utf8"));
  const fn = src.slice(src.indexOf("static unsigned int nic_verdict"));
  expect(fn).toContain("netdev_of(dev, net");
  expect(src).not.toContain("first_netdev");
  expect(src).not.toMatch(/opendir\("\/sys\/class\/net"\)/);
  expect(src).toMatch(/snprintf\(dir, sizeof dir, "%s\/net", dev\)/);
});

/*
 * ⛔ The RGMII sweep must try the strap pins (= the vendor) FIRST, keep the first setting that
 * makes packets arrive, and log every step to /dev/kmsg — the only channel Android can read.
 */
test("the RGMII sweep is gone: the delay is a measured device-tree fact (rgmii-id)", () => {
  const src = stripComments(readFileSync(`${DIR}/init.c`, "utf8"));
  expect(src).not.toContain("rgmii_sweep");
  const dts = readFileSync(`${import.meta.dir}/kernel/arm32/hi3798cv200-himedia-q10-pro.dts`, "utf8");
  // straps 10/10 and both-forced 10/10 router pings; either delay alone 0/10 (2026-10-11)
  expect(dts).toMatch(/phy-mode = "rgmii-id";/);
});

test("init.sh switches to rootfs.img only after every step succeeds, with the watchdog armed", () => {
  const sh = readFileSync(`${DIR}/init.sh`, "utf8");
  const fn = sh.slice(sh.indexOf("try_rootfs() {"), sh.indexOf("[ -e /noroot ] || try_rootfs"));
  // every failure returns (falls through to the initramfs shell) rather than exiting PID 1
  expect(fn.match(/return 1/g)!.length).toBeGreaterThanOrEqual(5);
  // the safety net is armed BEFORE the switch, and the switch is the last thing
  expect(fn.indexOf("devmem 0xf8a2c000 32 $WD_ROOTFS")).toBeGreaterThan(0);
  expect(fn.indexOf("devmem 0xf8a2c000 32 $WD_ROOTFS")).toBeLessThan(fn.indexOf("switch_root"));
  // the stick backs the loop file, so it moves INTO the new root instead of being unmounted
  expect(fn).toContain("mount --move /stick /newroot/mnt/stick");
  for (const m of ["/dev", "/proc", "/sys"]) expect(fn).toContain(`mount --move ${m}`);
  // and it runs before anything else mounts the stick
  expect(sh.indexOf("try_rootfs\n")).toBeLessThan(sh.indexOf("usb_log early"));
});

test("the hix5hd2 patch adds the MII ioctl and accepts every RGMII variant", () => {
  const p = readFileSync(`${import.meta.dir}/kernel/arm32/0003-net-hix5hd2-rgmii-variants-and-mii-ioctl.patch`, "utf8");
  expect(p).toContain("+	.ndo_eth_ioctl		= phy_do_ioctl_running,");
  for (const m of ["RGMII_ID", "RGMII_RXID", "RGMII_TXID"]) expect(p).toContain(`+	case PHY_INTERFACE_MODE_${m}:`);
});

test("the rootfs stands the watchdog down only after sshd, and forwards its journal to kmsg", () => {
  const b = readFileSync(`${import.meta.dir}/build-rootfs.ts`, "utf8");
  expect(b).toMatch(/After=ssh\.service\nRequires=ssh\.service/);
  expect(b).toContain("ExecStart=/bin/busybox devmem 0xf8a2c008 32 0");
  expect(b).toContain("ForwardToKMsg=yes");      // a hung userspace is still readable via ramoops
  expect(b).toContain('"busybox"');              // devmem comes from Debian's busybox
  expect(b).toMatch(/--arch", "armhf"/);         // the kernel is AArch32
});

test("PID 1 touches the SP805 only when the device tree says this is the Q10 Pro", () => {
  const src = stripComments(readFileSync(`${DIR}/init.c`, "utf8"));
  const cp = src.slice(src.indexOf("static void himedia_checkpoint"));
  expect(cp.indexOf("if (!on_board())")).toBeGreaterThan(0);
  expect(cp.indexOf("if (!on_board())")).toBeLessThan(cp.indexOf("mmap("));
  const dts = readFileSync(`${import.meta.dir}/kernel/arm32/hi3798cv200-himedia-q10-pro.dts`, "utf8");
  const m = src.match(/memmem\(b, \(size_t\)n, "([^"]+)", (\d+)\)/)!;
  expect(dts).toContain(`compatible = "${m[1]}"`);
  expect(Number(m[2])).toBe(m[1].length);          // a wrong length silently never matches
});

test("the rootfs ships a real resolver, D-Bus and the Mac's locale (first box boot lacked all three)", () => {
  const b = readFileSync(`${import.meta.dir}/build-rootfs.ts`, "utf8");
  expect(b).toContain('"dbus"');
  expect(b).toMatch(/nameserver 192\.168\.1\.1/);
  expect(b).toContain('rm -f "\\$TARGET/etc/resolv.conf"');
  expect(b).toContain("locale-gen");
});
