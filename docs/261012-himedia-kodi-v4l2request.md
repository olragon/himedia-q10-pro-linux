# HiMedia Q10 Pro: Kodi 21.2 with V4L2-Request hardware decode (GBM + GLES), side by side in /opt/kodi-v4l2req

**Date:** 2026-10-12
**Status:** Built, packaged, smoke-tested in an armhf userland. **Not run on the box** (the Mac cannot reach it by instruction).
Companion docs: `docs/261011-himedia-ffmpeg-v4l2request.md` (the FFmpeg this links), `docs/261011-himedia-mpv-v4l2request.md`
(the mpv precedent), `docs/261012-himedia-chromium-kodi-hw.md` (the parent plan).

## Version choice: Kodi 21.2 "Omega" (Debian `2:21.2+dfsg-4`) + a 2-commit backport, not Kodi 22

[read] What each version has for the V4L2-request path:

| | 21.2-Omega / 21.3-Omega | master (22 alpha) |
| --- | --- | --- |
| `CDVDVideoCodecDRMPRIME` accepts any `drm_prime`-output hwconfig (so FFmpeg's `V4L2REQUEST` device type) | **no** — hard-wired to `AV_HWDEVICE_TYPE_DRM` | yes, `ed324259c8` (PR #25467, merged 2024-12) |
| AV1 via v4l2request | no | `acd94b3193` (PR #27579) |
| everything else in the area | stable | **in flux**: ~60 commits touching DRMPRIME/GBM since 21.2 (dma-buf identity caches, pool rewrites, GBM vblank, D2P plane reservation, "DRMPRIME only with GLES" ...) all from the last two months |

[read] `git log 21.3-Omega..origin/master` on the one file that matters shows #25467 is the **only** thing 21.x lacks for this
driver; the LibreELEC `packages/mediacenter/kodi/patches` directory (checked on master) carries **no** v4l2request/drmprime fix for
Kodi 21 — it now tracks Kodi master (`PKG_VERSION=63063c8e…`) and only has the `drmprime-filter` WIP (deinterlace), which we do not need.
So there are no "LibreELEC Kodi 21 patches" to collect: the upstream commits are the whole set.

Choice, and why it is the least risky:
- **21.2 + the two upstream commits cherry-picked.** `ed324259c8` changes ~50 lines inside one function pair (`FindHWConfig`, `Open`); `acd94b3193` deletes one line. Both
  applied with `patch -p1` and no fuzz onto the *Debian-patched* 21.2 tree (the Debian FFmpeg-7 patchset moved nearby code; no reject).
- 21.2 is what Debian trixie ships, and Debian's own patchset (FFmpeg 7.x port, pcre2, libdvd, std::chrono dates) is the part that makes Kodi build against a 7.1 FFmpeg. Using the pinned
  Debian source means we inherit a patchset that is *already known to compile on armhf*; Kodi 22 would need its own FFmpeg-7/8 and CMake churn on top of a moving target.
- Kodi 22 only wins if we want features beyond hw decode (D2P screencap, HDR types, filters). Revisit when it is released.

## Patch provenance

| Layer | What | Where from |
| --- | --- | --- |
| Base | `kodi_21.2+dfsg.orig.tar.xz` + 3 embedded tarballs (libdvdnav, libdvdread, repo-resources) | `https://deb.debian.org/debian/pool/main/k/kodi/` — sha256 pinned in `build-kodi-v4l2req.sh`, taken from `kodi_21.2+dfsg-4.dsc` |
| Debian series | `kodi_21.2+dfsg-4.debian.tar.xz`: 18 `kodi/*` patches (libgcrypt, no openssl, branding, ...), libdvdnav/read, `cdatetime-std-chrono`, `workarounds/0001..0006` (**0004-ffmpeg7**, 0003-pcre2, 0002-libdvd_vfs, 0005/0006 PipeWire) | applied by `dpkg-source -x` — all applied, none failed |
| Backport 1 | `0001-CDVDVideoCodecDRMPRIME-Fix-use-of-v4l2request-hwdevi.patch` = xbmc `ed324259c8` ("Fix use of v4l2request hwdevice", Jonas Karlman, 2024-07-09; merge `b2edd8c2d6` = PR #25467) | `github.com/xbmc/xbmc`, `git format-patch -1 ed324259c8` |
| Backport 2 | `0002-CDVDVideoCodecDRMPRIME-Fix-AV1-playback-using-v4l2re.patch` = xbmc `acd94b3193` (Kwiboo, 2025-12-14; merge `532c26aa5d` = PR #27579) | same |

Both patch files are in `scripts/himedia/kodi/patches/`. **Conflicts: none.** `find -name '*.rej'` is part of the build script and would abort it.
Upstream base for reference: git tag `21.2-Omega` = `d1a1d48c3c`.

What backport 1 does (read from the diff): `FindHWConfig` used to return only `HW_DEVICE_CTX` configs whose `device_type == AV_HWDEVICE_TYPE_DRM`;
Kwiboo's FFmpeg declares `HW_CONFIG_HWACCEL(1,0,0, DRM_PRIME, V4L2REQUEST, …)`, so Kodi never saw it. Now **any** `HW_DEVICE_CTX` or `INTERNAL` config that outputs `drm_prime`
qualifies, and `Open` creates a device of *that* type (`av_hwdevice_ctx_create(&hw_device_ctx, pConfig->device_type, device, …)`) — for `DRM` it still passes the render node,
for `V4L2REQUEST` the device argument is `NULL` (FFmpeg enumerates media nodes itself). Backport 2 removes `m_pCodecContext->pix_fmt = AV_PIX_FMT_DRM_PRIME`, which stops FFmpeg's AV1 decoder from skipping `get_format`.
(Our driver has no AV1; H.264 is the proven codec. It is a one-line, harmless inclusion that keeps us equal to upstream.)

## What was built

`scripts/himedia/kodi/` (all committed-ready; **nothing was committed or pushed**, per instruction):

| File | Role |
| --- | --- |
| `Dockerfile` | trixie container: `crossbuild-essential-armhf`, native Java/Groovy/swig/doxygen/flatc/autotools, ~60 `:armhf` -dev libs (the FFmpeg ones too, so the linker can resolve libavcodec's own NEEDED) |
| `build-kodi-v4l2req.sh` | pin + checksum the Debian source, `dpkg-source -x`, apply `patches/`, cross-build, verify, tar + sha256 |
| `container-build.sh` | in-container: native JsonSchemaBuilder/TexturePacker, `cmake` cross configure, `make`, `make install DESTDIR` |
| `toolchain-armhf.cmake` | `-march=armv7-a -mtune=cortex-a7 -mfpu=neon-vfpv4 -mfloat-abi=hard`, RUNPATH `/opt/ffmpeg-v4l2req/lib:/opt/kodi-v4l2req/lib`, `-latomic`, Debian's `-D_XBMC -DDEB_VERSION` |
| `container-verify.sh` | symbol/strings checks on the unstripped binary, prune + strip, NEEDED->package map, qemu `--version` |
| `install-kodi-v4l2req.sh` | install / uninstall on the box (apt deps, wrapper, presets) |
| `presets/` | `guisettings.xml` (direct plane), `guisettings-gles-renderer.xml`, `advancedsettings.xml` (debug log) |
| `test-install-armhf.sh` | runs the **real installers** in a genuine armhf trixie (`docker --platform linux/arm/v7`) and smoke-tests |

Run: a tmux/screen window (JOBS=6 default; ~5 min on this Mac after the ~70 s image build).
Work tree: `$HIMEDIA_ROOT/kodi-v4l2req/` (`src/`, `build/`, `stage/`, `make.out`, `cmake-configure.out`, `build-verify.log`, `test-install-armhf.log`).

CMake configuration (the lines that matter; full set in `container-build.sh`):
`-DCORE_PLATFORM_NAME=gbm -DAPP_RENDER_SYSTEM=gles -DWITH_ARCH=arm -DENABLE_NEON=ON -DENABLE_INTERNAL_FFMPEG=OFF -DENABLE_PYTHON=ON -DENABLE_ALSA=ON -DENABLE_PULSEAUDIO=ON -DENABLE_UDEV=ON -DENABLE_DBUS=ON -DENABLE_UPNP=ON -DENABLE_MICROHTTPD=ON`
and **off**: VAAPI, VDPAU, Avahi, Bluray, CEC, LIRC, MySQL/MariaDB, NFS, SMB, AirTunes/plist, optical, DVDCSS, PipeWire, sndio, eventclients, tests. No X11, no Wayland (`Platforms: gbm`).
FFmpeg is found through pkg-config at `/opt/ffmpeg-v4l2req/lib/pkgconfig` (`Found libavcodec, version 61.19.101`; Kodi's `FindFFMPEG` reports `7.0.0` as the *minimum* it tested, not the build).

Install layout: `/opt/kodi-v4l2req/{bin/kodi,bin/kodi-standalone,lib/kodi/kodi-gbm,share/kodi,share/q10-presets}`; `bin/kodi` is the stock launcher that restarts on exit-code 65 and
honours `KODI_DATA`. `libdvdnav/libdvdread` are linked in statically (no `.so` ships). No binary add-ons were built (PVR etc.).

## Artifact

| | |
| --- | --- |
| Path | `$HIMEDIA_ROOT/kodi-v4l2req/kodi-v4l2req-armhf.tar.gz` (+ `.sha256`, `install-kodi-v4l2req.sh`) |
| Size | 27,365,880 bytes |
| sha256 | `10030be86dd1bd033fd8aa71d095d43c93ab4411ebdcacf0b7116a1540aca7ed` |
| Binary | `lib/kodi/kodi-gbm`, ELF32 ARM EABI5 hard-float, `Tag_CPU_arch v7`, VFPv4, NEONv1, RUNPATH `/opt/ffmpeg-v4l2req/lib:/opt/kodi-v4l2req/lib`, stripped (20.6 MB) |
| Version string | `Kodi from Debian Media Center 21.2 ... 2:21.2+dfsg-4+q10v4l2req1` |

## GLES 2.0 only: is that enough? [read]

- Kodi requests an **ES 2.0 context** on GBM: `WinSystemGbmGLESContext.cpp:184 contextAttribs.Add({{EGL_CONTEXT_CLIENT_VERSION, 2}})`. The build is `HAS_GLES 2` (no GLES3 headers included).
- All 20 GLES shaders shipped under `system/shaders/GLES/2.0` are `#version 100`; two of them need `GL_OES_EGL_image_external` (the DRM-PRIME GLES renderer's `samplerExternalOES`). **No ES 3 shader.**
- So there is no hard GLES3 requirement. Things that can still bite on a T720, none verified: `GL_OES_EGL_image_external` (needs panfrost's EGL dma-buf import), NPOT textures/large GUI textures (T720 is fine in principle), and Estuary's blur/shadow filters on a weak GPU.
- Contrast with Chromium on this box, which *does* demand GLES3 and needs `MESA_GLES_VERSION_OVERRIDE=3.0` (see `261012-himedia-chromium-kodi-hw.md`). **Do not** set that override for Kodi; it is unnecessary and fakes a capability level.

## The DRM-PRIME settings (names, and how to preset them headless)

[read] from `system/settings/linux.xml` and the source (`HAS_GLES` builds only; the first two are `visible=false` until `CDVDVideoCodecDRMPRIME::Register()` makes them visible):

| id | GUI label | default | what it does |
| --- | --- | --- | --- |
| `videoplayer.useprimedecoder` | Settings > Player > Videos > **Allow using DRM PRIME decoder** (level Advanced) | **false** | registers/uses `CDVDVideoCodecDRMPRIME` at all. *Must be true* or no v4l2request. |
| `videoplayer.useprimedecoderforhw` | **Use DRM PRIME decoder for hardware** (Expert) | true | `FindHWConfig` returns null when false => never picks `h264_v4l2request`. Leave true. |
| `videoplayer.useprimerenderer` | **Render method** (Advanced) | 1 | `0 = Direct to plane` (dma-buf scanned out on a DRM video plane, GUI on the GUI plane, zero-copy, no GPU); `1 = GLES` (EGL image import, `samplerExternalOES`) |

Seeded **only if absent** by the wrapper from `/opt/kodi-v4l2req/share/q10-presets/` into `~/.kodi-v4l2req/userdata/`:
- `guisettings.xml`: the three settings above (decoder true / for-hw true / renderer `0`) + `debug.showloginfo`.
- `advancedsettings.xml`: `<loglevel>1</loglevel>` (debug) so the hwdevice line reaches `~/.kodi-v4l2req/temp/kodi.log`.
- Alternative: `KODI_V4L2REQ_PRESET=gles kodi-v4l2req` seeds the GLES-renderer variant (`useprimerenderer=1`).
- ⛔ **A `guisettings.xml` that lacks any of `<resolutions>`, `<skinsettings>`, `<viewstates>` is thrown away whole.** `CSettings::Load` reads the values, then runs every sub-settings loader
  (`CDisplaySettings`, `CSkinSettings`, `CViewStateSettings`, ...); each returns false when its element is missing, the load as a whole fails, and Kodi calls `Reset()` — every value in the file silently
  reverts to its default. Found 2026-10-12 in the armhf smoke test: the first preset (settings only) logged `CDisplaySettings: settings file doesn't contain <resolutions>` and
  `CSettings: unable to load settings ... creating new default settings`; adding `<resolutions>` alone still failed (next loader), adding all three loaded cleanly (`test-install-armhf.sh` prints PASS/FAIL on that log line).
  The log says "creating new default settings", not "ignored your presets" — read it.
  The seeded files therefore carry the three empty elements. Kodi rewrites the file on a clean exit, so after the first successful run it is complete.

Direct renderer preconditions (read from `RendererDRMPRIME::Create`, they all must hold or Kodi silently uses the GLES renderer instead):
1. atomic modesetting (`CDRMAtomic`) — the histb-vdp driver must expose atomic;
2. a GUI plane that supports `FourCCWithAlpha(format)` (G0 XR24/AR24 + alpha: ours does);
3. a **video plane** that supports `(NV12, DRM_FORMAT_MOD_LINEAR)` — FFmpeg's `hwcontext_v4l2request.c` exports `V4L2_PIX_FMT_NV12 -> DRM_FORMAT_NV12 + MOD_LINEAR`, and V0 offers NV12/NV21: ok on paper.
If any fails the DRMPRIME-GLES renderer (`drm_prime_gles`, registered after it, no setting gate) takes the frame, which needs `EGL_EXT_image_dma_buf_import` in panfrost.

## Verified in the build [read from `build-verify.log` / `test-install-armhf.log`]

- Cross build exit 0 (`BUILD+INSTALL OK`), `Platforms: gbm`, GLES found, GBM `25.0.7`, Python 3.13 embedded, FFmpeg libavcodec 61.19.101 from `/opt/ffmpeg-v4l2req`.
- Unstripped symbols present: `CDVDVideoCodecDRMPRIME::{Create,Open,Register}`, `CRendererDRMPRIME::{Create,Register}`, `CRendererDRMPRIMEGLES::*`, GBM/atomic windowing.
- Strings present (so the backport is compiled in, not just the old code): `CDVDVideoCodecDRMPRIME::{} - creating {} hwdevice context using device: {}`, `... unable to create {} hwdevice context ...`, `videoplayer.useprimedecoder`, `…useprimedecoderforhw`, `…useprimerenderer`, `drm_prime`, `drm_prime_gles`, `GL_OES_EGL_image_external`.
  (The "creating {} hwdevice" string does not exist in unpatched 21.2; it is the control for "backport applied".)
- `qemu-arm-static` and a **real armhf trixie container** (`test-install-armhf.sh`): `ffmpeg-v4l2req` + `kodi-v4l2req` installers run, apt resolves every package,
  `ldd` shows **no `not found`** and `libavcodec/avfilter/avformat/avutil/swscale/swresample/postproc` all resolve to `/opt/ffmpeg-v4l2req/lib`, `kodi-v4l2req --version` prints the version above,
  uninstall removes `/opt/kodi-v4l2req` and leaves `/opt/ffmpeg-v4l2req` alone.
- Kodi really starts: logs `FFmpeg version/source: 7.1.5`, initialises the add-on manager and the **embedded Python** (`xbmc.python v3.0.1`, the two python metadata add-ons), tries `gbm` windowing, and with no `/dev/dri` fails cleanly
  (`CDRMUtils::OpenDrm - no drm devices found`, `critical: unable to init windowing system`, exit "Unable to create GUI") — i.e. the expected failure, at the expected place.

## NOT verified (all of it needs the box)

- Any decode: `av_hwdevice_ctx_create(V4L2REQUEST)` from inside Kodi, the hwaccel selection, frames.
- That Kodi's `GetFormat` accepts `AV_PIX_FMT_DRM_PRIME` from `h264_v4l2request` and that `FindDecoder` iterates to that decoder (it should: `avcodec_get_hw_config` lists it).
- GBM + EGL on the **histb-vdp** card: Kodi's `CDRMUtils::OpenDrm` takes the first `/dev/dri/card*` with a usable connector (panfrost's card has none, so histb-vdp), and finds no render node on it
  (`drmGetRenderDeviceNameFromFd` -> NULL), so it falls back to the **card path** and calls `gbm_create_device(vdp fd)`. mpv's `--gpu-context=drm --drm-device=/dev/dri/card1` does the same, which is the precedent,
  but whether Mesa 25.0.7 builds a panfrost-backed GBM device on a display-only KMS node is exactly what a first run shows. Fallback probe: `kmscube -D /dev/dri/card1`.
- Atomic commit on histb-vdp from Kodi (`CDRMAtomic`): plane properties it sets are `FB_ID CRTC_ID SRC_* CRTC_*` plus `MODE_ID/ACTIVE`, optionally `IN_FENCE_FD/OUT_FENCE_PTR`; nothing requires `zpos`.
- Direct-to-plane vs GLES-import behaviour, A/V sync, 1080p fps, CPU, panfrost faults. The GUI itself is GLES2 shaders on panfrost — untested too.
- HEVC / VP9 / MPEG-2 (exposed by the driver, never exercised; H.264 only is hardware-proven).
- Audio (ALSA/Pulse: HDMI audio path per `261011-himedia-hdmi-audio-recipe.md`), input (libinput needs /dev/input access), CEC (disabled), Python add-ons beyond import (Plex add-on is a later goal).
- ⚠️ Software-decoded streams: Kodi's non-hardware path uploads YUV frames into GL textures. The 2026-10-11 note says **software frames into GL cause a panfrost `INSTR_INVALID_PC` fault storm** on this box. With `useprimedecoder=true` Kodi's DRMPRIME codec also runs
  software decode into DMA buffers (`IsSupportedSwFormat`) and avoids that — but this is unproven. For codecs the VDEC cannot do (HEVC 10-bit, AV1), expect either that path or the fault storm; arm the watchdog (`q10-wd-run`) for the first runs.

## Install on the box

```
# on the Mac (no ssh from here by instruction; copy by whatever route you use)
W=$HIMEDIA_ROOT/kodi-v4l2req
scp $W/{kodi-v4l2req-armhf.tar.gz,kodi-v4l2req-armhf.tar.gz.sha256,install-kodi-v4l2req.sh} <box>:/tmp/
# on the box (ffmpeg-v4l2req must already be installed: install-ffmpeg-v4l2req.sh)
sudo sh /tmp/install-kodi-v4l2req.sh install /tmp/kodi-v4l2req-armhf.tar.gz
ldd /opt/kodi-v4l2req/lib/kodi/kodi-gbm | grep -E 'not found|libavcodec'      # expect no 'not found', libavcodec -> /opt/ffmpeg-v4l2req/lib
sudo sh /tmp/install-kodi-v4l2req.sh uninstall                                 # removes /opt/kodi-v4l2req + /usr/local/bin/kodi-v4l2req, keeps ~/.kodi-v4l2req
```

Never touches `/usr/bin/kodi`, Debian's Kodi packages or `~/.kodi` (profile is `~/.kodi-v4l2req`, set through `KODI_DATA`).

## First run on the box (suggested order)

GBM Kodi needs **DRM master and a free display**: stop the X desktop first (`sudo systemctl stop lightdm` or whatever the Q10 session manager is) and run from a text console / ssh with a VT, as a user that can open `/dev/dri/card*`, `/dev/input/*`, `/dev/video0`, `/dev/media0` (root is simplest for a first test).

```
# 0. is anything holding the display / decoder?
fuser -v /dev/dri/card* /dev/media0 /dev/video0
# 1. prove the display stack independently of Kodi (card number may differ: simpledrm / panfrost / histb-vdp)
for c in /sys/class/drm/card?; do echo $c $(cat $c/device/uevent | grep DRIVER); done
kmscube -D /dev/dri/card1 -c 120        # card1 = histb-vdp in the mpv doc
# 2. Kodi, GBM, debug log, direct-to-plane preset (seeded on first run)
sudo /usr/local/bin/kodi-v4l2req
#    (GLES renderer instead of the video plane: rm ~/.kodi-v4l2req/userdata/guisettings.xml; KODI_V4L2REQ_PRESET=gles sudo -E kodi-v4l2req)
# 3. play the 1080p H.264 clip from the UI (Videos > Files > Add videos > browse to the clip)
```

### Which Kodi log lines prove hardware decode

`~/.kodi-v4l2req/temp/kodi.log` (debug is on via the preset). Filter:
`grep -E "CDVDVideoCodecDRMPRIME|DRMPRIME|drm_prime|v4l2request|CRendererDRMPRIME|CDRMUtils|GBM|EGL" ~/.kodi-v4l2req/temp/kodi.log`

| Line | Level | Means |
| --- | --- | --- |
| `CDVDVideoCodecDRMPRIME::Open - using decoder H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10` | INFO | DRMPRIME codec accepted the stream. **Not proof by itself**: the software fallback prints the same line. |
| **`CDVDVideoCodecDRMPRIME::Open - creating v4l2request hwdevice context using device: (null)`** | DEBUG | **The proof.** `FindHWConfig` selected the `V4L2REQUEST` hwconfig, i.e. `h264_v4l2request` will be used. Absence of it (with the "using decoder" line present) means software. |
| `CDVDVideoCodecDRMPRIME::Open - unable to create v4l2request hwdevice context ...` | ERROR | device creation failed (no `/dev/media0` access, or no matching media device) — Kodi then falls back to its other video codecs |
| `CDVDVideoCodecDRMPRIME: FFMPEG has no libdrm support` | INFO | the loaded libav* lacks libdrm (i.e. Debian's, not ours): the startup line `FFmpeg version/source: 7.1.5` + `ldd` show which one loaded |
| Renderer: `CRendererDRMPRIME` (direct) vs `drm_prime_gles` | DEBUG | which renderer took the frames; with `useprimerenderer=0` and a failing precondition you silently get the GLES one |

Independent, non-log proof (use these two together with the log; they cannot be faked by a config typo):
```
fuser -v /dev/media0 /dev/video0                         # kodi-gbm must hold both while playing
top -b -n 3 -p $(pgrep -f kodi-gbm) | tail -4             # CPU for 1080p H.264 should be far below software decode (mpv hw: 40 fps at 6.3 s CPU); a pegged core means software
dmesg | grep -ciE 'js fault|INSTR_INVALID_PC'              # must stay 0 (panfrost fault storm marker)
```
To see FFmpeg's own `Using V4L2 media driver` message in the Kodi log: Settings > System > Logging > enable component-specific logging > FFmpeg (not preset; ids not verified).
On-screen: press `o` during playback — Player process info shows the decoder name; `drm_prime` there is consistent with the log, still not hardware proof alone.

If Kodi exits at startup: `kodi.log` tail and the stderr of `kodi-v4l2req`. `CDRMUtils::OpenDrm - no drm devices found` = no access/DRM master; `Unable to create GUI` after a GBM/EGL error = the card-selection risk above (try `kmscube` on each card).

## Gotchas found while doing this

- **The Debian source carries Debian-only defines:** patch `0003-differentiate-from-vanilla` references `DEB_VERSION`; without `-D_XBMC -DDEB_VERSION=...` `SystemInfo.cpp` fails to compile. They live in `toolchain-armhf.cmake`.
- **Kodi's CMake wants `libcdio` (and `autoreconf` for the embedded libdvd) even with optical/DVD off.** Both are in the Dockerfile.
- **`REUSE_BUILD=1` is not free:** it skips configure and source extraction but `make` still rebuilt the whole tree (generated inputs are re-touched; it took 55 min under load 14 vs ~4 min clean). To change only presets/installer/verify use **`REPACK=1`** (skips source + build, re-runs verify + package on the existing `stage/`).
- **The build is not reproducible offline:** the Debian tarballs are fetched (checksum-pinned) and `apt` runs unpinned in the Dockerfile.
- Debian security updates to Kodi/FFmpeg are not followed; rebuild when trixie moves.

## Follow-ups (not done, not authorized work)

- Run the first-run list above on the box and append the results here, including the card-selection outcome and fps/CPU against the mpv figure (40 fps / 6.3 s).
- If `useprimerenderer=0` falls back to GLES: log which precondition failed (`CDRMPlane::SupportsFormatAndModifier - format not supported` is logged at debug).
- Kodi 22 once released, if D2P screencap/HDR/filters matter; this setup is deliberately 21.2 for stability.
