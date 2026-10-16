#!/bin/bash
# codec-matrix-test.sh <clip>... — ON THE BOX, under q10-wd-run: per clip, decode with the VDH
# (FFmpeg v4l2request hwaccel, copy-back to NV12) and with software, compare per-frame md5
# (framemd5), report frames, hw fps, CPU seconds, mismatching frames and new kernel warnings.
# Video modules must be loaded (q10-video-stack). docs/261012-himedia-q10-hw-optimizations.md item 1
set -u
FF=ffmpeg-v4l2req; OUT=/var/log/q10/codec-matrix; mkdir -p $OUT
cpu() { awk '/^cpu /{print $2+$3+$4+$7+$8}' /proc/stat; }
printf "%-24s %6s %6s %8s %8s %6s %s\n" clip frames hwfps hwcpu_s swfps diff kernel
for c in "$@"; do
  n=$(basename "$c" .mkv)
  dmesg -C 2>/dev/null
  a=$(cpu); t0=$(date +%s.%N)
  timeout 120 $FF -y -nostdin -hide_banner -loglevel error -hwaccel v4l2request -hwaccel_output_format drm_prime -i "$c" -map 0:v -vf hwdownload,format=nv12 -f framemd5 $OUT/$n.hw.md5 2> $OUT/$n.hw.err
  rc=$?; t1=$(date +%s.%N); b=$(cpu)
  timeout 300 $FF -y -nostdin -hide_banner -loglevel error -i "$c" -map 0:v -pix_fmt nv12 -f framemd5 $OUT/$n.sw.md5 2> $OUT/$n.sw.err
  t2=$(date +%s.%N)
  fr=$(grep -vc '^#' $OUT/$n.hw.md5 2>/dev/null); frs=$(grep -vc '^#' $OUT/$n.sw.md5 2>/dev/null)
  diff=$(diff <(grep -v '^#' $OUT/$n.hw.md5 | awk -F, '{print $NF}') <(grep -v '^#' $OUT/$n.sw.md5 | awk -F, '{print $NF}') | grep -c '^<')
  hwfps=$(awk -v f=$fr -v a=$t0 -v b=$t1 'BEGIN{printf "%.1f", f/(b-a)}')
  swfps=$(awk -v f=$frs -v a=$t1 -v b=$t2 'BEGIN{printf "%.1f", f/(b-a)}')
  kw=$(dmesg | grep -ciE "error|fault|oops|timeout|warn")
  # ⛔ STRICT: drm_prime output + hwdownload fails (rc!=0) if decoding fell back to software, which
# would otherwise give matching md5s for the wrong reason.
  fb=$(grep -ciE "Failed setup|fallback|not supported|hwaccel initialisation" $OUT/$n.hw.err)
  printf "%-24s %6s %6s %8s %8s %6s %s rc=%s fallback_msgs=%s sw_frames=%s\n" "$n" "$fr" "$hwfps" "$(( (b-a) ))j" "$swfps" "$diff" "$kw" "$rc" "$fb" "$frs"
done
