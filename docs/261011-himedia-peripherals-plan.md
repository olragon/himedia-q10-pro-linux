# HiMedia Q10 Pro — which ports mainline can drive, and in what order

**Date:** 2026-10-11
**Status:** In Progress (planned; executes after SSH lands — docs/261011-himedia-ssh-rootfs.md)

## Goal
For every port on the box, a sourced answer: works now / one build away / needs a driver /
not realistic — then work them in cost order.

## Evidence used
- Running box on mainline 6.18.55 (telnet, 2026-10-11): `/sys/bus/usb`, platform devices, dmesg.
- Photos: rear/front panel (product shots), `Board01`, `FrontPanelBoardd01` (Tim, opened box).
  Board silkscreen `HI3798CV200_V2.2_20170706`; WiFi module markings **AP6255**.
- Stock firmware 2.1.4: `system/lib/modules/` = `bcmdhd.ko` (Broadcom SDIO), `rtl8188eu.ko`,
  `ahci_platform.ko`; `system/etc/firmware/ap6335/` holds `nvram_ap6255.txt`.
- Stock Android dmesg (android-probe 2026-10-10): `ata1: SATA link down` — no disk at the time.
- Kernel tree 6.18.55: `drivers/auxdisplay/` has no TM16xx/FD6xx VFD driver.

## Port by port

| Port | State now | Why | Next step | Cost |
| --- | --- | --- | --- | --- |
| Ethernet | **works** | rgmii-id + dma-ranges fixes | — | done |
| USB hub (GL850G-class, 05e3:0608) on xHCI host1 | **works** | hub + stick enumerated, `sda1` | side USB2 ports ride on it — confirm with a 2nd device | none |
| SATA 3.5" | one build away — **disk now installed (Tim, 2026-10-11)** | `sata@9900000` is in our DT with the 4 CRG clocks, but **disabled**; open gap: vendor pokes PERI_CRG98_COMBPHY = 0xd00 (25 MHz VPLL), we approximate with assigned-clock-rates | enable node; flash over ssh (not in the same boot as the first ssh image, so a failure is unambiguous); read `ata1: SATA link up` | small |
| USB 3.0 (side port) | one build away (likely) | xHCI **host0** `f98a0000` is live in the stock iomem; our tree has an `xhci0` node, **disabled**, with combphy0 fixed to USB3 — but its USB2-PHY pairing is a GUESS (`usb2_phy2_port0`, which host1 already uses) | read the vendor's host0 bring-up (clk-hiusb3.c) for its PHY/reset, then enable | small-medium |
| USB 3.0 (rear, blue) | unknown | product shot suggests a Type-B (device) socket; stock iomem has a USB device controller `hiudc@f98c0000` | confirm the socket type by eye; device mode is a later, separate job | — |
| 2× USB 2.0 (side) | **likely works** | the onboard 4-port hub (05e3:0608) is up; side ports are the plausible consumers | plug a device into each, read `/sys/bus/usb/devices` | none |
| SD card reader (side) | one check away | `sd0: mmc@9820000` is mmc0 in mainline and initialised its host (`Bus speed … 165 MHz`); no card was inserted | insert a card, read dmesg | none-small |
| WiFi (AP6255 = BCM43455 SDIO) | needs DT + firmware | `brcmfmac` (=m) + SDIO built; needs the SDIO host node, the WL_REG_ON GPIO (mmc-pwrseq-simple), 32 kHz LPO, `brcmfmac43455-sdio.bin` + vendor `nvram_ap6255.txt`, and **kernel modules installed in rootfs.img** | GPIOs from vendor DTB; linux-firmware blob | medium |
| Bluetooth (same AP6255) | needs DT | UART + `brcm,bcm43455-bt` serdev | after WiFi | medium |
| IR receiver (front) | one build away | `ir@8001000` node exists; `CONFIG_IR_HIX5HD2` + `RC_CORE` not built | enable config + node, keymap from vendor | small |
| Front VFD ("HUD") | needs a driver | controller is a **Titan Micro TM1629A** (Tim read the chip, 2026-10-11): 3-wire serial STB/CLK/DIO LED/VFD driver. 6.18 has no TM16xx driver | find its 3 GPIOs (vendor DTB / FD driver in the stock kernel), then a userspace bit-bang driver (libgpiod), kernel auxdisplay later | medium |
| Front touch keys | needs a driver | ⚠️ whether the TM1629A also scans the keys is NOT established — the left sub-board on the front panel carries its own chip, plausibly a touch controller | identify that chip; keys may arrive over I2C or as GPIOs | medium |
| HDMI | **not realistic soon** | no mainline display/HDMI driver for Hi3798CV200; vendor HiFB/HDMI are SDK modules | headless box; revisit only if someone upstreams it | large |
| RCA video + L/R audio | not realistic | vendor VDAC + AIAO, no mainline driver | — | large |
| Optical / coaxial S/PDIF | not realistic | vendor AIAO SPDIF, no mainline ASoC driver | — | large |
| eMMC | **not used, on purpose** | mainline mmc1 fails init (`error -110`) — which also means it cannot be written | leave alone; Android stays the fallback | — |

## Order of work
1. SATA (enable; the disk is in) — it is the box's reason to exist as a server, and rootfs moves there.
2. USB 3.0 host0.
3. IR receiver.
4. WiFi (+ install kernel modules into rootfs.img — needed for anything `=m`).
5. Front panel: photo of the chip → protocol → userspace driver.
HDMI / RCA / S/PDIF are recorded as out of scope, not forgotten.

## Notes
- ⚠️ "USB3.0" on the rear: whether it is a host Type-A or a device Type-B is not settled from
  the product photo; the host0 controller in the stock iomem says host is at least possible.

## 2026-10-11 — SATA built in: the box never came back (log lost)

- `uImage-noefi-sata2` (SATA `okay` + patch 0004, sha `7055f58ee93ad877`) rebooted 10:25:04;
  no address (.56/.57/.58/.200) answered at any later probe.
- The watchdog WAS armed at every stage (kernel checkpoints -> PID 1 80 s + NIC verdict ->
  init.sh rootfs safety net). An earlier claim in-session that it was not armed was wrong.
  So the box was almost certainly **looping**: hang -> reset -> stick boots the same kernel.
- **Inferred, not read:** .56 (IP_PNP, late initcall) never answered, so the hang is most likely
  in the SATA probe, before the network — the risk the old DT note warned about.
- The RAM log was **lost**: a power cut was requested before the self-reset had a chance;
  `ramoops.ts` found 0/5 DBGC headers afterwards.
- Stick restored: `uImage` = ssh-ok (`15eecdb2fde32a9d`), SATA kept as `uImage.sata2`.

**Next SATA attempt (no loop, log survives):** build `SATA_AHCI_PLATFORM=m` (+ the combphy),
install modules into the rootfs (WiFi needs this too), blacklist auto-load, then over ssh: arm
the SP805, `modprobe ahci_platform`. A hang resets into the same safe kernel, and the previous
boot's console is readable over ssh from `/sys/fs/pstore` (region `ramoops@7a800000` is already
reserved in our DT). No Android, no stick swap, no power cut.

## 2026-10-11 15:00 — SATA WORKS (as a module, loaded by hand)

⛔ **Correction to the section above: SATA never hung anything.** The real cause of both
"never came back" boots was the WRITE PATH: both images were written to the FAT stick by the
box's own Linux over ssh (`cat > /mnt/stick/uImage...`). The byte-identical image
(`12bfae6728e19248`), re-written from the Mac, booted first time. The box-written copy hashed
correctly when read back on the Mac, so the bytes were right; the stock U-Boot (`verify = n`)
most likely mis-reads a file that Linux allocated non-contiguously (the 1.1 GB loop-mounted
rootfs.img shares the volume). Fragmentation is inferred, not measured — macOS's FAT driver
refuses F_LOG2PHYS and a raw read needs root. Symptom to recognise: the box never pings and
NEVER resets to Android, because nothing has armed the watchdog yet.
⇒ **Write kernel images to the stick from the Mac only.**

Measured (build #61, `uImage-noefi-satam`):
- `q10-modprobe-guarded phy_histb_combphy 45` → rc 0, both combphys bound.
- `q10-modprobe-guarded ahci_platform 60 40` → rc 0; `ata1: SATA link up 3.0 Gbps`,
  `WDC WD5000AAVS-00G9B0`, 976,773,168 sectors (500 GB) as `sdb`, `sdb1` NTFS label "My Book"
  (Tim's data — never written). No libata errors.
- `dd if=/dev/sdb bs=1M count=512 iflag=direct` → **66.5 MB/s** read.
- Patch 0004 verified: box clock = Mac clock to the second, NTP synchronized.

Still to do: auto-load at boot (a unit running the guarded loader after ssh is up),
NTFS mount (ntfs3, read-only first), xhci0 for the side USB3 port.
