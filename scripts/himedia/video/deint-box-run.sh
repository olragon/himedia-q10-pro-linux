#!/bin/bash
# deint-box-run.sh <clip-basename> <W> <H> [frames=100] — Mac: decode an interlaced clip on the box with the VDH (module loaded
# with deinterlace=1 for the hardware path, =0 for the woven baseline), pull the raw NV12 and run deint-metrics.sh.
# Prints fps and the box CPU used while decoding. Box rules: under q10-wd-run, never reboot.
set -eu
here=$(cd "$(dirname "$0")" && pwd); B=${Q10_HOST:-root@q10.local}; n=$1; W=$2; H=$3; N=${4:-100}
scp -q ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/$n.mkv $B:/root/clips/
ssh $B "echo 1 > /proc/sys/vm/compact_memory; cd /root/clips; a=\$(awk '/^cpu /{print \$2+\$3+\$4+\$7+\$8}' /proc/stat); t0=\$(date +%s.%N)
  q10-wd-run timeout 120 ffmpeg-v4l2req -y -nostdin -v error -hwaccel v4l2request -hwaccel_output_format drm_prime -i $n.mkv -map 0:v -frames:v $N -vf hwdownload,format=nv12 -f rawvideo /tmp/deint.nv12
  t1=\$(date +%s.%N); b=\$(awk '/^cpu /{print \$2+\$3+\$4+\$7+\$8}' /proc/stat)
  echo fps=\$(awk -v n=$N -v a=\$t0 -v b=\$t1 'BEGIN{printf \"%.1f\", n/(b-a)}') cpu_jiffies=\$((b-a)) of \$(awk -v a=\$t0 -v b=\$t1 'BEGIN{printf \"%d\", (b-a)*400}'); dmesg | tail -3"
scp -q $B:/tmp/deint.nv12 ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/varout/deint-$n.nv12
"$here/deint-metrics.sh" $n ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/varout/deint-$n.nv12 $W $H $N
