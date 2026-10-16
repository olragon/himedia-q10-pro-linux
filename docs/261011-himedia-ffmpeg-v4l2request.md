# HiMedia Q10 Pro: FFmpeg 7.1.5 with V4L2 Request hwaccels (side-by-side build)

Goal: let ffmpeg (and, with caveats, mpv/Kodi) use the Hi3798CV200 stateless V4L2 decoder
(`/dev/video0` + `/dev/media0`, request API) that GStreamer `v4l2slh264dec` already proved (300/300 frames).
Debian's FFmpeg 7.1.5 has only stateful `*_v4l2m2m`, so a patched build ships to `/opt/ffmpeg-v4l2req`.

## Source (pinned)

| Item | Value |
| --- | --- |
| Patch set | Jonas Karlman (Kwiboo) `https://github.com/Kwiboo/FFmpeg` branch `v4l2-request-n7.1.3` |
| Branch tip | `fad85d9c76611c09b561167ab405c667a0dcdeb7` (2025-12-14), built on `n7.1.3` = `f46e514491` |
| Content | 1 backport (`FFHWAccel: add buffer_ref argument to start_frame`) + 13 commits: new hwdevice `AV_HWDEVICE_TYPE_V4L2REQUEST`, common code, **MPEG-2, H.264, HEVC, VP8, VP9, AV1** (AV1 is a bonus) |
| Base we use | Debian trixie's exact upstream, tag `n7.1.5` (`3a0867c2bf`). The 14 commits **cherry-pick cleanly** onto it. |
| Resulting commit | `3797016a1a26a50f3a3a92575a80e4d5f4072453` (`kwiboo-ffmpeg` branch `v4l2req-n7.1.5`) |
| Patch files | `$HIMEDIA_ROOT/ffmpeg-v4l2req/patches/` (14 files) |
| Why this one | It is the 2024 upstream ffmpeg-devel series (v2, Aug 2024) plus VP8/VP9/AV1, rebased onto the 7.1 stable line. The series is **not merged upstream**; Kwiboo's branches are what LibreELEC/Armbian ship. Other branches (`v4l2request-2024-v3`, `-2025-v3-rkvdec`) are based on master/7.1.1 and carry rkvdec-specific hacks. |

ABI: the only public-header change is one enum value appended to `AVHWDeviceType` (after the last existing one), so Debian's
mpv/Kodi built against 7.1.5 headers still load it. SONAMEs match Debian exactly:
`libavcodec.so.61 libavutil.so.59 libavformat.so.61 libswscale.so.8 libswresample.so.5 libavfilter.so.10 libavdevice.so.61` (+ `libpostproc.so.58`).

## Build

`scripts/himedia/video/build-ffmpeg-v4l2req.sh` (Dockerfile in `scripts/himedia/video/ffmpeg-v4l2req/`). Cross-compile in a Debian trixie
container (arm64 host here; `crossbuild-essential-armhf` + `:armhf` dev libs), verification runs under `qemu-arm-static`.
Long job: a tmux/screen window (compile takes ~2 min; the
image build ~2 min). Work tree: `$HIMEDIA_ROOT/ffmpeg-v4l2req/` (`src/`, `build/`, `stage/`, `kwiboo-ffmpeg/`, logs).

Configure (flags that matter; full line is in `ffmpeg -buildconf`):

```
--prefix=/opt/ffmpeg-v4l2req --enable-cross-compile --cross-prefix=arm-linux-gnueabihf- --arch=arm --target-os=linux
--extra-cflags='-march=armv7-a -mfpu=neon-vfpv4 -mfloat-abi=hard -O2' --extra-ldflags='-Wl,-rpath,/opt/ffmpeg-v4l2req/lib'
--enable-gpl --enable-shared --disable-static --enable-pic --disable-doc --disable-ffplay
--enable-v4l2-request --enable-libdrm --enable-libudev
--enable-gnutls --enable-libass --enable-libfontconfig --enable-libfreetype --enable-libfribidi --enable-libharfbuzz
--enable-libdav1d --enable-libaom --enable-libvpx --enable-libopus --enable-libvorbis --enable-libmp3lame --enable-libwebp
--enable-libxml2 --enable-libopenjpeg --enable-libtheora --enable-libspeex --enable-libsoxr --enable-libzimg
```

Not identical to Debian's list on purpose: no vaapi/vdpau/xlib/sdl2/opencl/x265/x264/pulse/jack (not useful on this box, heavy deps).
Decoders mpv needs (h264/hevc/vp9/av1 software, audio, subtitles via libass) are all present.

## Artifact

| | |
| --- | --- |
| Path | `$HIMEDIA_ROOT/ffmpeg-v4l2req/ffmpeg-v4l2req-armhf.tar.gz` (+ `.sha256`, `install-ffmpeg-v4l2req.sh`) |
| Size | 9,732,435 bytes |
| sha256 | `818c7b0a430310af00bb7dd4fa275ba858488b9e04a24c7f25d09db32f418c1f` |
| Layout | `opt/ffmpeg-v4l2req/{bin/ffmpeg,bin/ffprobe,lib/lib*.so.*,include,lib/pkgconfig}` |
| Binary | ELF32 ARM EABI5 hard-float, `Tag_CPU_arch v7`, `VFPv4`, `NEONv1`, RUNPATH `/opt/ffmpeg-v4l2req/lib` |

## Verified in the build (read from `build-verify.log`)

- `strings libavcodec.so.61` lists `V4L2RequestContext`, `av1_v4l2request`, `h264_v4l2request`, `hevc_v4l2request`, `mpeg2_v4l2request`, `vp8_v4l2request`, `vp9_v4l2request`.
- `qemu-arm-static ffmpeg -hwaccels` prints `drm` and `v4l2request`; `ffmpeg -version` = `7.1.5`; `-buildconf` shows `--enable-v4l2-request --enable-libdrm --enable-libudev`.
- Exact hwaccel names (per codec): **h264_v4l2request, hevc_v4l2request, mpeg2_v4l2request, vp8_v4l2request, vp9_v4l2request, av1_v4l2request**; one device type **`v4l2request`**; frame format `drm_prime` (the only one the hwaccel advertises).
- **Not verified:** actual decoding. Qemu has no `/dev/media0`; everything below is for the box. The HEVC/VP8/VP9/MPEG-2 paths need a driver that implements those controls (S265 etc. are listed by our driver; only H.264 is hardware-proven so far).

Runtime packages (from `readelf NEEDED`, armhf): `libaom3 libass9 libbz2-1.0 libdav1d7 libdrm2 libfontconfig1 libfreetype6 libfribidi0 libgnutls30t64
libharfbuzz0b liblzma5 libmp3lame0 libopenjp2-7 libopus0 libsoxr0 libspeex1 libtheoradec1 libtheoraenc1 libudev1 libvorbis0a libvorbisenc2 libvpx9 libwebp7
libwebpmux3 libxml2 libzimg2 zlib1g` (the install script runs `apt-get install` for exactly these).

## Install / uninstall on the box

```
scp $HIMEDIA_ROOT/ffmpeg-v4l2req/{ffmpeg-v4l2req-armhf.tar.gz,ffmpeg-v4l2req-armhf.tar.gz.sha256,install-ffmpeg-v4l2req.sh} <box>:/tmp/
sudo sh /tmp/install-ffmpeg-v4l2req.sh install /tmp/ffmpeg-v4l2req-armhf.tar.gz
sudo sh /tmp/install-ffmpeg-v4l2req.sh uninstall
```

Installs only under `/opt/ffmpeg-v4l2req` plus wrappers `/usr/local/bin/{ffmpeg-v4l2req,ffprobe-v4l2req,with-ffmpeg-v4l2req}`.
It **deliberately adds no `/etc/ld.so.conf.d` drop-in**: a system-wide entry would make every Debian program (mpv, Kodi, vlc) load our libav* and
remove the fallback. Opt in per command with `LD_LIBRARY_PATH=/opt/ffmpeg-v4l2req/lib` (or `with-ffmpeg-v4l2req <cmd>`). Nothing in
`/lib/arm-linux-gnueabihf/libav*` is touched. Check: `ldd /opt/ffmpeg-v4l2req/bin/ffmpeg | grep 'not found'`.

## Test commands (on the box; not yet run)

```
ffmpeg-v4l2req -hide_banner -hwaccels                      # expect: drm, v4l2request
# 1. zero-copy decode, no display
ffmpeg-v4l2req -hwaccel v4l2request -hwaccel_output_format drm_prime -i h264-720p.mp4 -map 0:v -f null -
# 2. copy-back variant (hwcontext implements transfer_data_from, so omitting -hwaccel_output_format downloads to a sw frame, NV12)
ffmpeg-v4l2req -hwaccel v4l2request -i h264-720p.mp4 -frames:v 1 -y /tmp/v4l2req-frame.png
#    explicit form:
ffmpeg-v4l2req -hwaccel v4l2request -hwaccel_output_format drm_prime -i h264-720p.mp4 -vf hwdownload,format=nv12 -frames:v 1 -y /tmp/v4l2req-frame.png
# timing / proof it is the hardware: compare against software
time ffmpeg-v4l2req -hwaccel v4l2request -hwaccel_output_format drm_prime -i h264-720p.mp4 -f null -
time ffmpeg-v4l2req -i h264-720p.mp4 -f null -
# the device is auto-selected by enumerating media nodes through udev; the device argument is currently ignored
```

If it falls back silently to software, run with `-loglevel debug` and look for `Using V4L2 media driver` / `Failed to open media device`.
Note `-hwaccel_output_format nv12` is **not** a valid request-API choice: the hwaccel only advertises `drm_prime`, so the copy-back is `hwdownload` or the default.

## mpv and Kodi: what ffmpeg alone does not give you (honest)

**mpv (Debian 0.40.0-3):** the `v4l2request` hwdec is **not in upstream mpv**. Kwiboo's PR mpv-player/mpv#14511 ("[RFC] hwdec: add v4l2request
hwcontext") was **closed unmerged** (2024-08). Our libavcodec requires a hw device of type `V4L2REQUEST`
(`HW_CONFIG_HWACCEL(1, 0, 0, DRM_PRIME, V4L2REQUEST, ...)`), while stock mpv's `--hwdec=drm`/`drm-copy` creates a *DRM* device, so
`LD_LIBRARY_PATH=... mpv --hwdec=drm` will not select the request hwaccel; there is no `--hwdec=v4l2request` in 0.40. Stock `--hwdec=v4l2m2m(-copy)` is the stateful
API and does not apply to this driver. Options: (a) build mpv with the PR's patch against this FFmpeg (then `--hwdec=v4l2request` / `v4l2request-copy` per the PR, `--vo=gpu --gpu-context=drm` or `--vo=dmabuf-wayland`); (b) for now use the proven GStreamer
`v4l2slh264dec` path. Test whichever mpv you get with `mpv --hwdec=help` and look for `v4l2request`; with a stock mpv this will only show the ffmpeg software path:
`LD_LIBRARY_PATH=/opt/ffmpeg-v4l2req/lib mpv --hwdec=no clip.mp4` is just a check that the side-by-side libs load (they do not make it hardware).

**Kodi (Debian 2:21.2+dfsg-4):** Kodi's DRM PRIME decoder (`CDVDVideoCodecDRMPRIME`) is the consumer. xbmc/xbmc#25467 ("Fix use of v4l2request hwdevice",
merged 2024-12) is on master (22.x); whether the 21.2 package has the equivalent was **not verified**, assume it needs Kodi 22 or a backport.
Beyond FFmpeg, Kodi needs the DRM-PRIME **renderer**, which imports dma-bufs via `EGL_EXT_image_dma_buf_import` and exists only in the **GBM and Wayland**
windowing builds (needs working GPU EGL on this SoC). **Debian's X11 Kodi cannot use it** (X11 builds do VAAPI/VDPAU/software only); it would decode
in hardware and then not be able to display the frames. Kodi also loads Debian's libav*, so it needs `LD_LIBRARY_PATH=/opt/ffmpeg-v4l2req/lib`.
This box has no proven EGL/GBM stack yet, so Kodi hardware decode is the least certain piece.

## Follow-ups (not done, not authorized work)

- Run the three test commands above on the box and record fps vs software.
- If mpv is the target: build mpv with Kwiboo's hwcontext patch against `/opt/ffmpeg-v4l2req` (decide with Tim).
- Debian ships FFmpeg security fixes; this build is pinned to 7.1.5 and needs a rebuild when trixie moves.
