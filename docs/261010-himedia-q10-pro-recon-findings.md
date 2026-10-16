# Q10 Pro — findings from the first read-only recon

**Date:** 2026-10-10 · **Box:** `<box-ip>:5555` (adb reports `Hi3798CV200`)
**Method:** `bun run himedia:recon` — read-only; a test asserts every command is a read.

## Headline

The box is **alive, stable on a replacement PSU, and reachable over adb**. Four of the six
questions the research left open are now answered, and two earlier claims need correcting.

## Identification

Found with `bun run himedia:find-box` (ping sweep + ARP + IEEE OUI + adb port probe).
`<box-ip>` was the candidate (`10:d0:7a` = **AMPAK Technology**, who make the SDIO Wi-Fi
modules these boxes use) and adb then confirmed `product:Hi3798CV200 model:Hi3798CV200`.

⚠️ `adb` is denied macOS Local Network access **separately from bun/ping** — TCC binds per
binary — and presents as the misleading `No route to host`. Start the adb *server* from
Terminal.app and the agent's client then reaches it over loopback, which is not "local network":

```
adb kill-server; adb start-server; adb connect <box-ip>:5555
```

## Answered

| Question | Answer | Evidence |
|---|---|---|
| **Is Wi-Fi on PCIe?** (would contend with SATA on combphy1) | **No — Wi-Fi is SDIO** | `wlan0 -> …/f9c40000.himciv200.SD/mmc_host/mmc2/…`, and `/sys/bus/pci/devices/` is **empty** |
| ⇒ **Is combphy1 free for SATA?** | **Yes, completely** | no PCIe device enumerated at all |
| **eMMC partition map** | **19 partitions**, exact sizes | `blkdevparts=` in `/proc/cmdline` |
| **Root on stock?** | **No** — `uid=2000(shell)` | `id` |
| **Serial console parameters** | **`ttyAMA0`, 115200** | `console=ttyAMA0,115200` in cmdline |
| **Is a disk fitted?** | **No** — bay is empty | `/proc/scsi/scsi` empty; `/dev/block/` has only `mmcblk0` + loops |

⭐ **Wi-Fi being SDIO is the single best piece of news.** It removes the lane-contention risk
entirely: both combo PHYs are available, so SATA can take combphy1 without costing Wi-Fi or USB3.

## Corrections to earlier claims

1. ⛔ **The vendor kernel on this box is `3.18.24_hi3798cv2x`, not 4.4.35.** The 4.4.35 figure came
   from the HiSTBLinux BSP; this unit runs **3.18.24**, built 2020-08-18. Linux 3.18 has been EOL
   since 2017, so the security argument for mainline is considerably stronger than stated.
2. ⛔ **The stock Android is 32-bit (AArch32) on a 64-bit core.** `/proc/cpuinfo` reports
   `ARMv7 Processor rev 4 (v7l)` and `CPU architecture: 7`, while `CPU part 0xd03` is Cortex-A53.
   ⇒ The box's 64-bit capability is **entirely unused today**, so moving to mainline **arm64** is a
   genuine capability upgrade, not merely a different OS.
   ⚠️ **This also makes the crypto-extension answer inconclusive rather than negative.** The
   feature list shows no `aes`/`sha`, but a 32-bit kernel reports AArch32 features and a 3.18
   vendor kernel may not probe the crypto ID registers at all. Only an arm64 kernel settles it.
   The recon tool now says "inconclusive" instead of implying the extensions are absent.
3. ⚠️ **The firmware on the box (`2020-08-18.140128`) is NEWER than the 2.1.4 archive being
   downloaded (dated 31-05-2019).** So the mirror copy is *not* what is installed. ⇒ **The eMMC
   dump is the only way to preserve the firmware this box actually runs** — the archive is a
   fallback, not a restore of the current state.

## Facts worth keeping for the device tree

- Board name: **`bigfish`** (HiSilicon's generic STB board id) — `ro.product.board`
- Ethernet: platform device **`f9841000.ethernet`**
- USB 3.0: **`f98b0000.xhci`**, live and bound
  ⚠️ **The reference NAS board's device tree puts xHCI at `0x098a0000`, this box reports
  `0xf98b0000`.** The SoC window is `soc@f0000000`, so that is offset `0x98b0000` versus
  `0x98a0000` — a *different controller instance*. The clock names in mainline
  (`HISTB_USB3_*_CLK` **and** `*_CLK1`) confirm there are two. Do not copy the reference node
  blindly; take the instance this board actually uses.
- Memory: `mem=1993M`, with `mmz=ddr,0,0,56M` reserved for the media zone and `vmalloc=600M`.
  `MemTotal` is 1,939,224 kB ≈ 1.85 GiB.
- SELinux is **disabled** in the stock cmdline, which eases rooting.
- eMMC: single `mmcblk0`, `179:0`.

### eMMC layout (authoritative, from `/proc/cmdline`)

`fastboot 1M · bootargs 1M · recovery 10M · deviceinfo 2M · baseparam 8M · pqparam 8M ·
logo 20M · logobak 20M · fastplay 40M · fastplaybak 40M · kernel 40M · misc 20M ·
trustedcore 40M · system 1024M · cache 1024M · private 50M · backup 800M · securestore 8M ·
userdata (rest)`

Note `trustedcore 40M` and `securestore 8M` — a TrustZone/secure-storage pair. Their presence
does **not** by itself prove secure boot is enforced on BL33, but it is where to look.

## ⭐ Root was already available — `adb root` works

`ro.build.type` is **`eng`** and `ro.debuggable` is **1**, so adbd restarts as root on
request. `adb root` returns `uid=0(root)` and **nothing is written to the box** — no
exploit, no `su` binary, no modified partition. The 4PDA "root via LAN" procedure is not
needed, which removes the only step that would have modified the device before a backup
existed. (There is no `su` on the system image; root is adbd-only, which is exactly enough
to read the raw block devices.)

⇒ This resolved the chicken-and-egg problem: rooting normally has to precede the backup,
but needing to modify the box before you can back it up is the worst possible order.

## eMMC layout as it actually appears

All 19 partitions exist as `mmcblk0p1`…`p19`, in the same order as `blkdevparts`, plus
`mmcblk0boot0`, `mmcblk0boot1` (4 MiB eMMC boot areas) and `mmcblk0rpmb`. Whole device is
**15,267,840 KiB ≈ 14.56 GiB**. There is **no `/dev/block/by-name/`**, so partitions must be
addressed as `mmcblk0pN` and the name mapping comes from `blkdevparts` by index.

⛔ **Pair names to partitions by INDEX, never by position in a listing.** If one partition
device were absent, positional pairing shifts every later label — and a mislabelled
device-unique image is a backup that restores the wrong bytes somewhere unrecoverable.

### Device-unique partitions — the ones that make a backup mandatory

`deviceinfo` (2M) · `baseparam` (8M) · `pqparam` (8M) · `trustedcore` (40M) · `private`
(50M) · `securestore` (8M)

These plausibly hold the MAC address, picture-quality calibration, TrustZone state and
keys. **They cannot be reconstructed from any generic firmware image, by anyone.** The
stock 2.1.4 archive does not restore them to *this* unit's values. They are therefore never
skipped by the dump tool regardless of flags.

## ⛔ `dd` on this box corrupts an image, silently

Two separate faults in the stock toybox `dd`, both of which produce a plausible-looking file:

1. `bs=1M` is rejected as an **"illegal number"** — and the error is printed to **stdout**,
   so `adb exec-out dd …` yields a **36-byte "image"**.
2. With a numeric block size it works, but writes its `N+0 records in` stats to **stdout**
   too, so a 1 MiB partition comes back as **1,048,667 bytes** — the right data plus 91
   bytes of junk. Almost the right size, and silently corrupt.

⇒ **Use `adb exec-out cat /dev/block/mmcblk0pN`**, which returns exactly the partition
bytes. This is why the dump verifies a sha256 computed *on the device* against one computed
locally: a size check alone would not have caught case 2 on a partition whose exact length
you did not already know.

## Next

1. **Root** — needed for the eMMC dump; documented over LAN for Android 7, and SELinux is off.
2. **Dump the eMMC** — all 19 partitions, verified by checksum, not by size.
3. **Find the UART** — `ttyAMA0 @ 115200` is confirmed; the pad location on this PCB is still
   undocumented and is the only rescue known to work on this model.
4. Fit a disk **only after** confirming the replacement PSU is rated 12V/3A or better, then
   re-run the recon to see whether a native `sd*` appears (which would prove the AHCI path).

ref: docs/261009-sota-himedia-q10-pro-linux-summary.md
ref: (an unpublished note)
