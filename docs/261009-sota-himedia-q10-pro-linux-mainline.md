# Mainline Linux / U-Boot / TF-A on Hi3798CV200 (HiMedia Q10 Pro) — mainline angle

Date 2026-10-09. Angle: `mainline`. Sources: fetched raw files from torvalds/linux, u-boot, TF-A on GitHub master; GitHub commit API; TF-A/96Boards/U-Boot docs pages. md`; this run: `.../mainline-sources.md`.

## Verdict

Mainline Linux is viable as a **headless / server-class** system on this SoC: 4x A53, eMMC, GbE, USB 2.0, UART, I2C, SPI, GPIO, IR, PCIe and clocks/resets are all in the upstream `hi3798cv200.dtsi` with in-tree drivers, and Poplar is actively fixed (a PCIe reset-polarity fix landed Feb/Mar 2026). It is **not** viable as a TV box: there is no upstream video decoder, no display/HDMI controller driver for this SoC, and no GPU node in the DTS. Boot chain is also upstream (U-Boot `poplar_defconfig`, TF-A `PLAT=poplar`, both maintained). The Q10 Pro needs its **own DTS** (the SoC dtsi is reusable, the board file is not) and a way to get a bootable `fastboot.bin` onto eMMC. Biggest risk is not the OS but the **BootROM/eMMC flash**: Poplar has a hardware USB-recovery button (S3); whether the Q10 Pro exposes an equivalent is unknown and must be established before any write.

## Subsystem -> upstream status

Status is from the in-tree Hi3798CV200 dtsi/poplar dts + Kconfig greps (fetched). "Works" means driver + DT node exist upstream; hardware-on-Q10-Pro behaviour is untested.

| Subsystem | Upstream status | Evidence / symbol |
|---|---|---|
| CPU, PSCI, GICv2, timer | works | dtsi: 4x cortex-a53, `arm,psci-0.2`, `arm,gic-400`, armv8-timer (needs PSCI from TF-A BL31) |
| Clock / reset (CRG) | works | `CONFIG_COMMON_CLK_HI3798CV200` (drivers/clk/hisilicon); `hisilicon,hi3798cv200-crg` + `ti,syscon-reset` |
| eMMC / SD | works | `CONFIG_MMC_DW_HI3798CV200` (compatible `hisilicon,hi3798cv200-dw-mshc`); poplar dts: eMMC 8-bit HS200/DDR 1.8 V |
| Ethernet (GbE) | works | dtsi: 2x `hisilicon,hi3798cv200-gmac`/`hisi-gmac-v2` -> `CONFIG_HIX5HD2_GMAC`; poplar uses gmac1 RGMII PHY addr 3. Q10 Pro PHY wiring may differ. (Binding-to-driver link is by Kconfig name; not verified by building) |
| UART | works | 2x PL011 (`CONFIG_SERIAL_AMBA_PL011`) |
| I2C | works | 5x `hisilicon,hix5hd2-i2c` -> `CONFIG_I2C_HIX5HD2` |
| SPI | works | 1x PL022 |
| GPIO | works | 13x PL061 |
| Pinctrl | works | generic `pinconf-single` at 0x8a21000 |
| USB 2.0 host (EHCI/OHCI) | works | `generic-ehci`/`generic-ohci` + `CONFIG_PHY_HISI_INNO_USB2` (`hisilicon,hi3798cv200-usb2-phy`) |
| USB 3.0 | partial | combphy driver supports mode USB3 (`CONFIG_PHY_HISTB_COMBPHY`, `COMBPHY_MODE_USB3`) and dtsi sets one combphy `fixed-mode = PHY_TYPE_USB3`, but **the dtsi has no xhci/dwc3 controller node**. Controller IP and driver not verified here (snippet-free inference: probably DWC3, needs a DT node + testing) |
| PCIe | works (regression fixed 2026) | `hisilicon,hi3798cv200-pcie` node, `pcie-histb` driver; poplar fix "Correct PCIe reset GPIO polarity", dated 2026-02-27 per commit API; Cc stable |
| SATA / AHCI | partial / unproven | combphy has `COMBPHY_MODE_SATA`, but **no SATA/AHCI node in the dtsi**, and the only SATA PHY Kconfig (`PHY_HIX5HD2_SATA`) depends on `ARCH_HIX5HD2` (a different SoC). Q10 Pro has no SATA port anyway (assumption: consumer box; unverified) |
| IR receiver | works | `hisilicon,hix5hd2-ir` -> `CONFIG_IR_HIX5HD2`; poplar keymap `rc-hisi-poplar`; Q10 Pro remote keymap needs own table |
| Watchdog | partial | no wdt node in the dtsi; generic `CONFIG_ARM_SP805_WATCHDOG` exists. TF-A BL31 uses watchdog0 for reset (see below), so the OS watchdog is entangled with firmware |
| Thermal / cpufreq | no upstream path (no node found) | no thermal or OPP nodes in the dtsi |
| GPU Mali-T720 | partial (driver yes, SoC wiring no) | panfrost lists `arm,mali-t720` and `GPU_MODEL(t720, 0x720)` (Midgard), but the dtsi has **no GPU node**; clocks/resets/power for it would have to be reverse-engineered |
| Video decoder (VPU/VDEC, H.265 4K60) | **no upstream path** | no driver or binding found in any grep; only vendor SDK blobs exist (vendor SDK not examined here) |
| HDMI / display controller | **no upstream path** | dtsi contains no display, HDMI, or DRM nodes |
| Audio | **no upstream path** | no audio nodes in the dtsi |
| Wi-Fi / BT | depends on chip, off-SoC | Poplar's is 802.11ac 2x2 + BT; Q10 Pro chip not identified in this angle; bus (SDIO/USB) would route through mmc/usb above |
| Front-panel VFD / LED | partial | GPIO LEDs work (poplar dts uses `gpio-leds`); a VFD controller would need its own driver by chip |
| CEC | **no upstream path** | no node, tied to HDMI block |
| Smart card / TSI | no upstream path | Poplar connectors, no nodes |

Absent from the dtsi (grep for `usb3|sata|xhci|thermal|mali` returned only the combphy USB3 fixed-mode line).

## Bootloader and firmware

- **U-Boot**: `configs/poplar_defconfig` is present in current master, `Maintained` (board MAINTAINERS lists Ramirez-Ortiz, Guo, Opaniuk). Supports eMMC (`MMC_DW`, `MMC_DW_K3`, env in MMC at 0x1F0000), USB host EHCI with ASIX USB ethernet, on-board GMAC (`HIGMACV300_ETH`), USB gadget DWC2 with fastboot flashing to MMC dev 0, distro boot. Recent commits are tree-wide refactors (Jun 2026), not poplar-specific work: maintained passively.
- **TF-A**: `docs/plat/poplar.rst` and `plat/hisilicon/poplar/` present, listed in `docs/plat/index.rst`, with a named maintainer (Shawn Guo) in `maintainers.rst`. Not marked deprecated in what I read. Recent activity: a 2024-03 commit switched reset to sysctrl and was **reverted** because it caused reboot regressions; watchdog0-based reset is used. (I did not fetch the platform-ports deprecation policy page; "not deprecated" rests on the maintainers + index entries only.)
- Documented tested versions are old (TF-A v1.3, U-Boot 2017.05-rc2, from the 2017 docs), so the upstream docs lag the code; expect to build current trees yourself.

## Boot chain and BootROM (risk-critical)

From the TF-A and U-Boot docs pages (both fetched):

1. BootROM -> `l-loader` (switches core to AArch64) -> TF-A BL1/BL2/BL31 -> U-Boot as BL33.
2. The BootROM requires the image to be named **`fastboot.bin`**. Per the U-Boot doc it is 983040 bytes (0x780 blocks) written to **eMMC block 0**.
3. **USB recovery ("debrick")**: copy `fastboot.bin` to a FAT USB drive, plug into a USB 2.0 port, power on while holding **S3 (usb_boot)**. The BootROM then loads it from the drive and you get a U-Boot shell to rewrite eMMC. This is confirmed by both docs and means a bad eMMC flash is recoverable on **Poplar**.
4. Other flash paths from U-Boot docs: TFTP over an AXIS USB ethernet dongle, or `fatload` from FAT32 USB.

**Caveat that matters**: S3 is a Poplar board button. For the Q10 Pro, the recovery trigger is a hardware fact I did not find. Pre-flash, locate the equivalent (a test pad / shorting eMMC CLK/CMD to force BootROM fallback is a common STB technique but is **not established here**). Also: the Q10 Pro's existing Android bootloader is signed/encrypted by the BootROM's "Decrypt auxiliary code" stage, so a Poplar `fastboot.bin` may not work on a secure-boot-fused unit; unknown. The DDR init in `l-loader` is **board-specific** (the Poplar trace names `hi3798cv2dmb_..._ddr3_2gbyte_8bitx4_4layers.reg`), so a Q10 Pro with different DRAM needs its own DDR reg blob.

## Kernel version floor and removal risk

- Floor: the DTS dates from 2016-2018 (SPDX fix 2018-10, IR keymap 2019-01); the PCIe polarity fix says the break came with the `PCI: histb` gpiod change, so PCIe is broken on kernels between that change and the Feb 2026 fix unless backported (it is Cc stable). Anything modern (v5.x+) boots Poplar; I did not test and did not find a precise floor.
- Removal risk: low. `MAINTAINERS` lists `ARM/HISILICON SOC SUPPORT` as **Supported** (Wei Xu), covering `arch/arm64/boot/dts/hisilicon/`; the Poplar dts was touched 2026-02-27 and the combphy driver 2026-03. No sign of deprecation. Note the SoC is a 2016 design; the long-term risk is maintainer attention, not policy.

## What this implies for the Q10 Pro

- Reuse `hi3798cv200.dtsi`, write `hi3798cv200-q10pro.dts`. Needs: DRAM size, eMMC bus width, Ethernet PHY/RGMII delay, Wi-Fi chip, LED/VFD GPIOs, IR keymap.
- Plan for a **serial console** (UART0) first; verify the recovery path before touching eMMC; back up all eMMC partitions raw before any write.
- Do not plan for hardware video playback or HDMI-native desktop. Display alternatives (USB-DisplayLink, simple framebuffer left by U-Boot) are unexplored here.

## Sourcing ledger

- Fetched and read: 5 via fetch-clean (TF-A poplar page, 96boards poplar page, `hi3798cv200.dtsi`, `hi3798cv200-poplar.dts`; plus probe U-Boot poplar docs page) + raw GitHub files read directly: `configs/poplar_defconfig`, U-Boot `board/hisilicon/poplar/MAINTAINERS`, Linux `MAINTAINERS`, Kconfigs for mmc/net/phy/clk/media-rc/i2c/watchdog, `phy-histb-combphy.c`, `panfrost_gpu.c`, TF-A `maintainers.rst` and `docs/plat/index.rst`, GitHub commit-API listings.
- Unavailable: `elixir.bootlin.com/.../hi3798cv200` (returned an Anubis bot-check page, no content; not used as a source).
- Snippet-only/unfetched: none cited. WebSearch was not used.
- Empty greps (absence evidence, not proof): SATA/AHCI, watchdog and dwc3 greps against Kconfig for "hisi" returned nothing; `pcie-histb` Kconfig grep returned nothing (driver existence inferred from the commit message "PCI: histb"); `Documentation/gpu/panfrost.rst` had no T720 mention. TF-A platform-ports-policy deprecation page and `dwc3` binding were not read.
