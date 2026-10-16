# HiMedia Q10 Pro (Hi3798CV200): hardware and software video decode on mainline 6.18 AArch32

Date: 2026-10-11 · Scope: read-only assessment, no hardware touched · Box: 4x Cortex-A53, AArch32 kernel 6.18

Confidence tags used on every claim:
- **[read]**: I read it myself in the local vendor tree, the stock `system.img`, or a source file fetched with `gh`/`curl`.
- **[fetched: URL]**: the claim comes from that page, which I fetched and read.
- **[inferred]**: my reasoning from the facts above. The basis is stated.
- **[unknown]**: not established.
- **[unverified]**: a source states it, but I did not fetch that source or test the claim.

---

## Decision first

1. **Do not start from the vendor SDK.** The decoder core in the vendor 4.4 tree is not open source. It ships as ~234k lines of compiler-generated ARMv7/AArch64 assembly (`*.S`, GCC output from `hevc.c`, `h264.c`, ...). Only ~1.8k lines of product C and ~9k lines of glue (OSAL/distributor) are real source [read]. Writing a clean driver from that assembly would take months [inferred].
2. **The cheapest real path is someone else's work, published 2026-10-01 to 10-05.** `github.com/HiSilicon-Development/linux-6.12.y` is a Linux 6.12 tree. It has GPL-2.0 V4L2 drivers for this exact SoC: a **stateless (Request API) VDEC** for H.264, HEVC Main/Main10, VP8, VP9 profile 0, MPEG-2 and AVS/AVS+, a stateful path for MPEG-4 ASP and VC-1, a VPSS driver, a DRM VDP driver, an HDMI bridge and a 62 KB CRG clock driver [read via `gh`]. That cuts the hardware milestone from months to roughly **1-3 weeks of porting to 6.18 AArch32** [inferred]. Caveats: the tree is arm64-only (DTS under `arch/arm64`), it is not upstream, and nobody outside the project has verified it on hardware. Its copyright line claims HiSilicon, but the source of the code is not established [read / unknown].
3. **Cheapest milestone with real value (M1):** port `histb-vdec` + `histb-vpss` + the CRG clock entries, for **H.264 and HEVC only**. The output is NV12 (P010 for 10-bit) in a dma-buf that userspace reads. Then convert with swscale and blit to the existing framebuffer or DRM dumb buffer. That gives 1080p (and likely 4K) hardware decode with a CPU copy for display. Estimate **5-10 working days** [inferred].
4. **AV1: no hardware support.** There is no AV1 in the vendor vfmw codec enum, in its build config, or in the stock `media_codecs.xml` [read].
5. **Software only is "720p-class" for modern codecs.** With 4x A53 in 32-bit mode at ~1.5-1.6 GHz, expect real-time H.264 1080p30 at normal bitrates. HEVC 8-bit only manages 720p, plus some low-bitrate 1080p24. VP9 manages 720p and AV1 (dav1d) also manages 720p. 1080p HEVC-10/VP9/AV1 is not reliably real-time, and 4K is out of reach [inferred from fetched Pi 3 / low-end ARM data below]. Hardware decode is the only route to 1080p HEVC/VP9 or to 4K.

---

## 1. Codecs the VDEC hardware supports

| Codec | Vendor BSP (CV200 config) | Evidence |
|---|---|---|
| H.264 BP/MP/HP 8-bit, MBAFF, fields | yes | `VFMW_H264_SUPPORT = YES` in `vfmw_v5.0/.../Hi3798CV200/HD_FULL/vfmw_config.cfg` [read]; OMX `video/avc` up to 4096x2306 in stock `media_codecs.xml` [read] |
| HEVC Main / Main10 4:2:0 | yes | `VFMW_HEVC_SUPPORT = YES` [read]; OMX `video/hevc`, max 4096x2306, `measured-frame-rate-3840x2160 30-70` [read] |
| VP9 | profile 0 (8-bit) confirmed; 10-bit profile 2 only partially present | `VFMW_VP9_SUPPORT = YES` [read]; the HiVXE matrix says profile 2 is partial (🟨) in BSP and absent in their Linux driver [read via `gh`, HiSilicon-Development/HiVXE-2.0 README] |
| VP8, VP6, MPEG-1/2, MPEG-4 ASP, DivX3, VC-1, AVS/AVS+, RealVideo 8/9, MVC, JPEG | yes | all `= YES` in `vfmw_config.cfg` [read]; Android OMX exposes only avc/hevc/mpeg2/mpeg4/vp8/vp9 [read] |
| AVS2 | no on CV200 | enum `VFMW_AVS2` exists, but CV200 has no `avs2.S` and no make rule [read] |
| **AV1** | **no** | zero `AV1` hits anywhere in `drivers/msp` [read] |
| H.264 encode (VENC) | yes, H.264 only | OMX `encoder.avc` + `encoder.hevc` listed [read]. The HiVXE README says the production VENC config has no H.265 [read via `gh`]. That conflicts with the OMX list, so this is **[unknown]** |

The stock OMX limits for H.264 are a maximum of 4096x2306 and a measured 40-90 fps at 1080p [read]. For HEVC the measured rate is 30-70 fps at both 1080p and 2160p [read]. Whether the hardware reaches 4K60 is **[unknown]**. The marketing claim is unverified.

## 2. Is the vendor decoder open source? Size

Local tree: `~/src/hisilicon-kernel-4.4.35` (origin `leandrotsampa/hisilicon-kernel`) [read].

| Part | Form | Lines |
|---|---|---|
| `vfmw` total (`.c`/`.h`) | mixed | 237,715 [read] |
| VFMW **core** for CV200, 32-bit (`HD_FULL/32bit`): syntax parsers (h264/hevc/vp9/...), `vfmw_ctrl`, `vdm_drv`, `fsp`, VDH HAL (`vdm_hal_*`), SCD driver | **compiler-generated GCC assembly (`.S`, `.file "hevc.c"`, symbols kept, no `.loc` debug lines)** | **234,276 lines `.S`** vs **1,792 lines `.c`** [read] |
| same core for 64-bit (`HD_FULL/64bit`) | `.S` | parallel copy [read] |
| Glue: `firmware/distributor` (VDH scheduling, DSP code management), `firmware/osal`, `scene/*`, `product.c`, headers | real C | ~12k lines (2,854 + 3,589 + ~5.6k scene) + 42k of product headers [read] |
| `vdec` (MSP wrapper) | C | 42,895 [read] |
| `vpss` | C | 133,160 (CV200 HAL 11,194) [read] |
| `vo` (VDP display) | C | 414,860 (vdp_v4_0 244,270; CV200 HAL 84,251) [read] |
| `hdmi` (2.0) | C, plus `c8051_hdcp22_program.bin` (HDCP 2.2 8051 MCU only) | 173,715 [read] |
| `pq` | C plus `.S` for HDR/DEI/IFMD/DB/DM algorithms | 69k C (v4) + 34k `.S` [read] |
| `omxvdec` | C | 19,202 [read] |

Firmware and microcode:
- The VDH (pixel decode engine) is fixed-function and is programmed by message pools from the ARM. There is no `request_firmware` in vfmw/vdec/vpss/vo [read].
- The SCD (stream code detector) has a small DSP. Two 17,920-byte images are embedded as data in `scd_drv.S`: `g_avsp_firmware` (AVS+) and `g_h264_firmware` (low-delay H.264) [read]. Normal H.264/HEVC decode does not need them [inferred from `vdh_normal.c` `DSP_CODE_AVS`/`DSP_CODE_LOWDLY`]. The 6.12 driver loads only `hisilicon/histb-avsp.bin` (17,920 bytes, the same size) plus two CABAC table blobs, `histb-h264-cabac.bin` and `histb-hevc-cabac.bin` (928 bytes). Those tables are data, not code [read via `gh`].
- The blob's external dependencies are almost all inside the open glue. They are `vfmw_Osal_Func_Ptr_S` (a function-pointer table), `VDH_*` (distributor), `PDT_GetVdecCapability` (product.c), `memcpy/memset/qsort/__aeabi_*` [read, `comm` of `bl` targets against defined labels]. So the 32-bit `.S` could in principle be assembled into a 6.18 ARM module behind a shim [inferred]. That would be a vendor-ABI module and not a V4L2 driver. Only fall back to it if the 6.12 port fails.
- Register map (vendor `sysconfig.h`): VDM `0xf8c30000`, SCD `0xf8c3c000`, BPD `0xf8c3d000`, SCD reset `0xf8a22078`. IRQs are VDM 95+32, SCD 104+32, MMU 149+32 (non-secure) [read]. The VDH has an SMMU (`VDMHAL_V400R003_EnableSmmu`) [read].

The stock Android `system.img` has no vfmw/vdec `.ko`. `/lib/modules` holds only USB, WiFi and NTFS modules, so the media stack is built into the kernel. Userspace is `libhi_msp.so` (975 KB), `libOMX.hisi.video.decoder.so`, `libhi_common.so` [read]. No separate decoder firmware file exists in `/system` [read].

## 3. Existing mainline / community drivers

| Effort | Status | Evidence |
|---|---|---|
| **Mainline Linux** | No VDEC, VPSS, VDP, HDMI or GPU node in `hi3798cv200.dtsi`. It has CPU, GIC, UART, SPI, GPIO, CRG, MMC, GMAC, PCIe, USB2, I2C, IR, combphy, syscon-reset only | [read via `gh` torvalds/linux] |
| Linaro / 96boards Poplar | The board itself is upstream (DTS, TF-A, U-Boot). No media work went upstream | [read DTS]; that work stalled is [inferred] |
| LibreELEC | HiSilicon is not supported and no one is porting it | [fetched: https://forum.libreelec.tv/thread/9745-does-libreelec-or-jeos-support-the-hisilicon-chip/ appeared only in search results, so treat as **unverified**] |
| leandrotsampa e2d-hi3798cv200 (Debian + Kodi 19 "HW decode") | Runs on the **vendor 4.4.35 kernel + HiSilicon SDK userspace (HI_UNF/AVServer)**, not on mainline | README read via `gh` (claims 4K playback) [read]; AVServer README: "Clone this project to Sample folder in Hisilicon SDK" [read] |
| **HiSilicon-Development/linux-6.12.y** (+ FFmpeg fork, HiVXE-2.0 capability doc) | **Out-of-tree 6.12.111 with V4L2 VDEC (Request + stateful), VENC, JPGE, VPSS, DMX, DRM VDP, HDMI bridge, Panfrost GPU, AIAO, CRG.** Targets Gehua DVB-IP1001/2/4/6 boxes, AArch64 after an AArch32→AArch64 handover | file list, Kconfig, `histb-vdec-core.c` (14,597 lines, `SPDX GPL-2.0-only`), `histb-vdp.c` (1,339 lines), `histb-hdmi.c` (1,944 lines) [read via `gh`/`curl`]. Hardware results are self-reported. The README warns that a capability-matrix ✅ does not mean every sample was tested on hardware [read]. On-box validation: **[unknown]** |

Notes on the 6.12 port:
- All visible commits are timestamped two minutes apart on 2026-10-01, so it is a curated publication and not a development history [read]. Code review status: **[unknown]**.
- VDEC source formats: `H264_SLICE`, `HEVC_SLICE`, `MPEG2_SLICE`, `VP8_FRAME`, `VP9_FRAME`, `MPEG4`, `VC1_ANNEX_G/L` and a non-mainline `AVS_SLICE`. Capture formats are `NV12`/`P010` [read]. The H.264/HEVC/VP8/VP9/MPEG-2 controls are mainline stateless uAPI, so upstream userspace (GStreamer `v4l2codecs`, FFmpeg v4l2-request patches) should work against them [inferred].
- The DT binding is `hisilicon,hi3798cv200-vdec`. It has 3 IRQs (vdh, scd, mmu), 3 clocks (vdh, dsp, bpd) and 4 resets [read].
- `dma_set_mask_and_coherent(DMA_BIT_MASK(32))`, and there is no `readq`/`writeq` or `CONFIG_ARM64` conditional in `histb-vdec-core.c` [read]. So nothing obvious blocks an AArch32 build [inferred]. The CRG driver is 62 KB against mainline's much smaller one, so VDH/VPSS/VDP clocks will need porting into Tim's 6.18 CRG [inferred].

## 4. What else it takes to SHOW decoded frames

| Block | Vendor tree | 6.12 port | Mainline |
|---|---|---|---|
| VPSS (tile→linear, ZME scale, DEI) | open C, 133k lines [read] | `histb-vpss.c` 82 KB. The README says it does the VDEC tile-to-linear step, ZME downscale and field-rate DEI, but not full MCDI/TNR [read] | none [read] |
| VDP (display controller) | open C, 415k lines [read] | `histb-vdp.c`: **graphics primary plane only, XRGB8888/ARGB8888/RGB565** [read]. No NV12 video layer, so decoded video must be colour-converted (CPU swscale or GPU) and composited [inferred] | none [read] |
| HDMI TX | open C, 174k lines; the HDCP 2.2 8051 blob is not needed for plain output [read] | `histb-hdmi.c` DRM bridge: AVI/audio/SPD/vendor and **DRM (HDR static metadata) infoframes**, scrambling, 297/340/594 MHz paths (4K60 TMDS) [read by grep]. Whether the HDR infoframe is wired to `hdr_output_metadata` end to end: **[unknown]** | none [read] |
| GPU (could do the NV12→RGB step) | Mali-T720 | Panfrost on `gpu@9200000` [read] | Panfrost supports Midgard T720 [inferred]; no mainline DT node for this SoC [read] |
| HDR | VDP HDR + PQ `.S` algorithms [read] | VDP has HDR registers only, with no HDR video path [read] | — |

Full zero-copy HDR video (VDEC → VDP video layer → HDMI with HDR infoframe) does not exist anywhere outside the vendor 4.4 stack [inferred from the table]. HDR passthrough would need a video-layer plane added to `histb-vdp`, using the vendor `vo/vdp_v4_0/hal/98cv200` register code as the reference [inferred].

## 5. Milestones and effort (single engineer who already owns the 6.18 AArch32 bring-up)

All estimates are **[inferred]**. They assume the 6.12 port works as described.

| M | Deliverable | Effort | Main risks |
|---|---|---|---|
| M0 | CRG clocks/resets for VDH, SCD, BPD, VPSS in the 6.18 CRG driver; DT nodes (`0xf8c30000`, IRQs 127/136/181); CMA reservation | 1-3 days | clock IDs differ between the 6.12 port and Tim's CRG; the SMMU page-table setup is reached from the non-secure side |
| **M1 (cheapest real value)** | `histb-vdec` + `histb-vpss` built for ARM32 6.18, H.264 + HEVC only; firmware blobs extracted (CABAC tables; AVSP not needed); decode a clip with GStreamer `v4l2slh264dec`/`v4l2slh265dec` or the project's FFmpeg into NV12 dma-bufs; swscale to RGB and blit to fbdev/DRM dumb | 5-10 days | 6.12→6.18 V4L2/vb2 API drift; the TrustZone/TEE may own the VDH or its SMMU on this box's firmware (the stock chain has a 40 MiB TEE); CMA size for 4K reference frames on this box's RAM |
| M2 | Add VP9 p0, VP8, MPEG-2; 4K HEVC Main10 → P010 → VPSS downscale | 3-5 days after M1 | VP9 10-bit absent; the CPU colour conversion of 4K frames will be too slow (do the downscale in VPSS) |
| M3 | DRM VDP + HDMI bridge ported (replaces the current framebuffer path, gives real modesetting and 4K60 TMDS) | 1-2 weeks | HDMI PHY/clock tree on this board; EDID/DDC; it competes with existing display bring-up |
| M4 | Display without a CPU copy: Panfrost NV12 import → GL composite, *or* a new VDP video-layer plane (NV12) in `histb-vdp` | 1-2 weeks (Panfrost) / 3-6 weeks (new VDP plane) | Mesa Midgard on 32-bit; VDP video-layer registers are only documented by vendor C |
| M5 | HDR10 passthrough (HDR infoframe + BT.2020/PQ out of VDP) | 2-4 weeks after M4 | no reference outside the vendor stack; needs an HDR TV for verification |
| Fallback | Wrap the vendor 32-bit `.S` vfmw blob in a 6.18 module behind an OSAL shim (vendor API, not V4L2) | 3-6 weeks | the blob's struct layouts and SMMU assumptions; ugly to maintain; only if the 6.12 port fails |
| Not viable | Clean-room V4L2 driver from the `.S` alone | 3-6+ months | — |

## 6. Software decode on 4x A53, AArch32 NEON

Reference point: Raspberry Pi 3 = 4x Cortex-A53 at 1.2 GHz, 32-bit userland (as in LibreELEC 9.2 / OSMC) [inferred, general knowledge]. The Q10 Pro at ~1.5-1.6 GHz gives about **1.25-1.33x Pi 3 per clock** for the same core, before memory-bandwidth effects [inferred].

Fetched evidence:
- **HEVC, Pi 3:** "Raspberry Pi 3 devices running LE 9.2.x with mild overclocking can play lower-bitrate 1080p content ... if media has higher bitrates ... expect poor results. Raspberry Pi 2/1/0 can normally manage 720p". That needed ">50,000 lines" of Pi-specific FFmpeg patches [fetched: https://wiki.libreelec.tv/hardware/raspberry-pi]. That decoder offloads part of the work to the VideoCore QPU/VPU. On a Pi 3, HEVC "is a hybrid using the 4 arm cores with NEON, plus two cores of VPU and 3D QPU" [search snippet only, **unverified**]. **So the Pi 3 HEVC number overstates what pure ARM can do.**
- **HEVC 10-bit, Pi 3:** a user reports 720p 10-bit and 1080p 8-bit fine, and "1080p 10bit content stutters and is totally unwatchable" even at 1.2 Mb/s [fetched: https://forum.kodi.tv/showthread.php?tid=360404].
- **AV1 / dav1d:** "low-end CPUs like the Snapdragon 410 still struggle with 1080p decoding. 720p should be very doable" (dav1d 0.5 era). "On the Arm side 720p is possible on low-end devices" [fetched: https://medium.com/@ewoutterhoeven/av1-is-ready-for-prime-time-part-2-decoding-performance-d3428221313]. The Snapdragon 410 is 4x A53 at 1.2 GHz [inferred, general knowledge]. Whether that test was 32-bit or 64-bit is **[unknown]**.
- NEON gives ~2.5x over C in dav1d 0.3.1, and the in-order A53 gains more than OoO cores [fetched: https://medium.com/@ewoutterhoeven/how-arms-neon-enables-efficient-av1-decoding-on-mobile-5fcb3a4f6e7f].
- "24 fps on the 1080p 'Summer Nature' demo, on a 32-bit ARM CPU". The CPU is not named, and the thread context is the Raspberry Pi 4 (Cortex-A72), so **this does not apply to A53** [fetched: https://www.phoronix.com/forums/forum/software/programming-compilers/1130947-dav1d-vs-libgav1-performance-benchmarking-google-s-new-av1-video-decoder/page5].
- No fetched source gave clean pure-CPU H.264 or VP9 fps on A53. OpenBenchmarking's ARMv7 Cortex-A53 page returned only the CPU summary [fetched: https://openbenchmarking.org/s/ARMv7+Cortex-A53+4-Core, no decode numbers].

Prediction for Q10 Pro, 4 threads, ~1.5-1.6 GHz, ARMv7 NEON, upstream FFmpeg/dav1d (all **[inferred]** from the data above):

| Codec | 720p30 | 1080p24/30 | 1080p60 | 4K |
|---|---|---|---|---|
| H.264 8-bit (ffmpeg, NEON) | yes | **yes** at normal bitrates | marginal | no |
| HEVC 8-bit (upstream ffmpeg; no QPU help) | yes | low-bitrate 1080p24 only | no | no |
| HEVC 10-bit | marginal-yes | no | no | no |
| VP9 p0 (ffmpeg vp9, NEON) | yes | marginal | no | no |
| AV1 8-bit (dav1d, NEON) | **yes** (likely the only modern codec with headroom) | marginal-to-no | no | no |
| AV1 10-bit | marginal | no | no | no |

A cheap way to replace these inferences with measurements (once the box is reachable): run `dav1d --threads 4 --muxer null` and `ffmpeg -threads 4 -benchmark -i X -f null -` on the Netflix/Blender test clips at 720p and 1080p. Use AArch32 `armhf` builds and fix the CPU governor at max. Add the per-file results to this doc.

## Sources

Local [read]:
- `~/src/hisilicon-kernel-4.4.35/drivers/msp/drv/{vfmw,vdec,vpss,vo,hdmi,pq,omxvdec}`
- `~/src/hisilicon-kernel-4.4.35/drivers/msp/drv/vfmw/vfmw_v5.0/firmware/product/Hi3798CV200/{sysconfig.h,HD_FULL/vfmw_config.cfg,HD_FULL/vfmw_make.cfg,HD_FULL/32bit/**}`
- `$HIMEDIA_ROOT/emmc-dump/system.img` via `scripts/himedia/system-img-debugfs.sh` (`/etc/media_codecs.xml`, `/lib/*.so`, `/lib/modules`)

Read via `gh`/`curl` (source files, not prose):
- https://github.com/torvalds/linux/blob/master/arch/arm64/boot/dts/hisilicon/hi3798cv200.dtsi
- https://github.com/HiSilicon-Development/Hi3798Cv200 (README, DVBIP-100x-INTRODUCTION.md)
- https://github.com/HiSilicon-Development/HiVXE-2.0 (capability matrix)
- https://github.com/HiSilicon-Development/linux-6.12.y (`drivers/media/platform/hisilicon/*`, `drivers/gpu/drm/hisilicon/histb/*`, `drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c`, bindings)
- https://github.com/leandrotsampa/e2d-hi3798cv200 · https://github.com/leandrotsampa/AVServer

Fetched prose:
- https://wiki.libreelec.tv/hardware/raspberry-pi
- https://forum.kodi.tv/showthread.php?tid=360404
- https://medium.com/@ewoutterhoeven/av1-is-ready-for-prime-time-part-2-decoding-performance-d3428221313
- https://medium.com/@ewoutterhoeven/how-arms-neon-enables-efficient-av1-decoding-on-mobile-5fcb3a4f6e7f
- https://www.phoronix.com/forums/forum/software/programming-compilers/1130947-dav1d-vs-libgav1-performance-benchmarking-google-s-new-av1-video-decoder/page5
- https://code.videolan.org/videolan/dav1d/-/issues/259 (x86 profiling only, no ARM numbers)

Unverified (search snippets only): the LibreELEC "HiSilicon not supported" forum threads, and the popcornmix QPU-hybrid HEVC description.
