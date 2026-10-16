#!/bin/bash
# mpeg2-variants-box.sh — Mac->box: decode each clip in clips/var on the VDH and print per-frame PSNR vs
# the Mac software decode. Needs the decoder module loaded and CMA free (compact_memory first).
set -u
B=${Q10_HOST:-root@q10.local}; V=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/var; R=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/varout
mkdir -p $R; ssh $B "mkdir -p /root/clips/var; sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory"
scp -q $V/*.mkv $B:/root/clips/var/
for f in ${@:-$(ls $V/*.mkv)}; do n=$(basename $f .mkv)
  ssh $B "cd /root/clips/var; q10-wd-run timeout 60 ffmpeg-v4l2req -y -nostdin -v error -hwaccel v4l2request -hwaccel_output_format drm_prime -i $n.mkv -map 0:v -vf hwdownload,format=nv12 -f rawvideo /tmp/v.nv12" 2>&1 | tail -2
  scp -q $B:/tmp/v.nv12 $R/$n.hw.nv12
  ffmpeg -y -nostdin -v error -i $V/$n.mkv -pix_fmt nv12 -f rawvideo $R/$n.sw.nv12
  echo "== $n"; python3 "$(dirname "$0")/frame-diff.py" $R/$n.hw.nv12 $R/$n.sw.nv12 ${W:-1920} ${H:-1080} | cut -d'|' -f1 | head -${N:-3}
done
