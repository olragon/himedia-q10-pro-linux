#!/bin/bash
# bench-on-box.sh [after-log] — MEASURE software decode speed per codec on the Q10 (no display
# needed): ffmpeg decodes each clip to null on all cores; "speed" >= 1.0x means real time.
# Clips: make-clips.sh (10 s, 30 fps, 720p + 1080p, H.264/HEVC/VP9/AV1/MPEG-2).
set -uo pipefail
H=${Q10_HOST:-root@q10.local}; SSH="ssh -o BatchMode=yes -o ConnectTimeout=5"
C=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/video-clips
if [ -n "${1:-}" ]; then until grep -qE "=== audio done" "$1" 2>/dev/null; do sleep 30; done; fi
until $SSH $H true 2>/dev/null; do sleep 20; done
$SSH $H 'command -v ffmpeg >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q ffmpeg >/dev/null 2>&1; ffmpeg -hide_banner -decoders 2>/dev/null | grep -E " (h264|hevc|vp9|libdav1d|av1|mpeg2video|vc1) " ; mkdir -p /root/clips'
scp -q -o BatchMode=yes "$C"/* $H:/root/clips/
echo "[local->remote:$H] cores: $($SSH $H nproc)  kernel: $($SSH $H uname -r)"
$SSH $H 'cd /root/clips; for f in $(ls | sort); do
  s=$(ffmpeg -hide_banner -nostats -benchmark -threads 0 -i $f -f null - 2>&1 | grep -oE "speed= *[0-9.]+x" | tail -1)
  printf "%-18s %s\n" "$f" "${s:-FAILED}"; done'
echo "=== bench done $(date +%H:%M:%S) ==="
