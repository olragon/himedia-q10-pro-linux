# HiMedia Q10 Pro: mpv 0.40.0 with the V4L2 Request hwdec (side-by-side build)

Goal: `mpv --hwdec=v4l2request` / `v4l2request-copy` on the Hi3798CV200 stateless decoder, linked against the side-by-side
FFmpeg in `/opt/ffmpeg-v4l2req` (see `docs/261011-himedia-ffmpeg-v4l2request.md`). Output path: `--vo=gpu --gpu-context=drm`,
dmabuf imported through EGL (`dmabuf_interop_gl`) into Mesa panfrost GLES.

## Finding: the name is automatic, the patch is for the device

mpv builds its hwdec list at runtime from `avcodec_get_hw_config()` (`add_all_hwdec_methods`, `video/decode/vd_lavc.c`): every
hwaccel config yields `<av_hwdevice_get_type_name()>` and `<name>-copy`. Kwiboo's FFmpeg declares device type `v4l2request`, so
**stock mpv 0.40 already lists `v4l2request`/`-copy` when it runs against our libavcodec**. What stock mpv cannot do is make the
*device*: the non-copy path asks the VO's `drmprime` hwdec for a device of type V4L2REQUEST
(`hwdec_devices_get_by_imgfmt_and_type`), and that hwdec only creates `AV_HWDEVICE_TYPE_DRM`. Hence the patch, and hence
`LD_LIBRARY_PATH=... /usr/bin/mpv --hwdec=v4l2request-copy` might half-work but `--hwdec=v4l2request` cannot. (Not tested; Debian's mpv is untouched.)

## Source (pinned)

| Item | Value |
| --- | --- |
| mpv | tag `v0.40.0` = `e48ac7ce08462f5e33af6ef9deeac6fa87eef01e` (peeled; Debian trixie ships 0.40.0-3 on this orig) |
| Patch origin | mpv-player/mpv PR #14511 "hwdec: add v4l2request hwcontext" (Jonas Karlman / Kwiboo, 2024-07-09, commit `c108232abf`), closed unmerged. Fetched via `https://github.com/mpv-player/mpv/pull/14511.patch` (7,548 bytes, one commit). |
| Our patch | `scripts/himedia/video/mpv-v4l2req/0001-hwdec-add-v4l2request-hwcontext.patch` (6 files, +84/-1) |
| Resulting commit | `79bf8efb069617abedae58f8d5ecabbfdb853bf6` (base + our patch via `git am`; hash depends on am timestamp, the patch file is the record) |
| Not used | Kwiboo's mpv fork branches and LibreELEC's patches: not looked at, the PR is complete for the hwdevice problem. |

### Where our patch differs from PR #14511 (conflicts resolved)

1. `git apply` of the PR fails on 0.40.0: `meson_options.txt` was renamed **`meson.options`**. Option added there (`v4l2request`, feature, default `disabled`).
2. `cc.has_header_symbol('libavutil/hwcontext.h', 'AV_HWDEVICE_TYPE_V4L2REQUEST')` gets `dependencies: libavutil`, otherwise it does not see `/opt/ffmpeg-v4l2req/include` and the option silently reads "not available".
3. **`hwdec_drmprime.c` keeps the DRM device.** The PR replaces `AV_HWDEVICE_TYPE_DRM` with V4L2REQUEST under `#if HAVE_V4L2REQUEST`, which would break `--hwdec=drm` (and any other DRM-device user such as `h264_v4l2m2m`-style flows) in the same binary. Ours creates the V4L2REQUEST device **in addition** and registers it as a second `mp_hwdec_ctx` on the same interop (`hwdec_devices_get_by_imgfmt_and_type` already supports several devices per imgfmt). V4L2REQUEST failing is non-fatal; DRM failing is fatal only if V4L2REQUEST also failed.
4. `hwdec_drmprime_overlay.c` (the `--vo=drm` plane path) is **not** changed; the PR's hunk is dropped. You said it is irrelevant.
5. `video/v4l2request.c` and the `hwcontext_fns_v4l2request` registration are kept unchanged (used by the `-copy` path).

## Build

`scripts/himedia/video/build-mpv-v4l2req.sh` (Dockerfile + `cross-armhf.ini` in `scripts/himedia/video/mpv-v4l2req/`). Same approach as FFmpeg:
Debian trixie container, `crossbuild-essential-armhf` + `:armhf` dev libs, meson cross file, verification under `qemu-arm-static`.
The FFmpeg tarball is unpacked at `/opt/ffmpeg-v4l2req` inside the container, so headers, `.pc` files and the rpath all use the box path.

```
a tmux/screen window    # whole job ~1.5 min incl. image
```

Work tree and logs: `$HIMEDIA_ROOT/mpv-v4l2req/` (`mpv-git/`, `src/`, `build/`, `stage/`, `meson-setup.out`, `ninja.out`, `build-verify.log`, `runtime-deps.txt`).

Meson options that matter: `-Dv4l2request=enabled -Ddrm=enabled -Dgbm=enabled -Degl=enabled -Degl-drm=enabled -Dgl=enabled -Dlua=lua5.2`
`-Dx11=disabled -Dwayland=disabled -Dvulkan=disabled -Dvaapi=disabled -Dvdpau=disabled -Dlibmpv=false`, audio `alsa` + `pulse`.
Compile flags `-march=armv7-a -mfpu=neon-vfpv4 -mfloat-abi=hard -O2`, link `-Wl,-rpath,/opt/ffmpeg-v4l2req/lib`. Lua 5.2 is the only
5.x that 0.40's `lua` option accepts besides 5.1/luajit; it is needed for the on-screen controller and stats script.

## Artifact

| | |
| --- | --- |
| Path | `$HIMEDIA_ROOT/mpv-v4l2req/mpv-v4l2req-armhf.tar.gz` (+ `.sha256`, `install-mpv-v4l2req.sh`) |
| Size | 850,465 bytes |
| sha256 | `6c11dc9883792b9ebbdde27702b392cf3bd4ead90a716a368bbd3564723f9b16` |
| Layout | `opt/mpv-v4l2req/{bin/mpv,etc/mpv,share/...}` |
| Binary | ELF32 ARM EABI5, `Tag_CPU_arch v7`, VFPv4, NEONv1, RUNPATH `/opt/ffmpeg-v4l2req/lib`, stripped |
| Runtime packages (readelf NEEDED) | `libarchive13t64 libasound2t64 libass9 libdisplay-info2 libdrm2 libegl1 libgbm1 libjpeg62-turbo liblcms2-2 liblua5.2-0 libplacebo349 libpulse0 libuchardet0 libzimg2 zlib1g` (+ `libgles2 libgl1-mesa-dri` added by the installer, dlopen'd by EGL) |

## Verified in the build (read from `build-verify.log`)

- Meson summary: `v4l2request: YES`, `opengl: YES`, `lua: YES`; `config.h`: `HAVE_V4L2REQUEST HAVE_DRM HAVE_GBM HAVE_EGL_DRM HAVE_DMABUF_INTEROP_GL HAVE_GL 1`, `HAVE_X11 0`, `HAVE_WAYLAND 0`. Enabled features line includes `v4l2request drm egl-drm gbm dmabuf-interop-gl libplacebo`.
- `qemu-arm-static mpv --version`: mpv v0.40.0, libplacebo v7.349.0, `FFmpeg version: 7.1.5` (ours; libav* resolved from `/opt/ffmpeg-v4l2req/lib/` via RUNPATH).
- `qemu-arm-static mpv --hwdec=help` lists, for h264 / hevc / mpeg2video / vp8 / vp9 / av1: **`v4l2request`** and **`v4l2request-copy`** (plus the stateful `v4l2m2m-copy`). No `drm`/`vaapi` (not built).
- `--gpu-context=help`: `drm` (DRM/EGL). `--gpu-hwdec-interop=help`: `drmprime`, `drmprime-overlay`. `--vo=help`: gpu, gpu-next, drm, null, image, tct, kitty.
- `--hwdec=v4l2request --vo=null` parses and starts (config line shows the option set).

## NOT verified

- **Any decoding or display.** qemu has no `/dev/media0`, no DRM, no GPU: device creation (`av_hwdevice_ctx_create(V4L2REQUEST)`), the dmabuf -> EGL import, and the panfrost GLES path all run first on the box.
- **mpv's GL renderer on GLES 2.0 only.** `vo=gpu` wants GL 2.1 or GLES 3.0 for full features; panfrost on Mali-T720 gives GLES 2.0. mpv has reduced-capability fallbacks (no FBO float/16-bit textures, 8-bit intermediates) but whether it initialises is unknown; if it refuses, the log says so (`-v`). If so try `--opengl-es=yes --gpu-api=opengl`, or `--profile=fast`, `--scale=bilinear --dscale=bilinear --cscale=bilinear`.
- `EGL_EXT_image_dma_buf_import` + NV12 `DRM_FORMAT_NV12` (two-plane) import in panfrost; `dmabuf_interop_gl` also needs `EGL_EXT_image_dma_buf_import_modifiers` only when the buffer has a modifier. A linear VDP/decoder buffer should not.
- Non-H.264 codecs (driver exposes the controls but only H.264 is proven).
- gpu-next (`--vo=gpu-next`): not tried, needs more GL than GLES2 gives.

## Install / uninstall on the box

```
scp $HIMEDIA_ROOT/mpv-v4l2req/{mpv-v4l2req-armhf.tar.gz,mpv-v4l2req-armhf.tar.gz.sha256,install-mpv-v4l2req.sh} <box>:/tmp/
sudo sh /tmp/install-mpv-v4l2req.sh install /tmp/mpv-v4l2req-armhf.tar.gz     # needs /opt/ffmpeg-v4l2req already installed
sudo sh /tmp/install-mpv-v4l2req.sh uninstall
```

Installs `/opt/mpv-v4l2req` and the wrapper `/usr/local/bin/mpv-v4l2req`. Does not touch `/usr/bin/mpv`, `/etc/ld.so.conf.d`, or
Debian's libav*. It does `apt-get install` of the runtime packages above (`libplacebo349` pulls shaderc/vulkan-loader dependencies; that is Debian's packaging).
Config: the build prefix is `/opt/mpv-v4l2req`, so system config is `/opt/mpv-v4l2req/etc/mpv/`; `~/.config/mpv` is shared with Debian's mpv.

## Test commands (on the box; none run yet)

```
mpv-v4l2req --version | head -3                         # mpv 0.40.0, FFmpeg version: 7.1.5
mpv-v4l2req --hwdec=help | grep v4l2request              # expect v4l2request + v4l2request-copy
ldd /opt/mpv-v4l2req/bin/mpv | grep -E 'not found|libav'  # no "not found"; libav* under /opt/ffmpeg-v4l2req/lib

# 1. decode only, no display (isolates the hwdec from GL): copy variant, then zero-copy variant
mpv-v4l2req --hwdec=v4l2request-copy --vo=null --ao=null --untimed --frames=300 -v h264-1080p.mp4 2>&1 | grep -iE 'hwdec|v4l2|Using hardware|fps|drop'
mpv-v4l2req --hwdec=v4l2request      --vo=null --ao=null --untimed --frames=300 -v h264-1080p.mp4 2>&1 | grep -iE 'hwdec|v4l2|Using hardware|fps|drop'
#   "Using hardware decoding (v4l2request)" in the log = the request hwaccel really opened. Note --vo=null has no
#   dmabuf interop, so plain `v4l2request` may fall back to software there: that is expected, judge by step 2.

# 2. real path: DRM/EGL context on the histb-vdp card, dmabuf import into panfrost
mpv-v4l2req --vo=gpu --gpu-context=drm --drm-device=/dev/dri/card1 --hwdec=v4l2request -v h264-1080p.mp4 2>&1 | tee /tmp/mpv-v4l2req.log | grep -iE 'drmprime|v4l2request|EGL|GLES|dmabuf|hwdec|Using|fail|error'
# if GL init fails on GLES2:
mpv-v4l2req --vo=gpu --gpu-context=drm --drm-device=/dev/dri/card1 --opengl-es=yes --profile=fast --hwdec=v4l2request -v h264-1080p.mp4
# copy-back variant through the same VO (software upload, proves GL alone):
mpv-v4l2req --vo=gpu --gpu-context=drm --drm-device=/dev/dri/card1 --hwdec=v4l2request-copy h264-1080p.mp4
# comparison: software
mpv-v4l2req --vo=gpu --gpu-context=drm --drm-device=/dev/dri/card1 --hwdec=no h264-1080p.mp4
# proof of zero-copy: CPU while playing (second ssh): top -b -n3 -d2 | grep mpv   -- compare v4l2request vs v4l2request-copy vs no
```

Useful log lines on failure: `Failed to open media device` / `Using V4L2 media driver` (libavcodec), `No v4l2request hwdevice_ctx`
(ours, -v), `drmprime hwdec requires at least one dmabuf interop backend` (EGL missing `dma_buf_import`), `Using DRM device:`.
In the OSD (`i` key / `--osd-level=3`) the `hwdec-current` property should read `v4l2request`.

## Follow-ups (not done, not authorized work)

- Run the box tests above and record fps / CPU against `--hwdec=no`.
- Upstreaming-quality cleanup (FIXME in the PR: pick the device type from `AVCodecHWConfig`) is out of scope.
- Rebuild when trixie moves mpv/libplacebo (SONAME `libplacebo.so.349`) or when the FFmpeg tarball is rebuilt.

## Addendum 2026-10-12: X11 variant

`build-mpv-v4l2req.sh` now builds `X11=1` by default (`-Dx11=enabled -Degl-x11=enabled`, DRM context kept) into
`mpv-v4l2req-x11-armhf.tar.gz`; `X11=0` reproduces the DRM-only artifact. Verified under qemu: `--gpu-context=help` lists
`auto x11egl drm`, `--hwdec=help` still lists `v4l2request`. Not run on the box. Used by `docs/261012-himedia-chromium-mpv-bridge.md`.
