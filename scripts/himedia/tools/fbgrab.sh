#!/bin/bash
# fbgrab.sh <name> — grab the Q10's HDMI picture into archive/<ts>-q10-screen-<name>.png (Mac side).
set -euo pipefail
name=${1:-screen}; here=$(cd "$(dirname "$0")/../../.." && pwd)
out="$here/archive/$(date +%Y%m%d-%H%M%S)-q10-screen-$name.png"
raw=$(mktemp); trap 'rm -f "$raw"' EXIT
ssh -o BatchMode=yes ${Q10_HOST:-root@q10.local} q10-fbgrab > "$raw"
# bgr0, not bgra: an XRGB scanout (X=0) read as alpha renders as all-transparent = a white PNG
ffmpeg -hide_banner -loglevel error -y -f rawvideo -pix_fmt bgr0 -s 1920x1080 -i "$raw" -vf scale=960:540 "$out"
echo "$out"
