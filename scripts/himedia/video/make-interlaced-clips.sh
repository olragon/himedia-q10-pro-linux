#!/bin/bash
# make-interlaced-clips.sh — Mac: true interlaced test clips (50 fps source -> 25i, so moving parts comb) for the VPSS
# deinterlace work (docs/261012-himedia-vdec-hevc-mpeg2.md "Hardware deinterlace"). Output ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/
#   mpeg2-1080i-25.mkv  MPEG-2 1080i, top field first, frame pictures + interlaced DCT
#   h264-1080i-25.mkv   H.264 High 1080i MBAFF, top field first
#   mpeg2-576i-25.mkv   already made by make-test-clips.sh (720x576)
set -eu
O=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips
src="testsrc2=size=1920x1080:rate=50,format=yuv420p"
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$src" -t 8 -vf interlace=scan=tff -c:v mpeg2video -flags +ilme+ildct -field_order tt -b:v 14M -g 12 $O/mpeg2-1080i-25.mkv
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$src" -t 8 -vf interlace=scan=tff -c:v libx264 -preset veryfast -flags +ilme+ildct -x264-params interlaced=1:tff=1 -b:v 10M -g 50 $O/h264-1080i-25.mkv
ls -l $O/*i-25.mkv
