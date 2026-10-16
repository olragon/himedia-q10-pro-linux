#!/bin/bash
# FFmpeg v4l2request hwaccel on the box: speed, CPU, and a bit-exactness check against the
# GStreamer v4l2slh264dec decode (both hash every decoded NV12 byte). Watchdog-guarded.
# usage: ffmpeg-v4l2req-bench.sh [clip ...]
set -u
CLIPS=("$@"); [ ${#CLIPS[@]} -eq 0 ] && CLIPS=(/root/h264-720p.h264 /root/h264-1080p.h264)
FF=/opt/ffmpeg-v4l2req/bin/ffmpeg; BB=busybox
wd() { $BB devmem 0xf8a2cc00 32 0x1acce551; "$@"; $BB devmem 0xf8a2cc00 32 1; }
wd $BB devmem 0xf8a2c000 32 $((120 * 24000000)); wd $BB devmem 0xf8a2c008 32 3
[ "$($BB devmem 0xf8a2c008 32)" = "0x00000003" ] || { echo "watchdog did not arm — refusing to run"; exit 3; }
pet() { wd $BB devmem 0xf8a2c00c 32 1; }
t() { # label, cmd...  -> wall, fps (300 frames), all-core CPU
  local lbl=$1; shift; pet
  local s=$(date +%s%N) c0=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat)
  timeout 100 "$@" >/tmp/ff.log 2>&1; local rc=$?
  local e=$(date +%s%N) c1=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat) ms
  ms=$(( (e-s)/1000000 ))
  echo "$(basename $clip) $lbl rc=$rc wall_ms=$ms fps=$(awk -v ms=$ms 'BEGIN{printf "%.1f",300000/ms}') cpu_s=$(awk -v t=$((c1-c0)) 'BEGIN{printf "%.2f",t/100}')"
  [ $rc -ne 0 ] && tail -4 /tmp/ff.log
}
for clip in "${CLIPS[@]}"; do
  t ff-hw-drmprime   $FF -hide_banner -nostdin -hwaccel v4l2request -hwaccel_output_format drm_prime -i "$clip" -f null -
  t ff-hw-download   $FF -hide_banner -nostdin -hwaccel v4l2request -i "$clip" -f null -
  t ff-sw-4threads   $FF -hide_banner -nostdin -threads 4 -i "$clip" -f null -
  pet
  ffm=$(timeout 100 $FF -hide_banner -nostdin -loglevel error -hwaccel v4l2request -i "$clip" -pix_fmt nv12 -f rawvideo - | md5sum | cut -c1-12)
  pet
  gsm=$(timeout 100 gst-launch-1.0 -q filesrc location="$clip" ! h264parse ! v4l2slh264dec ! video/x-raw,format=NV12 ! fdsink fd=1 2>/dev/null | md5sum | cut -c1-12)
  pet
  swm=$(timeout 100 $FF -hide_banner -nostdin -loglevel error -i "$clip" -pix_fmt nv12 -f rawvideo - | md5sum | cut -c1-12)
  echo "$(basename $clip) md5 ffmpeg-hw=$ffm gst-hw=$gsm ffmpeg-sw=$swm"
done
wd $BB devmem 0xf8a2c008 32 0
echo "watchdog ctrl=$($BB devmem 0xf8a2c008 32)"
