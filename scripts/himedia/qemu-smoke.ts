#!/usr/bin/env bun
/**
 * Boot our kernel under QEMU, with a real console — no USB swap, no box.
 *
 * ⭐ Why this matters: every failure so far has been diagnosed through a single bit of ICMP,
 * because the box has no console attached. QEMU's `virt` machine gives a PL011 on stdio, so
 * we see the entire kernel log. It would have caught the empty initramfs instantly.
 *
 * ⚠️ What it CANNOT test: our board device tree. QEMU has no hi3798cv200 machine model, so
 * this runs on `virt` with QEMU's own tree. So it validates the kernel binary, the embedded
 * initramfs, the static init and the userspace plumbing — and says nothing about whether our
 * DT is right for the real SoC. Board-DT work still needs the hardware.
 *
 * ⛔ Uses the BARE zImage, not the uImage: with CONFIG_ARM_APPENDED_DTB the decompressor
 * prefers a device tree glued to the image over whatever the bootloader passes in r2, so the
 * uImage would make the kernel try to drive HiMedia hardware inside QEMU.
 *
 * Usage:
 *   bun run himedia:qemu            # boot, capture the log, report what probed
 *   bun run himedia:qemu --timeout 60
 *   bun run himedia:qemu --stick <rootfs.img>   # + the Debian root, booted to an ssh login
 *
 * ⭐ `--stick` reproduces the box's boot medium: a partitioned FAT32 disk holding rootfs.img,
 * attached as USB mass storage behind QEMU's xHCI so the guest sees /dev/sda1 exactly as the
 * box does. init.sh loop-mounts it and switch_roots; the run passes only when a real
 * `ssh root@` login through the forwarded port answers from the loop-mounted root.
 * ⚠️ The SP805 is not modelled, so q10-watchdog-off.service fails here by design (devmem of an
 * unmapped address) — the watchdog half is validated on the box only.
 */
import { WORK_ROOT } from "./lib.ts";
import { existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

const ROOT = `${WORK_ROOT}/kernel-build-arm32`;

async function main() {
  const argv = process.argv.slice(2);
  const ti = argv.indexOf("--timeout");
  const si = argv.indexOf("--stick");
  // --smp N: multi-threaded TCG. UNMEASURED speed-up (docs/261011-sota-aarch32-emulation-
  // apple-silicon-summary.md) — compare the wall-clock line below across runs before keeping it.
  const smpI = argv.indexOf("--smp");
  const smp = smpI >= 0 ? Number(argv[smpI + 1]) : 1;
  const rootfs = si >= 0 ? argv[si + 1] : "";
  const secs = ti >= 0 ? Number(argv[ti + 1]) : rootfs ? 300 : 45;
  const HOSTPORT = 18080;
  const SSHPORT = 12222;
  let stick = "";
  if (rootfs) {
    if (!existsSync(rootfs)) { console.error(`⛔ ${rootfs} missing (from --stick)`); process.exit(1); }
    stick = await makeStick(rootfs);
  }

  if (!Bun.which("qemu-system-arm")) { console.error("qemu-system-arm not found (brew install qemu)"); process.exit(2); }

  // ⚠️ Only DIRECTORIES: a glob of `linux-*` also matches `linux-6.18.55.tar.xz`,
  // which then yields a zImage path that can never exist.
  const vers = (await Array.fromAsync(
    new Bun.Glob("linux-*/arch/arm/boot/zImage").scan({ cwd: ROOT }))).sort();
  const zImage = vers.length ? `${ROOT}/${vers[vers.length - 1]}` : `${ROOT}/<none>`;
  if (!existsSync(zImage)) {
    console.error(`⛔ no zImage at ${zImage} — run \`bun run himedia:build-arm32\` first.`);
    process.exit(1);
  }

  // ⛔ The harness boots whatever zImage the LAST build left. A --checkpoints build writes the
  // SP805 from the decompressor and cannot run on virt — it produced "no output at all" four
  // times on 2026-10-11 and read as a broken kernel. Refuse it by name instead.
  const cfg = `${dirname(dirname(dirname(dirname(zImage))))}/.config`;
  if (existsSync(cfg) && /^CONFIG_DEBUG_LL=y/m.test(await Bun.file(cfg).text())) {
    console.error("⛔ the zImage in the tree is a --checkpoints build (DEBUG_LL=y, SP805 stores) — it cannot boot on QEMU virt.");
    console.error("   Rebuild without --checkpoints first: bun scripts/himedia/build-kernel-arm32.ts --no-efi --out uImage-qemu");
    process.exit(2);
  }
  console.log(`[local] ${zImage}`);
  console.log(`[local] qemu-system-arm -M virt (QEMU's own device tree, NOT ours)\n`);

  // `rdinit=/init` exercises the real embedded initramfs and our static PID 1.
  //
  // ⭐ The networking is the point, not a nicety: `ip=` is handled by CONFIG_IP_PNP in the
  // kernel before userspace, and `httpd` serving /info.txt is precisely what watch-boot
  // fetches from the real box. Forwarding port 80 out to the host means the end-to-end path
  // the box is judged on can be exercised here, with a console attached, and no USB swap.
  //
  // ⚠️ QEMU's user network is 10.0.2.x, so the board's own `ip=` cannot be reused — and the
  // bare zImage carries no appended DTB, so QEMU's device tree wins and -append is honoured.
  const args = [
    // ⛔ highmem=off: virt otherwise puts the PCIe ECAM above 4 GiB, which a non-LPAE kernel
    // cannot map ("missing reg", -75) — no PCI means no xHCI, no stick, no /dev/sda1.
    ...(smp > 1 ? ["-smp", String(smp), "-accel", "tcg,thread=multi,tb-size=512"] : []),
    "-M", "virt,highmem=off", "-m", rootfs ? "1024" : "512", "-nographic", "-no-reboot",
    "-kernel", zImage,
    "-append",
    "console=ttyAMA0 earlycon panic=5 loglevel=8 rdinit=/init " +
      "ip=10.0.2.15::10.0.2.2:255.255.255.0::eth0:off",
    "-netdev", `user,id=n0,hostfwd=tcp::${HOSTPORT}-:80,hostfwd=tcp::${SSHPORT}-:22`,
    "-device", "virtio-net-device,netdev=n0",
    ...(stick ? ["-device", "qemu-xhci,id=xhci",
      "-drive", `if=none,id=stick,format=raw,file=${stick}`,
      "-device", "usb-storage,bus=xhci.0,drive=stick"] : []),
  ];
  const t0 = Date.now();
  const p = Bun.spawn(["qemu-system-arm", ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const killer = setTimeout(() => p.kill("SIGKILL"), secs * 1000);
  // Probe the forwarded port WHILE the guest runs — once it exits there is nothing to ask.
  let httpBody = "";
  let httpErr = "";
  let sshOut = "";
  // ⛔ Stop probing the moment QEMU is gone: the first --stick run kept retrying ssh for
  // minutes against a guest that had already exited, and looked like a slow boot.
  let qemuGone = false;
  p.exited.then(() => { qemuGone = true; });
  const probe = rootfs ? (async () => {
    for (let i = 0; i < secs - 5 && !qemuGone; i += 5) {
      await Bun.sleep(5000);
      const r = Bun.spawn(["ssh", "-p", String(SSHPORT), "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null", "-o", "ConnectTimeout=4", "-o", "BatchMode=yes",
        "root@127.0.0.1", "uname -a; findmnt -no SOURCE,FSTYPE /; . /etc/os-release; echo $PRETTY_NAME; dpkg --print-architecture; systemctl is-system-running"],
        { stdout: "pipe", stderr: "pipe" });
      const o = await new Response(r.stdout).text();
      if ((await r.exited) === 0 || /Linux/.test(o)) { sshOut = o; p.kill("SIGKILL"); return; }
    }
  })() : (async () => {
    for (let i = 0; i < secs - 2; i++) {
      await Bun.sleep(1000);
      try {
        const r = await fetch(`http://127.0.0.1:${HOSTPORT}/info.txt`,
          { signal: AbortSignal.timeout(2000) });
        if (r.ok) { httpBody = await r.text(); return; }
        httpErr = `HTTP ${r.status}`;
      } catch (e) { httpErr = String((e as Error).message ?? e); }
    }
  })();

  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  clearTimeout(killer);
  await probe;

  const log = out + err;
  mkdirSync(`${WORK_ROOT}/qemu`, { recursive: true });
  const f = `${WORK_ROOT}/qemu/${new Date().toISOString().replace(/[-:T]/g, "").replace(/\..*$/, "")}-virt.log`;
  writeFileSync(f, log);

  console.log(`--- ${log.split("\n").length} lines captured -> ${f}\n`);
  if (!log.trim()) {
    console.error("⛔ QEMU produced NO output at all — the kernel did not even reach earlycon.");
    console.error("   That points at the kernel image itself, not at any device tree.");
    process.exit(1);
  }

  // The questions this run exists to answer.
  const checks: Array<[string, RegExp]> = [
    ["decompressor ran", /Uncompressing Linux|Booting Linux/i],
    ["kernel banner", /Linux version 6\.\d+/],
    ["initramfs unpacked", /Unpacking initramfs|rootfs image is initramfs/i],
    ["reached init", /Run \/init as init process|Freeing unused kernel/i],
    ["our static init ran", /random: crng init done|init\b/i],
    ["/dev mounted (devtmpfs)", /devtmpfs: mounted/i],
    ["no missing-console warning", /^(?!.*unable to open an initial console)/],
    ["panic (NOT expected)", /Kernel panic|Attempted to kill init/i],
  ];
  for (const [label, re] of checks) {
    const hit = log.split("\n").find((l) => re.test(l));
    console.log(`  ${hit ? "ok " : "·  "} ${label.padEnd(26)} ${hit ? hit.trim().slice(0, 96) : ""}`);
  }

  if (rootfs) {
    console.log(`\n--- ssh root@ via :${SSHPORT} (the loop-mounted Debian root) ---`);
    if (sshOut) {
      // ⭐ WALL clock, not guest timestamps: the guest's "ssh up at 22 s" said nothing about how
      // long a run takes, which is the number a speed flag has to move.
      console.log(`  ok  ssh login after ${((Date.now() - t0) / 1000).toFixed(0)} s wall clock (smp ${smp})`);
      for (const l of sshOut.trim().split("\n")) console.log(`  ok  ${l}`);
    }
    else console.log(`  ⛔  no ssh login within ${secs} s`);
    for (const l of log.split("\n").filter((l) => /q10: rootfs|switch_root|systemd\[1\]: (Started|Failed|Reached target Multi)/.test(l)).slice(0, 25))
      console.log(`  |  ${l.trim().slice(0, 140)}`);
    process.exit(sshOut ? 0 : 1);
  }

  // ⛔ The httpd answer is the only check that spans kernel + initramfs + init.c + init.sh
  // + busybox + networking. Everything above it can pass while the second stage is a no-op.
  console.log(`\n--- httpd on :80 (forwarded to ${HOSTPORT}) ---`);
  if (httpBody) {
    writeFileSync(f.replace(/-virt\.log$/, "-info.txt"), httpBody);
    console.log(`  ok  /info.txt served, ${httpBody.length} bytes`);
    for (const l of httpBody.split("\n").slice(0, 12)) console.log(`      ${l.slice(0, 110)}`);
  } else {
    console.log(`  ⛔  no answer (${httpErr || "never tried"}) — the second stage did not get as far as httpd`);
  }

  console.log("\n--- last 14 lines ---");
  for (const l of log.trimEnd().split("\n").slice(-14)) console.log(`  ${l.slice(0, 150)}`);
}

/**
 * A partitioned FAT32 disk image holding rootfs.img at its root — the box's stick, in a file.
 * Built in a container (sfdisk + mkfs.vfat + mtools) next to the rootfs, and reused while it
 * is newer than the rootfs image it carries.
 */
async function makeStick(rootfs: string): Promise<string> {
  const dir = `${WORK_ROOT}/qemu`;
  mkdirSync(dir, { recursive: true });
  const out = `${dir}/stick.img`;
  if (existsSync(out) && statSync(out).mtimeMs > statSync(rootfs).mtimeMs) return out;
  const mb = Math.ceil(statSync(rootfs).size / 1048576) + 96;
  const script = [
    "set -eu",
    "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fdisk dosfstools mtools >/dev/null",
    `rm -f /out/stick.img && truncate -s ${mb}M /out/stick.img`,
    "echo 'start=2048, type=c' | sfdisk -q /out/stick.img",
    `mkfs.vfat -F 32 -n STICK --offset 2048 /out/stick.img $(( ${mb} * 1024 - 1024 )) >/dev/null`,
    `mcopy -i /out/stick.img@@1M /in/${basename(rootfs)} ::rootfs.img`,
    "mdir -i /out/stick.img@@1M ::",
  ].join("\n");
  console.log(`[local] building the QEMU stick (${mb} MiB FAT32, rootfs.img inside) -> ${out}`);
  const p = Bun.spawn(["docker", "run", "--rm", "--platform", "linux/arm64",
    "-v", `${dirname(rootfs)}:/in:ro`, "-v", `${dir}:/out`, "debian:trixie", "bash", "-c", script],
    { stdout: "inherit", stderr: "inherit" });
  if ((await p.exited) !== 0) { console.error("⛔ stick image build failed"); process.exit(1); }
  return out;
}

if (import.meta.main) await main();
