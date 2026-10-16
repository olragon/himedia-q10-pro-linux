# Q10 Pro: histb-vdec HEVC + MPEG-2 with FFmpeg v4l2request - 2026-10-12

Status: **verified on the box (cma=320M).** HEVC 8-bit, Main10 and **4K (150/150)** are bit-exact, MPEG-2
(progressive 1080p, 576i) is within 66-68 dB PSNR (IDCT rounding), H.264 and VP9 are still bit-exact.
Tags: **[read]** source, **[tested]** ran and read output, **[inferred]** reasoning only.
(First pass at 12:22 was blocked by Android holding all CMA; the lead re-ran after stopping it.)

## 1. Before (user's run, 2026-10-12, strict drm_prime + hwdownload) [tested, from the task brief]

| clip | frames | vs software | note |
| --- | ---: | --- | --- |
| h264 1080p60 | 2400/2400 | identical | 79 fps |
| vp9 1080p | 300/300 | identical | 75 fps |
| hevc 1080p 8-bit | 300 | all differ, flat image | |
| mpeg2 1080p | 300 | all differ, flat image | `MG2S request setup failed: -95` |
| mpeg2 576i | 250 | all differ, flat image | same -95 |
| hevc Main10 1080p | 0 | ffmpeg rc 234 | |
| hevc 2160p | 0 | ffmpeg rc 218 | 4 kernel warnings |

## 2. After (histb-vdec-k19-fixed.ko, run 13:00-13:08, strict drm_prime + hwdownload) [tested]

| clip | frames | vs reference | fps | note |
| --- | ---: | --- | ---: | --- |
| h264 1080p60 | 2400/2400 | md5 identical | 75.1 | regression check |
| vp9 1080p | 300/300 | md5 identical | 52.2 | see fps note below |
| hevc 1080p 8-bit | 300/300 | md5 identical | 51.1 | lead's run 72.2 |
| hevc Main10 1080p | 300/300 | md5 identical **as p010le** (`FMT=p010le`, reference `ref/*.p010le.md5`) | 31.1 | P010 capture, hwdownload gives p010le |
| mpeg2 1080p | 300/300 | not bit-exact; PSNR y 72.3 / u 69.5 / v 69.6, **min frame 68.4 dB**, was ~25.7 | 41.0 | |
| mpeg2 576i | 250/250 | not bit-exact; PSNR y 69.5, **min frame 66.1 dB** | 68.4 | frame pictures, interlaced DCT |
| hevc 2160p | 150/150 | md5 identical (fix6, cma=320M) | 15.2 | was rc 218; see section 3 "4K" |

PSNR was measured on the box with ffmpeg's `psnr` filter (hw vs sw, same file). The MPEG-2 md5 differences are
sub-LSB decoder arithmetic (no frame is below 66 dB), not a layout error; the spec allows IDCT differences.

## 3. Root causes

### MPEG-2: `-EOPNOTSUPP` [tested: requests accepted, output within 66-68 dB]
`histb_vdec_validate_mpeg2()` demanded `profile_and_level_indication` to decode to Simple/Main/High.
FFmpeg's `v4l2_request_mpeg2.c:53` always sends `.profile_and_level_indication = 0`, so profile 0 failed
with -95 on every request. Fix: 0 means "not provided" and skips the profile check (a real indication is
still checked). The hardware is programmed from the picture header, not the profile.
The "all frames differ, flat image" is then the consequence: no request ever reached the hardware.
Still **[unknown]** after this: whether the MPEG-2 slice buffer FFmpeg builds satisfies
`histb_vdec_parse_mpeg2_slices()` (it needs a slice start code at offset 0 and nothing but slices after).

### HEVC: `bit_size` / `data_byte_offset` mean different things to GStreamer and FFmpeg [tested: 300/300 md5-identical after the fix]
The driver (written against GStreamer) treats `bit_size` as the whole slice NAL and `data_byte_offset`
as the offset inside that NAL: `sum(ceil(bit_size/8)) == payload` is required
(`histb_vdec_validate_hevc_frame`, `histb_vdec_copy_hevc_bitstream`).
FFmpeg (Kwiboo, `v4l2_request_hevc.c:fill_slice_params`) sends `bit_size = (size - data_offset)*8`
and `data_byte_offset = bytesused + data_offset`, i.e. slice data only and absolute in the buffer.
Every FFmpeg frame therefore fails the "NALs add up to payload" check. Fix: new
`histb_vdec_hevc_normalize_slices()` converts a copy of the slice array: FFmpeg's `data_byte_offset +
ceil(bit_size/8)` is exactly the NAL end for every slice, so boundaries need no stream scan. A frame whose
sizes already add up (GStreamer) is passed through unchanged.
**What I did not establish:** the dmesg of the failed HEVC run. If it shows no `HEVC validation failed`
line, this is not the (only) cause and the next suspect is `histb-hevc-cabac.bin`.

### MPEG-2 1080p at 25.7 dB: VPSS resampled 1088 -> 1080 instead of cropping [tested]
Row-by-row comparison (`frame-diff.py`): no shift (best dy=0), errors only in detailed regions, and the crop
of the noise squares shows hardware output **vertically smeared**. dmesg showed `VPSS capture scaling
negotiated: 1920x1088 -> 1920x1080`: FFmpeg's MPEG-2 sets the OUTPUT format to the coded 1088 rows and the
CAPTURE format to the visible 1080, and `histb_vdec_copy_capture()` passed 1088 as VPSS input height, so VPSS
scaled the whole picture by 1080/1088, low-passing every row. The surface layout is the same for both heights
(it derives from the aligned height), so the fix tells VPSS the input is the visible size when width and height
align to the same macroblock/surface multiple: a crop, not a resample. 576 was unaffected (already 16-aligned).
Same 31.5 dB on every encoder variant (`mpeg2-variants.sh`: qscale 2/10, 3M, intra_vlc, alt scan, non-linear
quant, dc precision) confirmed it is independent of the bitstream.

### 4K HEVC: `dma_alloc_pages()` never returns highmem CMA, then the vmalloc window ran out [tested]
1. With `cma=320M` the whole CMA area (pfn 0x67900..) sits above lowmem. `dma_direct_alloc_pages()` calls
   `__dma_direct_alloc_pages(..., allow_highmem = false)`, so the CMA block was allocated (`cma_alloc_finish
   errorno=0` in the trace) and **immediately released**, and the request fell back to the buddy allocator, whose
   largest block is order 10 = 4 MB. Every 1080p surface (3 MB) "worked" that way and a 4K buffer (12.4 MB)
   could never succeed, with 310 MB of CMA free. `histb-dma.h` now uses `dma_alloc_attrs(...,
   DMA_ATTR_NO_KERNEL_MAPPING)`, which goes through `dma_direct_alloc_no_mapping()` (highmem allowed, page cookie),
   zeroes with `clear_highpage()` and cleans the cache; `histb_dma_alloc_noncoherent()` is built on it.
   (The old header comment claimed `dma_alloc_pages()` fails only for `page_address()`; it was wrong for 6.18.)
2. After that, `vmalloc_node_range ... failed` (the 32-bit window is 240 MB): every highmem block was vmap()ed, and 4K
   needs ~9-16 capture buffers + ~10 tile surfaces. Capture buffers are no longer mapped at allocation: the vb2
   `vaddr` op maps on first use, and `histb_vdec_copy_capture()` asks for a CPU mapping only for P010, VC-1 and
   the CPU fallback. The direct NV12 path is DMA only.
3. `HISTB_VDEC_MAX_LARGE_CAPTURE_BUFFERS` 11 -> 16 (written for a 192 MiB CMA). With 11, FFmpeg's pool growth hit
   `ENOBUFS` at frame 125-133 and the next frame lost its reference (`HEVC APC sync failed -22`).
No VPSS/VDH limit needed changing: 3840x2160 decodes with the existing line-buffer/stride settings, 150 frames
identical, `hw=11 ms post=13 ms` per frame. **histb-vpss.ko must be replaced with the vdec** (same header,
its staging buffer used the old allocator): `histb-vpss-k19-fixed.ko`.

## 4. HEVC CABAC table cross-check [tested, offline]
`scripts/himedia/video/verify-hevc-cabac-table.py` compares the vendor `s_InitValue` (what the blob is built
from) with FFmpeg's `init_values[3]`: per init type, the vendor 154 non-skip values are a **sub-multiset
of FFmpeg's list (154 of 154 for P and B, 134 of 134 for I)**, and from entry 16 the order starts the
same way (`153, 185, 107, 139, 126, 154, 197, 185` for P). So the table content is the spec's; what the
check cannot prove is the layout the VDH expects.

## 5. What still fails / notes
- MPEG-2 is not md5-identical to software (66-68 dB); field-picture (non-frame) streams and 4:2:2 untested.
- 4K was tested with the one HEVC 8-bit clip only (no 4K H.264/VP9/Main10 clip exists); capture buffers are capped at 16, so
  a client that wants more fails with ENOBUFS. 16 x 12.4 MB + tile surfaces is close to 320M; `cma=320M` is a floor for 4K.
- **fps gap (VP9/HEVC 51-52 vs 72):** measured, not thermal. `vp9-1080p-30` runs 72-74 fps with a warm page cache,
  **52.8 right after `echo 3 > drop_caches`**, 65.6 right after `compact_memory`. My runs always dropped caches first
  (so the clip, ffmpeg and libs were read cold inside the timed window). `q10-wd-run` itself costs nothing (66 vs 72
  within noise). For throughput numbers run twice and keep the second.

## 5b. Multi-planar node + H.264 FRAME_BASED for Chromium (k19, box-tested)

Debian armhf Chromium 150 is built with `use_v4l2_codec=true`; its V4L2 decoder scans `/dev/video0..255` and takes a node whose
`OUTPUT_MPLANE` lists a video fourcc and whose `CAPTURE_MPLANE` lists a pixel format, then matches `/dev/media%d` by `bus_info`
(sources: `~/src/chromium-v4l2-150/`). Our node had only `VIDEO_M2M`, so it was skipped silently.

**Design: a second video node, not both capabilities on one.** A vb2 queue has one buffer type for life, and FFmpeg/GStreamer pick the
`*_MPLANE` types as soon as `V4L2_CAP_VIDEO_M2M_MPLANE` is advertised, which would have moved the bit-exact users onto a new path.
`/dev/video0` is unchanged; `/dev/video1` (`histb-vdec-mplane`, caps `VIDEO_M2M_MPLANE|STREAMING`) shares the m2m device, hardware,
controls and media device (`bus_info platform:histb-vdec`). `ctx->mplane` (from the node opened) selects the queue types; the
`g/try/s_fmt_*_mplane` ioctls convert one-to-one (every format is one plane). The media graph gets a second V4L interface
(`histb_vdec_register_mplane_intf`) linked to the same source/sink entities, so `v4l2-ctl -d /dev/video1 -D` finds its topology entry.
Chromium's `ApplyResolution` calls `S_FMT(OUTPUT)` with 17 buffers allocated but not streaming (it only frees CAPTURE), which returned
EBUSY: S_FMT on OUTPUT is now allowed while not streaming if the codec is unchanged and `sizeimage` still fits the buffers.

**H.264 differs from FFmpeg** (`v4l2_video_decoder_delegate_h264.cc`): Chromium sets `DECODE_MODE = FRAME_BASED` in every request, sends
the whole access unit with 3-byte start codes and NO `SLICE_PARAMS`, `PRED_WEIGHTS`, reference lists or P/B frame flags. The VDH needs
all of those per slice, so FRAME_BASED does what a hardware parser would: split on `00 00 01`, parse each slice header (7.3.3 incl.
pred weight table, ref list modification, MMCO skipped), build the lists (`v4l2-h264` initial order, then 8.2.4.3), set the P/B flag from
the slice types, and run the existing per-slice staging in a loop (`histb_vdec_h264_stage_slice`) before one hardware start.
Default stays SLICE_BASED. `Kconfig` gains `select V4L2_H264` (`v4l2-h264.ko` must be installed with the vdec).
Verified two ways [tested]:
- `h264_selfcheck=1` (parser + list builder run beside the SLICE_BASED path and compared with FFmpeg's SLICE_PARAMS): **3500 slices, 0
  mismatches**, then 2400/0 at close, on a clip with B-frames and multiple references.
- `h264_frame_default=1` (advertises FRAME_BASED + ANNEX_B as defaults so FFmpeg drives the frame-based path): **2400/2400 md5-identical**,
  76 fps. `video0` matrix unchanged: h264 2400/2400, vp9 300/300, hevc 300/300 identical (77/65/69 fps).

**Chromium on the box** (`q10-chromium-hwdec-test`, features `AcceleratedVideoDecoder,AcceleratedVideoDecodeLinuxGL,
AcceleratedVideoDecodeLinuxZeroCopyGL`; the `AcceleratedVideoDecoder` flag is required, the old default list omitted it):
`InitializeBackend(): Using a stateless API for profile: h264 high and fourcc: S264`, a **gpu-process holds `/dev/video1` + `/dev/media0`**,
requests queue and frames dequeue (strace: `VIDIOC_QBUF/DQBUF *_MPLANE`, `MEDIA_REQUEST_IOC_QUEUE`). VP9 engages the same way. HEVC does
not: Debian's Chromium has no HEVC decode (the clip does not play at all, 0.4% CPU).
But **the picture is blank**, and the box CPU gain is small (box total over 20 s, 4 cores):

| clip | HW (V4L2) | software | note |
| --- | ---: | ---: | --- |
| h264 1080p60 mp4 | 51.0% | 69.5% | frames decoded, converted, NOT visible |
| vp9 1080p30 webm | 40.4% | 38.3% | same |
| hevc 1080p mp4 | - | - | not supported by this Chromium build |

Why (three layers, all Chromium/GL, found in this order):
1. `PickDecoderOutputFormat` finds no directly renderable fourcc (`supports_nv12_gl_native_pixmap` false) and inserts a LibYUV image
   processor NV12 -> AR24. That conversion is the CPU: the gpu process runs at ~230% (a ThreadPool thread at 97% plus the main thread),
   so zero-copy NV12 is the only way to a large saving.
2. Its AR24 pool frames come from gbm and Mesa's `gbm_bo_get_fd` exports them read-only; Chromium then `mmap(PROT_READ|PROT_WRITE)`
   -> EACCES -> "Failed to map output FrameResource", "ImageProcessor error", software fallback. Reproduced without Chromium
   (`gbm-mmap-test`, `dmabuf-mmap-test`: RW mmap needs `DRM_RDWR` at `PRIME_HANDLE_TO_FD`). Worked around with an `LD_PRELOAD`
   shim (`drm-rdwr-preload.c`, installed at `/usr/local/lib/q10/`, used by the test script; NOT enabled in `/etc/chromium.d`).
3. With 1+2 solved the frames still do not show: compositing them needs `NativePixmapEGLBinding`, but the GL display ANGLE gives Chromium
   (`--use-angle=gles` works; the default ANGLE-GL display cannot be created on GLES-only panfrost: "Could not create a backing OpenGL
   context") does **not** expose `EGL_EXT_image_dma_buf_import` (`angle-egl-probe.c` lists its extensions; Mesa's own EGL has it on every
   platform), so Chromium falls back to the X11-pixmap binding, which tries to create the failing ANGLE-GL display again:
   `OzoneImageBacking::ProduceSkiaGanesh failed to create GL representation`. Without GPU compositing the video is visible but the
   hardware decoder is not used. This is a Chromium/ANGLE-on-X11 limitation, not the V4L2 driver.
**Do not enable hardware video decode in Chromium by default on this box**: it would trade a working software picture for a blank one.
Next options (not done): an ANGLE/Chromium build whose GLES display exposes dma_buf import, Chromium on Wayland under cage, or a
different player (mpv/Kodi already use this decoder).

### 5c. Chromium as a native Wayland client under cage: WORKS (box, k19)
`q10-chromium-wayland-test` (cage on the VDP, `--ozone-platform=wayland`, `LD_PRELOAD` RDWR shim) shows the hardware-decoded picture: Wayland imports
NV12 dma-bufs through linux-dmabuf, so there is no ImageProcessor, no libyuv and no ANGLE pixmap fallback. First run stalled after one frame.
Cause (trace events `v4l2:*`): after 6 decoded frames (timestamps 0..5000) Chromium never re-queued a CAPTURE buffer. Without an image processor
Chromium asks for `num_reference_frames + 2 = 6` buffers (one being decoded, one for the IP) and hands the same buffers to the compositor, which holds
several for display; all six were held and decoding stopped (VDH IRQ count flat). The driver may answer a REQBUFS with more buffers and Chromium uses
every buffer it gets, so for the multi-planar node `queue_setup` raises the CAPTURE count to `max(n + 6, 12)` (4K: n + 2). Single-planar users
(FFmpeg, GStreamer on `video0`) are untouched; FFmpeg grows its pool with CREATE_BUFS (count 1), which is not bumped.
Result [tested, 1080p, 20-25 s, box total over 4 cores]: H.264 60 fps steady (VDH IRQ +360 per 6 s; TV grabs 4.8 s of timecode apart show
00:00:16.300 -> 00:00:21.117, frame counter 978 -> 1267): **26.3% CPU vs 82.4% with software decode**. VP9 30 fps: **15.1% vs 49.1%**
(826 VDH IRQs in the window). Both hold `/dev/video1` in the gpu-process. Cost of the setup: the desktop is stopped for the run
(`pkill -x cage; systemctl start q10-desktop`), Chromium is a Wayland client of cage, not of the X11 desktop.

## 5d. Hardware deinterlace with the VPSS DEI block (item 4) - WORKS on the box (k19)

What exists: `histb_vpss_dei()` (ported from the community driver, 4-field motion-adaptive DI with the vendor PQ tuning image) and a private
ioctl `VIDIOC_HISTB_VPSS_DEI` that needs userspace to hand it four dequeued woven capture buffers in display order. It had never run:
no client, and `docs/261011-himedia-vdec-port-report.md` lists it as "kept, no userspace". It cannot serve a normal decode (clients dequeue
in decode order, B-frames are reordered later), so it is now wired into the decode path.

**Control** `Deinterlace` (private menu, `V4L2_CID_USER_BASE + 0x1d00`; module parameter `deinterlace` sets its default for new streams):
`0 Off` (default: woven frames, bit-exact as before) / `1 Motion adaptive (VPSS, frame rate)`. Active only for interlaced H.264
(`!frame_mbs_only`) and MPEG-2 (not progressive_sequence/progressive_frame, or field pictures), NV12 capture, width <= 1920, height <= 1088;
anything else silently stays woven.

**How** (`histb_vdec_deinterlace`): the VPSS detiles into one of two private woven buffers (ping-pong), then DEI reads the current woven frame plus the
previous one and writes the client's buffer. Window for a top-field-first frame n: LAST = bottom(n-1), CUR = top(n), NEXT1 = bottom(n), NEXT2 = top(n)
(repeat of CUR: the next frame is not decoded yet); bottom-field-first mirrors it. That is a 3-field motion-adaptive deinterlace, one progressive frame
per interlaced frame, no future frame, no change to buffer counts or ordering. "Previous" is the previous *decoded* frame; with B-frames the motion test then
sees motion where there is none and falls back to spatial interpolation (softer, never combed). Field rate (two frames per frame) is not offered: it would
need two capture buffers per picture.

**Test kit** (Mac): `video/make-interlaced-clips.sh` (mpeg2-1080i-25, h264-1080i-25 MBAFF, TFF, 50 fps source so motion combs), `video/deint-box-run.sh <clip> W H`
(hw decode on the box -> raw NV12 -> `video/deint-metrics.sh`: ffmpeg `idet` on the hw output and on the woven software decode, PSNR vs software `yadif`/`bwdif`
at frame rate). Run once with `deinterlace=0` (baseline) and once with `deinterlace=1`. Modules: `histb-{vdec,vpss}-k19-deint.ko` (vermagic 6.18.55-k19).
**Measured** (box, 100 frames per clip, `ffmpeg-v4l2req` hw decode + copy-back; `deinterlace=0` vs `=1`):

| clip | idet hw output off -> on | PSNR Y vs yadif off -> on | vs bwdif on | fps off -> on | box CPU off -> on |
| --- | --- | --- | ---: | ---: | ---: |
| mpeg2 1080i25 | TFF 100/100 (combed) -> **Progressive 96, TFF 4** | 31.7 -> **46.5 dB** | 45.9 | 30.4 -> 25.7 | 30% -> 26% |
| h264 1080i25 MBAFF | TFF 100 -> **Progressive 96, TFF 4** | 31.7 -> **46.7 dB** | 46.1 | 37.7 -> 32.3 | 35% -> 31% |
| mpeg2 576i25 | TFF 100 -> **Progressive 96, TFF 4** | (31.4 off) -> **45.3 dB** | 43.0 | - -> 76.6 | - -> 28% |

The DEI block completes on every frame (no hang, no dmesg error). The 4 combed frames are the first ones (no previous frame yet). The 1080i
decode with deinterlace runs at 25.7-32 fps, i.e. real time for 25i but little headroom for 1080i50/60. Progressive streams are unaffected: with
`deinterlace=1` loaded, h264 1080p60 600/600, vp9 300/300, hevc 300/300 are md5-identical (75/72/71 fps). Not tested: H.264 PAFF (x264 only makes
MBAFF), B-frame interlaced streams (the previous-decoded-frame window is then only approximately right), 1080i50/60 throughput.
The installed k19 modules do not carry this yet (they are the 5c build); the deinterlace build is `histb-{vdec,vpss}-k19-deint.ko`.

## 6. Files
- Driver tree: `$HIMEDIA_ROOT/kernel-build-arm32/linux-6.18.55/drivers/media/platform/hisilicon/histb-vdec-core.c`
- Patch: **folded into 0008** (`scripts/himedia/kernel/arm32/0008-...patch`, via `vdec-regen-core-patch.py`;
  the tree file and the patch had been identical before, so the diff is exactly this change).
- Modules (install **both**): `$HIMEDIA_ROOT/vdec-port/histb-vdec-k19-fixed.ko` + `histb-vpss-k19-fixed.ko`, vermagic `6.18.55-k19 SMP mod_unload ARMv7 p2v8` [tested].
- Scripts: `scripts/himedia/vdec-build-module.sh` (module-only build), `scripts/himedia/vdec-box-test.sh`
  (swap module under `q10-wd-run`, run per clip, dmesg to `archive/`), `scripts/himedia/video/hw-vs-cached-sw.sh`
  (on-box: hw decode vs reference md5, first differing frame), `make-reference-md5.sh`, `verify-hevc-cabac-table.py`.
- Trap: the box's `q10-codec-matrix` calls ffmpeg without `-y`/`-nostdin`; when the md5 files exist and
  stdin is a pipe (ssh) it waits at "Overwrite? [y/N]" forever. Use `hw-vs-cached-sw.sh`.

## 7. Reproduce
```
# on the Mac; compacts memory first (fragmentation makes dma_alloc_pages fail even with CMA free)
scripts/himedia/vdec-box-test.sh $HIMEDIA_ROOT/vdec-port/histb-vdec-k19-fixed.ko h264-1080p-60 vp9-1080p-30 mpeg2-1080p-30 mpeg2-576i-25 hevc-1080p-30
FMT=p010le scripts/himedia/vdec-box-test.sh - hevc10-1080p-30
```
`video/codec-matrix-test.sh` now passes `-y -nostdin` too. Extra tools: `video/frame-diff.py` (per-frame PSNR and best shift),
`video/mpeg2-variants.sh` + `mpeg2-variants-box.sh`.
