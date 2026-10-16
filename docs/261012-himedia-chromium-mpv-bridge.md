# HiMedia Q10 Pro: Chromium -> hardware mpv bridge

Code: `scripts/himedia/browser/` (extension, native host, installer, tests). Status: **written and unit-tested on the Mac; nothing has run on the box.**

## Why not decode in the browser

Chromium 150 on this box has no hardware video path: its V4L2 stateless decoder (`V4L2StatelessVideoDecoder`) is built and
supported for ChromeOS only, and there is no VA-API driver for the Hi3798CV200 VDEC. Rebuilding Chromium with that path is out of
scope. mpv, linked to the Kwiboo FFmpeg with the v4l2request hwaccel, already decodes 1080p H.264 at ~40 fps at low CPU
(`docs/261011-himedia-mpv-v4l2request.md`). So the browser only *finds* the video; mpv plays it.

## Design

```
Chromium  --(MV3 extension: toolbar / context menu / <video> overlay)-->  chrome.runtime.sendNativeMessage("vn.himedia.mpv_hw")
   --> /usr/local/lib/q10/mpv_hw_host.py  (stdlib Python, 4-byte length + JSON)
   --> mpv-v4l2req --hwdec=v4l2request --profile=fast --fullscreen --ytdl-format=<avc1> --vo=gpu --gpu-context=x11egl -- <url>
```

- **Extension** (`extension/`, MV3, no dependencies): toolbar click plays the tab URL; context menu "Play in mpv (HW)" on
  page / link / video / frame (link URL wins, then a http(s) video `src`, then the page); an overlay button appears over any
  `<video>` >= 200x120 on hover (looks through the element stack, because players cover the video). The reply shows as a badge
  (OK/ERR) and a notification.
- **Host** (`mpv_hw_host.py`): one message in, one out. URL must be a single token, `http`/`https`, with a host, <= 4096 chars,
  no whitespace/control characters. It is passed as one argv element after `--`; `shell=True` is never used (a test proves
  `$(touch ...)` in a URL does not run). mpv is launched with `start_new_session=True`, stdio to `/var/log/q10-mpv-bridge.log`
  (so it never touches the protocol stdout). A new request ends the previous mpv the host started (pidfile
  `/run/q10-mpv-bridge.pid`, cmdline checked): there is one decoder.
- **yt-dlp format**: `bv*[vcodec^=avc1][height<=1080]+ba/b[vcodec^=avc1][height<=1080]/b[height<=1080]` - H.264 first (the only
  codec proven on the decoder, and AV1 has no hardware), 1080p cap, then any <=1080p as a software-decode last resort.
- **Output choice** (`pick_vo`, decided from `mpv --gpu-context=help` + whether X is up): X up -> `x11egl`; no X -> `drm`
  (`--drm-device=/dev/dri/card1`). **X up but mpv lacks `x11egl` -> refuse with a clear error**, never try DRM (Xorg holds DRM
  master), and never fall back to `v4l2request-copy` with Debian's `/usr/bin/mpv` (its libavcodec has no v4l2request).
- `{"action":"ping"}` returns yt-dlp/mpv presence and the contexts the mpv offers.

## mpv X11 rebuild (required for the X desktop)

The original mpv was built `-Dx11=disabled`. `build-mpv-v4l2req.sh` now takes `X11=1` (default) and the Dockerfile gained
`libx11 libxext libxpresent libxrandr libxss libxkbcommon libxinerama libxv libxcb` dev packages. DRM context is kept.

| | |
| --- | --- |
| Artifact | `$HIMEDIA_ROOT/mpv-v4l2req/mpv-v4l2req-x11-armhf.tar.gz` (906,294 bytes) |
| sha256 | `ff9971bd28534d80909038bc54920b86b645889870eff35a723a3d00fc51e79c` |
| Source commit | `783f967a2e5e10ce2541bf6be755a285cfbb6f17` |
| qemu | `--gpu-context=help`: `auto`, `x11egl`, `drm`. `--hwdec=help`: `v4l2request` + `v4l2request-copy` for h264/hevc/mpeg2video/vp8/vp9/av1. `config.h`: `HAVE_X11 1 HAVE_EGL_X11 1 HAVE_DRM 1 HAVE_V4L2REQUEST 1` |
| Old DRM-only tarball | untouched (`mpv-v4l2req-armhf.tar.gz`, 6c11dc98...) |

The sha above is the one printed by the build; confirm with the `.sha256` file next to the tarball before copying.
`install-mpv-v4l2req.sh` now checks `<tarball>.sha256` generically and installs the X runtime libs (`libx11-6 libxext6
libxpresent1 libxrandr2 libxss1 libxv1`). Same install path `/opt/mpv-v4l2req`, so it replaces the DRM-only build.

## Extension ID and key

`manifest.json` carries a fixed `"key"` (RSA-2048 public key, DER base64), so the ID is stable across installs:
**`ndcllcbcfbjcioigndaglbfkaofdpaee`**. The ID is derived, not stored: `python3 scripts/himedia/browser/extension-id.py
extension/manifest.json` (sha256 of the DER key, first 16 bytes, hex digits mapped 0-f -> a-p). The installer runs that and
writes it into the host manifest's `allowed_origins`, so manifest.json is the single source.
The private key was generated with `openssl genrsa 2048`, used only to derive the public key, and **discarded**: it is needed
only to sign a CRX. To rotate: `openssl genrsa -out k.pem 2048; openssl rsa -in k.pem -pubout -outform DER | base64 -w0`,
paste into `"key"`, reinstall (the ID changes; the installer follows).

## Loading choice

`ExtensionInstallForcelist` accepts only an update-manifest URL pointing at a CRX (web store or a self-hosted update server),
which needs a signed CRX and a served `update.xml`: more moving parts than a test box warrants. So the installer drops
`/etc/chromium.d/q10-mpv-bridge` exporting `CHROMIUM_FLAGS="$CHROMIUM_FLAGS --load-extension=/usr/share/q10/mpv-bridge-extension"`
(Debian's launcher sources `/etc/chromium.d/*`). Risk: Chrome 137+ removed `--load-extension` in *branded* Chrome; Debian
Chromium is unbranded and should keep it, but that is **unverified**. If the extension does not appear: open
`chrome://extensions`, enable Developer mode, "Load unpacked" `/usr/share/q10/mpv-bridge-extension` (the key keeps the ID, so
the host manifest still matches). Another `--disable-features=` line in `/etc/chromium.d` would not clash with this, but a later
duplicate switch overrides an earlier one; the installer warns when it sees one.

## Install / uninstall (on the box, as root)

```
# from the Mac (the box is 192.168.1.56; this was not done by the author)
scp $HIMEDIA_ROOT/mpv-v4l2req/mpv-v4l2req-x11-armhf.tar.gz{,.sha256} scripts/himedia/video/install-mpv-v4l2req.sh root@q10.local:/tmp/
scp -r scripts/himedia/browser root@q10.local:/tmp/mpv-bridge
# on the box
sh /tmp/install-mpv-v4l2req.sh install /tmp/mpv-v4l2req-x11-armhf.tar.gz
sh /tmp/mpv-bridge/install-mpv-bridge.sh install
sh /tmp/mpv-bridge/install-mpv-bridge.sh uninstall      # removes extension, host, manifest, flag file
```

## Box test steps

```
mpv-v4l2req --gpu-context=help | grep x11egl                     # x11egl present
mpv-v4l2req --hwdec=help | grep v4l2request
which yt-dlp && yt-dlp --version
# 1. host alone (no browser), from an X terminal or with DISPLAY=:0
python3 - <<'PY'
import struct, subprocess, json
m = json.dumps({"action":"play","url":"https://www.youtube.com/watch?v=aqz-KE-bpKQ"}).encode()
p = subprocess.run(["/usr/local/lib/q10/mpv_hw_host.py"], input=struct.pack("=I", len(m))+m, capture_output=True, env={"DISPLAY":":0","PATH":"/usr/local/bin:/usr/bin:/bin"})
print(p.stdout[4:].decode())
PY
tail -f /var/log/q10-mpv-bridge.log                              # look for: Using hardware decoding (v4l2request)
top -b -n3 -d2 | grep mpv                                        # CPU low = hwdec is real
# 2. browser: restart Chromium (pkill chromium), confirm chrome://extensions shows "Play in mpv (HW)" with ID ndcllcbcfb...
#    open a YouTube watch page, click the toolbar button -> badge OK, mpv fullscreen; right-click link -> Play in mpv (HW)
# 3. refusal paths: ping from the host; stop yt-dlp (mv /usr/bin/yt-dlp{,.off}) and expect an error notification
```
Press `i` in mpv: `hwdec-current` should read `v4l2request`.

## Untested

- Everything on the box: install, Chromium honouring `--load-extension` and finding `/etc/chromium/native-messaging-hosts/`,
  Chromium running as root, the native-messaging launch, the notification (the desktop may have no notification daemon; the badge still works).
- mpv `vo=gpu` + `x11egl` on panfrost GLES2 with dmabuf import of the v4l2request surface (the DRM path was the one benchmarked; `x11egl` is a different EGL platform and may need `--opengl-es=yes`).
- Whether yt-dlp offers avc1 <=1080p for a given site (YouTube often does; some sites do not and fall to the last format alternative, software decode).
- Behaviour of `--fullscreen` under openbox, Xorg DISPLAY/XAUTHORITY when the host is launched by Chromium as root (assumed inherited).
- Host-side: ping's context probe and the `/proc` pid check were tested only with a fake mpv on macOS (the pidfile kill path is not exercised).
- HEVC/VP9/MPEG-2 playback (exposed by the decoder, never run); an HEVC-only stream would pick the `b[height<=1080]` fallback.
