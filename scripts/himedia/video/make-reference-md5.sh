#!/bin/bash
# make-reference-md5.sh — software reference framemd5 for the codec matrix, computed on the Mac
# (much faster than the box). Bit-exact decode is codec-defined, so these equal the box's software
# md5s. nv12 for every clip, plus p010le for the 10-bit clip (a P010 hw capture cannot be compared
# against an 8-bit reference). Output: ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/ref/<name>.<fmt>.md5
set -eu
C=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips; R=$C/ref; mkdir -p $R
for f in $C/*.mkv; do
  n=$(basename $f .mkv)
  ffmpeg -y -nostdin -v error -i $f -map 0:v -pix_fmt nv12 -f framemd5 $R/$n.nv12.md5
  case $n in hevc10*) ffmpeg -y -nostdin -v error -i $f -map 0:v -pix_fmt p010le -f framemd5 $R/$n.p010le.md5;; esac
  echo "$n $(grep -vc '^#' $R/$n.nv12.md5) frames"
done
