#!/bin/bash
# host-install.sh — ON THE BOX (Debian armhf), as root. DRAFT: written from reading Waydroid's
# lxc.py and never run (the task that wrote it forbade touching the box).
# docs/261012-himedia-android-hw-video.md §3.
#
#   host-install.sh nodes    # let the Android container see /dev/media* and open /dev/video*, /dev/media*
#   host-install.sh overlay  # copy overlay/ + the built service + FFmpeg libs into the Waydroid vendor overlay
#   host-install.sh probe    # push v4l2req-probe into the container and run it on a clip
#   host-install.sh undo
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OV=/var/lib/waydroid/overlay/vendor
LXCPY=/usr/lib/waydroid/tools/helpers/lxc.py
RULE=/etc/udev/rules.d/60-q10-vdec-android.rules

nodes() {
  # 1. Waydroid's generate_nodes_lxc_config() already globs /dev/video*; it does NOT glob /dev/media*.
  #    Request-API needs MEDIA_IOC_REQUEST_ALLOC on the media node, so add the same loop.
  if ! grep -q '/dev/media\*' "$LXCPY"; then
    cp -n "$LXCPY" "$LXCPY.q10-orig"
    python3 - "$LXCPY" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
anchor = '    for n in glob.glob("/dev/video*"):\n        make_entry(n)\n'
assert anchor in s, "lxc.py changed shape; re-read generate_nodes_lxc_config"
s = s.replace(anchor, anchor + '    for n in glob.glob("/dev/media*"):\n        make_entry(n)\n', 1)
open(p, "w").write(s)
PY
  fi
  # 2. Android's `media` uid (1013) is not in host group `video`; the container is privileged but
  #    uid-mapped 1:1, so the node mode is what counts. Match histb_vdec by driver, not by number
  #    (video0/media0 numbering is not stable across probes).
  cat > "$RULE" <<'R'
SUBSYSTEM=="video4linux", ATTR{name}=="histb*", MODE="0666"
SUBSYSTEM=="media",       ATTRS{driver}=="histb*", MODE="0666"
R
  udevadm control --reload && udevadm trigger --subsystem-match=video4linux --subsystem-match=media
  ls -l /dev/video* /dev/media* || true
  echo "regenerate the LXC config: waydroid upgrade -o   (then restart the session)"
}

overlay() {
  : "${BUILD:=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/android-hwvideo}"   # on the Mac; scp'd to the box by the caller
  install -d "$OV/etc/init" "$OV/etc/vintf/manifest" "$OV/etc/seccomp_policy" "$OV/bin/hw" "$OV/lib"
  cp -a "$HERE/overlay/vendor/etc/." "$OV/etc/"
  : "${SERVICE:=?}"   # path to the built android.hardware.media.c2@1.2-service-ffmpeg (plan step 4; not built yet)
  [ -f "$SERVICE" ] && install -m0755 "$SERVICE" "$OV/bin/hw/android.hardware.media.c2@1.2-service-ffmpeg"
  [ -d "${LIBS:-/nonexistent}" ] && install -m0644 "$LIBS"/lib{avcodec,avutil,swscale,swresample}.so "$OV/lib/"
  find "$OV" -type f | sort
}

probe() {
  P=${PROBE_DIR:-/root/v4l2req-probe}; CLIP=${1:-/root/h264-1080p.h264}
  waydroid shell -- sh -c 'mkdir -p /data/local/tmp/probe'
  D=/root/.local/share/waydroid/data/local/tmp/probe   # Android /data on this box (docs/261012-himedia-dual-boot-android.md #6)
  mkdir -p "$D"; cp -r "$P"/. "$D"/; cp "$CLIP" "$D"/clip.h264
  waydroid shell -- sh -c 'cd /data/local/tmp/probe && chmod +x v4l2req-probe && ls -l /dev/video0 /dev/media0; ./v4l2req-probe h264 clip.h264 --crc; echo exit=$?'
}

undo() {
  [ -f "$LXCPY.q10-orig" ] && mv "$LXCPY.q10-orig" "$LXCPY"
  rm -f "$RULE"
  rm -f "$OV/etc/media_codecs_ffmpeg.xml" "$OV"/etc/vintf/manifest/android.hardware.media.c2@1.2-service-ffmpeg.xml \
        "$OV"/etc/init/android.hardware.media.c2@1.2-service-ffmpeg.rc \
        "$OV"/etc/seccomp_policy/android.hardware.media.c2@1.2-ffmpeg.policy \
        "$OV"/bin/hw/android.hardware.media.c2@1.2-service-ffmpeg "$OV"/lib/lib{avcodec,avutil,swscale,swresample}.so
}
"${1:?nodes|overlay|probe|undo}" "${@:2}"
