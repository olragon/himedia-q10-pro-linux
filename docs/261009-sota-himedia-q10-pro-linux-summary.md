# SOTA: HiMedia Q10 Pro → general-purpose Linux box

**Date:** 2026-10-09 · **Angles:** sessions, mainline, flashing, community, frontier (+ a gap-fill round)

## Verdict

**Viable, and on a much firmer footing than a typical TV-box hack — but it is a time-boxed hobby
conversion into a low-stakes appliance, not a route to a dependable NAS.** Three facts decide it:

1. **The SoC is the 96Boards Poplar reference part.** Hi3798CV200 has mainline Linux, mainline
   U-Boot (`poplar_defconfig`) and TF-A support, and all three are still marked Supported /
   Maintained with named maintainers. This is bring-up of a known upstream platform, not reverse
   engineering.
2. **Both features that justify this box over a cheap SBC — native SATA 3.0 and USB 3.0 — run on
   100% mainline drivers.** The only upstream gap is the *device-tree nodes*, and a working node
   set already exists publicly, proven on a different Hi3798CV200 NAS box running mainline 6.18
   with Debian 12.
3. **The rescue path is weaker than the spec sheet implies.** The box has a rear recovery pinhole,
   but a real user's USB-stick recovery failed outright, and the only rescue that worked was
   soldering to UART pads whose location nobody has ever published.

⇒ **Do it in the order below, and find the UART before writing anything.** Do not let this box hold
the only copy of anything. If the actual goal is a reliable NAS, an N100 mini PC is the honest
answer and this is a distraction.

## What it can and cannot become

Checked directly against mainline `master` (`hi3798cv200.dtsi`, `hi3798cv200-poplar.dts`, and the
driver trees), not inferred.

| Subsystem | Upstream status | Consequence |
|---|---|---|
| 4× Cortex-A53, PSCI, clk/reset (CRG) | ✅ works | `COMMON_CLK_HI3798CV200` |
| eMMC | ✅ works | `MMC_DW_HI3798CV200` |
| Gigabit Ethernet | ✅ works | `HIX5HD2_GMAC` — the box's primary link |
| UART (PL011), I2C, SPI, GPIO | ✅ works | console + housekeeping |
| USB 2.0 (EHCI/OHCI) + PHY | ✅ works | nodes present in Poplar dts |
| PCIe | ✅ works | fix for reset polarity landed 2026-02-27 |
| IR receiver | ✅ works | `IR_HIX5HD2` |
| **USB 3.0 (xHCI)** | ⚠️ **driver yes, node no** | `xhci-histb.c`, `CONFIG_USB_XHCI_HISTB`, compatible `hisilicon,hi3798cv200-xhci`. Add a DT node. |
| **SATA 3.0** | ⚠️ **driver yes, node no** | `generic-ahci` (`SATA_AHCI_PLATFORM`) + combphy `PHY_TYPE_SATA`. Add a DT node. |
| GPU (Mali-T720, Midgard) | ⚠️ partial / moot | panfrost lists `arm,mali-t720`; no GPU node, and no display controller to drive |
| **Video decoder (VPU)** | ⛔ **no upstream path** | no hardware decode, ever, on mainline |
| **HDMI / display controller** | ⛔ **no upstream path** | headless only |
| Audio, CEC | ⛔ no upstream path | — |
| Wi-Fi / Bluetooth | ❓ unverified | chip-dependent; see open question 4 |

**The one-line summary: it can become a headless server, and on mainline it can never be a media
player again.** Every reason you would have bought this box — 4K HDR, Dolby Vision, Blu-ray ISO,
7.1 passthrough — lives in the vendor blob and dies with Android.

⚠️ The `mainline` angle read SATA, USB3 and the GPU as "partial" from the *absence of dtsi nodes*.
That is true of the Poplar board and wrong as a statement about the SoC: **absence of a device-tree
node is not absence of a driver.** Verified by reading the driver trees directly — the xHCI driver
matches this exact compatible string, and `hisilicon,mode-select-bits` (needed to put a combo PHY
into SATA mode) is in the mainline combphy driver.

## The combo-PHY lane budget — the non-obvious engineering constraint

There are **two combo PHY lanes and three candidate functions**. The vendor block diagram says it
plainly: *"PCIe (shared with SATA 3.0 and USB 3.0)"*. Observed allocations:

| Board | combphy0 | combphy1 |
|---|---|---|
| Poplar (reference) | USB3 (`fixed-mode = 4`) | PCIe |
| a Hi3798CV200 NAS box | USB3 | **SATA** (`PHY_TYPE_SATA` = 1) |

⇒ **SATA and USB 3.0 coexist. The real trade-off is SATA versus PCIe.** (I initially suspected SATA
would cost USB 3.0 — it does not; corrected against the device tree and the vendor diagram.)

⚠️ **Consequence worth checking before counting on Wi-Fi:** if this box wires its Wi-Fi module to
PCIe, claiming combphy1 for SATA may disable Wi-Fi. Ethernet is unaffected — the GMAC is separate.
For a headless server on GbE this is probably irrelevant, but it should not be discovered by
surprise.

## Two routes, and the one that is blocked

| Route | What you write | Reversible? | Blocker |
|---|---|---|---|
| **A — keep the stock bootloader, replace only the kernel** (recommended) | nothing to the loader; kernel + dtb + rootfs on USB or the SATA disk | **yes**, if the loader scans USB before eMMC | needs the stock loader's boot order confirmed over UART |
| B — build l-loader + ATF + U-Boot and write `fastboot.bin` to eMMC block 0 | eMMC block 0 | **no**, without a working rescue | **board-specific DDR timing does not exist for this box** |

**Route B's blocker is concrete.** The community build system takes `DDR_REG=${BOARD}.reg`, and only
four board files exist — none for a HiMedia box. DDR init runs before anything can print, so wrong
timing means a silent no-boot, recoverable only through the rescue path that is already the weak
link. Worse, **this box shipped in multiple PCB revisions**, so even a donated timing file may not
match the unit in hand.

Route A is the method an active project already uses on retail Hi3798CV200 boxes: keep the vendor
loader, hand it a replaced kernel container. It sidesteps DDR init entirely.

## Risk: the rescue path is the real exposure

- The rear panel **does** have a recovery pinhole, and stock update packages ship a `fastboot.bin`
  (the exact filename the BootROM wants).
- **But a documented brick exists and the USB path did not save it:** a user upgrading firmware was
  left showing `0000` on the front LED with the vendor logo on screen, and the USB upgrade button
  produced no drive activity across *all three* USB ports and several firmware versions.
- The remedy another user offered was: open the case, contact the **RS232** pads, use PuTTY.
- The thread's closing question — *where are those pins on the board?* — **was never answered.**

⇒ **The UART pad location on this PCB is genuinely undocumented, not merely un-found.** It is also
the only rescue known to work. So it must be located and verified **while the box still boots**,
which inverts the usual order of operations and is the single most useful operational finding here.

## Order of operations

1. **Read-only recon over adb** — `/proc/cpuinfo`, partition table, board revision, Wi-Fi chip.
2. **Archive the stock firmware** — 2.1.4 is the last official build; a 2.1.7 community build exists.
   Keep it off the box, under `$HIMEDIA_ROOT`, with a second copy.
3. **Root, then dump the eMMC.** Root over LAN is documented for Android 7.0, which settles the
   question the `flashing` angle left open. `dd` every partition; verify by size *and* checksum.
4. **Find and verify the UART.** Capture a full boot log. This answers, in one shot: the stock boot
   order, whether the loader can be interrupted, and whether secure boot is enforced.
5. **Only then** try booting a kernel from USB or SATA.

⛔ **Gate: no write to eMMC until 1–4 are all done.** Steps 1–4 are entirely reversible; step 5
onward is not, until a tested restore exists.

## Opportunity cost

| Option | Rough price (2026-10) | Performance | Mainline | Verdict for a home server |
|---|---|---|---|---|
| **Q10 Pro (owned)** | **$0 marginal** | ~Pi 3B+ class, 2 GB | good headless, DT work needed | quiet cold-backup / sync / DNS node |
| Raspberry Pi 5 8 GB | ~$95–180 (unreconciled) | much faster | excellent | good, but needs USB-SATA for disks |
| Orange Pi 5+ / Rock 5B+ | ~$225–251 (snippet-only) | vastly faster, NVMe | good | strong if you want ARM horsepower |
| N100 mini PC | ~$150–250 | far faster, x86 | n/a | **the honest default for a real NAS** |

⚠️ Prices are soft: the Pi 5 figure appears as both ~$95 and ~$180 in different sources and was not
reconciled; the RK3588 figures are snippet-only. Treat the ordering as reliable and the numbers as
indicative. Power draw does not separate the options — 1 W for a year is roughly $1.75, and a
spinning 3.5" disk dominates whatever hosts it.

**Where this box genuinely wins:** it is already owned, and it pairs a **native 3.5" SATA bay** with
its own GbE and USB 3.0 in a metal case with a fan. Most small SBCs reach disks through a USB-SATA
bridge, which is the usual reliability weak point in DIY NAS builds. For an IO-bound, CPU-light role
that combination is real value at zero marginal cost.

**Where it loses outright:** anything needing hardware transcode (the VPU is dark), anything
memory-hungry, VMs, or k8s.

## Open questions

1. **UART pad location** on this PCB — and which board revision this unit is.
2. Is **secure boot / BL33 signing** enforced on retail units? Unknown; gates route B entirely.
3. Does the **stock** loader scan USB before eMMC, and can it be interrupted? Gates route A.
4. Is **Wi-Fi on PCIe**? If so it conflicts with SATA on combphy1.
5. Does the SoC expose **ARMv8 crypto extensions**? Decides whether restic or a VPN role is sane.
6. Board-specific **DDR timing** — only needed if route B is ever attempted.

## Angle reports

- ref: (an unpublished note)
- ref: docs/261009-sota-himedia-q10-pro-linux-mainline.md
- ref: docs/261009-sota-himedia-q10-pro-linux-flashing.md
- ref: docs/261009-sota-himedia-q10-pro-linux-community.md
- ref: (an unpublished note)
- ref: (an unpublished note)
- ref: docs/261010-himedia-q10-pro-linux-vs-android.md — follow-up: why a newer Android is not an
  option (7.0 is the ceiling), and why vendor-kernel Linux is a trap rather than a compromise.
