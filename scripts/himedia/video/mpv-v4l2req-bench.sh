#!/bin/bash
# mpv + v4l2request hwdec on the box: decode-only, GPU dmabuf import, and the DRM-PRIME overlay
# (frames straight onto the VDP V0 plane). Counts panfrost job faults per case — mpv's GL path
# threw 1,796 INSTR_INVALID_PC faults on 2026-10-11 and is the prime suspect for a reset.
# Watchdog 60 s + pet loop (a hang resets in ~2 min); printk 7 so a crash lands in pstore.
# usage: mpv-v4l2req-bench.sh [clip ...]     (stop q10-desktop first: mpv needs DRM master)
set -u
[ -e /dev/media0 ] || { echo "no /dev/media0 — load histb_vpss + histb_vdec first (q10-modprobe-guarded)"; exit 4; }
CLIPS=("$@"); [ ${#CLIPS[@]} -eq 0 ] && CLIPS=(/root/h264-720p.h264 /root/h264-1080p.h264)
MPV=/opt/mpv-v4l2req/bin/mpv BB=busybox
KMS=/dev/dri/by-path/platform-f8cc0000.display-controller-card
wd() { $BB devmem 0xf8a2cc00 32 0x1acce551; "$@"; $BB devmem 0xf8a2cc00 32 1; }
wd $BB devmem 0xf8a2c000 32 $((60 * 24000000)); wd $BB devmem 0xf8a2c008 32 3
[ "$($BB devmem 0xf8a2c008 32)" = "0x00000003" ] || { echo "watchdog did not arm — refusing to run"; exit 3; }
( while sleep 20; do wd $BB devmem 0xf8a2c00c 32 1; done ) & petter=$!
trap 'kill $petter 2>/dev/null; wd $BB devmem 0xf8a2c008 32 0' EXIT
old_printk=$(cut -f1 /proc/sys/kernel/printk); echo 7 > /proc/sys/kernel/printk
t() { # label, mpv args...
  local lbl=$1; shift; dmesg -C
  echo "mpv-bench: $lbl $(basename $clip)" > /dev/kmsg
  local s=$(date +%s%N) c0=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat)
  timeout 120 $MPV --no-config --no-audio --untimed "$@" "$clip" >/tmp/mpvb.log 2>&1; local rc=$?
  local e=$(date +%s%N) c1=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat) ms
  ms=$(( (e-s)/1000000 ))
  echo "$(basename $clip) $lbl rc=$rc wall_ms=$ms fps=$(awk -v ms=$ms 'BEGIN{printf "%.1f",300000/ms}') cpu_s=$(awk -v t=$((c1-c0)) 'BEGIN{printf "%.2f",t/100}') js_faults=$(dmesg | grep -c 'js fault') hw=$(grep -qE "Using software decoding" /tmp/mpvb.log && echo SOFTWARE || grep -oE "Using hardware decoding \([^)]*\)" /tmp/mpvb.log | head -1)"
  [ $rc -ne 0 ] && grep -iE "error|fail|cannot" /tmp/mpvb.log | grep -v "VT switcher" | head -3
}
for clip in "${CLIPS[@]}"; do
  # --msg-level=vd=v only: a global -v costs more than half the frame rate (17.9 vs 40.7 fps, 1080p)
  t decode-only:v4l2request-copy   --vo=null --hwdec=v4l2request-copy --msg-level=vd=v
  t gpu:hwdec-v4l2request-dmabuf   --vo=gpu --gpu-context=drm --drm-device=$KMS --hwdec=v4l2request --profile=fast --msg-level=vd=v
  # NOT run: --gpu-hwdec-interop=drmprime-overlay falls back to SOFTWARE decode here, and software
  # frames through mpv's GL renderer raise panfrost INSTR_INVALID_PC job faults (356 / 1,199 per
  # clip) — the same fault storm that preceded the 2026-10-11 23:08 reset.
done
echo "$old_printk" > /proc/sys/kernel/printk
wd $BB devmem 0xf8a2c008 32 0; echo "watchdog ctrl=$($BB devmem 0xf8a2c008 32)"
