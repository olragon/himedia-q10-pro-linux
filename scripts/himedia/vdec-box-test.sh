#!/bin/bash
# vdec-box-test.sh <ko|-> <clip-basename>... — from the Mac: (optionally) swap histb_vdec on the box
# for <ko> via q10-wd-run, then run q10-codec-matrix one clip at a time under q10-wd-run, saving the
# matrix line and the per-clip dmesg into archive/. "-" = leave the loaded module alone.
# Rules (hard): never reboot/kexec; only rmmod histb_vdec + insmod under the watchdog.
# usage: vdec-box-test.sh $HIMEDIA_ROOT/.../histb-vdec-x.ko h264-1080p-60 hevc-1080p-30
set -u
BOX=${Q10_HOST:-root@q10.local}
ko=$1; shift
ts=$(date +%Y%m%d-%H%M%S)
A=$(cd "$(dirname "$0")/../.." && pwd)/archive
tag=${VDEC_TAG:-test}
if [ "$ko" != "-" ]; then
  scp -q "$ko" $BOX:/tmp/histb-vdec.ko.new || exit 1
  # VPSS shares histb-dma.h: swap it too when a build for it sits beside the vdec .ko (histb-vpss-<same suffix>.ko)
  vp="$(dirname "$ko")/$(basename "$ko" | sed 's/histb-vdec/histb-vpss/')"
  [ -f "$vp" ] && scp -q "$vp" $BOX:/tmp/histb-vpss.ko.new
  ssh $BOX 'systemctl is-active --quiet q10-kodi && systemctl stop q10-kodi
    mkdir -p /root/vdec-test; cp /tmp/histb-vdec.ko.new /root/vdec-test/histb-vdec.ko
    lsmod | grep -q "^histb_vdec" && rmmod histb_vdec
    if [ -f /tmp/histb-vpss.ko.new ]; then lsmod | grep -q "^histb_vpss" && rmmod histb_vpss; cp /tmp/histb-vpss.ko.new /root/vdec-test/histb-vpss.ko; q10-wd-run insmod /root/vdec-test/histb-vpss.ko; rm /tmp/histb-vpss.ko.new; fi
    dmesg -C; q10-wd-run insmod /root/vdec-test/histb-vdec.ko; echo insmod_rc=$?; modinfo -F vermagic /root/vdec-test/histb-vdec.ko
    ls /dev/video* | head' || exit 1
fi
scp -q "$(dirname "$0")/video/hw-vs-cached-sw.sh" $BOX:/root/vdec-test/ 2>/dev/null || { ssh $BOX mkdir -p /root/vdec-test; scp -q "$(dirname "$0")/video/hw-vs-cached-sw.sh" $BOX:/root/vdec-test/; }
ssh $BOX mkdir -p /root/vdec-test/ref; scp -q ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/clips/ref/*.md5 $BOX:/root/vdec-test/ref/
for c in "$@"; do
  ssh $BOX "sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory; cd /root/clips && dmesg -C; q10-wd-run env REF=/root/vdec-test/ref REFFMT=${FMT:-nv12} LIMIT=${LIMIT:-} FMT=${FMT:-nv12} TMO=${TMO:-120} DM=${DM:-40} /root/vdec-test/hw-vs-cached-sw.sh $c.mkv" > $A/$ts-vdec-$tag-$c.log 2>&1
  sed -n '1,/---DMESG---/p' $A/$ts-vdec-$tag-$c.log | grep -v -- '---DMESG'
  echo "   dmesg lines: $(sed -n '/---DMESG---/,$p' $A/$ts-vdec-$tag-$c.log | wc -l) -> $A/$ts-vdec-$tag-$c.log"
done
