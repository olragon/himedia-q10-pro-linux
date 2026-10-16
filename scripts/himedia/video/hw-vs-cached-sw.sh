#!/bin/bash
# hw-vs-cached-sw.sh <clip>... — ON THE BOX, under q10-wd-run: like codec-matrix-test.sh but the
# software reference md5 is REUSED from /var/log/q10/codec-matrix/<n>.sw.md5 (produced once by the
# full matrix; software decode is the slow half). Strict: drm_prime + hwdownload, fails on fallback.
# REF=<dir> REFFMT=<nv12|p010le>: reference md5 from <dir>/<n>.<REFFMT>.md5 (default: box sw run).
# Extra: first differing frame index, and optional LIMIT=<frames> to stop early (-frames:v).
set -u
FF=ffmpeg-v4l2req; OUT=/var/log/q10/codec-matrix
for c in "$@"; do
  n=$(basename "$c" .mkv); lim=${LIMIT:+-frames:v $LIMIT}
  dmesg -C 2>/dev/null; t0=$(date +%s.%N)
  timeout ${TMO:-120} $FF -y -nostdin -hide_banner -loglevel error -hwaccel v4l2request -hwaccel_output_format drm_prime -i "$c" -map 0:v $lim -vf hwdownload,format=${FMT:-nv12} -f framemd5 $OUT/$n.hw.md5 2> $OUT/$n.hw.err
  rc=$?; t1=$(date +%s.%N)
  fr=$(grep -vc '^#' $OUT/$n.hw.md5 2>/dev/null)
  grep -v '^#' $OUT/$n.hw.md5 | awk -F, '{gsub(/ /,"",$NF); print $NF}' > /tmp/hw.$$
  grep -v '^#' ${REF:-$OUT}/$n.${REFFMT:-sw}.md5 | awk -F, '{gsub(/ /,"",$NF); print $NF}' | head -n $fr > /tmp/sw.$$
  nd=$(paste /tmp/hw.$$ /tmp/sw.$$ | awk '$1!=$2{c++} END{print c+0}')
  first=$(paste /tmp/hw.$$ /tmp/sw.$$ | awk '$1!=$2{print NR-1; exit}')
  fps=$(awk -v f=$fr -v a=$t0 -v b=$t1 'BEGIN{printf "%.1f", f/(b-a)}')
  printf "%-22s hw_frames=%s sw_ref=%s differ=%s first_diff=%s fps=%s rc=%s\n" "$n" "$fr" "$(wc -l < /tmp/sw.$$)" "$nd" "${first:--}" "$fps" "$rc"
  head -3 $OUT/$n.hw.err
  echo "---DMESG---"; dmesg | tail -${DM:-40}
  rm -f /tmp/hw.$$ /tmp/sw.$$
done
