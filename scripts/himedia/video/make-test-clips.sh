#!/bin/bash
# make-test-clips.sh — Mac side: build timed H.264 test clips in MKV for players that need container
# timestamps (Kodi). The box's raw .h264 clips cannot be remuxed: FFmpeg 7 refuses "packet with
# unknown timestamp" even with -framerate/+genpts (2026-10-12). Output -> ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/
# then scp to ${Q10_HOST:-root@q10.local}:/root/.
set -euo pipefail
O=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips; mkdir -p "$O"
for spec in 1920x1080:1080p 1280x720:720p; do
  s=${spec%%:*} n=${spec##*:}
  ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=$s:rate=60,format=yuv420p" -t 40 \
    -c:v libx264 -profile:v high -preset veryfast -b:v 8M -g 120 "$O/h264-$n-60.mkv"
done
# A/V clip: 1080p60 + 48 kHz stereo AAC (1 kHz tone, quiet) — exercises Kodi's audio sink + A/V clock
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=1920x1080:rate=60,format=yuv420p" \
  -f lavfi -i "sine=frequency=1000:sample_rate=48000" -t 40 -ac 2 \
  -c:v libx264 -profile:v high -preset veryfast -b:v 8M -g 120 -c:a aac -b:a 128k -af volume=0.1 "$O/h264-1080p-60-aac.mkv"
# Codec matrix for the VDH (item 1 of docs/261012-himedia-q10-hw-optimizations.md): 1080p, 10 s,
# plus a 300-frame raw elementary stream of each for bit-exactness checks.
src="testsrc2=size=1920x1080:rate=30"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$src,format=yuv420p" -t 10 -c:v libx265 -preset fast -b:v 6M -x265-params log-level=error "$O/hevc-1080p-30.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$src,format=yuv420p10le" -t 10 -c:v libx265 -profile:v main10 -preset fast -b:v 6M -x265-params log-level=error "$O/hevc10-1080p-30.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$src,format=yuv420p" -t 10 -c:v libvpx-vp9 -b:v 4M -deadline realtime -cpu-used 8 "$O/vp9-1080p-30.mkv"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$src,format=yuv420p" -t 10 -c:v mpeg2video -b:v 12M -g 15 "$O/mpeg2-1080p-30.mkv"
# interlaced MPEG-2 (576i, TV/DVD style) for the deinterlace item
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=720x576:rate=50,format=yuv420p" -t 10 -vf interlace -c:v mpeg2video -flags +ilme+ildct -field_order tt -b:v 6M "$O/mpeg2-576i-25.mkv"
# 4K HEVC for the display item
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "testsrc2=size=3840x2160:rate=30,format=yuv420p" -t 5 -c:v libx265 -preset ultrafast -b:v 15M -x265-params log-level=error "$O/hevc-2160p-30.mkv"
ls -la "$O"; shasum -a 256 "$O"/*.mkv
