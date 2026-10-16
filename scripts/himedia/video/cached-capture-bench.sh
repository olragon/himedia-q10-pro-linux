#!/bin/bash
# Path A benchmark: histb_vdec capture_cached=0 vs 1, run ON the box.
# Watchdog-guarded: the SP805 is armed for the whole run, so a hang reboots
# the box into the known-good stick kernel instead of locking it out.
# usage: cached-capture-bench.sh [clip ...]   (default: /root/h264-720p.h264 /root/h264-1080p.h264)
set -u
CLIPS=("$@"); [ ${#CLIPS[@]} -eq 0 ] && CLIPS=(/root/h264-720p.h264 /root/h264-1080p.h264)
P=/sys/module/histb_vdec/parameters/capture_cached
[ -w "$P" ] || { echo "no $P (module not loaded / old build)"; exit 2; }
BB="busybox"   # devmem is a busybox applet here, not on PATH
wd() { $BB devmem 0xf8a2cc00 32 0x1acce551; "$@"; $BB devmem 0xf8a2cc00 32 1; }   # unlock, write, relock
wd $BB devmem 0xf8a2c000 32 $((120 * 24000000)); wd $BB devmem 0xf8a2c008 32 3     # arm: 120 s, reset on 2nd expiry
[ "$($BB devmem 0xf8a2c008 32)" = "0x00000003" ] || { echo "watchdog did not arm — refusing to run"; exit 3; }
pet() { wd $BB devmem 0xf8a2c00c 32 1; }
run() { # $1 label, rest pipeline tail
  local lbl=$1; shift
  pet
  local s=$(date +%s%N) c0=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat)
  timeout 100 gst-launch-1.0 -q filesrc location="$clip" ! h264parse ! v4l2slh264dec ! "$@" >/tmp/gst.log 2>&1; local rc=$?
  local e=$(date +%s%N) c1=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat)
  local ms=$(( (e-s)/1000000 )) cpu=$(( (c1-c0) ))   # USER_HZ ticks, all cores
  echo "$(basename $clip) cached=$(cat $P) $lbl rc=$rc wall_ms=$ms fps=$(awk -v ms=$ms 'BEGIN{printf "%.1f",300000/ms}') cpu_s=$(awk -v t=$cpu 'BEGIN{printf "%.2f",t/100}')"
  [ $rc -ne 0 ] && tail -3 /tmp/gst.log
}
for clip in "${CLIPS[@]}"; do
  for c in 0 1; do
    echo $c > $P
    run fakevideosink    fakevideosink sync=false
    run convert          videoconvert ! fakevideosink sync=false
    run fakesink-copy    fakesink sync=false
    # correctness: hash every decoded byte; cached=0 and cached=1 must agree
    pet; echo "$(basename $clip) cached=$(cat $P) md5=$(timeout 100 gst-launch-1.0 -q filesrc location="$clip" ! h264parse ! v4l2slh264dec ! video/x-raw,format=NV12 ! fdsink fd=1 2>/dev/null | md5sum | cut -c1-12)"
  done
done
wd $BB devmem 0xf8a2c008 32 0   # disarm: control only, never LOAD=0
echo "watchdog ctrl=$($BB devmem 0xf8a2c008 32)"
dmesg | grep -iE "histb|vdec|vpss" | tail -5
