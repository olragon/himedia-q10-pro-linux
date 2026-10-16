# HiMedia Q10 Pro: hardware video decode inside Android 13 (Waydroid)

Date 2026-10-12. Research + offline prototype. **Nothing here was run on the box** (task forbade ssh) and
nothing is committed. Tags: **[read]** = I opened the file/URL, **[built]** = compiled here and the
artifact inspected, **[inferred]** = reasoning from what I read, **[unverified]** = a claim from memory or a
search snippet that I did not confirm.

## Decision

**Feasible. Take the copy path first (V4L2 stateless -> FFmpeg v4l2request -> `ffmpeg_codec2` HIDL service ->
CPU copy into a gralloc block). Estimate 4-7 working days to the first hardware-decoded 1080p H.264 clip in an
Android app; zero-copy is a separate 5-10 day project and should not be promised.**

Why this and not another route:

1. **There is no ready-made stateless Codec2.** Google's `external/v4l2_codec2` is stateful-only [read:
   `git grep` for `MEDIA_IOC_REQUEST|request_fd|V4L2_CID_STATELESS` over `origin/main` of
   android.googlesource.com/platform/external/v4l2_codec2, head `af9fcc0` 2025-01-20, returned **nothing**; its
   README-class forks (Rockchip, lineage-rpi) list "V4L2 stateful decoding API" as a prerequisite].
   Our driver is stateless, so v4l2_codec2 cannot drive it without writing a request-API backend (weeks).
2. **The only mature stateless-capable path is FFmpeg inside a Codec2 service.** `android_external_ffmpeg_codec2`
   (Goffioul, then KonstaKANG/raspberry-vanilla, now LineageOS) wraps libavcodec as `c2.ffmpeg.*` components and
   already contains a generic hwaccel bring-up (`ffmpeg_hwaccel_init` walks `avcodec_get_hw_config()` and calls
   `av_hwdevice_ctx_create`) [read]. Our FFmpeg already decodes H.264 1080p at 96 fps with the v4l2request
   hwaccel, so the library half is proven on Linux.
3. **Waydroid itself has no arm hardware-codec plan.** Its device config wires the old Stagefright **OMX** FFmpeg
   plugin (`libffmpeg_omx`, `media.sf.omx-plugin`, VAAPI `media.sf.hwaccel=1`) for **x86 products only**
   [read: waydroid/android_device_waydroid_waydroid `lineage-20` device.mk lines 165-173]. Its FFmpeg fork
   (`waydroid/android_external_ffmpeg`, `dev/lineage-23.2`, FFmpeg 7.1.3) gained "enable V4L2 support" in
   Feb 2026, but that is **`CONFIG_*_V4L2M2M_*` = stateful m2m only**; no `v4l2request` [read: commit 582e6cf
   diff]. So Waydroid upstream will not give us stateless decode; we bring our own.

## 1. Candidates (arm32, Android 13)

| Candidate | State | Stateless? | Verdict |
| --- | --- | --- | --- |
| `raspberry-vanilla/android_external_ffmpeg_codec2` branch **`android-13.0`** (last commit 2023-04-27) | HIDL `android.hardware.media.c2@1.2`, `Android.mk`, `service.cpp`, arm seccomp policy, `media_codecs_ffmpeg_c2.xml` [read] | Only by luck: hwaccel loop runs for **HEVC only, behind `persist.ffmpeg_codec2.v4l2.h265`** [read ffmpeg_hwaccel.c]; output always CPU-copied to YV12 | **Base to start from** (right Android version, right HAL flavour) |
| `LineageOS/android_external_ffmpeg_codec2` branch `lineage-24.0` (Aaron Kling commits **2026-09-17..23**) | AIDL c2 HAL + APEX (Android 16 shape) [read] | Generic hwaccel loop for every codec | **Source of three commits to backport**, not a base |
| GloDroid `aospext` `meson_ffmpegcodec2.mk` + `glodroid_configuration/common/codecs` | Same HIDL 1.2 service name, built by **meson inside an AOSP tree** [read]; its `ffmpeg.mk` has `--enable-v4l2-request --enable-libdrm --enable-libudev` behind `BOARD_FFMPEG_ENABLE_REQUEST_API` [read] | Yes (Kwiboo/jernejsk-style request API) | **Proof that "FFmpeg v4l2request in a c2 service" is a real shipped config**, and the closest recipe. Issue #152 closed 2023-11-30 with PinePhone support [read] |
| Google `external/v4l2_codec2` and forks (Rockchip android12, lineage-rpi) | production-grade | **No** (stateful) [read] | Rejected |
| Waydroid `android_external_stagefright-plugins` | branches 17.1/18.1 only, last push 2024-01 [read] | No | Rejected (OMX, Android 11) |
| `goffioul/external-stagefright-plugins` | CM 10.1 era, "no codec2" [read] | No | Rejected |
| KonstaKANG RPi builds | use the raspberry-vanilla repo above (RPi4: stateful H.264 via v4l2_codec2, HEVC stateless via FFmpeg) [read device.mk] | HEVC only | Same lineage as the base |

The three Lineage commits worth backporting (HIDL/NV12 adaptation needed) [read, `git show`]:

- `aa0e929` "Dynamically prefer hardware backed codecs": tries HW decoders, **falls back to the software decoder
  and resubmits the same packet** when HW open/first-send fails. This is the safety net we need, because the
  vdec driver may refuse a second concurrent context [unverified].
- `00f6f65` "Use native output formats for hw decode": allocates `HAL_PIXEL_FORMAT_YCBCR_420_888` with
  `BufferUsage::VIDEO_DECODER`, outputs **NV12 (no YV12 conversion)**, P010 for 10-bit.
- `2b13410` default service name (not needed on 13).

⚠️ One gap in those commits: they pick NV12 only when `codec->capabilities & AV_CODEC_CAP_HARDWARE`. The
v4l2request path is a **hwaccel on the native `h264` decoder**, which has no `CAP_HARDWARE`, so it would still be
forced through YUV420P/YV12. The condition must become "`frame->hw_frames_ctx != NULL`" [inferred from
reading `ffmpeg_hwaccel_get_frame`].

## 2. Building without an AOSP tree: what is and is not possible

**Done [built] - the FFmpeg half, out of tree, for bionic armv7a with the NDK:**

`scripts/himedia/android/codec2/build-ffmpeg-bionic.sh` (NDK r27c, API 33, the pinned Kwiboo n7.1.5 tree our
Linux build already uses) produced `libavcodec.so` 3.38 MB, `libavutil.so` 0.64 MB, `libswscale.so`,
`libswresample.so` under `$HIMEDIA_ROOT/android-hwvideo/stage-bionic/vendor/lib`.
Verified from the artifacts: ELF 32-bit ARM EABI5; `NEEDED` = only `libavutil/libm/libc` (no libdrm, no libudev);
`strings` shows `h264_v4l2request hevc_v4l2request vp9_v4l2request vp8_v4l2request mpeg2_v4l2request`,
`/dev/media%d` and "Using V4L2 media driver". `CONFIG_V4L2_REQUEST 1`, `CONFIG_{H264,HEVC,VP9}_V4L2REQUEST_HWACCEL 1`.
SHA-256 prefixes: avcodec `ea0694b1`, avutil `c17ddc9c`, swresample `436e3fbf`, swscale `6148422d`.

It needed **one patch** (`patches/0001-v4l2request-udev-free-android.patch`, 232 lines), and every item was a
real failure on the way:

1. Kwiboo's `hwcontext_v4l2request.c` finds the decoder with **libudev** (enumerate subsystem `media`, then
   `udev_device_new_from_devnum`). Android has no libudev (GloDroid links one; we have none). Replaced by: try
   `/dev/media0..31` (or `$V4L2REQUEST_MEDIA_DEVICE`), read the media topology with ioctls, resolve each
   `V4L_VIDEO` interface devnum to `/dev/video*` by `stat().st_rdev`. Uses only ioctls the code already issued.
2. `configure` required `libdrm` + `libudev`; the code only needs `drm_fourcc.h` (header-only fourcc table), so
   the dependency was dropped and `drm_fourcc.h/drm.h/drm_mode.h` from linux v6.12 uapi are vendored at build time.
3. `configure` probed `v4l2_timeval_to_ns` as a **linkable function**; Android's sanitized uapi
   `videodev2.h` strips inline helpers. Replaced by a local static inline in `v4l2_request.c`; also the probe
   `check_func_headers` was the thing that silently set `linux_media_h`, so an explicit `check_headers linux/media.h`
   had to replace it.

**Not done - the Codec2 service itself.** It cannot be compiled out of tree today, and I could not find a shortcut:

- It links `libcodec2_vndk`, `libcodec2_hidl@1.2`, `libstagefright_foundation`, `libhidlbase`, `libbinder`,
  `libcodec2_soft_common`, `libavservices_minijail` [read: rv13 `Android.mk`; GloDroid `meson_ffmpegcodec2.mk` lists
  the same set]. The plain C++ headers (C2*.h, stagefright foundation, utils) are fetchable. The blocker is the
  **HIDL-generated headers** (`android/hardware/media/c2/1.x/*.h`, bufferpool, graphics common) which only
  `hidl-gen` inside a Soong tree produces. I know of no standalone `hidl-gen` [unverified: did not search
  exhaustively].
- Link-time libs must be **the exact ones in the target image**. The vendor image has `libavservices_minijail.so`,
  `libhwminijail.so`, `libmediautils_vendor.so`, `libstagefright_soft*` [read from vendor.img], but `libcodec2_vndk`
  and `libcodec2_hidl@1.2` live in the **system** image / VNDK, which I could not inspect: the 689 MB
  `system.zip` from SourceForge ran at 10-27 KB/s on every mirror I tried (netcologne, altushost, versaweb,
  phoenixnap) while the 73 MB vendor zip had come down at once, so I aborted. **System-image contents: [unverified].**
- The supported route is a **LineageOS 20 + Waydroid device tree build** (`m android.hardware.media.c2@1.2-service-ffmpeg`
  with `lineage_waydroid_arm`), because Waydroid builds its images exactly that way
  (`waydroid/android_device_waydroid_waydroid`, branch `lineage-20`) and the resulting libs then match the shipped
  ABI. It needs an x86_64 Linux host (Soong prebuilts); on this arm64 Mac that means an OrbStack/Rosetta container
  [inferred]. Rough cost [inferred]: ~40-60 GB shallow sync (178 GB free on DATA), hours of build under emulation.
  I did not start it: a half-synced tree is not a result, and the sync belongs in a long-running window once Tim
  approves the disk spend.

The service sources checked out for the work: `~/src/ffmpeg_codec2-rv13` (android-13.0),
`~/src/ffmpeg_codec2-lineage` (lineage-24.0), `aospext`, `glodroid_configuration`,
`waydroid`, `wd-device`, `minigbm-waydroid`, `ffmpeg-waydroid`, `v4l2_codec2-aosp` (all shallow, DATA volume).

## 3. What must be added to the overlay and to LXC passthrough

Waydroid mounts `/var/lib/waydroid/overlay/vendor` as an **overlayfs lower dir over `vendor.img`** [read:
`tools/helpers/images.py` lines 166-185], so added files appear in `/vendor`. The existing project overlay
(`scripts/himedia/android/overlay/vendor/etc/init/q10-mesa.rc`) already uses this successfully.

Draft files (all **never run**) in `scripts/himedia/android/codec2/overlay/vendor/`:

| Path in `/vendor` | Content | Basis |
| --- | --- | --- |
| `bin/hw/android.hardware.media.c2@1.2-service-ffmpeg` | the service (not built yet) | rv13 `Android.mk` |
| `lib/libavcodec.so libavutil.so libswscale.so libswresample.so` | the NDK build above | [built] |
| `etc/init/android.hardware.media.c2@1.2-service-ffmpeg.rc` | `class hal`, `user media`, `group mediadrm drmrpc` | rv13 `.rc` |
| `etc/vintf/manifest/android.hardware.media.c2@1.2-service-ffmpeg.xml` | HIDL `@1.2::IComponentStore/ffmpeg` | rv13 `.xml`; vendor image already uses `etc/vintf/manifest/` fragments [read] |
| `etc/seccomp_policy/android.hardware.media.c2@1.2-ffmpeg.policy` | rv13's arm policy + `sched_getaffinity sysinfo eventfd2 kcmp pselect6` | rv13 policy; the added syscalls are a guess from reading, expect to iterate on SIGSYS |
| `etc/media_codecs_ffmpeg.xml` | `c2.ffmpeg.{h264,hevc,vp9,vp8,mpeg2}.decoder` | see below |

⭐ **`/vendor/etc/media_codecs.xml` in the shipped image already contains `<Include href="media_codecs_ffmpeg.xml" />`
but the file does not exist on arm** [read: vendor.img, `etc/media_codecs.xml`; `ls etc/media_codecs_ffmpeg.xml`
-> missing]. Dropping a file of that name into the overlay needs no edit of Waydroid's own `media_codecs.xml`.
Component name -> framework: `c2.ffmpeg.*` is not `c2.android.*`/`OMX.google.*`, so MediaCodecList should treat it as
a vendor (hardware-class) codec and prefer it over the Google software ones [inferred; verify with
`dumpsys media.player`/`MediaCodecList`]. Because the Lineage fallback logic opens the software FFmpeg decoder
when hardware fails, this stays safe if the vdec is busy.

Other vendor-image facts [read]: vendor FCM `target-level="3"` with HIDL services; `android.hardware.media.omx@1.0`
service present (OMX + soft codecs only); no `android.hardware.media.c2` HAL registered at all today.
Framework compatibility matrix: GloDroid ships `device_framework_compatibility_matrix_ffmpegcodec2.xml` for the
build-time VINTF check [read]; a runtime overlay does not run that check, but `hwservicemanager` still wants the
fqname in the **device manifest**, which the fragment provides [inferred].

**SELinux**: the vendor image has `precompiled_sepolicy` and a `vendor_file_contexts` line labelling the OMX service
`mediacodec_exec` [read]. Whether the container enforces policy is **[unverified]**; first command on the box should be
`waydroid shell getenforce`. If enforcing, the new service binary has no label and needs a `file_contexts` entry
plus ioctl allows (`allowxperm ... video_device`), which cannot be done by overlay and forces a vendor.img rebuild.

**LXC device passthrough** (`/dev/video0` + `/dev/media0`), from Waydroid `tools/helpers/lxc.py` [read]:

- `generate_nodes_lxc_config()` already bind-mounts every `/dev/video*` (`glob.glob("/dev/video*")`) and
  `/dev/dma_heap/*`; it does **not** glob `/dev/media*`. The request API needs `MEDIA_IOC_REQUEST_ALLOC` on the
  media node, so a three-line loop must be added to `lxc.py` (a package file; `host-install.sh nodes` patches it
  idempotently and keeps `lxc.py.q10-orig`). This file is regenerated by `waydroid upgrade -o` / init, so it is not
  possible to hand-edit `config_nodes`.
- `config_base` sets no `lxc.cgroup*.devices.*` deny list [read: `data/configs/config_base` has none], and the seccomp
  profile is a **blacklist** (`init_module`, `kexec`, `reboot`, `swapon`, ...) with no `ioctl` filtering
  [read: `waydroid.seccomp`]. So device cgroup and container seccomp should not block V4L2/media ioctls [inferred].
- Permissions: the container is privileged with no uid map, so Android uid `media` (1013) meets the **host** mode of
  the node. udev rule (`MODE="0666"` matched on the `histb*` driver, not on the video number) is in `host-install.sh`.
- ⚠️ The Linux-side ffmpeg opens `/dev/media0` + `/dev/video0` from the hwdevice code; inside the container
  a second `/dev` (tmpfs) is built from only the bind mounts, so any path not mounted simply does not exist.
  With the udev-free patch there is **no dependency on `/sys` or the udev database**, which Android's
  container view would have made unreliable.

## 4. Gralloc / dmabuf interop (and the part that is already suspect)

What the image does [read: `waydroid/android_external_minigbm` `gbm_mesa_driver/gbm_mesa_internals.cpp`, head `e5a7769`
"Fix YVU420 format"]:

- Gralloc 4 allocator/mapper `minigbm_gbm_mesa` allocates through **Mesa's GBM** (the `libgbm_mesa_wrapper.so`
  in the vendor image).
- `FLEX_YCbCr_420_888` is resolved to `DRM_FORMAT_NV12`. `NV12, NV21, YVU420, YVU420_ANDROID` are
  `texture_only_formats`. Where `get_gbm_format(format)` is zero, the backend **"spoofs" the format: allocates a
  1-D R8 linear buffer laid out as a 4096-wide 2D R8 texture** and computes the YUV plane layout itself
  (`"Unable to allocate 0x%08x format, allocate as 1D buffer"`). YV12 is handled the same way.
  ⇒ The YUV gralloc buffers the software Codec2 decoders write to are **plain linear CPU/dmabuf memory**, not GPU-tiled
  surfaces. That is good for a CPU-copy decoder (no detiling) and says nothing yet about the display side.
- `gbm_mesa_bo_import()` (importing someone else's dmabuf into a gralloc handle) has an open upstream defect for exactly
  these fallback formats: it passes `bo->meta.total_size` (always 0 at that point) as the width, so `gbm_bo_import()`
  rejects the buffer; a 3-plane YVU420 import *succeeds* but the following **map crashes** [read:
  waydroid/android_external_minigbm issue #3, still open; a workaround patch is described there].
  ⇒ **Zero-copy (wrapping the V4L2 CAPTURE dmabuf as a C2 graphic block) lands on this defect directly.**

Consequences for the plan:

- **Copy path** (phase 1): `av_hwframe_transfer_data()` maps the CAPTURE dmabuf and copies NV12; then NV12 -> gralloc
  block (`YCBCR_420_888` -> NV12 by the table above) with `sws_scale`/memcpy. The Linux driver now maps CAPTURE
  *cached* with proper sync (`capture_cached=1`: [read] `docs/261011-himedia-vdec-cached-capture.md`; before it was
  60 ms per 3 MB frame uncached, after: expected memory speed [inferred, "expect" in that doc]). The write side lands in
  a gbm-mapped R8 buffer whose cacheability I have not established [unverified]; if it is write-combined, writes are
  still fine, reads from it (the sws path never reads dest) are the slow case.
  Throughput estimate for 1080p NV12 [inferred, no measurement]: ~3.1 MB/frame read + ~3.1 MB written; at a
  realistic 500 MB/s-1 GB/s for A53 on this memory that is 6-12 ms/frame, i.e. 1080p30 fits, 1080p60 is marginal.
  Measure it with `v4l2req-probe --copy` (below) before building the service.
- **Midgard-specific**: Mali-T720 is GLES 2.0 hardware that Mesa reports as 3.0 only through
  `MESA_GLES_VERSION_OVERRIDE`, SkiaGL crashes, and **"software frames into GL cause a panfrost `INSTR_INVALID_PC`
  fault storm" on this box** [read: `docs/261012-himedia-kodi-v4l2request.md` line 141]. Android's SurfaceFlinger
  composes with the legacy GLES RenderEngine here [read: dual-boot doc item 5]; a video layer reaching SF as a YUV
  `EGLImage` is therefore the same class of thing that already faulted under Kodi. **It is also true that video playback
  inside Android was never verified, even with software codecs** [read: dual-boot doc "Not verified"]. This is the
  riskiest unknown below.
- Whether Mesa-panfrost-Midgard imports `DRM_FORMAT_NV12` dmabufs as `EGL_EXT_image_dma_buf_import` [unverified; the
  search results I got did not state it for T720/T820, and our own mpv/Kodi plans list it as "not verified"].
- Zero-copy additional costs [inferred]: the V4L2 CAPTURE pool is owned by FFmpeg's `AVHWFramesContext` and must be
  sized for DPB + every buffer Android holds downstream (app + SF + surface queue, typically 8-12 more); at 3.1 MB per
  1080p buffer that is ~85 MB of CMA. The SKIP_CPU_SYNC dmabuf contract in the vdec doc holds for GPU import only if the
  CPU never writes the buffer.

## 5. Ordered implementation plan

| # | Step | Output / gate | Effort | Status |
| --- | --- | --- | --- | --- |
| 0 | **Baseline.** `waydroid shell getenforce`; play a 1080p H.264 file with the existing software `c2.android.avc.decoder`; `dmesg | grep -ci js.fault` must stay 0 | Tells whether YUV presentation works at all, and whether SELinux is enforcing | 0.5 d (box) | not started (needs box) |
| 1 | **FFmpeg for bionic** | libs + patch, no libudev/libdrm | - | **[built]** |
| 2 | **Probe in the container.** `host-install.sh nodes`, restart session, `host-install.sh probe` -> `v4l2req-probe h264 clip.h264 --crc` | `hw=1 fmt=drm_prime`, fps, crc30 equal to the Linux-side frame-30 NV12 | 0.5-1 d (box) | probe **[built]**, never run |
| 3 | Copy-cost measurement `v4l2req-probe ... --copy` (adds `av_hwframe_transfer_data`) | fps with the CPU copy included; decides if zero-copy is ever needed | 0.25 d | built, never run |
| 4 | **Service build** in a LineageOS 20 + `lineage_waydroid_arm` tree: rv13 service + backport `aa0e929`/`00f6f65` (HIDL), FFmpeg libs as `prebuilt` shared libs, change NV12 condition to "has `hw_frames_ctx`", enumerate `V4L2REQUEST` device for all codecs not only HEVC | `android.hardware.media.c2@1.2-service-ffmpeg` arm ELF | 1-2 d + sync/build wait | not started |
| 5 | Install via `host-install.sh overlay`; start service; `lshal | grep c2`; `dumpsys media.player` lists `c2.ffmpeg.h264.decoder` | codec visible | 0.5-1 d | draft files exist |
| 6 | Play 1080p H.264 in a test app: `top` CPU for the decoder vs software, `dmesg` vdec/panfrost faults 0 | the actual goal | 1-2 d (SELinux/seccomp iteration likely) | - |
| 7 | HEVC, VP9, MPEG-2 sweep (`codec-matrix-test.sh` equivalents) | per-codec table | 1 d | - |
| 8 | (optional) Zero-copy: fix/patch `gbm_mesa_bo_import` (issue #3), export CAPTURE dmabuf as `cros_gralloc_handle` (`fds[]`, `strides[]`, `offsets[]`, `format`, `magic`, `id`, ... [read: `cros_gralloc_handle.h`]), size the frame pool | no CPU copy | 5-10 d, high risk | not started |

Total to first HW-decoded clip in Android (steps 0-6): **~4-7 working days**, dominated by step 4's tree sync/build and
by SELinux/seccomp iteration on first runs (my past-session priors on this box, not a measurement).

### Riskiest unknown

**Does any video reach the screen in this Android at all?** Two things sit between a decoded frame and the TV that
nobody on this project has ever exercised: (a) SurfaceFlinger sampling a YUV buffer produced by the
`gbm_mesa` "spoofed 1-D R8" allocator through panfrost on Midgard, with a recorded fault storm for CPU-written YUV in GL on
the same GPU, and (b) the container being able to open the stateless decoder. (b) is cheap to settle (step 2), (a) is
settled by step 0 using the software codec **before any of the expensive work**. If (a) fails the whole effort is moot
until the SF/Mesa path is fixed, and the right fallback is Kodi/mpv on the Linux side (already hardware-decoding), with
Android demoted to apps that do not need video.

Second-order risks: (c) the `histb_vdec` driver may support one context only, so an app creating two decoders (e.g.
thumbnailing) gets the software fallback [unverified]; (d) SELinux enforcing forces a `vendor.img` rebuild instead of an
overlay; (e) A13's `MediaCodecList` ranking of `c2.ffmpeg.*` against `c2.android.*` [inferred, not read in framework code].

## 6. Files

All under `scripts/himedia/android/codec2/`:
`build-ffmpeg-bionic.sh`, `build-probe.sh`, `v4l2req-probe.c`, `host-install.sh` (draft, `bash -n` only),
`patches/0001-v4l2request-udev-free-android.patch`, `overlay/vendor/etc/{media_codecs_ffmpeg.xml,init/*.rc,vintf/manifest/*.xml,seccomp_policy/*.policy}` (drafts).
Artifacts (DATA): `$HIMEDIA_ROOT/android-hwvideo/{stage-bionic,probe,configure-bionic.out,make-bionic.out,config-bionic.log}`,
NDK `$HIMEDIA_ROOT/android-ndk/android-ndk-r27c`, vendor image `$HIMEDIA_ROOT/waydroid/vendor-fs`.
Run logs: `archive/*-ffmpeg-bionic.log` (four runs; three failed before the last one built).

## Sources fetched or read

- https://github.com/GloDroid/glodroid_manifest/issues/152 (V4L2 hardware codecs, closed 2023-11-30)
- https://github.com/GloDroid/aospext (`meson_ffmpegcodec2.mk`, `ffmpeg.mk`), https://github.com/GloDroid/glodroid_configuration (`common/codecs`)
- https://github.com/raspberry-vanilla/android_external_ffmpeg_codec2 (`android-13.0`), https://github.com/raspberry-vanilla/android_device_brcm_rpi4 (`android-13.0` device.mk, media_codecs.xml)
- https://github.com/LineageOS/android_external_ffmpeg_codec2 (`lineage-24.0`, commits aa0e929, 00f6f65)
- https://android.googlesource.com/platform/external/v4l2_codec2 (head af9fcc0, 2025-01-20); https://github.com/lineage-rpi/android_external_v4l2_codec2 (README); https://github.com/TinkerBoard-Android/rockchip-android-external-v4l2_codec2
- https://github.com/waydroid/waydroid (`tools/helpers/lxc.py`, `images.py`, `data/configs/*`), https://github.com/waydroid/android_device_waydroid_waydroid (`lineage-20`), https://github.com/waydroid/android_external_ffmpeg (`dev/lineage-23.2`, commit 582e6cf), https://github.com/waydroid/android_external_minigbm (+ issue #3), https://github.com/waydroid/android_external_stagefright-plugins
- https://github.com/goffioul/external-stagefright-plugins
- Waydroid `lineage-20.0-20260927-MAINLINE-waydroid_arm-vendor.zip` (SourceForge) - extracted and read
- Kwiboo v4l2-request FFmpeg tree already in `$HIMEDIA_ROOT/ffmpeg-v4l2req/src`
- Not fetched / not obtained: the Waydroid **system** image (SourceForge throttled to ~15-27 KB/s), LineageOS 20 AOSP tree, any Mesa source for panfrost Midgard YUV import.

## Step 0 on the box (2026-10-12 12:25-12:48, k19, gpu-skia profile) - PAUSED, unfinished

Box work stopped at the lead's request (CMA needed for decoder tests). Nothing below was fixed; these are
measurements and one strong lead. Tags as above. No eMMC/stick writes, no reboot, no /dev/video0 or /dev/media0 access,
histb_vdec untouched.

**1. The "99.7% dropped, first frame only" run ended in a SurfaceFlinger crash [read].**
`/data/tombstones/tombstone_02` (12:27:39, SF uptime 680 s): `SIGSEGV code 1`, thread **`RenderEngine`** of
`/system/bin/surfaceflinger`, single frame `pc 00d508e8 /vendor/lib/libgallium_dri.so` (no symbols). After it,
SF was re-created but `system_server` held the dead binder: `am start` threw
`Surface$OutOfResourcesException: DEAD_OBJECT` from `SurfaceControl.nativeCreate`, and the TV kept showing the
last video frame (testsrc frame at 00:03.9) - I read that from `fbgrab`, so the "first frame only" picture is
consistent with a dead SF, not with a slow pipeline.

**2. The crash reproduces, at the END of playback [read].**
After a clean Android restart I played `q10test720.mkv` (720p60, 40 s): playback finished 12:44:37.42,
`tombstone_04` is stamped **12:44:38.87** - same thread, **same `pc 00d508e8`**, same register shape. `tombstone_01`
(10:06) has the same signature. So: SkiaGL RenderEngine in `libgallium_dri` dereferences NULL (`fault addr` 0, `r0=0x97`)
when the video layer's buffers are released [inferred: timing only; the tombstone has no symbols]. The most likely
object is the EGLImage/texture made from the `gbm_mesa` "spoofed" R8 YUV buffer (section 4) [unverified].
Everything after it (system_server restart, bootanimation loop, `DeadSystemException` in launcher/systemui) is fallout.

**3. On a clean boot the display path DID present frames [read].**
`q10test720.mkv` 720p60, OMX.google.h264.decoder: `FRAMES: 2308 DROP: 1083 (46.9%)` -> ~31 fps presented of 60.
`fbgrab` mid-playback showed the burned-in counter advancing (frame 1401 at 00:23.350). Box CPU 76% idle at the
sample taken during a following run. So the earlier 99.7% is not a steady-state property of the path; it is the
combination "decode slower than real time" (software h264 ~33 fps on 4xA53, same number as the lead's 1321 frames
over 40 s) **plus** a dead SF. [inferred: Codeaurora's DROP counts frames later than the sync threshold, so a decoder
running at 55% of real time drops about as many frames as it is behind; I did not read its source.]
=> At present **hardware decode would help the drops, and the SkiaGL crash is a separate bug that must be fixed first**
because it takes the whole Android session down every time a video ends.

**4. HWC facts relevant to the path [read: waydroid/android_hardware_waydroid `hwcomposer/gralloc_handler.cpp`].**
- Buffers reach the compositor as `zwp_linux_dmabuf_v1` `create_immed` with **plane 0 only** (`zwp_linux_buffer_params_v1_add(... plane 0 ...)`);
  for the cros/minigbm gralloc type the DRM format is `cros_handle->format` passed straight through; on any failure
  `create_failed()` calls **`abort()`** (the code comment says "TODO: failure handling"). A YV12/NV12 buffer is
  therefore only presentable if SF client-composes it into an RGB buffer first. `dumpsys SurfaceFlinger` on this
  device shows `usesClientComposition=true`, so the YUV video layer is sampled by **SF's RenderEngine in Mesa/panfrost** -
  exactly where the crash is. cage never sees a YUV dmabuf in the observed configuration [inferred from those two facts,
  not from `WAYLAND_DEBUG`].
- `composition type=DEVICE` was shown for the single `bbq-wrapper` layer while idle; I did not capture the layer
  list during playback (the run that would have is below).
- Props present: `debug.sf.disable_backpressure=1`, `debug.sf.latch_unsignaled=1`; `q10.graphics.profile=gpu-skia`,
  `service.sf.prime_shader_cache=0`; **no `debug.renderengine.backend`** => default SkiaGL.

**5. Operational traps found (so the next person does not repeat them) [read].**
- `waydroid shell -- am ...` as root prints nothing and returns 255; use **`waydroid shell -u 2000 -- sh -c "am ..."`**.
  `logcat` through `-u 2000` returned 0 lines when redirected into a file; root `waydroid shell -- logcat -d` works.
- `q10-mode switch desktop` only **freezes** Android; it is not a restart. `systemctl restart q10-android.service` from a
  paused state left the container STOPPED (post-stop hook exit 126, then no restart; `waydroid session stop` +
  `systemctl restart waydroid-container` + `q10-mode switch android` recovered it, ~3 min). The composer aborted once at
  start with `Binder threadpool cannot be shrunk after starting` (`hwc_binder_thread`), tombstone_03.
- Free RAM is thin (1.9 GB; 46 MB free, 59% iowait right after a SF crash) so crashes cascade.

**6. Not done (needs the Android session back):**
a. A/B: set `waydroid-props.sh gpu-gles` (legacy GLES RenderEngine, `debug.renderengine.backend=threaded`) and replay -
   if the end-of-playback SEGV disappears, that is the fix and it needs no image rebuild.
b. 720p30 / 480p30 clips (made, on the box in `/sdcard/Download/q10t-720p30.mkv`, `q10t-480p30.mkv`) to separate decode
   load from path: expect near-zero drops if the path is fine.
c. `dumpsys SurfaceFlinger` layer list **during** playback; `WAYLAND_DEBUG=1` on cage is not possible without restarting
   the session.
d. `scripts/himedia/android/codec2/wd-play.sh <clip> [secs]` does (b)+(c) in one command (it ran once and aborted
   because the lead stopped the container at 12:48; its readiness check, `service check activity`, is not yet proven).
