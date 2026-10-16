# Q10 Android: what we have, its limits, and how each could be overcome

**Date:** 2026-10-12 · **Decision (Tim):** accept the current Android; no own Android build.

## What runs today (measured on the box, k22)
- **LineageOS 20 = Android 13**, Waydroid `waydroid_arm` (32-bit) VANILLA image built 2026-09-26/27,
  **security patch level 2026-02-01**, in an LXC container on our mainline kernel (no emulation).
- GPU-rendered UI on the Mali-T720 (Mesa panfrost, ES 3.0 override), 0 GPU faults.
- Sound via PipeWire → ALSA; remote/keyboard via cage; boot-menu entry "Android 13".
- Pause/resume: leaving Android freezes it (memory to zram), back in ~1-7 s; cold start ~100-110 s.
- Memory: ~720 MB with Android running, 1.2 GB still free.

## Limitations → how to overcome
| # | limitation | why | how to overcome | cost |
| --- | --- | --- | --- | --- |
| 1 | **Android 13, security patch 2026-02** | Waydroid publishes no newer image for any arch; LineageOS 23.2 (Android 16) has a `waydroid_arm` target but nobody ships it | build LineageOS 23.2 ourselves (`scripts/himedia/android/build/*`, sources already synced on a LAN build container) | a builder with **≥ 48-64 GB RAM** (our build host could not: swap exhausted); ~6-10 h; then port the Q10 changes |
| 2 | **Video decode is software only** — 720p60 drops ~45%, 1080p60 not real-time | Waydroid's codec service uses CPU codecs; our hardware decoder is not exposed to Android | an `ffmpeg_codec2` service with FFmpeg's v4l2request hwaccel (Android 16 tree already ships `c2.ffmpeg` on ARM); FFmpeg for bionic armv7 + probe already built (`scripts/himedia/android/codec2/`) | needs #1's build tree; ~4-7 days; zero-copy is extra |
| 3 | **No Google Play** | VANILLA image | swap to the published LineageOS 20 **GAPPS** `waydroid_arm` image (1.1 GB) — no build | ~30 min; +~300 MB RAM |
| 4 | **Netflix/Disney-class apps, banking (Play Integrity)** | no Widevine L1 / certified device; container | not fixable on this hardware | — |
| 5 | **32-bit only** — arm64-only apps will not install | kernel is AArch32 (32-bit boot firmware + TEE) | a 64-bit kernel needs an AArch64 boot path through the 32-bit TEE (Poplar-style) | large, risky research project |
| 6 | **GPU is GLES 2.0 hardware** (ES 3.0 is an override); no Vulkan | Mali-T720 (Midgard) | none for Vulkan; apps using real ES 3.x features may misrender | — |
| 7 | **2 GB RAM** shared with Linux | hardware | zram + pause already applied; heavy apps still swap | — |
| 8 | **Original Android 7** (stock, eMMC) | kexec boot shows stripe noise | opt-in only; pull the stick to boot it normally | — |

**Fallbacks:** `waydroid-install.sh uninstall` removes Android 13; LineageOS 20 images stay in
`/var/lib/q10/waydroid-images`; pulling the boot stick boots the untouched stock Android 7.
