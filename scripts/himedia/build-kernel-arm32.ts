#!/usr/bin/env bun
/**
 * Build a 32-bit ARM (AArch32) mainline kernel + uImage for the Q10 Pro.
 *
 * ⭐ Why 32-bit: the stock bootloader is a 32-bit U-Boot whose `bootm` checks the uImage
 * architecture field. The stock kernel is `arch=2` (ARM), there is no 32->64 handoff in the
 * loader, and it carries U-Boot's `Unsupported Architecture` rejection — so an arm64 image
 * cannot boot here. Replacing the loader needs unpublished DDR timing plus serial, so
 * AArch32 is the only route that keeps the box closed.
 *
 * ⭐ All four cores still work: the secure firmware provides PSCI, so `enable-method = "psci"`
 * applies in AArch32 too.
 *
 * Produces `uImage` (not `Image`): that is what the loader's `bootm` consumes, and the
 * generated env loads exactly `uImage` from the USB stick's root.
 *
 * ⛔ Output under $HIMEDIA_ROOT, never the repo.
 *
 * Usage:
 *   bun run himedia:build-arm32                # fetch, patch, configure, build uImage + dtb
 *   bun run himedia:build-arm32 --config-only
 */
import { WORK_ROOT } from "./lib.ts";
import { CHECKPOINTS, PATIENT, LATE, STEXT, MMU, KERNEL, USERSPACE, FAST_LADDER_SECONDS, assertReadable, CACHE_PROBE, CACHE_PROBE_IF_SET, asmFor, periodTable } from "./checkpoints.ts";
import { mkdirSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";

/** Q10_KBUILD_ROOT lets a second builder use a COPY of the tree (the build restores/re-applies patched files). */
const ROOT = process.env.Q10_KBUILD_ROOT ?? `${WORK_ROOT}/kernel-build-arm32`;
import { BUILDER_IMAGE } from "./build-builder-image.ts";
/**
 * The cached builder (toolchain pre-installed) when it exists, else plain debian:trixie + apt.
 * ⛔ The apt path stays as the fallback, never removed — the cached image is an accelerator.
 */
const IMAGE = Bun.spawnSync(["docker", "image", "inspect", BUILDER_IMAGE]).exitCode === 0
  ? BUILDER_IMAGE : "debian:trixie";
const DTS = "hi3798cv200-himedia-q10-pro";
/** The stock bootcmd loads to 0x1FFBFC0 and the stock uImage declares load/entry 0x2000000. */
/**
 * ⛐ The watchdog checkpoints are applied INSIDE the container, from the same table
 * `himedia:checkpoints` uses, because the kernel source is extracted in there. Applying them
 * on the host only works when the tree already exists — and a fresh extract would silently
 * drop them, shipping a kernel with no telemetry whose frozen logo would be misread as
 * "the kernel never ran" when in truth nothing was ever armed.
 */

/**
 * ⛔ A post-MMU checkpoint writes 0xf8a2c000 after __enable_mmu, where that physical address
 * has no mapping — the write would fault and the resulting hang would be our own instrument,
 * misread as the bug under test.
 *
 * ⭐ CONFIG_DEBUG_LL makes __create_page_tables add a flat section mapping for the debug UART
 * (head.S: `addruart r7, r3, r0` then a section store with io_mmuflags). A section is 1 MB and
 * section-aligned, so pointing DEBUG_UART_PHYS/VIRT at the SP805 maps 0xf8a00000-0xf8afffff
 * — which contains the watchdog — and the mapping survives the MMU switch.
 *
 * ⚠️ PHYS == VIRT is deliberate: it keeps the post-MMU address identical to the pre-MMU one,
 * so every checkpoint uses the same constant and there is one less thing to get wrong.
 * 0xf8a2c000 sits in vmalloc space (above lowmem, below VMALLOC_END), so it collides with
 * nothing.
 *
 * ⚠️ CONFIG_EARLY_PRINTK is deliberately NOT enabled: nothing should actually treat the
 * watchdog as a PL011. Should some error path call early_print anyway, the checkpoints now
 * re-LOCK WdogLock, and the SP805 ignores writes while locked — so a stray byte cannot retime
 * the instrument.
 */
function postMmuConfig(armed: boolean): string {
  /*
   * ⛔ A build WITHOUT --checkpoints must switch DEBUG_LL back OFF. The .config persists across
   * builds, so it stayed aimed at the SP805 and the decompressor printed "Uncompressing Linux"
   * into 0xf8a2c000 — on the box a locked watchdog ignores it, but under QEMU virt the address
   * is unmapped and the kernel faulted before printing one byte (2026-10-11, two QEMU runs).
   */
  if (!armed) return `./scripts/config --disable DEBUG_LL`;
  if (!CHECKPOINTS.some((c) => c.postMmu)) return "";
  const BASE = "0xf8a2c000";
  return [
    `# post-MMU checkpoint present: map the SP805's section via the DEBUG_LL mechanism`,
    `./scripts/config --enable DEBUG_LL`,
    `./scripts/config --enable DEBUG_LL_UART_PL01X`,
    `./scripts/config --set-val DEBUG_UART_PHYS ${BASE}`,
    `./scripts/config --set-val DEBUG_UART_VIRT ${BASE}`,
    `./scripts/config --disable EARLY_PRINTK`,
  ].join("\n");
}

/**
 * Assert the mapping really stuck. olddefconfig silently drops a symbol whose dependencies are
 * unmet — the exact failure that once shipped an empty initramfs — and here the consequence is
 * a kernel that faults the instant checkpoint J runs.
 */
function postMmuAssert(armed: boolean): string {
  if (!armed) return `grep -q "^CONFIG_DEBUG_LL=y" .config && { echo "⛔ DEBUG_LL still on in a build without checkpoints"; exit 1; }; true`;
  if (!CHECKPOINTS.some((c) => c.postMmu)) return "";
  return `
echo "=== post-MMU mapping (checkpoint J) ==="
for sym in DEBUG_LL DEBUG_LL_UART_PL01X; do
  grep -q "^CONFIG_\${sym}=y" .config || { echo "⛔ \${sym} did not stick — checkpoint J would fault"; exit 1; }
  echo "  ok   \${sym}"
done
for sym in DEBUG_UART_PHYS DEBUG_UART_VIRT; do
  v=\$(grep "^CONFIG_\${sym}=" .config | cut -d= -f2)
  [ "\$v" = "0xf8a2c000" ] || { echo "⛔ \${sym}=\$v, expected 0xf8a2c000 — the SP805 section would not be mapped"; exit 1; }
  echo "  ok   \${sym}=\$v"
done`;
}

/**
 * ⛔ A build WITHOUT --checkpoints must put the checkpointed files back to pristine. The tree
 * persists between builds, so the stores a previous --checkpoints build inserted stayed in —
 * checkpoint A writes the SP805 at 0xf8a2c000 from the decompressor, before the MMU. On the box
 * that is harmless; under QEMU virt the address is unmapped and the kernel died before printing
 * a byte, three runs in a row (2026-10-11), read as "QEMU is slow".
 * Restoring the text is not enough — see the touch below.
 */
const RAMLOG_CONFIG = [
  "./scripts/config --enable DEBUG_LL",
  "./scripts/config --enable DEBUG_LL_UART_PL01X",
  "./scripts/config --set-val DEBUG_UART_PHYS 0x7a87f000",
  // Same offset within the 1 MiB section as PHYS (__create_page_tables maps a section), in the
  // static-mapping area — like the SP805 mapping the checkpoints use.
  "./scripts/config --set-val DEBUG_UART_VIRT 0xf7a7f000",
  "./scripts/config --enable EARLY_PRINTK",
].join("\n");
const RAMLOG_ASSERT = `
for kv in DEBUG_LL=y EARLY_PRINTK=y DEBUG_UART_PHYS=0x7a87f000 DEBUG_UART_VIRT=0xf7a7f000; do
  grep -q "^CONFIG_\${kv}\$" .config || { echo "⛔ ramlog: CONFIG_\${kv} did not stick"; exit 1; }
  echo "  ok   ramlog \${kv}"
done
`;

function pristineStep(version: string): string {
  const files = [...new Set(CHECKPOINTS.map((c) => c.file))];
  return [
    ...files.map((f) => `tar -C /ws -xf /ws/linux-${version}.tar.xz linux-${version}/${f} && echo "  pristine ${f}"`),
    ...files.map((f) => `grep -q "himedia checkpoint" ${f} && { echo "⛔ checkpoint code still in ${f}"; exit 1; }; true`),
    // ⛔ tar restores the TARBALL's mtime, older than the objects the checkpointed build made,
    // so make kept the stale objects and the stores stayed compiled in (QEMU trace: data abort
    // at 0xf8a2cc00). (`mv backup file` restores the content with the OLD mtime, and make then skips it.)
    `touch ${files.join(" ")}`,
  ].join("\n");
}

function checkpointStep(version: string): string {
  const specs = CHECKPOINTS.map((c) => ({
    id: c.id, file: c.file, anchor: c.anchor, asm: asmFor(c, c.indent),
  }));
  return [
    "cat > /tmp/cp.json <<'CPJSON'",
    JSON.stringify(specs),
    "CPJSON",
    /*
     * ⛔ Patch from PRISTINE sources, not from whatever state the tree is in. Stripping was
     * not enough: the restore used to be emitted after the end marker, which the strip regex
     * does not cover, so each revert orphaned a `pop {r3, r4}`. They accumulated to 15 pops
     * against 3 pushes and one flashed image carried 6 — corrupting sp directly beneath
     * inflate's workspace, which hangs decompression in a way that mimics the real bug.
     * Re-extracting the two files makes the patch idempotent by construction.
     */
    ...[...new Set(CHECKPOINTS.map((c) => c.file))].map((f) =>
      `tar -C /ws -xf /ws/linux-${version}.tar.xz linux-${version}/${f} && echo "  pristine ${f}"`),
    "python3 - <<'CPPY'",
    "import json, re",
    // ⛔ Strip any previously inserted blocks FIRST. applyTo is idempotent, so without this a
    // changed timeout is silently ignored and the box reports the OLD period — a reading that
    // looks valid and means something else.
    // Both comment styles: `@ ---` in assembly, `/* ---` in the C checkpoints in init/main.c.
    "STRIP = re.compile(r'^[ \\t]*(?:@|/\\*) --- himedia checkpoint [\\s\\S]*?--- end checkpoint [A-Za-z0-9-]+ ---(?: \\*/)?\\n', re.M)",
    "for f in set(c['file'] for c in json.load(open('/tmp/cp.json'))):",
    "    src = open(f).read()",
    "    n = len(src)",
    "    src = STRIP.sub('', src)",
    "    open(f,'w').write(src)",
    "    print('  stripped', n - len(src), 'B from', f)",
    "for c in json.load(open('/tmp/cp.json')):",
    "    src = open(c['file']).read()",
    "    if 'checkpoint ' + c['id'] in src:",
    "        print('  already present', c['id']); continue",
    "    n = src.count(c['anchor'])",
    "    assert n == 1, 'anchor for %s matched %d times in %s, need exactly 1' % (c['id'], n, c['file'])",
    "    open(c['file'],'w').write(src.replace(c['anchor'], c['anchor'] + chr(10) + c['asm']))",
    "    print('  inserted', c['id'], 'into', c['file'])",
    "CPPY",
    // ⛔ Assert it is really in the file that will be compiled, not merely that python exited 0.
    ...CHECKPOINTS.map((c) =>
      `grep -q "checkpoint ${c.id}" ${c.file} || { echo "⛔ checkpoint ${c.id} missing from ${c.file}"; exit 1; }`),
    // ⛔ PUSH/POP BALANCE. The restore used to be emitted after the end marker, which the
    // strip regex does not cover, so every revert orphaned a `pop {r3, r4}` and every
    // re-apply added another. The tree reached 15 pops against 3 pushes and a flashed image
    // carried 6 orphans — each advancing sp by 8 bytes, directly under inflate's malloc
    // workspace. The resulting hang is indistinguishable from the bug under investigation,
    // so this must be a hard gate, not a comment.
    ...[...new Set(CHECKPOINTS.map((c) => c.file))].map((f) =>
      [`PUSHES=$(grep -c "push.*{r3, r4}" ${f} || true)`,
       `POPS=$(grep -c "pop.*{r3, r4}" ${f} || true)`,
       `echo "  ${f}: $PUSHES push / $POPS pop"`,
       `[ "$PUSHES" = "$POPS" ] || { echo "\u26d4 UNBALANCED push/pop in ${f} \u2014 orphaned stack ops corrupt the decompressor"; exit 1; }`,
      ].join("\n")),
  ].join("\n");
}

/**
 * Where bootm places and enters the image. 0x2000000 is what the stock bootcmd uses for the
 * vendor kernel.
 *
 * ⚠️ Raising it buys decompression headroom and does NOT move the kernel: AUTO_ZRELADDR
 * derives the RAM base as `pc & 0xf8000000`, which is 0 for anything below 128 MiB, so
 * zreladdr stays at TEXT_OFFSET either way. Our 30.5 MiB inflated image ends only 1.5 MiB
 * below 0x2000000, where the vendor's leaves 22 MiB. See himedia:decomp.
 */
const DEFAULT_LOADADDR = "0x2000000";

const REQUIRED = [
  ["ARCH_MULTI_V7", "the 32-bit baseline this SoC's A53 runs in AArch32"],
  ["ARCH_HISI", "exists on 32-bit ARM too, and gates the HiSilicon drivers"],
  ["ARM_GIC", "GIC-400"],
  ["ARM_PSCI", "secondary CPU bring-up — the secure firmware provides it"],
  ["SMP", "all four A53 cores"],
  ["ARM_ARCH_TIMER", "the architected timer"],
  ["COMMON_CLK_HI3798CV200", "the CRG"],
  ["MMC_DW", "eMMC core"],
  ["MMC_DW_HI3798CV200", "eMMC — the stock boot device"],
  /*
   * ⛔ Provider of gmac1's "phy" reset (ti,syscon-reset inside the CRG). multi_v7 builds it
   * as a MODULE, and the initramfs ships none — the driver tolerated the missing reset and
   * never pulsed the PHY. A `=m` passed the old `=[ym]` gate; the gate is `=y` now.
   */
  // Boot log to the USB stick: host, storage, and the FAT codepages vfat mounts with by default.
  ["USB_EHCI_HCD_PLATFORM", "EHCI — the controller the stock U-Boot loads our uImage through"],
  ["USB_OHCI_HCD_PLATFORM", "OHCI companion for full/low-speed devices on the same port"],
  ["USB_STORAGE", "the boot stick as /dev/sda"],
  ["BLK_DEV_SD", "SCSI disk, which usb-storage presents as"],
  ["VFAT_FS", "the stick is FAT32"],
  ["NLS_CODEPAGE_437", "vfat's default codepage — mount fails without it"],
  ["NLS_ISO8859_1", "vfat's default iocharset"],
  ["RESET_TI_SYSCON", "gmac1 phy reset provider — must be built in, the initramfs has no modules"],
  ["HIX5HD2_GMAC", "gigabit ethernet (gmac1); the box is on Ethernet"],
  ["SERIAL_AMBA_PL011", "ttyAMA0"],
  ["SERIAL_AMBA_PL011_CONSOLE", "…as the console"],
  ["USB_XHCI_HISTB", "USB 3.0"],
  ["PHY_HISI_INNO_USB2", "USB 2.0 PHY"],
  ["EXT4_FS", "rootfs"],
  ["ARM_APPENDED_DTB", "lets the dtb ride with the kernel if the loader passes none"],
  ["BLK_DEV_INITRD", "the embedded initramfs — the only way to observe this board"],
  ["IP_PNP", "the kernel configures eth0 itself, before userspace"],
  ["DEVTMPFS", "/dev for the initramfs"],
  ["PROC_FS", "/proc"],
  ["SYSFS", "/sys"],
  // ⚠️ There is no CONFIG_DEVPTS_FS: devpts is built in with UNIX98_PTYS
  // (obj-$(CONFIG_UNIX98_PTYS) += devpts/). What was missing was MOUNTING it in init.
  ["UNIX98_PTYS", "brings devpts with it; init must still mount /dev/pts"],
  // The real root: Debian (systemd) on rootfs.img, loop-mounted off the FAT32 stick.
  ["BLK_DEV_LOOP", "rootfs.img is a file on the FAT32 stick"],
  ["CGROUPS", "systemd will not boot without cgroups"],
  ["FHANDLE", "systemd: name_to_handle_at"],
  ["AUTOFS_FS", "systemd automount points"],
  ["INOTIFY_USER", "systemd and udev"],
  ["TMPFS", "systemd's /run and /tmp"],
  ["NAMESPACES", "units with PrivateTmp/ProtectHostname/PrivateNetwork"],
  ["UTS_NS", "ProtectHostname= (systemd-hostnamed, logind)"],
  ["NET_NS", "PrivateNetwork= (systemd-hostnamed)"],
  // Built in again: the "SATA hang" was a box-written uImage, and xhci0 (side USB3) needs
  // combphy0 at probe time — as a module it deferred until the SATA unit loaded it (~30 s).
  ["PHY_HISTB_COMBPHY", "combo PHYs: combphy0 = side USB3 (xhci0), combphy1 = SATA — patch 0002"],
  // IR receiver (ir@8001000, front panel window). Built in: the remote is how a TV box is used.
  // HDMI output as a DRM device over the boot-logo buffer: /dev/dri/card0 for video players.
  ["DRM_SIMPLEDRM", "simple-framebuffer as /dev/dri/card0 (mpv --vo=drm); fbcon via fbdev emulation"],
  ["DRM_FBDEV_EMULATION", "keeps the text console on HDMI"],
  ["RC_CORE", "remote-control core (/dev/lirc0, rc input device)"],
  ["RC_DEVICES", "menu gate for the IR receiver drivers"],
  ["IR_HIX5HD2", "the Hi3798CV200 IR receiver (mainline drivers/media/rc/ir-hix5hd2.c)"],
  ["RC_DECODERS", "menu gate for the in-kernel protocol decoders"],
  ["IR_NEC_DECODER", "NEC — the usual protocol of Chinese TV-box remotes"],
  ["LIRC", "/dev/lirc0: raw pulses for learning the remote with ir-keytable"],
  // Android 13 as a Waydroid (LXC) container on this kernel — docs/261012-himedia-dual-boot-android.md.
  // No newer vendor Android exists and the eMMC is never written, so a recent Android runs here.
  ["ANDROID_BINDER_IPC", "binder: Android's IPC (Waydroid)"],
  ["ANDROID_BINDERFS", "binderfs: per-container binder/hwbinder/vndbinder nodes"],
  ["MEMCG", "memory cgroup (LXC, Android lmkd)"],
  ["CGROUP_SCHED", "cpu cgroup (Android task profiles)"],
  ["CGROUP_FREEZER", "freezer (Android cached-app freezer, waydroid session freeze)"],
  ["CGROUP_PIDS", "pids cgroup (LXC)"],
  ["CPUSETS", "cpuset cgroup (Android task profiles)"],
  ["BPF_SYSCALL", "bpf(): LXC cgroup2 device policy"],
  ["CGROUP_BPF", "cgroup2 device controller is a BPF program"],
  ["CGROUP_DEVICE", "device cgroup (LXC)"],
  ["POSIX_MQUEUE", "LXC/IPC namespace mqueue"],
  ["PSI", "pressure stall info: Android 13 lmkd"],
  ["FUSE_FS", "Android /sdcard emulated storage"],
  // ⛔ vold sets a default POSIX ACL on /data/media/0 when it prepares user 0's CE storage; on
  // ext4 without ACLs that fails ("Operation not supported"), vold_prepare_subdirs exits 255 and
  // system_server loops on "error rebooting into recovery" (Waydroid's /data lives on our ext4).
  ["EXT4_FS_POSIX_ACL", "ext4 ACLs: Android vold's /data/media default ACL"],
  ["EXT4_FS_SECURITY", "ext4 security.* xattrs (Android file contexts)"],
  ["INPUT_UINPUT", "/dev/uinput: q10-keyinject tests a session's remote-key path without a person"],
  ["OVERLAY_FS", "Waydroid system/vendor overlays"],
  ["ZRAM", "compressed swap: Android + Linux in 2 GB"],
  ["DMABUF_HEAPS", "Codec2/gralloc linear buffers"],
  ["DMABUF_HEAPS_SYSTEM", "/dev/dma_heap/system"],
  ["VETH", "container network pair"],
  ["BRIDGE", "waydroid0 bridge"],
  ["NETFILTER", "NAT for the container"],
  ["NETFILTER_ADVANCED", "gates the xtables targets below"],
  ["NF_CONNTRACK", "NAT needs conntrack"],
  ["NF_NAT", "NAT core"],
  ["NF_TABLES", "nftables (Debian's iptables is iptables-nft)"],
  ["NF_TABLES_INET", "inet family"],
  ["NF_TABLES_IPV4", "ip family"],
  ["NFT_NAT", "nft nat"],
  ["NFT_MASQ", "nft masquerade"],
  ["NFT_CT", "nft ct"],
  ["NFT_COMPAT", "xtables matches through iptables-nft"],
  ["NETFILTER_XTABLES", "xtables core"],
  ["NETFILTER_XT_NAT", "xt SNAT/DNAT"],
  ["NETFILTER_XT_TARGET_MASQUERADE", "xt MASQUERADE"],
  // Debian 13's iptables is the nft backend, so the legacy x_tables tables (IP_NF_FILTER/NAT,
  // which 6.18 gates behind IP_NF_IPTABLES_LEGACY) are not needed — NFT_COMPAT carries the matches.
  ["IP_NF_IPTABLES", "iptables"],
  // CPU frequency scaling, stage 1 (patch 0013 + DT OPP table; docs/261012-himedia-cpufreq-stage1.md).
  // All =y: the initramfs ships no modules. Default governor is SCHEDUTIL since k23b (was PERFORMANCE), so boot
  // behaviour is unchanged (stays at 1596 MHz) until userspace picks a governor.
  ["CPU_FREQ", "cpufreq core"],
  ["CPUFREQ_DT", "generic DT cpufreq driver: OPP table + clk, no regulator in stage 1"],
  ["CPU_FREQ_GOV_PERFORMANCE", "selectable at runtime: pins the top OPP"],
  ["CPU_FREQ_GOV_USERSPACE", "scaling_setspeed: the stage-1 test steps rates by hand"],
  ["CPU_FREQ_GOV_ONDEMAND", "selectable at runtime"],
  ["CPU_FREQ_GOV_SCHEDUTIL", "selectable at runtime"],
  ["CPU_FREQ_DEFAULT_GOV_SCHEDUTIL", "schedutil from boot (measured 2026-10-12: idle 53.8 C vs 56.4 C with performance)"],
  ["THERMAL", "thermal core"],
  ["THERMAL_OF", "thermal zones from the device tree"],
  ["HI3798CV200_THERMAL", "SoC temperature sensor (patch 0014): /sys/class/thermal; critical trip 110 C"],
  // DVFS stage 2 (patch 0018 + DT; docs/261012-himedia-dvfs-stage2.md): CPU voltage + GPU devfreq.
  ["REGULATOR_HI3798CV200_CPU", "CPU core-voltage PWM regulator (patch 0018); q10_cpu_vscale=0 disables scaling"],
  ["DEVFREQ_GOV_USERSPACE", "devfreq userspace governor: the stage-2 GPU test pins each OPP by hand"],
  ["DEVFREQ_GOV_PERFORMANCE", "devfreq performance governor"],
  // HDMI CEC (patch 0019): the adapter lives in histb-hdmi (a module); the CEC core is already =y.
  ["MEDIA_CEC_SUPPORT", "CEC menu gate"],
  ["DRM_HISI_HISTB_HDMI_CEC", "CEC adapter inside histb-hdmi (bool: compiled into the module); histb_hdmi cec=0 disables it at load"],
  ["MEDIA_CEC_RC", "CEC User Control keys -> an rc-cec input device (KEY_UP/DOWN/OK/... for the session menu)"],
] as const;

/**
 * ⛔ Built as MODULES on purpose, and asserted `=m`. With both built in, the first SATA boot
 * (2026-10-11, disk installed) never reached the network and looped on the watchdog — the log
 * was lost. As modules nothing probes at boot: every boot reaches ssh, and the driver is loaded
 * BY HAND (`modprobe`) with the SP805 armed, so a hang resets into the same safe kernel and its
 * console is readable from /sys/fs/pstore. The rootfs blacklists both from udev auto-load.
 * Loaded in this order, each under its own watchdog, so a hang names the stage.
 */
/**
 * Asserted OFF. FB_SIMPLE and DRM_SIMPLEDRM both bind "simple-framebuffer"; simpledrm wins
 * because players (mpv --vo=drm, ffmpeg kmsgrab) need /dev/dri, and fbcon keeps working
 * through DRM_FBDEV_EMULATION.
 */
const DISABLED = [
  ["FB_SIMPLE", "replaced by DRM_SIMPLEDRM on the same boot-logo framebuffer"],
] as const;

const MODULAR = [
  // Hardware video decode (patch 0008): modules, so a TrustZone fault or a bad probe can only
  // happen on an explicit modprobe, never at boot.
  ["VIDEO_HISTB_VDEC", "Hi3798CV200 VDH decoder (V4L2 stateful mem2mem: H.264/HEVC/VP9/VP8/MPEG-2/4/VC-1)"],
  ["VIDEO_HISTB_VPSS", "Hi3798CV200 VPSS tile->linear converter the decoder needs"],
  ["DRM_PANFROST", "Mali-T720 GPU (render node for Mesa panfrost); blacklisted on the rootfs until proven"],
  ["DRM_HISI_HISTB_VDP", "VDP display controller + NV12 video plane; evicts simpledrm on load; blacklisted until proven"],
  ["DRM_HISI_HISTB_HDMI", "HDMI transmitter bridge: EDID, mode switching, HDR infoframes; adopts the boot link; pulled in by histb_vdp"],
  // Plug-in peripherals (Tim, 2026-10-11: "usb keyboard/mouse/bluetooth/wifi/sim?"). Modules load
  // only when a matching device is plugged in, so none of this can affect boot.
  ["BT_HCIBTUSB", "USB Bluetooth dongles (btusb)"],
  ["RTL8XXXU", "Realtek USB WiFi dongles (8188/8192/8723 families)"],
  ["RTW88", "rtw88 menu (gates the 8822BU/8821CU entries below)"],
  ["RTW88_8822BU", "Realtek 8822BU USB WiFi"],
  ["RTW88_8821CU", "Realtek 8821CU USB WiFi (common AC600 dongles)"],
  ["MT7601U", "MediaTek MT7601U USB WiFi (cheap N150 dongles)"],
  // MT76x2U omitted: scripts/config upper-cases names and that symbol is mixed-case.
  ["USB_SERIAL", "USB serial core (4G modem AT/diag ports)"],
  ["USB_SERIAL_OPTION", "4G/LTE USB modems' serial ports (option)"],
  ["USB_WDM", "cdc-wdm control channel for QMI/MBIM modems"],
  ["USB_NET_QMI_WWAN", "Qualcomm-based 4G modems (QMI)"],
  ["USB_NET_CDC_MBIM", "MBIM 4G modems"],
  // CDC-ECM (USB_NET_CDCETHER: HiLink modems, USB ethernet) is already built in.
  ["USB_NET_RNDIS_HOST", "RNDIS modems / phone USB tethering"],
  ["USB_NET_HUAWEI_CDC_NCM", "Huawei NCM modems"],
  ["USB_ACM", "CDC-ACM modems/serial gadgets"],
  ["HID_MULTITOUCH", "USB touch panels"],
  ["SATA_AHCI_PLATFORM", "the SATA bay (ahci_platform)"],
] as const;

/**
 * Bring-up networking. A static address is used rather than DHCP so the box is findable the
 * instant the kernel configures it, with no dependency on a lease.
 * ⚠️ Deliberately OUTSIDE the router's DHCP pool (.160-.251) to avoid a collision.
 */
const BRINGUP_IP = process.env.Q10_STATIC_IP ?? "192.168.1.56";  // pick a free address on YOUR LAN (Q10_STATIC_IP)
const BRINGUP_GW = process.env.Q10_GATEWAY ?? "192.168.1.1";

async function sh(cmd: string[], timeoutMs = 5_400_000) {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const code = await p.exited;
  clearTimeout(t);
  return code;
}

async function latest(): Promise<string> {
  const r = await fetch("https://www.kernel.org/releases.json");
  const d = await r.json() as { releases: Array<{ version: string }> };
  return d.releases.find((x) => x.version.startsWith("6.18."))?.version ?? "6.18.55";
}

/**
 * ⛔ A backtick inside the shell template literal closes the string, and bun then reports the
 * parse error at a line far from the cause. I made this mistake three times, and a test for
 * it already existed — the failure was not running the test before building. So the build
 * checks itself: a guard you have to remember to invoke is a guard that will be forgotten.
 */
async function assertShellBodyClean() {
  const src = await Bun.file(import.meta.path).text();
  const bodies = [...src.matchAll(/=\s*`\n([\s\S]*?)\n`;/g)].map((m) => m[1]);
  for (const b of bodies) {
    if (b.includes("`")) {
      console.error("⛔ a shell template literal in this file contains a backtick, which closes");
      console.error("   the string. Use single quotes in comments instead.");
      process.exit(2);
    }
  }
}

async function main() {
  await assertShellBodyClean();
  const argv = process.argv.slice(2);
  const vi = argv.indexOf("--version");
  /*
   * ⛔ PINNED. Defaulting to kernel.org's "latest" silently switched a k-build to 6.18.56 the
   * evening it was released (2026-10-11): new tree, full rebuild, and modules for a release no
   * box runs. Bump this on purpose; `--version latest` still asks kernel.org.
   */
  const PINNED_VERSION = "6.18.55";
  const version = vi >= 0 ? (argv[vi + 1] === "latest" ? await latest() : argv[vi + 1]) : PINNED_VERSION;
  const configOnly = argv.includes("--config-only");
  /**
   * ⭐ --checkpoints arms the SP805 watchdog at two PRE-MMU points, turning the reboot period
   * into a readable number. Needed because this box has no console: mainline has no display
   * driver for the SoC, so a healthy kernel and a hung one look identical on HDMI.
   */
  const checkpoints = argv.includes("--checkpoints");
  /**
   * ⛔ --patient gives the decompression stage a 60 s budget. Without it D arms 12 s, and
   * inflating 30.5 MB of gzip can exceed that — so a reset at D cannot distinguish "hung" from
   * "still working", and the reading understates progress.
   */
  if (argv.includes("--patient")) {
    for (const c of CHECKPOINTS) c.seconds = PATIENT[c.id] ?? c.seconds;
  }
  /**
   * --late spreads the LAST three checkpoints tens of seconds apart. The cache-probe reading
   * could not distinguish D-off / E / B because all three land near 16 s once the (unmeasured)
   * 12.3 MB USB-read overhead is allowed for; with --late they are 66 / 46 / 16 s.
   */
  /** --stext bisects the post-stext, pre-MMU path (F/G/H/I) and gives I room to live. */
  /**
   * --mmu adds the first POST-MMU checkpoint (J, at __mmap_switched). See `postMmuConfig`
   * below: it only works because CONFIG_DEBUG_LL maps the debug-UART section and we aim that
   * mapping at the SP805's own 1 MB section.
   */
  /** --kernel-cp bisects start_kernel with C checkpoints (K..O) on top of the asm ones. */
  /** --userspace adds P/Q (initcalls, pre-exec) and pairs with R, armed by PID 1 itself. */
  /**
   * --fast collapses every kernel checkpoint to one period: "regressed somewhere". Deliberately
   * NOT assertReadable — uniformity is the point. The readable outcomes are PID 1's verdicts,
   * whose separation fastReadings() and its test guarantee.
   */
  if (argv.includes("--fast")) {
    for (const c of CHECKPOINTS) c.seconds = FAST_LADDER_SECONDS;
  }
  if (argv.includes("--userspace")) {
    assertReadable("USERSPACE", USERSPACE);
    for (const c of CHECKPOINTS) c.seconds = USERSPACE[c.id] ?? c.seconds;
  }
  if (argv.includes("--kernel-cp")) {
    assertReadable("KERNEL", KERNEL);
    for (const c of CHECKPOINTS) c.seconds = KERNEL[c.id] ?? c.seconds;
  }
  if (argv.includes("--mmu")) {
    assertReadable("MMU", MMU);
    for (const c of CHECKPOINTS) c.seconds = MMU[c.id] ?? c.seconds;
  }
  if (argv.includes("--stext")) {
    assertReadable("STEXT", STEXT);
    for (const c of CHECKPOINTS) c.seconds = STEXT[c.id] ?? c.seconds;
  }
  if (argv.includes("--late")) {
    for (const c of CHECKPOINTS) c.seconds = LATE[c.id] ?? c.seconds;
  }
  /** --cache-probe makes D read SCTLR.C, so the period reports the cache state. */
  if (argv.includes("--cache-probe")) {
    for (const c of CHECKPOINTS) {
      c.seconds = CACHE_PROBE[c.id] ?? c.seconds;
      if (CACHE_PROBE_IF_SET[c.id] !== undefined) {
        c.probe = "sctlr-c";
        c.secondsIfSet = CACHE_PROBE_IF_SET[c.id];
      }
    }
  }
  const pick = (f: string, d = "") => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  /** --load 0x4000000 moves the image up, buying decompression margin. */
  const LOADADDR = pick("--load", DEFAULT_LOADADDR);
  /**
   * --no-efi drops CONFIG_EFI_STUB. It replaces the decompressor's 8 leading nops with a
   * PE/COFF "MZ" header (ours starts 0xe2255a4d; the vendor's starts with 8 real nops), and
   * this board's loader is a vendor U-Boot of unknown tolerance. Nothing here needs EFI.
   */
  const noEfi = argv.includes("--no-efi");
  /** --out <name> keeps candidate images from overwriting each other. */
  const outName = pick("--out", "uImage");
  /*
   * --localversion <tag>: kernel release becomes 6.18.55-<tag>. Test kernels are booted by kexec
   * on a box whose rootfs already holds the BASE kernel's modules; a distinct release keeps each
   * build's modules in their own /lib/modules dir, so a test never loads a mismatched module.
   */
  const localversion = pick("--localversion", "");
  /*
   * --ramlog: DEBUG_LL + EARLY_PRINTK into a RAM ring (kernel/arm32/debug/q10ramlog.S) at
   * 0x7a87f000, the tail of ramoops dmesg zone 3. For kexec'd TEST kernels only: on this box a
   * kexec'd kernel dies before any console (2026-10-11) and DRAM survives the watchdog reset,
   * so the base kernel can read the dead one's last 2 KiB with `q10-ramlog`. Needs
   * `earlyprintk` on the test kernel's command line. Exclusive with --checkpoints, which
   * aims DEBUG_LL at the SP805 instead.
   */
  const ramlog = argv.includes("--ramlog");
  if (ramlog && checkpoints) { console.error("⛔ --ramlog and --checkpoints both claim DEBUG_LL"); process.exit(1); }
  writeFileSync(`${ROOT}/in/q10ramlog.S`, readFileSync(new URL("./kernel/arm32/debug/q10ramlog.S", import.meta.url)));
  if (localversion && !/^[a-z0-9.]+$/.test(localversion)) { console.error("⛔ --localversion: [a-z0-9.] only"); process.exit(1); }
  const localversionCfg = localversion
    ? './scripts/config --set-str LOCALVERSION "-' + localversion + '"\n./scripts/config --disable LOCALVERSION_AUTO'
    : "";
  const src = `/ws/linux-${version}`;

  mkdirSync(`${ROOT}/in`, { recursive: true });
  const here = `${import.meta.dir}/kernel`;
  for (const [from, to] of [
    [`${here}/0001-clk-hisilicon-crg-hi3798cv200-add-SATA-clocks.patch`, "0001-sata-clocks.patch"],
    [`${here}/arm32/0002-phy-histb-combphy-allow-32-bit-arm.patch`, "0002-combphy-arm32.patch"],
    [`${here}/arm32/0003-net-hix5hd2-rgmii-variants-and-mii-ioctl.patch`, "0003-hix5hd2.patch"],
    [`${here}/arm32/0004-clocksource-arch_timer-no-arm32-vdso-on-physical-counter.patch`, "0004-vdso-counter.patch"],
    [`${here}/arm32/0005-ARM-hisi-hi3798cv200-smp-without-psci.patch`, "0005-smp.patch"],
    [`${here}/arm32/0006-clk-hisilicon-crg-hi3798cv200-add-SDIO1-clocks.patch`, "0006-sdio1-clocks.patch"],
    [`${here}/arm32/0007-watchdog-sp805-restart-with-nonzero-load.patch`, "0007-sp805-restart.patch"],
    [`${here}/arm32/0008-media-hisilicon-histb-vdec-vpss-from-6.12.patch`, "0008-vdec-vpss.patch"],
    [`${here}/arm32/0009-clk-hisilicon-crg-hi3798cv200-vdec-vpss-clocks.patch`, "0009-vdec-clocks.patch"],
    [`${here}/arm32/0010-clk-hisilicon-crg-hi3798cv200-gpu-clock.patch`, "0010-gpu-clock.patch"],
    [`${here}/arm32/0011-drm-hisilicon-histb-vdp-with-video-plane.patch`, "0011-vdp.patch"],
    [`${here}/arm32/0012-clk-hisilicon-crg-hi3798cv200-vo-vdp-gates.patch`, "0012-vdp-clocks.patch"],
    [`${here}/arm32/0013-clk-hisilicon-crg-hi3798cv200-cpu-apll-clock.patch`, "0013-cpu-clock.patch"],
    [`${here}/arm32/0014-thermal-add-hi3798cv200-tsensor.patch`, "0014-tsensor.patch"],
    [`${here}/arm32/0015-clk-hisilicon-hi3798cv200-hdmi-pixel-clock.patch`, "0015-hdmi-pixel-clock.patch"],
    [`${here}/arm32/0016-drm-bridge-add-histb-hdmi-transmitter.patch`, "0016-hdmi-bridge.patch"],
    [`${here}/arm32/0017-drm-hisilicon-histb-vdp-mode-setting-through-the-hdmi-bridge.patch`, "0017-vdp-modeset.patch"],
    [`${here}/arm32/0018-regulator-add-hi3798cv200-cpu-pwm-regulator.patch`, "0018-cpu-regulator.patch"],
    [`${here}/arm32/0019-drm-bridge-histb-hdmi-add-cec-adapter.patch`, "0019-hdmi-cec.patch"],
    [`${here}/arm32/0020-phy-histb-combphy-sata-mode-vendor-tuning.patch`, "0020-combphy-sata.patch"],
    [`${here}/arm32/hi3798cv200.dtsi`, "hi3798cv200.dtsi"],
    [`${here}/arm32/${DTS}.dts`, `${DTS}.dts`],
    [`${here}/arm32/initramfs/init.sh`, "init.sh"],
    [`${here}/arm32/initramfs/init.c`, "init.c"],
  ] as const) {
    if (!existsSync(from)) { console.error(`⛔ missing input: ${from}`); process.exit(1); }
    writeFileSync(`${ROOT}/in/${to}`, readFileSync(from));
  }
  /*
   * ⛔ Every file a local patch touches is restored from the tarball before patching. The tree
   * persists between builds and each patch is guarded by "already applied?" greps, so a REVISED
   * patch was silently skipped: the old 0005 stayed in platsmp.c (2026-10-11). Same trap as the
   * checkpoint stores; restore by tar, then touch (tar keeps the tarball's old mtime).
   */
  // Each patched file is either EXISTING (restore it from the tarball) or NEW (`--- /dev/null`:
  // delete it, or the "already applied?" guard would see a stale copy and skip a revised patch).
  const pairs = readdirSync(`${ROOT}/in`).filter((f) => /^\d{4}-.*\.patch$/.test(f))
    .flatMap((f) => [...readFileSync(`${ROOT}/in/${f}`, "utf8").matchAll(/^--- (\S+).*\n\+\+\+ b\/(\S+)/gm)]
      .map((m) => ({ file: m[2], isNew: m[1] === "/dev/null" })));
  const newFiles = [...new Set(pairs.filter((p) => p.isNew).map((p) => p.file))].sort();
  // ⛔ A file one patch creates and a LATER patch edits (0011 creates the histb-vdp sources, 0017 edits
  // them) is not in the tarball: restoring it would fail the build. It is removed with the new files.
  const patchedFiles = [...new Set(pairs.filter((p) => !p.isNew && !newFiles.includes(p.file)).map((p) => p.file))].sort();
  if (patchedFiles.length < 6) { console.error(`⛔ only ${patchedFiles.length} patched files found — patch parsing broke`); process.exit(1); }
  const restorePatched = [
    `tar -C /ws -xf /ws/linux-${version}.tar.xz ${patchedFiles.map((f) => `linux-${version}/${f}`).join(" ")}`,
    `touch ${patchedFiles.join(" ")}`,
    newFiles.length ? `rm -f ${newFiles.join(" ")}` : "true",
    `echo "  restored ${patchedFiles.length} patched files to pristine, removed ${newFiles.length} patch-created files"`,
  ].join("\n");

  /*
   * Inject the bring-up bootargs HERE, on the host, rather than inside the container script.
   * ⛔ With an APPENDED dtb, U-Boot never sees the FDT and cannot patch /chosen/bootargs, so
   * the device tree must carry them itself.
   * ⛔ CORRECTION (2026-10-10, read from the ramoops RAM log): the DECOMPRESSOR patched them —
   * ARM_ATAG_DTB_COMPAT_CMDLINE_FROM_BOOTLOADER copied U-Boot's ATAG cmdline over these
   * bootargs, so every boot ran the stock Android command line and ip=/panic=/rdinit= never
   * reached the kernel. ARM_ATAG_DTB_COMPAT is now disabled and asserted off (see below).
   * ⚠️ Doing this in a Python heredoc nested inside this file's shell template inside bash
   * mangled the escapes through three layers and failed in a way that pointed at the wrong
   * line. One language per file.
   */
  {
    const f = `${ROOT}/in/${DTS}.dts`;
    let dts = readFileSync(f, "utf8");
    if (!/bootargs\s*=/.test(dts)) {
      /*
       * ⛔ `console=`/`earlycon` are OPT-IN (--with-console), not the default.
       *
       * earlycon writes to the PL011 before the clock framework is up. If this device tree
       * has the UART's clock or base wrong, or the bootloader left the FIFO in a state where
       * it never drains, the kernel spins there and emits NOTHING — which is exactly the
       * observed failure, and is self-concealing: a wedged earlycon means a serial console
       * would show nothing either.
       *
       * Dropping both makes the kernel silent by design but lets it proceed to networking,
       * the only channel we can currently observe. If it boots with these removed, the UART
       * node is the bug rather than the rest of the tree.
       */
      const withConsole = process.argv.includes("--with-console");
      /*
       * ⛔ `mem=1993M` — do NOT let Linux claim all 2048 MiB.
       *
       * The vendor's own command line is `mem=1993M mmz=ddr,0,0,56M`, holding back 55 MiB of
       * a 2 GiB machine. That top region is where BL31 and the TEE live — and BL31 is what
       * serves PSCI. Our device tree claimed the whole 0x80000000 with no reservation, so the
       * kernel would allocate over the secure world and then issue a PSCI call into memory it
       * had just overwritten. That fails before networking, with no output, and it explains
       * why loading the TEE first changed nothing: we load BL31 correctly and then clobber it.
       *
       * Matching the vendor's figure exactly is the conservative choice: it is known to work
       * on this board, whereas any reservation we invent is a guess.
       */
      const args = [
        "mem=1993M",
        ...(withConsole ? ["console=ttyAMA0,115200", "earlycon"] : []),
        `ip=${BRINGUP_IP}::${BRINGUP_GW}:255.255.255.0:q10pro:eth0:off`,
        "rdinit=/init",
        "panic=5",   // a panic then REBOOTS, so it shows as ping flapping rather than hiding
        "loglevel=8",          // everything reaches the console — and so the ramoops RAM log
        "carrier_timeout=15",  // ip= waits for link; cap it so a dead PHY cannot stall boot 120 s
        // The SP805 driver is bound for its RESTART handler (mainline has no other for this SoC),
        // but the kernel must not feed it: our safety nets arm it by devmem and rely on it firing.
        "watchdog.handle_boot_enabled=0",
        // VDEC frame pools: 4K HEVC needs ~180-230 MB (measured 2026-10-12), and a paused Android
        // pins its gralloc buffers in CMA — 320 MiB; CMA pages serve movable allocations when idle.
        "cma=320M",
        // DVFS stage 2 fallback (patch 0018): hold the CPU rail at 1150 mV, keep scaling frequency.
        ...(process.argv.includes("--vscale0") ? ["q10_cpu_vscale=0"] : []),
      ].join(" ");
      const anchor = '\t\tstdout-path = "serial0:115200n8";';
      if (!dts.includes(anchor)) { console.error("⛔ could not find the chosen/stdout-path anchor in the dts"); process.exit(1); }
      dts = dts.replace(anchor, `${anchor}\n\t\tbootargs = "${args}";`);
      writeFileSync(f, dts);
      console.log(`[local] injected bring-up bootargs: ${args}`);
    } else console.log("[local] dts already carries bootargs");
  }
  /*
   * --sata-off: ship the SATA node DISABLED without editing the source dts. A bisect switch:
   * two images with SATA enabled (built in, then as a module) never reached the network on
   * 2026-10-11, and the only other change in both was patch 0004. This splits the two.
   */
  if (process.argv.includes("--sata-off")) {
    const f = `${ROOT}/in/${DTS}.dts`;
    const dts = readFileSync(f, "utf8");
    const re = /(sata: sata@9900000 \{[\s\S]*?)status = "okay";/;
    if (!re.test(dts)) { console.error("⛔ --sata-off: no 'status = \"okay\"' inside the sata node"); process.exit(1); }
    writeFileSync(f, dts.replace(re, '$1status = "disabled";'));
    console.log("[local] --sata-off: SATA node shipped disabled");
  }
  writeFileSync(`${ROOT}/in/required.txt`, REQUIRED.map(([k]) => k).join("\n"));
  writeFileSync(`${ROOT}/in/modular.txt`, MODULAR.map(([k]) => k).join("\n"));
  writeFileSync(`${ROOT}/in/disabled.txt`, DISABLED.map(([k]) => k).join("\n"));

  console.log(`[local] kernel ${version} · ARCH=arm (AArch32) · ${ROOT}\n`);

  // ⛔ ONE container: `docker run --rm` discards apt-installed tools between invocations.
  const script = `
# Skipped entirely when the cached builder image already carries the toolchain.
if ! command -v arm-linux-gnueabihf-gcc >/dev/null; then
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
  build-essential bc bison flex libssl-dev libelf-dev python3 xz-utils curl ca-certificates \
  kmod u-boot-tools gcc-arm-linux-gnueabihf >/dev/null
fi

cd /ws
if [ ! -d linux-${version} ]; then
  [ -f linux-${version}.tar.xz ] || curl -fsSL -o linux-${version}.tar.xz \
    https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-${version}.tar.xz
  tar xf linux-${version}.tar.xz
fi
cd ${src}

${checkpoints ? checkpointStep(version) : pristineStep(version)}
tar -C /ws -xf /ws/linux-${version}.tar.xz linux-${version}/arch/arm/include/debug/pl01x.S
${ramlog ? "cp /ws/in/q10ramlog.S arch/arm/include/debug/pl01x.S && echo '  ramlog: pl01x.S replaced by the RAM ring'" : "grep -q q10ramlog arch/arm/include/debug/pl01x.S && { echo '⛔ RAM ring still in pl01x.S'; exit 1; }; true"}
touch arch/arm/include/debug/pl01x.S
${restorePatched}
grep -q HISTB_SATA_BUS_CLK include/dt-bindings/clock/histb-clock.h || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0001-sata-clocks.patch
grep -q HISTB_SATA_BUS_CLK drivers/clk/hisilicon/crg-hi3798cv200.c
# SDIO1 (0xf9c40000, the AP6255 WiFi): CRG 0x28c gates + mux, absent upstream. After 0001.
grep -q HISTB_SDIO1_BIU_CLK include/dt-bindings/clock/histb-clock.h || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0006-sdio1-clocks.patch
grep -q '"clk_sdio1_ciu"' drivers/clk/hisilicon/crg-hi3798cv200.c \
  || { echo "⛔ SDIO1 clock patch did not apply"; exit 1; }
# SP805 restart: HiSilicon's clone never expires from LOAD 0 -> reboot hung (sysrq-b, 190 s).
grep -q "never expires from a LOAD of 0" drivers/watchdog/sp805_wdt.c || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0007-sp805-restart.patch
grep -q "writel_relaxed(0x100, wdt->base + WDTLOAD)" drivers/watchdog/sp805_wdt.c \
  || { echo "⛔ sp805 restart patch did not apply"; exit 1; }

# Hardware video decode (VDEC + VPSS), ported from the community 6.12 tree by a sub-agent,
# compile-tested (docs/261011-himedia-vdec-port-report.md). 0009 needs 0001 + 0006 first.
[ -f drivers/media/platform/hisilicon/histb-vdec-core.c ] || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0008-vdec-vpss.patch
[ -f drivers/media/platform/hisilicon/histb-vdec-core.c ] || { echo "⛔ vdec patch did not apply"; exit 1; }
grep -q HISTB_VDH_CLK include/dt-bindings/clock/histb-clock.h || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0009-vdec-clocks.patch
grep -q HISTB_VDH_CLK include/dt-bindings/clock/histb-clock.h || { echo "⛔ vdec clock patch did not apply"; exit 1; }
# GPU clock (Mali-T720 for Panfrost), after 0009.
grep -q HISTB_GPU_CLK include/dt-bindings/clock/histb-clock.h || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0010-gpu-clock.patch
grep -q HISTB_GPU_CLK include/dt-bindings/clock/histb-clock.h || { echo "⛔ gpu clock patch did not apply"; exit 1; }
# VDP display controller with a video plane (DRM, adopts the bootloader's 1080p60 pipe), then
# its VO/VDP clock gates. Ported by a sub-agent, compile-tested (docs/261011-himedia-vdp-drm-port.md).
[ -f drivers/gpu/drm/hisilicon/histb/histb_vdp_drv.c ] || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0011-vdp.patch
[ -f drivers/gpu/drm/hisilicon/histb/histb_vdp_drv.c ] || { echo "⛔ vdp patch did not apply"; exit 1; }
grep -q HISTB_VO_BUS_CLK include/dt-bindings/clock/histb-clock.h || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0012-vdp-clocks.patch
grep -q HISTB_VO_BUS_CLK include/dt-bindings/clock/histb-clock.h || { echo "⛔ vdp clock patch did not apply"; exit 1; }

# CPU APLL clock (cpufreq stage 1, frequency only) and the SoC tsensor — after 0012 (shared header).
grep -q HISTB_CPU_CLK include/dt-bindings/clock/histb-clock.h || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0013-cpu-clock.patch
grep -q HISTB_CPU_CLK include/dt-bindings/clock/histb-clock.h || { echo "⛔ cpu clock patch did not apply"; exit 1; }
grep -q "hi3798cv200_cpu_clk_set_rate" drivers/clk/hisilicon/crg-hi3798cv200.c || { echo "⛔ cpu clock driver missing"; exit 1; }
[ -f drivers/thermal/hi3798cv200_thermal.c ] || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0014-tsensor.patch
[ -f drivers/thermal/hi3798cv200_thermal.c ] || { echo "⛔ tsensor patch did not apply"; exit 1; }
grep -q HI3798CV200_THERMAL drivers/thermal/Kconfig || { echo "⛔ tsensor Kconfig missing"; exit 1; }

# CPU core-voltage regulator (DVFS stage 2, patch 0018; docs/261012-himedia-dvfs-stage2.md).
[ -f drivers/regulator/hi3798cv200-cpu-regulator.c ] || \\
  patch -p1 --no-backup-if-mismatch < /ws/in/0018-cpu-regulator.patch
[ -f drivers/regulator/hi3798cv200-cpu-regulator.c ] || { echo "⛔ cpu regulator patch did not apply"; exit 1; }
grep -q REGULATOR_HI3798CV200_CPU drivers/regulator/Kconfig || { echo "⛔ cpu regulator Kconfig missing"; exit 1; }

# Display mode setting (docs/261012-himedia-display-modes-port.md): the HDMI pixel clock / HPLL + the
# transmitter gates (0015), the HDMI bridge (0016), VDP mode setting on top of 0011 (0017). All three
# are modules at runtime; nothing here runs until histb_vdp is modprobed and a commit asks for a new mode.
[ -f drivers/clk/hisilicon/clk-hi3798cv200-hdmi.c ] || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0015-hdmi-pixel-clock.patch
[ -f drivers/clk/hisilicon/clk-hi3798cv200-hdmi.c ] || { echo "⛔ hdmi pixel clock patch did not apply"; exit 1; }
grep -q HISTB_HDMI_PIXEL_CLK include/dt-bindings/clock/histb-clock.h || { echo "⛔ hdmi clock ids missing"; exit 1; }
grep -q hi3798cv200_hdmi_pixel_clk_register drivers/clk/hisilicon/crg-hi3798cv200.c || { echo "⛔ hdmi pixel clock not registered by the CRG"; exit 1; }
[ -f drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c ] || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0016-hdmi-bridge.patch
[ -f drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c ] || { echo "⛔ hdmi bridge patch did not apply"; exit 1; }
[ -f drivers/gpu/drm/hisilicon/histb/histb_vdp_mode.c ] || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0017-vdp-modeset.patch
[ -f drivers/gpu/drm/hisilicon/histb/histb_vdp_mode.c ] || { echo "⛔ vdp modeset patch did not apply"; exit 1; }
grep -q histb_hdmi_set_boot_mode drivers/gpu/drm/hisilicon/histb/histb_vdp_drv.c || { echo "⛔ vdp modeset hunk missing"; exit 1; }
# HDMI CEC (0019, docs/261012-himedia-hdmi-cec.md): an adapter on the bridge. histb-hdmi.c is a NEW file of 0016 (removed
# and re-applied each build), so the guard below sees a fresh 0016 and applies 0019 on top of it every time.
[ -f drivers/gpu/drm/bridge/hisilicon/histb-hdmi-cec.h ] || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0019-hdmi-cec.patch
[ -f drivers/gpu/drm/bridge/hisilicon/histb-hdmi-cec.h ] || { echo "⛔ hdmi cec patch did not apply"; exit 1; }
grep -q DRM_HISI_HISTB_HDMI_CEC drivers/gpu/drm/bridge/hisilicon/Kconfig || { echo "⛔ hdmi cec Kconfig missing"; exit 1; }
grep -q histb_hdmi_cec_probe drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c || { echo "⛔ hdmi cec hook missing"; exit 1; }

# SATA (0020, docs/261014-himedia-sata-kernel-vs-board.md): combphy writes the vendor SATA
# value nano[0x1]=0x4 in SATA mode instead of the PCIe tuning — before the first link training.
grep -q "vendor SATA tuning" drivers/phy/hisilicon/phy-histb-combphy.c || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0020-combphy-sata.patch
grep -q "priv->mode.select == PHY_TYPE_SATA" drivers/phy/hisilicon/phy-histb-combphy.c \
  || { echo "⛔ combphy SATA patch did not apply"; exit 1; }

# hix5hd2: accept rgmii-id/-rxid/-txid (it rejected every variant but plain rgmii as
# "not supported mode") and expose MDIO via SIOCxMIIREG so PID 1 can sweep the RTL8211E's
# RGMII delays. Measured 2026-10-10: link Up 1Gbps, IP-Config complete, RX packets 0.
grep -q "phy_do_ioctl_running" drivers/net/ethernet/hisilicon/hix5hd2_gmac.c || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0003-hix5hd2.patch
grep -q "phy_do_ioctl_running" drivers/net/ethernet/hisilicon/hix5hd2_gmac.c \
  || { echo "⛔ hix5hd2 patch did not apply"; exit 1; }
grep -q "case PHY_INTERFACE_MODE_RGMII_ID:" drivers/net/ethernet/hisilicon/hix5hd2_gmac.c \
  || { echo "⛔ hix5hd2 RGMII-variant hunk missing"; exit 1; }

# arch_timer: the arm32 vDSO reads the VIRTUAL counter while the kernel (booted with HYP
# available) uses the PHYSICAL one; this firmware leaves CNTVOFF at ~933 s, so userspace time
# was 933 s off the kernel's — measured on the box 2026-10-11 (date -s @T reads back T+933).
grep -q "rd != arch_counter_get_cntvct_stable" drivers/clocksource/arm_arch_timer.c || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0004-vdso-counter.patch
grep -q "rd != arch_counter_get_cntvct_stable" drivers/clocksource/arm_arch_timer.c \
  || { echo "⛔ arch_timer vDSO patch did not apply"; exit 1; }

# SMP without PSCI: the vendor's non-TEE secondary bring-up (SRAM stub at 0xffff0000 + CRG
# resets), as smp_operations "hisilicon,hi3798cv200-smp". The box ran on 1 of 4 cores.
grep -q "hi3798cv200_smp_ops" arch/arm/mach-hisi/platsmp.c || \
  patch -p1 --no-backup-if-mismatch < /ws/in/0005-smp.patch
grep -q "hisilicon,hi3798cv200-smp" arch/arm/mach-hisi/platsmp.c \
  || { echo "⛔ SMP patch did not apply"; exit 1; }

# The combphy Kconfig gate: PHY_HISTB_COMBPHY is gated on ARM64 upstream.
# ⚠️ The pattern CONTAINS '||', so '|' must not be the sed delimiter — using it made sed see
# 's|A||' plus garbage, which silently did nothing and left the option unselectable.
sed -i 's@depends on (ARCH_HISI && ARM64) || COMPILE_TEST@depends on ARCH_HISI || COMPILE_TEST@' \
  drivers/phy/hisilicon/Kconfig
grep -q 'depends on ARCH_HISI || COMPILE_TEST' drivers/phy/hisilicon/Kconfig \
  || { echo "⛔ combphy Kconfig gate not relaxed"; exit 1; }

# --- our device tree, into the 32-bit tree ---
install -d arch/arm/boot/dts/hisilicon
cp /ws/in/hi3798cv200.dtsi /ws/in/${DTS}.dts arch/arm/boot/dts/hisilicon/
MK=arch/arm/boot/dts/hisilicon/Makefile
touch \$MK
grep -q ${DTS} \$MK || echo 'dtb-\$(CONFIG_ARCH_HISI) += ${DTS}.dtb' >> \$MK
grep -q 'subdir-y += hisilicon' arch/arm/boot/dts/Makefile || true

# --- an initramfs, so the kernel does not panic on a missing root and stays alive to answer ---
# ⛔ EXTRACT the armhf busybox, do not install it. This container is arm64, and
# 'apt install busybox-static:armhf' puts an armhf binary at the same /bin/busybox path as the
# native one — so the copy taken from there was arm64 and the static check caught it. Pulling
# the .deb and unpacking it sidesteps the multiarch conflict entirely.
dpkg --add-architecture armhf
command -v file >/dev/null || { apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends file >/dev/null; }
cd /tmp && rm -rf bbx && mkdir bbx && cd bbx
# The cached builder image carries the armhf .deb already; only fetch when it does not.
if ls /opt/armhf/busybox-static_*_armhf.deb >/dev/null 2>&1; then
  cp /opt/armhf/busybox-static_*_armhf.deb .
else
  apt-get update -qq
  apt-get download busybox-static:armhf >/dev/null 2>&1 || apt-get download busybox-static:armhf
fi
dpkg-deb -x busybox-static_*_armhf.deb /tmp/bbx/root
cd ${src}

# ⛔ The initramfs is staged on CONTAINER-LOCAL storage, never on the /ws bind mount.
# A Docker bind mount of APFS cannot hold device nodes, so mknod there fails and /dev ships
# EMPTY — which is fatal in a way that looks like a kernel hang: with no /dev/null, the first
# 2-greater-than-/dev/null redirection in init.sh fails, and POSIX says a command whose redirection fails
# IS NOT EXECUTED. So the mount that would have created /dev/null never ran either, and the
# whole second stage was a silent no-op while the kernel itself was perfectly healthy.
IRD=/irfs
rm -rf \$IRD; mkdir -p \$IRD/bin \$IRD/proc \$IRD/sys \$IRD/dev
BB=\$(find /tmp/bbx/root -name busybox -type f | head -1)
[ -n "\$BB" ] || { echo "⛔ no busybox in the extracted .deb"; exit 1; }
cp "\$BB" \$IRD/bin/busybox
# A STATIC ARM binary is essential: there is no libc in the initramfs, and the kernel is 32-bit.
file \$IRD/bin/busybox
file \$IRD/bin/busybox | grep -q "statically linked" || { echo "⛔ busybox is not static"; exit 1; }
file \$IRD/bin/busybox | grep -qE "ARM, EABI|ARM," || { echo "⛔ busybox is not a 32-bit ARM binary"; exit 1; }
for a in sh mount mkdir sleep dmesg ip ifconfig cat ls head uname netstat telnetd httpd; do ln -sf busybox \$IRD/bin/\$a; done
install -m 755 /ws/in/init.sh \$IRD/init.sh
# A STATIC PID 1: no interpreter, no shebang, no PATH, no symlink resolution.
arm-linux-gnueabihf-gcc -static -O2 -o \$IRD/init /ws/in/init.c
file \$IRD/init | grep -q "statically linked" || { echo "⛔ init is not static"; exit 1; }
file \$IRD/init | grep -qE "ARM" || { echo "⛔ init is not an ARM binary"; exit 1; }

# ⭐ /dev/console gives PID 1 stdin/stdout/stderr; without it the kernel prints
# "unable to open an initial console" and every printf in our init goes to a closed fd —
# so we lost all first-stage diagnostics. /dev/null is what init.sh redirections need.
mknod -m 600 \$IRD/dev/console c 5 1
mknod -m 666 \$IRD/dev/null    c 1 3
mknod -m 666 \$IRD/dev/zero    c 1 5
mknod -m 622 \$IRD/dev/tty     c 5 0
# ⛔ /dev/mem is how PID 1 reaches the SP805 for the userspace checkpoint. Without it the
# probe silently does nothing and "PID 1 ran" looks identical to "the kernel never exec'd it".
# PID 1 also mknods it itself; this is the belt to that braces.
mknod -m 600 \$IRD/dev/mem     c 1 1
for n in console null zero tty mem; do
  [ -c \$IRD/dev/\$n ] || { echo "⛔ /dev/\$n is not a character device — refusing to ship a /dev that cannot be opened"; exit 1; }
done
ls -l \$IRD/dev

# A copy on the bind mount so the host can inspect what shipped (device nodes excepted —
# they cannot exist there, which is the entire reason staging moved off it).
rm -rf /ws/initramfs; mkdir -p /ws/initramfs
tar -C \$IRD --exclude=./dev -cf - . | tar -C /ws/initramfs -xf -

# The device tree already carries its bring-up bootargs: they were injected on the host
# before staging, deliberately, to avoid nesting a second language inside this script.
grep -q 'bootargs = ' arch/arm/boot/dts/hisilicon/${DTS}.dts || { echo "⛔ bootargs missing from the dts"; exit 1; }

export ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-
make multi_v7_defconfig
for opt in \$(cat /ws/in/required.txt); do ./scripts/config --enable \$opt; done
for opt in \$(cat /ws/in/modular.txt); do ./scripts/config --module \$opt; done
for opt in \$(cat /ws/in/disabled.txt); do ./scripts/config --disable \$opt; done
${noEfi ? "./scripts/config --disable EFI_STUB\n./scripts/config --disable EFI" : ""}
# ⛔ Without this the decompressor replaces our bootargs with U-Boot's ATAG command line.
./scripts/config --disable ARM_ATAG_DTB_COMPAT
${ramlog ? RAMLOG_CONFIG : postMmuConfig(checkpoints)}
${localversionCfg}
# Default governor: choice symbol, so the others must be turned off for SCHEDUTIL to win.
./scripts/config --disable CPU_FREQ_DEFAULT_GOV_ONDEMAND
./scripts/config --disable CPU_FREQ_DEFAULT_GOV_PERFORMANCE
./scripts/config --disable CPU_FREQ_DEFAULT_GOV_USERSPACE
# Critical trip: orderly shutdown first, forced power-off after 10 s if userspace cannot (default 0 = never forced).
./scripts/config --set-val THERMAL_EMERGENCY_POWEROFF_DELAY_MS 10000
make olddefconfig
grep -q "^CONFIG_THERMAL_EMERGENCY_POWEROFF_DELAY_MS=10000" .config || { echo "⛔ emergency poweroff delay did not stick"; exit 1; }
grep -q "^# CONFIG_CPU_FREQ_DEFAULT_GOV_ONDEMAND is not set" .config || { echo "⛔ ondemand is still the default governor"; exit 1; }
grep -q "^CONFIG_CPU_FREQ_DEFAULT_GOV_SCHEDUTIL=y" .config || { echo "⛔ schedutil is not the default governor"; exit 1; }

# ⛔ INITRAMFS_SOURCE must be set AFTER BLK_DEV_INITRD is enabled AND resolved.
# Setting it first leaves the symbol with an unmet dependency, and olddefconfig then
# silently discards it — which shipped a kernel with an EMPTY 512-byte cpio that would have
# panicked on a missing root and been mistaken for the bug under test. Order, then assert.
./scripts/config --set-str INITRAMFS_SOURCE /irfs
make olddefconfig
grep -q '^CONFIG_INITRAMFS_SOURCE="/irfs"' .config \
  || { echo "⛔ INITRAMFS_SOURCE did not stick: $(grep INITRAMFS_SOURCE .config)"; exit 1; }

echo "=== required options ==="
fail=0
for opt in \$(cat /ws/in/required.txt); do
  # ⛔ =y, not =[ym]: the initramfs ships no modules, so a required =m never loads.
  if grep -q "^CONFIG_\${opt}=y" .config; then echo "  ok   \$opt";
  else echo "  MISS \$opt"; fail=1; fi
done
[ \$fail -eq 0 ] || { echo "⛔ required options missing"; exit 1; }
for opt in \$(cat /ws/in/modular.txt); do
  if grep -q "^CONFIG_\${opt}=m" .config; then echo "  ok   \$opt =m"; else echo "  MISS \$opt =m ($(grep "CONFIG_\${opt}[= ]" .config))"; fail=1; fi
done
[ \$fail -eq 0 ] || { echo "⛔ modular options not =m"; exit 1; }
for opt in \$(cat /ws/in/disabled.txt); do
  if grep -qE "^CONFIG_\${opt}=(y|m)\$" .config; then echo "  MISS \$opt still on"; fail=1; else echo "  ok   \$opt off"; fi
done
[ \$fail -eq 0 ] || { echo "⛔ options that must be off are on"; exit 1; }
${ramlog ? RAMLOG_ASSERT : postMmuAssert(checkpoints)}
grep -q "^CONFIG_ARM_ATAG_DTB_COMPAT=y" .config && { echo "⛔ ARM_ATAG_DTB_COMPAT still on — U-Boot's cmdline would replace ours"; exit 1; }
echo "  ok   ARM_ATAG_DTB_COMPAT off (our bootargs win)"
${configOnly ? 'echo "(config only)"; exit 0' : ""}

make -j"$(nproc)" LOADADDR=${LOADADDR} uImage dtbs modules

# Modules ship as a tarball installed into rootfs.img's /lib/modules — they must come from THIS
# build (vermagic), so they are packed next to the uImage they belong to, under its name.
rm -rf /tmp/mods && make INSTALL_MOD_PATH=/tmp/mods INSTALL_MOD_STRIP=1 modules_install
for m in ahci_platform; do
  find /tmp/mods -name "\$m.ko*" | grep -q . || { echo "⛔ module \$m.ko missing from modules_install"; exit 1; }
done
tar -C /tmp/mods -czf /ws/${outName}-modules.tar.gz lib/modules
ls -l /ws/${outName}-modules.tar.gz

# A 512-byte cpio is an EMPTY one. Check the content, not the existence.
CPIO=usr/initramfs_data.cpio
SZ=$(stat -c %s \$CPIO 2>/dev/null || echo 0)
echo "initramfs cpio: \$SZ bytes"
[ "\$SZ" -gt 200000 ] || { echo "⛔ cpio is only \$SZ bytes — the initramfs is empty or tiny"; exit 1; }
# ⚠️ Do NOT use 'cpio -itv' here: the cpio TOOL is not installed in this image, so the check
# ran a missing command, matched nothing, and failed a perfectly good build. The newc format
# stores filenames as plain ASCII, so grep on the archive needs no extra tool.
grep -aq "init.sh" \$CPIO || { echo "⛔ init.sh not found in the cpio"; exit 1; }
grep -aq "bin/busybox" \$CPIO || { echo "⛔ busybox not found in the cpio"; exit 1; }
grep -aq "dev/console" \$CPIO || { echo "⛔ dev/console not found in the cpio — PID 1 would have no stdio"; exit 1; }
echo "cpio content check: init.sh and bin/busybox present"

# The stock bootcmd calls bootm <addr> with NO device-tree argument, so the kernel would
# come up with no DT at all. CONFIG_ARM_APPENDED_DTB exists for exactly this: the zImage
# decompressor picks up a DTB concatenated directly after it. So the image we actually ship
# is zImage+dtb wrapped as a uImage — the bare uImage above would boot and then find nothing.
cat arch/arm/boot/zImage arch/arm/boot/dts/hisilicon/${DTS}.dtb > /ws/zImage-dtb
mkimage -A arm -O linux -T kernel -C none -a ${LOADADDR} -e ${LOADADDR} \
  -n "Linux q10pro appended-dtb" -d /ws/zImage-dtb /ws/${outName}
ls -l /ws/${outName} arch/arm/boot/zImage arch/arm/boot/dts/hisilicon/${DTS}.dtb
# kexec takes the zImage and the dtb separately (kexec -l <zImage> --dtb <dtb>).
cp arch/arm/boot/zImage /ws/${outName}.zImage
cp arch/arm/boot/dts/hisilicon/${DTS}.dtb /ws/${outName}.dtb
echo "kernel release: $(cat include/config/kernel.release)"
`;

  // ⛔ Platform pinned: the bare `debian:trixie` tag on this Mac was found to be linux/arm/v7.
  const code = await sh(["docker", "run", "--rm", "--platform", "linux/arm64", "-v", `${ROOT}:/ws`, "-w", "/ws", IMAGE, "bash", "-eux", "-c", script]);
  if (code !== 0) { console.error(`\n⛔ ${configOnly ? "config" : "build"} failed (exit ${code})`); process.exit(1); }
  if (configOnly) { console.log("\n✅ patched, device tree installed, config verified."); return; }

  const img = `${ROOT}/${outName}`;  // zImage + appended dtb, wrapped
  const dtb = `${ROOT}/linux-${version}/arch/arm/boot/dts/hisilicon/${DTS}.dtb`;
  for (const f of [img, dtb]) if (!existsSync(f)) { console.error(`⛔ missing artifact: ${f}`); process.exit(1); }

  // The uImage arch field is the whole reason for this build — assert it, never assume it.
  const hdr = Buffer.from(await Bun.file(img).slice(0, 64).arrayBuffer());
  const magic = hdr.readUInt32BE(0), arch = hdr[29], type = hdr[30];
  const name = hdr.subarray(32, 64).toString("latin1").replace(/\0.*$/, "");
  console.log(`\n[local] uImage header: magic=0x${magic.toString(16)} arch=${arch} type=${type} name="${name}"`);
  if (magic !== 0x27051956) { console.error("⛔ not a uImage"); process.exit(1); }
  if (arch !== 2) {
    console.error(`⛔ uImage arch=${arch}, expected 2 (ARM). The stock loader rejects anything else.`);
    process.exit(1);
  }
  console.log(`✅ arch=2 (ARM) — the stock 32-bit loader will accept this.`);
  /*
   * The appended DTB must actually be at the TAIL, or the kernel boots and finds no device
   * tree.
   * ⛔ Do NOT simply search for the 0xd00dfeed magic: the zImage decompressor carries that
   * constant for its own comparison, so a scan finds it near the start and "passes" even when
   * nothing was appended. An earlier version of this check did exactly that and reported
   * success for the wrong reason. Verify the position and the DTB's own totalsize instead.
   */
  const whole = Buffer.from(await Bun.file(img).arrayBuffer());
  const zBytes = Bun.file(`${ROOT}/linux-${version}/arch/arm/boot/zImage`).size;
  const dBytes = Bun.file(dtb).size;
  const expect = 64 + zBytes + dBytes;           // uImage header + zImage + dtb
  const at = 64 + zBytes;
  const problems: string[] = [];
  if (whole.length !== expect) problems.push(`size ${whole.length}, expected ${expect} (64 + zImage ${zBytes} + dtb ${dBytes})`);
  if (whole.readUInt32BE(at) !== 0xd00dfeed) problems.push(`no DTB magic at the expected tail offset 0x${at.toString(16)}`);
  else if (whole.readUInt32BE(at + 4) !== dBytes) problems.push(`appended DTB totalsize ${whole.readUInt32BE(at + 4)} != dtb file size ${dBytes}`);
  if (problems.length) {
    console.error("⛔ the appended device tree is not right — the kernel would boot without a DT:");
    for (const p of problems) console.error(`   • ${p}`);
    process.exit(1);
  }
  console.log(`✅ DTB appended at the tail (0x${at.toString(16)}), totalsize ${dBytes} matches`);
  console.log(`\n   uImage (zImage+dtb) : ${img}`);
  console.log(`   standalone DTB      : ${dtb}`);
  console.log(`\nNot booted yet. Copy this uImage to the ROOT of a FAT32 stick — the env loads`);
  console.log(`exactly 'uImage' from usb 0:1. A failure still falls through to Android.`);
  console.log(`\n⭐ This build is OBSERVABLE WITHOUT SERIAL:`);
  console.log(`   • the kernel configures eth0 itself at ${BRINGUP_IP} (static, outside the DHCP pool)`);
  console.log(`   • an embedded initramfs keeps it alive instead of panicking on a missing root`);
  console.log(`   • so:  ping ${BRINGUP_IP}      answered  => the kernel booted and GbE works`);
  console.log(`          telnet ${BRINGUP_IP}    => a shell; 'dmesg' answers everything else`);
}

if (import.meta.main) await main();
