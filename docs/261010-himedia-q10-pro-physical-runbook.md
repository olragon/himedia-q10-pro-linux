# Q10 Pro — physical runbook (what needs hands)

**Date:** 2026-10-10 · **Status:** everything that can be done without touching the box is done.

## What exists now

| Artifact | Path | Verified |
|---|---|---|
| Stock firmware 2.1.4 | `$HIMEDIA_ROOT/firmware/` | sha256 `637bd0e4…` |
| **eMMC dump, 19 partitions** | `$HIMEDIA_ROOT/emmc-dump/` | **both ends, 6 device-unique** |
| Restore procedure | `…/emmc-dump/RESTORE.md` | per-partition commands |
| Vendor DTB (decompiled) | `…/extracted/…/_dtb/` | from stock `boot.img` |
| **Kernel 6.18.55 `Image`** | `$HIMEDIA_ROOT/kernel-build/linux-6.18.55/arch/arm64/boot/Image` | 41 MB, builds clean |
| **Board DTB** | `$HIMEDIA_ROOT/kernel-build/linux-6.18.55/arch/arm64/boot/dts/hisilicon/hi3798cv200-himedia-q10-pro.dtb` | 13,740 B, clocks all resolve |
| Debian trixie arm64 rootfs | `$HIMEDIA_ROOT/rootfs/q10-trixie-arm64-rootfs.tar.xz` | 136 MB, key-only SSH |

Reproduce any of it: `himedia:firmware`, `himedia:dump`, `himedia:inspect`,
`himedia:build-kernel`, `himedia:rootfs`, `himedia:validate-dts`.

## ⭐ REVISED 2026-10-10 — the UART can wait, and the box need not be opened

Tim asked whether the UART could be deferred, and declined disassembly. Reading the dumped
bootloader answers it, and the answer is **yes, with one substitution**.

**What the stock loader actually is** (from `fastboot.img` and the env in `bootargs.img`):

| | |
|---|---|
| `bootdelay` | **0** — autoboot cannot be interrupted **even with a UART attached** |
| `stdin/stdout/stderr` | **serial only** — no HDMI console, no USB keyboard, as configured |
| `bootcmd` | eMMC only; the loader never looks at USB as shipped |
| USB support | ⭐ **present and complete** — `usb start`, `usb dev/part/read/info`, `fatload`, even USB-keyboard code |

⇒ Two consequences, and the second is the useful one:

1. **A UART alone would not have been enough.** With `bootdelay=0` there is no prompt to
   interrupt, so a serial console would have given a boot log and nothing more until the
   environment was changed anyway. That weakens the case for opening the box first.
2. **The loader can already boot from a USB stick — it is simply not told to.** One small
   change to `bootcmd` makes it try USB first and fall through to the stock eMMC boot.

### The trade that replaces the UART

**One small, reversible, self-recovering write buys unlimited risk-free iteration.** After it,
every experiment is just a different file on a USB stick, and a failure boots Android instead
of needing a rescue.

The env has **three independent fallbacks by construction**:

1. no stick, no `uImage`, or a kernel that will not boot → the original eMMC commands are
   appended **verbatim**, so execution simply continues into them (`;`, not `&&` — a failed
   command continuing is the shell's own behaviour, not a feature we are relying on);
2. a **corrupt** env → U-Boot prints "bad CRC" and uses its **compiled-in defaults**, which
   also boot from eMMC;
3. `bootargs.img` is dumped and hash-verified, so `himedia:env restore --apply` puts the
   original back.

It also leaves the **loader and `recovery` partitions untouched**, which matters: the one
documented brick on this model happened during a *full firmware flash* that rewrites the
loader. Changing only a 64 KiB environment block is a different class of risk.

`bun run himedia:env show | plan` — dry run by default; `--apply` is the only writing path,
and it reads the block back and compares before reporting success.

### Logging — do this around EVERY risky step

This box has **no previous-boot kernel log**: `/proc/last_kmsg` and `/sys/fs/pstore` are both
absent on the 3.18 vendor kernel. So with no serial attached, the only durable record across
a reboot is what userspace wrote to disk — and the one that matters is
**`/cache/recovery/last_log`**, Android recovery's own account of what it did.

```
bun run himedia:logs --label baseline        # BEFORE
bun run himedia:logs --label after-probe     # AFTER it boots back
bun run himedia:logs --diff baseline after-probe
```

A snapshot taken only *after* a failure cannot tell you what changed, so the baseline is the
point. It also captures `dmesg`, full `logcat`, `getprop`, the partition and mount state, and
the **bootloader control block** from the `misc` partition, which is what tells recovery what
to do on the next boot.

Baseline is already taken (`…/logs/20261010030207-baseline`), with
`recovery-last_log` **empty** — so anything appearing there after the test is direct evidence.

### ⛔ What I still need from you, and it needs no screwdriver

**Prove the recovery path works while the box is healthy.** This replaces "find the UART" as
step 1, and serves the same purpose:

1. Put the stock `update.zip` (extracted from the archived firmware) on the **root of a
   FAT32 USB stick**.
2. Hold the **RESTORE pinhole** (rear panel, beside the DC jack) and power the box on.
3. Confirm it enters the vendor update flow, then let it finish.

If that works, there is a proven way back from anything short of a loader corruption, and the
env change becomes genuinely low-risk. If it does **not** work, stop — that is exactly the
failure mode the XDA brick report describes, and then the UART really is required first.

⚠️ One open question remains before a kernel is written: **whether this 32-bit-era loader can
`bootm` an arm64 kernel.** Its architecture table names `arm64`/`AArch64`, but that proves the
header parser knows the name, not that a 32-bit build will boot it. Because the USB route
makes each attempt free, this is cheapest to settle by trying rather than by more reading.

---

## (superseded) Step 1 — find the UART

This is the gate, and it is the one step that cannot be prepared remotely.

**Why it comes first:** a documented brick on this exact model showed the USB recovery path
*failing* (stuck at `0000` on the front LED, all three ports, several firmware versions),
and the only rescue that worked was a serial console. The pad location on this PCB has never
been published — the XDA thread asking "where are the rs232 pins" was never answered. So it
must be located **while the box still boots**, when a wrong guess costs nothing.

Parameters are already known from the stock cmdline: **`ttyAMA0`, 115200 8N1, 3.3 V**.

1. Power off and unplug. Open the case.
2. Look for a 3- or 4-pad header near the SoC or the rear connectors, often labelled
   `GND / TX / RX` or `J*`. Photograph the board before touching anything.
3. Identify **GND** with a multimeter in continuity mode against the metal chassis or a
   USB shield.
4. With the box **powered on**, measure each remaining pad to GND:
   - **TX** idles near **3.3 V** and flickers during boot — that is the one that talks.
   - **RX** sits near 0 V or floats.
5. Wire USB-TTL **GND→GND, box TX→adapter RX, box RX→adapter TX**. Do **not** connect VCC.
6. `screen /dev/tty.usbserial-* 115200` (or `picocom -b 115200`), then power on.

**Success looks like:** HiSilicon boot text, then the Android kernel log. Capture it all.
That single log answers three open questions at once — whether the loader can be
interrupted, whether it scans USB before eMMC, and whether secure boot is enforced.

⚠️ 3.3 V only. A 5 V adapter can damage the SoC's UART.

## Step 2 — confirm the PSU rating before a disk goes in

The original PSU failed and was replaced. **Check the replacement's label.** Stock is
12 V / 2 A = 24 W, and a 3.5" drive wants **1.5–2.5 A on the 12 V rail at spin-up** on top of
the board. A 2 A replacement will reproduce the fault that was just repaired, and it will
present as a new problem. Want **12 V / 3 A minimum, 4 A comfortable**.

## Step 3 — first boot from USB, not eMMC

⛔ **Nothing is written to eMMC yet.** First boot must be non-destructive, so that a failure
costs a reboot rather than the box.

1. A USB stick, GPT or MBR, one ext4 partition.
2. Unpack the rootfs onto it, then put its UUID into `/etc/fstab`.
3. Copy `Image` and `hi3798cv200-himedia-q10-pro.dtb` into `/boot`.
4. With the serial console attached, interrupt the loader and boot from USB by hand.

**First boot only has to prove three things:** serial output, eMMC visible, Ethernet up. USB3
is deliberately **disabled** in the DTS — an unverified PHY pairing wedging a controller
during probe is indistinguishable from a kernel that never booted.

## Step 4 — SATA, once first boot works

Fit the disk, then look for `ata1` and an `sd*` device. ⛔ Expect the second USB3 port to
lose SuperSpeed: SATA and USB3 share **combphy1**, and that is hardware, not configuration.

## If it will not boot

1. The stock firmware on a FAT32 USB stick, RESTORE pinhole held at power-on. Needs no console.
2. The eMMC dump, one partition at a time, per `RESTORE.md`.
3. The UART — which is why step 1 is step 1.

⛔ Address every disk by **UUID or serial, never by letter** — this box is about to gain one.
⛔ Root belongs on the SATA disk, not eMMC: eMMC, USB flash and SD are consumables.

## Still open (and only hardware answers them)

1. UART pad location on this PCB — and which board revision this unit is.
2. Whether secure boot / BL33 signing is enforced.
3. Whether the stock loader scans USB before eMMC, and can be interrupted.
4. Which usb2-phy port pairs with which xHCI (a guess in the DTS, marked as such).
5. Whether the SoC has ARMv8 crypto extensions — the stock 32-bit kernel cannot answer it.

ref: docs/261010-himedia-q10-pro-vendor-dtb.md
ref: docs/261010-himedia-q10-pro-recon-findings.md
ref: docs/261009-sota-himedia-q10-pro-linux-summary.md
