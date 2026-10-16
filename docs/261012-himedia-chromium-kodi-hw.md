# Chromium + Kodi: hardware-level acceleration on the Q10 Pro

**Date:** 2026-10-12
**Status:** Complete (Chromium + Kodi measured on the box; TV look-checks pending, need Tim)

## Goal
Chromium and Kodi on the Q10 use the hardware the box now has: Mali-T720 (Panfrost, GLES 2.0)
for rendering, the VDEC/VPSS V4L2 stateless decoder for video, and the VDP planes for display.

## Starting point (measured 2026-10-11, k15)
- HW decode: GStreamer v4l2sl*, FFmpeg 7.1.5 v4l2request (/opt), mpv 0.40 v4l2request (/opt) —
  mpv 1080p 40 fps at 6.3 s CPU via dmabuf -> panfrost -> VDP.
- Desktop: Xorg modesetting + glamor on Mali-T720 over histb-vdp.
- Chromium 150 (Debian) and Kodi 21.2 (Debian, X11) both render; neither decodes video in hardware.

## Approach
1. **Chromium GPU (me):** read chrome://gpu over CDP on the VDP/glamor desktop; find the flag set
   that gets GPU compositing + rasterization on GLES2/Panfrost (ANGLE vs native EGL); benchmark
   CPU/fps on a scroll + WebGL + video page; ship it as `/etc/chromium.d/q10-gpu`.
2. **Chromium video (agent):** Chromium's V4L2 stateless decoder is ChromeOS-only, and an armhf
   Chromium build is a multi-hour, ~100 GB job — out of scope. Instead a "play with mpv" extension +
   native-messaging host hands the page's video URL (yt-dlp) to mpv-v4l2req, which decodes in HW.
3. **Kodi (agent):** Kodi 21.2 rebuilt against /opt/ffmpeg-v4l2req with GBM windowing + the
   V4L2 Request / DRM-PRIME patches (xbmc #25467 backport or LibreELEC's set), side by side in
   /opt/kodi-v4l2req. GBM on the VDP lets Kodi put decoded frames on the V0 plane (zero copy).
4. Test on the box (me): GPU fault count, fps, CPU for each; watchdog-guarded.

## Files to Change
scripts/himedia/browser/ (flags, extension, native host, CDP probe), scripts/himedia/kodi/
(Dockerfile, build, install, patches), (an unpublished note) (results).

## Validation
- chrome://gpu shows "Hardware accelerated" for compositing/rasterization; CPU lower than now.
- Extension: clicking it on a video page plays it in mpv with `Using hardware decoding (v4l2request)`.
- Kodi GBM plays the 1080p clip with HW decode (Kodi log), CPU near the decode-only figure, 0 js faults.

## Notes
- Never feed software frames into GL on this box: panfrost INSTR_INVALID_PC fault storm (2026-10-11).

## Results — Chromium (2026-10-12, k15, VDP + glamor desktop, all runs under `q10-wd-run`)

**Chromium GPU.** [read] Chromium 150 refuses the T720's context: `GLES3 is unsupported and ES
version fallback is disabled`, ANGLE `Could not create a backing OpenGL context` → the GPU process
exits and everything is CPU-rendered, no WebGL. panfrost exposes GLES 2.0 only; `PAN_MESA_DEBUG=gl3`
alone changes nothing; **`MESA_GLES_VERSION_OVERRIDE=3.0`** makes it report ES 3.0 and Chromium keeps
its GPU process. `scripts/himedia/browser/chrome-gpu-probe.py` + `gpu-test.html` (40 CSS layers +
WebGL), 20 s each:

| flag set | page fps | box CPU s / 20 s | WebGL | panfrost faults |
| --- | ---: | ---: | --- | ---: |
| Debian default (`--enable-gpu-rasterization`) | 11.7 | 34.8 | no | 0 |
| + `MESA_GLES_VERSION_OVERRIDE=3.0` | **38** | 35.1 | **yes** | 0 |
| + `PAN_MESA_DEBUG=gl3` too | 37.5 | 32.5 | yes | 0 |
| ES3 override, **180 s soak** | 38 (35-40, 90 samples) | 324.8 / 180 | yes | **0** |

⇒ 3.2x the frames for the same CPU. Shipped as `/etc/chromium.d/q10-gpu`
(`scripts/himedia/browser/q10-gpu.chromium.d`), scoped to Chromium's process tree.
⚠️ The override claims a GLES level the T720 is not certified for; a page using ES3-only features
(WebGL2 in particular) may misrender or fault. Watch `dmesg | grep "js fault"` on real browsing.
⚠️ The probe's chrome://gpu text parse still returns nothing (info-view shadow DOM); the evidence
above is the GPU-process log + WebGL availability + fps, not the feature table.

**Chromium video → mpv bridge** (agent-built, `scripts/himedia/browser/`, extension id
`ndcllcbcfbjcioigndaglbfkaofdpaee`). [read] `bridge-e2e.py` drives the extension's own
`sendNativeMessage` over DevTools: extension loaded via `--load-extension` (Chromium 150 honours
it); `play` → host launched mpv-v4l2req (X11 build, sha256 ff9971bd) with `--vo=gpu
--gpu-context=x11egl --hwdec=v4l2request`; mpv holds **/dev/media0 + /dev/video0 + renderD128** =
the hardware decoder; box CPU 6.6 s over 12 s of 1080p; 0 faults. mpv under X by hand: 40.1 fps
1080p, 6.47 s CPU, `Using hardware decoding (v4l2request)`, `Using EGL dmabuf interop`.
⚠️ `Runtime.evaluate … awaitPromise` never returns in an MV3 service worker here — call, then poll.
⚠️ The first native `ping` after Chromium starts can exceed 10 s (cold self-test).
⚠️ Not yet tested: a real YouTube page through yt-dlp (needs network + avc1 availability), HEVC/VP9.

## Results — Kodi (2026-10-12, k15, all runs under `q10-wd-run`, q10-desktop stopped for DRM master)

Kodi 21.2 GBM + v4l2request backport (`docs/261012-himedia-kodi-v4l2request.md`, tarball sha256
`10030be8`), installed side by side in `/opt/kodi-v4l2req`. Bench: `scripts/himedia/kodi/kodi-box-test.sh`
(on the box as `kodi-box-test <clip> [secs] [direct|gles]`). Clips from
`scripts/himedia/video/make-test-clips.sh` (timed MKV; the raw `.h264` clips cannot be remuxed).
25 s window starting 3 s after the codec opens, warm profile (`KEEP=1`). Decoded fps = `v4l2:v4l2_dqbuf`
CAPTURE events / window [read]; HW proof = the `creating v4l2request hwdevice context` log line **and**
kodi-gbm holding `/dev/media0` + `/dev/video0` [read].

| clip | renderer | decoded fps | Kodi CPU s / 25 s | box CPU s / 25 s | V0 plane | faults | commit fails |
| --- | --- | ---: | ---: | ---: | --- | ---: | ---: |
| 1080p60 H.264 | direct (V0 plane) | **60.6** | **7.59** | 8.89 | fb set | 0 | 0 |
| 1080p60 H.264 | GLES (panfrost -> G0) | 60.7 | 8.28 | 10.91 | off | 0 | 0 |
| 720p60 H.264 | direct + ZME scale | 60.6 | 7.67 | 8.69 | fb set | 0 | 0 |
| 720p60 H.264 | GLES | 60.7 | 8.43 | 10.47 | off | 0 | 0 |
| 1080p60 H.264 + AAC | direct, ALSA S16 | 60.6 | 8.28 | 9.02 | fb set | 0 | 0 |

⇒ Real-time 60 fps at ~0.3 of one core (box: ~9% of 4 cores); 5.9 ms box CPU per frame vs mpv's
GPU path 20.9 ms/frame. Thread split (1080p direct): kodi-gbm 2.4 s, FFmpeg frame threads
`av:h264:df0-3` ~4.4 s together (slice parsing for the hwaccel), VideoPlayer 0.9 s.

Found and fixed on the way:
- ⛔ **720p direct failed silently without `allow_scale=1`**: 1,118 `test commit failed: (Numerical
  result out of range)` in 25 s — Kodi re-showed the last good frame while decode still reported 60 fps,
  and burnt 19.9 s CPU. Reloaded `histb_vdp allow_scale=1` (`scripts/himedia/vdp/vdp-reload.sh`):
  0 failures, ZME programmed 1280x720 -> 1920x1080 [read, `histb_vdp_regs`], CPU 7.7 s. Persisted as
  `/etc/modprobe.d/q10-vdp.conf` (`scripts/himedia/rootfs-units/`). Scaled picture quality is **unverified**.
- ⛔ **No sound card on k15**: `q10_aiao.ko` is out-of-tree and was only built for k14 → Kodi
  `no sink was returned` twice a second. Built for k15 (`scripts/himedia/audio/build.sh`), installed,
  loaded guarded: card `Q10 [RCA + S/PDIF + HDMI]`, Kodi opens `sysdefault:CARD=Q10` S16, ALSA
  RUNNING with hw_ptr advancing [read]. Audible? not checked (needs ears).
- ⚠️ Bench traps (both produced false numbers before the fix): a kept profile keeps the resume point
  (clip starts near its end) and the previous `kodi.log` (the "codec opened" wait matches the old line,
  so the window swallows ~15 s of start-up: a false 24 fps); `/proc/stat` field 6 is iowait, not CPU.
- ⚠️ `drm_vblank_event_queued` stays 0 — histb-vdp sends its events without that path, so page-flip
  rate is not measured; displayed-frame drops are not measured either (Kodi keeps them in its debug
  overlay only).
- The first fresh-profile run spends ~4.7 s CPU on JobWorker (add-on repo jobs) — not playback cost.

Not verified: picture on the TV (direct, GLES, scaled), audibility, A/V sync by eye, HEVC/VP9/MPEG-2,
remote/CEC input, Kodi as a boot-time session.
