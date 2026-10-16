#!/bin/bash
# make-clips.sh — encode the same 10 s synthetic clip in every codec the box must play, at 720p
# and 1080p, so decode speed can be MEASURED on the box (ffmpeg -benchmark), not guessed.
# Output: ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/video-clips/ (transient bytes, not the repo).
set -euo pipefail
O=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/video-clips; mkdir -p "$O"
src() { echo "-f lavfi -i testsrc2=size=$1:rate=$2,format=yuv420p -t 10"; }
for res in 1280x720 1920x1080; do
  h=${res#*x}
  # shellcheck disable=SC2046
  ffmpeg -y -hide_banner -loglevel error $(src $res 30) -c:v libx264 -preset medium -b:v 4M  "$O/h264-${h}p.mp4"
  ffmpeg -y -hide_banner -loglevel error $(src $res 30) -c:v libx265 -preset fast -b:v 3M -tag:v hvc1 "$O/hevc-${h}p.mp4"
  ffmpeg -y -hide_banner -loglevel error $(src $res 30) -c:v libvpx-vp9 -b:v 3M -deadline realtime -cpu-used 8 "$O/vp9-${h}p.webm"
  ffmpeg -y -hide_banner -loglevel error $(src $res 30) -c:v libsvtav1 -preset 10 -b:v 2M "$O/av1-${h}p.mkv"
  ffmpeg -y -hide_banner -loglevel error $(src $res 30) -c:v mpeg2video -b:v 8M "$O/mpeg2-${h}p.ts"
done
ls -l "$O"
