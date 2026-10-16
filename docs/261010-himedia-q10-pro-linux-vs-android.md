# Q10 Pro: mainline Linux vs a "more modern Android"

**Date:** 2026-10-10 · **Question:** for the HiMedia Q10 Pro (Hi3798CV200), is converting to Linux
better than putting a newer Android on it?

## Verdict

**"A more modern Android" is not on the menu — that is the whole answer.** Android **7.0 is the hard
ceiling** for this SoC, and the reason is structural rather than a matter of effort. So the real
choice is *keep Android 7 and stay a media player*, or *go mainline Linux and become a headless
server*. For the stated goal — a general-purpose Linux box — **mainline Linux wins, and it is not
close.**

## Why a newer Android is impossible here

- No LineageOS or AOSP 9+ device tree exists for Hi3798CV200. Every firmware for this box, official
  and community, sits on the vendor's Android 7 tree: HiMedia's last official build is **2.1.4**,
  and the newest community build is **2.1.7**.
- The cause is structural: the media blobs (VPU, HDMI, Mali) are built against the **vendor BSP
  kernel 4.4.35**, and **Android's HAL is the only consumer of those blobs**. Moving Android forward
  means a new HAL against a newer kernel, which means a new vendor BSP — and HiSilicon is under
  sanctions and out of the set-top-box market. That BSP will never ship.
- *(snippet-only, unfetched)* Experimental Android 8 work on this SoC is reported, requiring
  workarounds and HiSilicon SDK support. Treat as rumour, not a path.

## The asymmetry that actually decides it

**You can have a modern kernel without the media stack, or the media stack frozen in 2016. Not
both.**

- Mainline Linux **gives up the blobs by design** — which is precisely why it can be current. The
  working community port runs **6.18**.
- Android **keeps the blobs** — which is precisely why it cannot move past 2016.

## The three real options

| | Kernel | Userland | Hardware media | Security | Verdict |
|---|---|---|---|---|---|
| **A. Mainline Linux** (Debian arm64) | **6.18** — a current longterm | real `apt` + systemd, first-class arm64 | ⛔ none | ✅ patched | **best general-purpose box** |
| **B. Vendor-kernel Linux** (4.4.35 + Debian rootfs) | 4.4.35 — **long EOL** | real, but see below | ⚠️ blobs present, unusable (see below) | ⛔ unpatched | **a trap — never do this** |
| **C. Android 7 + CFW 2.1.7** (+ Entware) | 4.4.35 — **long EOL** | crippled: no systemd, no `apt`, opkg only, Android's process killer | ✅ full 4K HDR, Atmos, BD-ISO | ⛔ unpatched | **best media player, poor server** |

## Why option B is a trap, not a compromise

It looks like the best of both worlds — keep the vendor kernel so you keep the drivers, but run a
real Linux userland. It isn't, for one specific reason:

**The vendor blobs expose HiSilicon's proprietary MSP (Media Standard Platform) API, not standard
V4L2 or DRM/KMS.** Jellyfin, VLC, Kodi and ffmpeg all speak V4L2/DRM. They cannot talk to MSP. So
"keeping the vendor kernel to keep hardware decode" does **not** yield working video in any ordinary
Linux software — the blobs are reachable only through Android's HAL or HiSilicon's own SDK samples.

⇒ **There is no Linux configuration of this box that is a competent media player.** Accepting that
up front is what makes the decision easy.

Two further strikes against B: kernel 4.4.35 is years past end of life, and the one published
vendor-kernel-plus-Ubuntu guide targets the **Hi3798MV100** (32-bit Cortex-A7) with an **armhf**
rootfs, so it does not transfer to the 64-bit CV200 without redoing the work.

## Security, which may be the deciding factor on its own

As of 2026-10, kernel.org's supported list runs **5.10 through 7.2**. **Neither 4.4 nor 4.9 appears
on it.**

- Android 7 (kernel 4.4.35, last firmware 2019) is unpatched at *both* the kernel and the Android
  layer. Acceptable for a media player on a trusted LAN; a poor choice for anything always-on,
  internet-facing, or holding data.
- Mainline 6.18 is a current longterm and still receives fixes.

For a box intended to run continuously on the network, this alone argues for mainline.

## Recommendation

- **Goal = general-purpose Linux box** (what was asked) ⇒ **option A, mainline Linux.** The plan and
  its gate are unchanged: dump the eMMC and find the UART *before* any write to eMMC.
- **Goal = keep a 4K HDR player** ⇒ **option C.** Don't convert; flash CFW 2.1.7 and stop.
- **Never option B.**

⭐ **The decision is reversible if you do step 3 of the plan.** Dumping the stock eMMC first keeps
Android 7 restorable, so you can try mainline and go back. That is another reason the backup gates
everything else.

## Sourcing ledger

- Fetched & read: 2 — `kernel.org/releases.json` (supported-release list, `plain`) and the
  `lucamot/HiSTB` README plus GitHub repo metadata (`plain`).
- Carried over from the 2026-10-09 run (already fetched there): the 4PDA thread header (firmware and
  root index), the vendor SoC block diagram, the XDA brick thread.
- Snippet-only, **not** cited as evidence: the "experimental Android 8" report; the U5PVR
  Android-7-ceiling statement (consistent with the 4PDA firmware list, which is fetched evidence).
- Unavailable: 0 this round.
- Searches that returned nothing on-topic: LineageOS / AOSP 9+ device trees for Hi3798CV200 — the
  absence is itself the finding, and it agrees with the firmware lists.
- ⚠️ The MSP-vs-V4L2 claim is an architectural reading of how the vendor BSP exposes media, not a
  quote from a fetched page. It is the load-bearing reason to reject option B, so it deserves a
  direct check against the BSP's headers before anyone spends time on B.

ref: docs/261009-sota-himedia-q10-pro-linux-summary.md
