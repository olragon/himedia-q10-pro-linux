# Q10 Pro: the watchdog ladder reached the exec of /init — and why there is still no network

**Date:** 2026-10-10 (evening review) · **Status:** kernel boots through every initcall; NIC
root cause found offline, fix queued · **Supersedes** the "kernel does not boot / hang inside
the decompressor" verdicts in `261010-himedia-q10-pro-bringup-state.md` and
`261010-himedia-decompressor-hunt.md`.

## What the ladder measured (7 flashes, 18 checkpoints)

The SP805 at `0xf8a2c000` is a one-bit-per-checkpoint telemetry channel on a box with no
console: each checkpoint re-arms the watchdog with its own period, so the reboot cycle names the
**last checkpoint reached**. `cycle = overhead + 2 x load`.

| cycle (obs) | last checkpoint | meaning |
|---|---|---|
| ~19 s | B `stext` | kernel proper entered (LATE profile; only B fits — all others >=44 s) |
| 134 s | I `__create_page_tables` | whole pre-MMU path done: CPU known, atags vetted, pv patched |
| 194 s | J `__mmap_switched` | **MMU on**, executing from virtual addresses |
| >4 min | O `console_init` | `setup_arch`, mm, sched, **`time_init`** all returned |
| 216 s (3:36) | Q `kernel_init_freeable` | **every initcall ran** (GbE probe attempted); about to exec `/init` |

So the kernel boots. The earlier "hang inside the decompressor" was an artefact of the
orphaned-`pop` bug (`794fb18`); the "no mainline kernel has ever booted" line in the
bring-up-state doc is now false.

### The overhead is not a constant — it grows with depth

Calibrated at 6 s with the 44-byte stub; measured 11-14 s for a 12.3 MB USB read, and the
pre-checkpoint time keeps growing as deeper checkpoints do more work before arming. Two
consequences, both bitten:

- **Periods must be spread wider than the overhead uncertainty.** The cache-probe profile put
  E and B 4 s apart and one reading fitted three conclusions. `assertReadable()` now refuses
  a profile with any gap <= 10 s or any checkpoint left at a colliding default — it fired four
  times in one evening, each time catching a profile that would have cost a boot cycle.
- **Solve for the pre-checkpoint time, not just the nearest period.** 216 s fits Q with 18 s of
  kernel work and R with 6 s — and 6 s is impossible. That is what separates them.

### What is NOT visible from this channel

- **The last checkpoint hides everything after it.** The watchdog fires because nothing
  re-arms it; mainline binds no SP805 driver, so a kernel that boots to userspace resets
  exactly like one that died one instruction after the last checkpoint. "B fired" never meant
  "died after B" — it meant "reached B and nothing later was armed".
- **Post-MMU writes need a mapping.** `0xf8a2c000` is physical. Checkpoints J..Q work because
  `CONFIG_DEBUG_LL` makes `__create_page_tables` map a flat section for the debug UART, aimed at
  the SP805's own 1 MB section (`DEBUG_UART_PHYS == DEBUG_UART_VIRT == 0xf8a2c000`,
  `EARLY_PRINTK` off, every checkpoint re-locks `WdogLock` so a stray byte cannot retime it).
  C checkpoints may not sit inside `setup_arch`: `paging_init` drops the early map and only
  `debug_ll_io_init` restores it.

## Instrument failures (all mine, all fixed, all tested)

| failure | effect | fix |
|---|---|---|
| restore emitted after the end marker | 6 orphaned `pop {r3,r4}` in a flashed image; one void hardware reading | restore inside the block; pristine re-extraction; push/pop gate |
| 4 s gaps in the cache-probe profile | one reading, three conclusions | `assertReadable`, LATE/STEXT/MMU/KERNEL/USERSPACE profiles |
| verifier searched `movw`+`movt` only | 5 present C checkpoints reported MISSING (GCC used `mov rD,#<rotated imm8>`) | `arm-const.ts` decodes rotated imm12 |
| verifier was ARM-only | PID 1 is **Thumb-2** (kernel is ARM, same image) — R reported missing twice (`MOVW T3`, then `MOV.W`/`ThumbExpandImm`) | Thumb-2 decoder, 13 tests pinning the exact bytes |
| **R opened `/dev/mem`, which the initramfs did not have** | **R could never fire** — "PID 1 ran" and "exec failed" gave the identical 216 s | PID 1 `mknod`s it itself (EEXIST = ok); build stages + asserts it |

The last one voids the Q-vs-R reading of 3:36. `uImage-noefi-userspace2` (sha `e9fa65762c7f2d91`)
is built and verified end to end — 17 kernel checkpoints, R in the Thumb-2 PID 1, `dev/mem c 1,1`
in the cpio, DTB at the image end — and has not been flashed yet.

## Eliminated offline

- **The appended DTB is real**: `totalsize 13574`, `version 17`, ends exactly at the image end.
  There are two `d00dfeed` hits; the first is the decompressor's own constant (the false
  positive this project overclaimed once already).
- **An unmatched machine descriptor does not panic**: `setup_machine_fdt` passes
  `__mach_desc_GENERIC_DT` as the default, so no arm32 `mach-hisi` entry is needed.
- **Timers and clocks**: `time_init` returned (N), with `ARM_ARCH_TIMER=y`,
  `COMMON_CLK_HI3798CV200=y`, timer `clock-frequency = 24000000`.
- **Network probes**: `watch-boot` over 420 s + 400 s + 600 s with the control passing 3/3 —
  nothing on the ladder, box MAC absent from ARP. Link-layer dead.

## Why there is no network — found in the driver, two bugs, both ours

`CONFIG_HIX5HD2_GMAC=y`, the DT has `ethernet@9841000` (gmac1) `okay`, `phy-mode rgmii`,
`phy-handle` -> `ethernet-phy@3`, `local-mac-address` from `deviceinfo`. Then:

1. **PHY node shape.** `drivers/net/ethernet/hisilicon/hix5hd2_gmac.c` registers the MDIO bus on
   the gmac node itself — `of_mdiobus_register(bus, node)` with `node = dev->of_node` — and
   `of_mdio.c` scans **direct children only** (`for_each_available_child_of_node`, address parsed
   per child). Our tree wraps the PHY in an `mdio { ethernet-phy@3 }` subnode, so the `mdio`
   child has no `reg` and is skipped, the PHY is never registered, `phy-handle` resolves to a
   node with no `phy_device`, and `open()` fails. **Both references put the PHY directly under
   the gmac node**: Poplar (`&gmac1 { phy@3 { reg = <3>; } }`) and the vendor arm32 tree
   (`higmac1 { eth_phy1: ethernet_phy@1 { reg = <3>; } }`). Address 3 and `rgmii` match both.
2. **`CONFIG_RESET_TI_SYSCON=m`.** gmac1's `"phy"` reset is provided by the `ti,syscon-reset`
   node inside the CRG; its driver is built as a **module** and the initramfs ships none. The
   driver tolerates the lookup failure (`phy_rst = NULL`, no defer), so it does not block probe —
   it just **never pulses the PHY reset**. ⚠️ Fixing this alone breaks probe: once the reset
   resolves, the driver **requires** `hisilicon,phy-reset-delays-us` and `goto out_disable_clk`
   without it. Poplar uses `<10000 10000 30000>`. **Both changes land together.**

Gate bug behind (2): the required-options check accepts `=[ym]`, and `--enable` only ever sets
the symbols it is told about; a boot-critical symbol not in `REQUIRED` that defaults to `m`
passes every check and never loads.

## Board (box opened by Tim; two photos)

`HI3798CV200_V2.2_20170706` · label `<unit-label> / Q10 PRO 2+16G / Q10PROV2.2…` · serial
`<board-serial>` · **2 GB RAM / 16 GB eMMC** (so `mem=1993M` is sane) · `AP6255` (BCM43455
WiFi/BT, SDIO, `1753`) · `MHX HS2403 1812` · SATA data + 4-pin power **populated**.
Unpopulated headers: **`J32` 3-pin at the bottom edge** (near `Q35/R244/R245`), **`J15` 9-pin row**
mid-board, `J42`/`J43` 4-pin, `S10` switch footprint. Function **not identified** from a photo.
Stock U-Boot env: `console=ttyAMA0,115200` (x3), `baudrate=115200`. Front-panel controller: wide
SSOP, ~24 pins a side, **marking not legible** — brighter close-up needed. Recorded for the
runbook; not a recommendation.

## Plan (next steps at the time)

1. **Flash `uImage-noefi-userspace2` first** to settle Q-vs-R with a probe that can fire:
   ~3:49 = PID 1 ran (kernel boots fully; fault is the NIC alone) · ~3:36 again = exec fails.
2. **DT**: flatten `mdio{}` -> `phy@3` as a direct child of `&gmac1` with
   `#address-cells = <1>; #size-cells = <0>` on gmac1; add
   `hisilicon,phy-reset-delays-us = <10000 10000 30000>`.
3. **Config**: add `RESET_TI_SYSCON` to `REQUIRED`; tighten the gate to `=y` for boot-needed
   symbols.
4. **Build, verify, flash.** Expect IP_PNP to configure `.56`, init.c `.57`, init.sh `.58`.
5. **Stop killing a booted box**: when R fires, arm a 10-20 min period (or have `init.sh` pet the
   SP805 only while `eth0` is up, so the reboot period itself reports NIC success).
6. **Tooling**: `himedia:verify-uimage` (one named script for every pre-flash check done inline
   today; `make-recovery-usb` calls it) and `himedia:check-dt` extended from clocks to
   compatibles -> Kconfig `=y`.
7. **Docs**: point `261010-himedia-q10-pro-bringup-state.md` at this file (done).

## Refs

`scripts/himedia/checkpoints.ts` (profiles, `assertReadable`) · `scripts/himedia/arm-const.ts`
(13 tests) · `scripts/himedia/kernel/arm32/initramfs/init.c` (R) ·
`scripts/himedia/build-kernel-arm32.ts` (`postMmuConfig`, `/dev/mem`) ·
commits `ccc0fff`..`a301d8f` · board photos `~/Downloads/HimediaQ10Pro-*.HEIC`

## Late evening (2026-10-10): the RAM log, and three causes it exposed

### ⭐ The boot log now comes back through Android (Tim's idea)

`himedia:ramoops`. Mainline keeps its console in a pstore/ramoops block at **`0x7A800000`**
(1 MiB, unbuffered); a watchdog reset keeps DRAM powered; with the stick pulled the box boots
stock Android, whose vendor tool **`himd.l`** (over `/dev/hi_mem`) dumps physical RAM.

- The vendor kernel has **no `/dev/mem` driver** (`ENXIO` on *open*, `CONFIG_DEVMEM=n`) and no
  `/proc/kcore`, so `dd if=/dev/mem` never worked — `himd.l` does.
- The address is **measured**: the free tail of the vendor media zone (MMZ `ddr`
  `0x77C00000-0x7B3FFFFF`, highest allocation `0x7A582FFF` behind the framebuffer). Five markers at
  `0x7A800000..0x7B380000` **all survived** reset + U-Boot + a full Android boot.
- First real readout: **14,865 chars** of console, every zone header valid.
- The console only records `printk`; userspace is invisible unless it writes **`/dev/kmsg`**, which
  `init.sh` now does (ifconfig, eth0 state, MDIO, USB, block, USB/ETH registers; boot and +20 s).

### What the log showed

1. **`Kernel command line: androidboot.selinux=disabled console=ttyAMA0,115200 …`** — U-Boot's.
   `ARM_ATAG_DTB_COMPAT_CMDLINE_FROM_BOOTLOADER=y` makes the *decompressor* copy the ATAG cmdline
   over the appended DTB's `bootargs`. **`ip=`, `panic=5`, `rdinit=` never reached the kernel on any
   boot today — the `.56` rung never existed.** Fixed: `ARM_ATAG_DTB_COMPAT` off, asserted in the build.
2. **No gmac line at all.** `hix5hd2_gmac` probes silently and its `open()` fails silently
   (`of_phy_connect` NULL → `-ENODEV`). Nothing ever opened `eth0`, because `ip=` was gone.
3. **xHCI `f98b0000` registered bus 3/4, nothing enumerated** — the onboard Genesys hub never answered.

### Measured from stock Android (`himedia:android-probe`, read-only)

- **Ethernet PHY: MDIO address 1** (`f9841000.etherne:01`, id `0x001cc915` = RTL8211E), link Up
  1 Gbps/Full, MAC `02:00:00:00:10:01`. The vendor DT's `reg = <0x03>` (on a node named
  `ethernet_phy@1`) was wrong and we had copied it.
- **The boot stick is on xHCI `f98b0000`** behind an onboard **Genesys `05e3:0608`** 4-port hub.
  EHCI/OHCI have nothing attached. Two EHCI "fixes" (OTG switch, PHY port 1) were aimed at the wrong
  controller.
- **xHCI host1's bring-up** (vendor `clk-hiusb3.c` `hiclk_enable_usb3_host1`): the **one-port PHY**
  (`usb2_phy2`: SRST bit 6, TREQ bit 10, `inno_phy_config_1p`) and reset **`USB3_VCC_SRST_REQ1` =
  CRG `0xb0` bit 28**. Our node had `usb2_phy1_port1` and bit 13. Fixed.
- **Working register values** (`himd.l`): `CRG 0xb0 = 0x007f007f`, `0xb8 = 0x3f`, `0xbc = 0x5`,
  `0xcc = 0x02003035` (bit 13 = 1: PHY out of reset — our polarity is right), `0x120 = 0x00a01140`,
  `0x124 = 0x00a011c0`, `0x12c = 0x100001a8`, `MACIF1 = 0x000d003c`, xHCI1 `HCSPARAMS1 = 0x02000140`.
  Saved under `$HIMEDIA_ROOT/android-probe/`.
- The vendor kernel is **3.18.24**, not the 4.4.35 tree we read; its OTG thread flips
  `0x12c` bit 28 between host and device.

### Instrument failures tonight (all fixed, tested)

| failure | consequence |
|---|---|
| NIC verdict scanned `/sys/class/net` for "first non-lo" | `sit0` (`IPV6_SIT=y`, always DOWN) may have been read — **every DOWN reading unproven** |
| USB "device present" grep `^[0-9]*-` | matched root-hub *interfaces* (`1-0:1.0`) → false DEVICE_NO_DISK |
| SH_STARTED 5 s period | reset a healthy box mid-wait for the stick (24.5 s) |
| stage predictions ignored the +60 s re-arm | readings over ~45 s shifted to ~142 s + 2L |
| ARM-only constant search; Thumb-2 PID 1 | two false "MISSING" verdicts on correct images |
| `debian:trixie` tag was `arm/v7` | every build ran emulated; native arm64 builder now: **~55 s** builds |

### Image on the stick tonight: `uImage-noefi-night` (sha `a265fb04fff529ff`)

Our cmdline (`ip=` `.56`, `panic=5`, `loglevel=8`, `carrier_timeout=15`), PHY at MDIO 1, xHCI host1
on `usb2_phy2` with reset bit 28, ramoops log, `init.sh` diagnostics into `/dev/kmsg`.

**Readout:** boot it, wait for one reset, pull the stick → Android → `bun run himedia:ramoops`.
The log should now contain `IP-Config:` lines for eth0, the PHY attach (or its failure), USB
enumeration under xHCI, and the `q10:` diag blocks with our registers to diff against Android's.

## 2026-10-11 — the box is on the LAN: one dma-ranges bug killed both NIC and USB

**State (read, not inferred):** `uImage-noefi-dma2g` (sha `311aa02df1bddc58`) boots, `.56`
answers ping and telnet, MAC `02:00:00:00:10:01` confirmed by ARP. `RX bytes:33144`, xHCI
host1 IRQ 168, onboard hub `1-1` (4 ports) enumerated, the stick at `1-1.2` is `sda`/`sda1`.
The SP805 was disabled over telnet at uptime 65 s (`0xf8a2c008` reads 0) and the box stays up.
dmesg: (run log).

**Three boots, three readings:**

| boot | image | reading (RAM log via Android) |
| --- | --- | --- |
| 08:2x | sweep | straps let frames in: rx +4972, **bytes 0**, all dropped. xHCI port 1 `PORTSC 0x6E1` (hub attached, never reset) |
| 08:37 | rings | gmac `RX_FQ/BQ_START_ADDR` = **`0xFFFFFFFF`** (Android: `0x7c445000`); xHCI `USBSTS 0x1015` = HCHalted + **Host System Error**, IRQ count 0 |
| 08:48 | dma2g | everything works |

**Root cause.** The arm32 `soc` node carried the arm64 tree's `dma-ranges = <0 0 0x40000000>`
(1 GiB). arm32 placed CMA at **`0x76800000`**, so every `dma_alloc_coherent()` from CMA
translated to `DMA_MAPPING_ERROR` (`~0`). The gmac pointed its rings at `0xFFFFFFFF` (frames
counted, length never written back) and xHCI faulted on its first DMA. Widened to 2 GiB
(covers `mem=1993M`); the stock kernel's queues at `0x7c445000` prove the masters reach it.
Gated by `gmac-dt.test.ts` (mutation-checked).
⚠️ **A counter is not a payload.** RX *packets* climbing looked like a working NIC for two
boots; *bytes* stayed 0. The sweep now ranks by bytes.

**RGMII sweep, measured with DMA working (10 s per setting):**

| setting | ext 0xa4/0x1c | rx | bytes |
| --- | --- | --- | --- |
| straps (vendor) | 0x8575 | 49 | 4642 |
| forced RX | 0xad75 | 47 | 4563 |
| forced TX | 0xb575 | 0 | 0 |
| forced RX+TX | 0xbd75 | 49 | 4221 |
| forced off (mainline `rgmii`) | 0xa575 | 0 | 0 |

⇒ **The RX delay is the one that matters**; mainline `phy-mode = "rgmii"` forces it off. Straps
are kept and TX works under them (telnet). Which `phy-mode` reproduces the straps
(`rgmii-rxid` vs `rgmii-id`) is not yet decided — TX was only proven under straps.
⚠️ `tx-probe` (ping the Mac) reported 100% loss while telnet worked — the Mac does not answer
ICMP from there; it is not a TX fault.

## Checkpoint — end of 2026-10-10 (resume here)

### Measured in the second RAM log (`ramoops/20261010T164256-log.md`)

- Our cmdline now applies (`ARM_ATAG_DTB_COMPAT` off): `mem=1993M ip=192.168.1.56::… rdinit=/init
  panic=5 loglevel=8 carrier_timeout=15`.
- **`eth0: Link is Up - 1Gbps/Full`**, **`IP-Config: Complete … ipaddr=192.168.1.56`**, PHY
  `f9841000.ethernet-mii:01 id=0x001cc915` (RTL8211E at MDIO 1). Everything above the wire works.
- **`RX packets:0`, `TX packets:8`, carrier 1** at +25 s while the Mac ARPed it → receive path dead.
- **MACIF1 = `0x000D003C` in mainline = `0x000d003c` in working Android** → MAC side identical;
  the difference is the PHY's RGMII clock delays (mainline forces them off for `rgmii`; the vendor
  kernel leaves the strap pins).
- USB: xHCI host1 still enumerates nothing. Register diff vs Android: CRG `0xb0` bit 17
  (`USB3_REF_CKEN1`) **off** in mainline (`0x007D0060` vs `0x007f007f`) — no mainline clock models
  it; PHY2 trim writes (`0x124`) differ (`0x00A00604` vs `0x00a011c0`).

### On the stick, NOT yet booted: `uImage-noefi-sweep` (sha `1a11910eb7ddc258`)

- `0003-net-hix5hd2-rgmii-variants-and-mii-ioctl.patch`: MAC accepts `rgmii-id/-rxid/-txid`;
  `.ndo_eth_ioctl = phy_do_ioctl_running` exposes MDIO to userspace.
- PID 1 `rgmii_sweep()`: RTL8211E ext page `0xa4` reg `0x1c` — **straps** (bit 13 clear, = vendor),
  then forced RX / TX / RX+TX / off; restarts aneg, counts RX for 6 s each, **keeps the first that
  receives**, logs every step (`q10: sweep: …`) to `/dev/kmsg`.
- `init.sh` sets CRG `0xb0` bit 17 (host1 ref clock) before waiting for the stick; diag adds xHCI
  host1 PORTSC (`0xf98b0420`, `0xf98b0430`).

### Next session

1. Boot the stick; give it ~3 min. **If `.56` answers → telnet/HTTP in, read `dmesg` live.**
2. Otherwise pull the stick → Android → `bun run himedia:ramoops` (or leave
   `scripts/himedia/await-ramoops.sh` running to do it unattended). Read the `q10: sweep:` lines:
   whichever setting got `rx +N` is the board's RGMII delay; make it permanent as the DT
   `phy-mode` (`rgmii-rxid` / `-txid` / `-id`) — the 0003 patch makes those accepted — or keep
   strap-mode via a small realtek tweak if "straps" wins.
3. USB: read the PORTSC lines. If still nothing with the ref clock on, compare the vendor's
   `inno_phy_config_1p` trims against mainline's `phy-hisi-inno-usb2`.
4. After network: armhf rootfs on SATA/USB, SSH, drop the watchdog ladder.

### Tooling added today (all committed)

`himedia:android-probe` · `himedia:ramoops` · `scripts/himedia/await-ramoops.sh` ·
`scripts/himedia/arm-const.ts` (ARM + Thumb-2 constant finder) · `himedia:builder`
(native arm64 builder, ~55 s builds) · checkpoint profiles FAST/USERSPACE with `assertReadable`.
