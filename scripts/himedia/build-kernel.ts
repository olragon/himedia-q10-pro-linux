#!/usr/bin/env bun
/**
 * Build a mainline arm64 kernel for the Q10 Pro, with our SATA clock patch and board DTS.
 *
 * Runs in Docker, which on an Apple-silicon Mac is **natively linux/aarch64** — so this is
 * a native build and needs no cross-compiler at all.
 *
 * ⛔ Build output goes to $HIMEDIA_ROOT, never the repo: a kernel tree is multiple GB.
 *
 * What it proves without hardware: that the patch applies to a real tree, that the board
 * DTS compiles inside the kernel's own build (not just via a hand-rolled cpp invocation),
 * and that every driver this box needs is actually reachable in the config.
 *
 * Usage:
 *   bun run himedia:build-kernel                # fetch, patch, configure, build
 *   bun run himedia:build-kernel --config-only  # stop after configuring (fast sanity check)
 *   bun run himedia:build-kernel --version 6.18.55
 */
import { WORK_ROOT } from "./lib.ts";
import { mkdirSync, existsSync, writeFileSync, readFileSync } from "node:fs";

const ROOT = `${WORK_ROOT}/kernel-build`;
const IMAGE = "debian:trixie";
const DTS_NAME = "hi3798cv200-himedia-q10-pro";

/** Drivers this specific box needs. Each one is justified by a measurement, not a guess. */
const REQUIRED = [
  ["ARCH_HISI", "the SoC family"],
  ["COMMON_CLK_HI3798CV200", "the CRG — everything else hangs off its clocks"],
  ["MMC_DW", "eMMC controller core"],
  ["MMC_DW_HI3798CV200", "eMMC — the boot device"],
  ["HIX5HD2_GMAC", "gigabit ethernet; the box binds gmac1"],
  ["SERIAL_AMBA_PL011", "ttyAMA0 — the only rescue console"],
  ["SERIAL_AMBA_PL011_CONSOLE", "…as the console"],
  ["PHY_HISTB_COMBPHY", "the combo PHY that carries SATA"],
  ["SATA_AHCI_PLATFORM", "generic AHCI — the SATA bay"],
  ["USB_XHCI_HISTB", "USB 3.0"],
  ["PHY_HISI_INNO_USB2", "USB 2.0 PHY"],
  ["RESET_CONTROLLER", "the CRG's reset cells"],
  ["EXT4_FS", "rootfs"],
] as const;

async function sh(cmd: string[], timeoutMs = 3_600_000) {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const code = await p.exited;
  clearTimeout(t);
  return code;
}
async function cap(cmd: string[], timeoutMs = 600_000) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  const code = await p.exited;
  clearTimeout(t);
  return { out, err, code };
}

async function latest618(): Promise<string> {
  const r = await fetch("https://www.kernel.org/releases.json");
  const d = await r.json() as { releases: Array<{ version: string; moniker: string }> };
  const v = d.releases.find((x) => x.version.startsWith("6.18."));
  return v?.version ?? "6.18.55";
}

function dockerRun(script: string, extra: string[] = []) {
  return ["docker", "run", "--rm", "-v", `${ROOT}:/ws`, "-w", "/ws", ...extra, IMAGE, "bash", "-eux", "-c", script];
}

async function main() {
  const argv = process.argv.slice(2);
  const vi = argv.indexOf("--version");
  const version = vi >= 0 ? argv[vi + 1] : await latest618();
  const configOnly = argv.includes("--config-only");
  const src = `/ws/linux-${version}`;

  mkdirSync(ROOT, { recursive: true });
  // Stage our two inputs where the container can see them.
  mkdirSync(`${ROOT}/in`, { recursive: true });
  for (const f of ["0001-clk-hisilicon-crg-hi3798cv200-add-SATA-clocks.patch", `${DTS_NAME}.dts`]) {
    writeFileSync(`${ROOT}/in/${f}`, readFileSync(`${import.meta.dir}/kernel/${f}`));
  }
  writeFileSync(`${ROOT}/in/required.txt`, REQUIRED.map(([k]) => k).join("\n"));

  console.log(`[local] kernel ${version} · native linux/aarch64 build in Docker · ${ROOT}\n`);

  const prep = `
# ⛔ apt pipelines every package over ONE connection per host, and its default
# Acquire::http::Timeout is 120 s — so a single stalled CDN node froze the toolchain download at
# a few KB/s for minutes, then it "suddenly" ran at full speed once apt gave up and reconnected
# (measured 2026-10-10: the Mac and a fresh container both got 3.5 MB/s from the same host).
# Drop a stalled connection in 15 s, retry, and do not pipeline.
cat > /etc/apt/apt.conf.d/99-fail-fast <<'APTCONF'
Acquire::http::Timeout "15";
Acquire::Retries "5";
Acquire::http::Pipeline-Depth "0";
APTCONF
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  build-essential bc bison flex libssl-dev libelf-dev python3 xz-utils curl ca-certificates kmod >/dev/null

cd /ws
if [ ! -d linux-${version} ]; then
  [ -f linux-${version}.tar.xz ] || curl -fsSL -o linux-${version}.tar.xz \
    https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${version}.tar.xz
  tar xf linux-${version}.tar.xz
fi
cd ${src}

# --- our SATA clock patch (idempotent) ---
if ! grep -q HISTB_SATA_BUS_CLK include/dt-bindings/clock/histb-clock.h; then
  patch -p1 --no-backup-if-mismatch < /ws/in/0001-clk-hisilicon-crg-hi3798cv200-add-SATA-clocks.patch
fi
grep -q HISTB_SATA_BUS_CLK drivers/clk/hisilicon/crg-hi3798cv200.c

# --- our board DTS, wired into the kernel's own build ---
cp /ws/in/${DTS_NAME}.dts arch/arm64/boot/dts/hisilicon/
MK=arch/arm64/boot/dts/hisilicon/Makefile
grep -q ${DTS_NAME} \$MK || echo 'dtb-$(CONFIG_ARCH_HISI) += ${DTS_NAME}.dtb' >> \$MK

# --- config ---
make ARCH=arm64 defconfig
for opt in \$(cat /ws/in/required.txt); do ./scripts/config --enable \$opt; done
make ARCH=arm64 olddefconfig

echo "=== required options after olddefconfig ==="
fail=0
for opt in \$(cat /ws/in/required.txt); do
  if grep -q "^CONFIG_\${opt}=[ym]" .config; then echo "  ok   \$opt";
  else echo "  MISS \$opt"; fail=1; fi
done
[ \$fail -eq 0 ] || { echo "⛔ some required options could not be enabled"; exit 1; }
`;

  /*
   * ⛔ ONE container for prepare and build. `docker run --rm` discards the container, so
   * apt-installed tools do not survive into a second invocation — splitting these cost a
   * 40-minute run that died on `make: command not found` after the config step passed.
   */
  const build = configOnly ? "" : `
cd ${src}
make ARCH=arm64 -j"$(nproc)" Image dtbs
ls -l arch/arm64/boot/Image arch/arm64/boot/dts/hisilicon/${DTS_NAME}.dtb
`;
  const code = await sh(dockerRun(prep + build));
  if (code !== 0) { console.error(`\n⛔ ${configOnly ? "prepare/config" : "build"} failed (exit ${code})`); process.exit(1); }
  if (configOnly) { console.log("\n✅ patched, DTS installed, config verified. Stopping before the build (--config-only)."); return; }

  const img = `${ROOT}/linux-${version}/arch/arm64/boot/Image`;
  const dtb = `${ROOT}/linux-${version}/arch/arm64/boot/dts/hisilicon/${DTS_NAME}.dtb`;
  for (const f of [img, dtb]) {
    if (!existsSync(f)) { console.error(`⛔ expected artifact missing: ${f}`); process.exit(1); }
  }

  /*
   * ⚠️ Check the kernel's OWN cpp output, not the .dtb. A compiled DTB has numeric
   * phandles instead of `&crg` labels, so the clock check can verify nothing there — and
   * pointing it at the DTB is exactly the false-green its zero-reference guard exists to
   * catch. The kernel leaves the preprocessed source beside the blob.
   */
  const pre = `${ROOT}/linux-${version}/arch/arm64/boot/dts/hisilicon/.${DTS_NAME}.dtb.dts.tmp`;
  const target = existsSync(pre) ? pre : dtb;
  if (target === dtb) console.log("\n⚠️  kernel cpp output not found; falling back to the DTB, which verifies little");
  const chk = await cap(["bun", `${import.meta.dir}/check-dt-refs.ts`, target,
    "--kernel", `${ROOT}/linux-${version}`]);
  console.log(`\n[local] clock check on the kernel's preprocessed tree:`);
  console.log((chk.out + chk.err).split("\n").filter((l) => /⛔|✅|NOT NAMED|not registered|no .&crg/.test(l)).join("\n"));

  console.log(`\n✅ artifacts:`);
  console.log(`   Image : ${img}`);
  console.log(`   DTB   : ${dtb}`);
  console.log(`\nNeither has been booted. Next is a serial console on the box.`);
}

if (import.meta.main) await main();
