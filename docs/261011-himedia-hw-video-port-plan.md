# Q10 Pro — hardware video decode: port plan (community 6.12 -> our 6.18 AArch32)

**Date:** 2026-10-11 · **Status:** Planned (task 3 of Tim's list)
**Source:** `HiSilicon-Development/linux-6.12.y` @ 79347a39f, cloned to
`~/src/histb-linux-6.12.y` (GPL-2.0, arm64-targeted, authorship unclear,
not upstream). Assessment: docs/261011-himedia-video-decode-assessment.md.

## What exists there (read)
- `drivers/media/platform/hisilicon/`: `histb-vdec-core.c` (V4L2 mem2mem stateful decoder, H.264/
  HEVC/VP9/VP8/MPEG-2 in core + `-mpeg4/-vc1/-mvc`), `histb-vpss.c` (scaler/detiler), plus
  `histb-jpge`, `histb-venc`, `histb-dmx` (out of scope). ~23 k lines incl. the DRM side.
- `drivers/gpu/drm/hisilicon/histb/histb-vdp.c` (DRM display, graphics layer only) +
  `drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c` (HDMI TX, no audio).
- DT: `hi3798cv200.dtsi` nodes `vdec@8c30000` (links `hisilicon,vpss`), `vpss@8cb0000`,
  `vdp@8cc0000` -> `hdmi@8ce0000`. Clocks in their `crg-hi3798cv200.c` (1996 lines vs ours).
- Firmware: `request_firmware_direct` — the AVS+ SCD image and two table files (data, not code),
  `firmware/hisilicon/` in that tree.

## Milestones
1. **VDEC + VPSS as modules on 6.18 arm32** (patch 0008): copy the two drivers + headers, Kconfig/
   Makefile, the CRG clock entries they use (diff their crg against ours), DT nodes for vdec/vpss
   + a reserved-memory pool. Build as `=m` so it loads like q10_aiao (no stick write per try).
   Gate: `/dev/videoN` registers; `v4l2-ctl --list-formats-out` shows H264/HEVC.
2. **Decode H.264 1080p to a file**: `gst-launch`/`ffmpeg -c:v h264_v4l2m2m` -> NV12 frames,
   md5 vs software decode. Gate: bit-exact or visually correct frames, fps measured.
3. **Show it**: NV12 -> simpledrm (CPU/NEON convert) via mpv `--hwdec=v4l2m2m-copy --vo=drm`.
   Gate: 1080p30 H.264 plays on the TV.
4. HEVC (incl. 10-bit 4K), VP9, MPEG-2/4, VC-1; then the VDP video layer + HDMI (no CPU copy),
   then HDR — each its own milestone (assessment: weeks).
- AV1: **no hardware** — dav1d software (bench script: scripts/himedia/video/bench-on-box.sh).

## Risks
32-bit build of arm64-only-tested code; 6.12 -> 6.18 V4L2/DRM API drift; secure firmware owning
the decoder or its MMU; CMA size for 4K frames (we have 64 MiB CMA).
