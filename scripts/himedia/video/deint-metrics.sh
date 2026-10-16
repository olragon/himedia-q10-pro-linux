#!/bin/bash
# deint-metrics.sh <clip-basename> <hw.nv12> <W> <H> [frames] — Mac: measure a hardware-deinterlaced decode.
# hw.nv12 = raw NV12 frames the VDH+VPSS produced (see deint-box-run.sh). Prints, for the hw output and for the plain
# woven software decode: ffmpeg idet verdict (TFF/BFF = still combed, Progressive = clean), and PSNR of the hw output
# against software yadif / bwdif at frame rate (mode=0: one progressive frame per interlaced frame).
set -eu
C=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/$1.mkv; HW=$2; W=$3; H=$4; N=${5:-100}
T=$(mktemp -d ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/varout/deint.XXXXXX)
raw="-f rawvideo -pix_fmt nv12 -s ${W}x${H} -r 25"
idet() { ffmpeg -nostdin -v info "$@" -vf idet -frames:v $N -f null - 2>&1 | grep "Multi frame detection" | sed 's/.*detection: //'; }
echo "idet hw output   : $(idet $raw -i $HW)"
echo "idet woven sw    : $(idet -i $C)"
for f in yadif=mode=0:parity=tff bwdif=mode=0:parity=tff; do
  n=${f%%=*}
  ffmpeg -nostdin -v error -y -i $C -vf $f -pix_fmt nv12 -frames:v $N -f rawvideo $T/$n.nv12
  echo "PSNR hw vs $n: $(ffmpeg -nostdin -v info $raw -i $HW $raw -i $T/$n.nv12 -lavfi psnr -frames:v $N -f null - 2>&1 | grep -o 'PSNR y.*average:[0-9.]*' | tail -1)"
done
echo "PSNR woven sw vs yadif (reference gap): $(ffmpeg -nostdin -v info -i $C $raw -i $T/yadif.nv12 -lavfi "[0:v]format=nv12[a];[a][1:v]psnr" -frames:v $N -f null - 2>&1 | grep -o 'PSNR y.*average:[0-9.]*' | tail -1)"
rm -rf $T
