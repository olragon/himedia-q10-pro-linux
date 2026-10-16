#!/bin/bash
# mpeg2-variants.sh — Mac: build short MPEG-2 clips that each change ONE encoder feature, to find which
# one the VDH decodes differently from software (docs/261012-himedia-vdec-hevc-mpeg2.md). Output
# ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/var/. Then: mpeg2-variants-box.sh
set -eu
O=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/var; mkdir -p $O
src="testsrc2=size=${SIZE:-1920x1080}:rate=30,format=yuv420p"
enc() { n=$1; shift; ffmpeg -hide_banner -loglevel error -y -f lavfi -i "$src" -frames:v 8 -c:v mpeg2video -g 4 "$@" $O/$n.mkv; }
enc base12M -b:v 12M
enc q2 -qscale:v 2
enc q10 -qscale:v 10
enc b3M -b:v 3M
enc ivlc -b:v 12M -intra_vlc 1
enc altscan -b:v 12M -alternate_scan 1
enc nonlin -b:v 12M -non_linear_quant 1 -qmax 28
enc dcp10 -b:v 12M -dc 10
enc bf0 -b:v 12M -bf 0
ls $O
