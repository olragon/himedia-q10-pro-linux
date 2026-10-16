#!/bin/bash
# Display-path benchmark, run ON the box: HW-decoded H.264 to a real display sink.
# Compares the CPU path (videoconvert -> kmssink on simpledrm) with the GPU path
# (glimagesink on GBM: NV12 dmabuf imported by Panfrost, drawn to the scanout).
# Watchdog-guarded for the whole run. Stop any X session first (DRM master).
# usage: display-path-bench.sh [clip ...]
# ⚠️ never `pkill -f display-path-bench` over ssh — it matches the ssh command itself
set -u
CLIPS=("$@"); [ ${#CLIPS[@]} -eq 0 ] && CLIPS=(/root/h264-720p.h264 /root/h264-1080p.h264)
BB=busybox
wd() { $BB devmem 0xf8a2cc00 32 0x1acce551; "$@"; $BB devmem 0xf8a2cc00 32 1; }
wd $BB devmem 0xf8a2c000 32 $((120 * 24000000)); wd $BB devmem 0xf8a2c008 32 3
[ "$($BB devmem 0xf8a2c008 32)" = "0x00000003" ] || { echo "watchdog did not arm — refusing to run"; exit 3; }
pet() { wd $BB devmem 0xf8a2c00c 32 1; }
export GST_GL_WINDOW=gbm GST_GL_PLATFORM=egl GST_GL_API=gles2 GST_GL_GBM_DRM_DEVICE=/dev/dri/card0
run() { # label, sink chain
  local lbl=$1; shift; pet
  local s=$(date +%s%N) c0=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat)
  timeout 100 gst-launch-1.0 -q filesrc location="$clip" ! h264parse ! v4l2slh264dec ! "$@" >/tmp/dp.log 2>&1; local rc=$?
  local e=$(date +%s%N) c1=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat) ms
  ms=$(( (e-s)/1000000 ))
  echo "$(basename $clip) $lbl rc=$rc wall_ms=$ms fps=$(awk -v ms=$ms 'BEGIN{printf "%.1f",300000/ms}') cpu_s=$(awk -v t=$((c1-c0)) 'BEGIN{printf "%.2f",t/100}')"
  [ $rc -ne 0 ] && tail -3 /tmp/dp.log
}
# Which scanout owns the screen: simpledrm (boot framebuffer, CPU copy) or histb-vdp (VDP planes).
DRV=$(cat /sys/kernel/debug/dri/*/name 2>/dev/null | awk '{print $1}' | grep -E "histb-vdp|simpledrm" | head -1)
V0=${V0_PLANE:-37}   # histb-vdp overlay plane id (modetest -M histb-vdp -p)
echo "scanout driver: $DRV"
for clip in "${CLIPS[@]}"; do
  if [ "$DRV" = histb-vdp ]; then
    # ZERO-COPY: decoder CAPTURE buffers (NV12, dmabuf) scanned out by the V0 plane, no conversion.
    run vdp:kmssink-V0-zerocopy  kmssink driver-name=histb-vdp plane-id=$V0 can-scale=false sync=false
    run vdp:kmssink-V0-vsync     kmssink driver-name=histb-vdp plane-id=$V0 can-scale=false sync=true
    continue
  fi
  # simpledrm has no vblank: without skip-vsync kmssink fails every frame (flow -5); it cannot scale either
  run cpu:videoconvert+kmssink  videoconvert ! kmssink driver-name=simpledrm skip-vsync=true can-scale=false sync=false
  # glimagesink on GBM is NOT here: it picks a 10-bit / alpha / 565 scanout format and simpledrm
  # accepts only XRGB8888 (AddFB2 EINVAL) — see docs/261011-himedia-full-linux-goal.md
  if command -v mpv >/dev/null; then   # GPU path: Panfrost GLES draws to the simpledrm scanout
    pet; s=$(date +%s%N); c0=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat)
    timeout 100 mpv --really-quiet --no-audio --vo=gpu --gpu-context=drm --gpu-api=opengl --hwdec=no \
      --untimed --video-sync=display-desync "$clip" >/tmp/mpv.log 2>&1; rc=$?
    e=$(date +%s%N); c1=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat); ms=$(( (e-s)/1000000 ))
    echo "$(basename $clip) gpu:mpv-drm-swdec rc=$rc wall_ms=$ms fps=$(awk -v ms=$ms 'BEGIN{printf "%.1f",300000/ms}') cpu_s=$(awk -v t=$((c1-c0)) 'BEGIN{printf "%.2f",t/100}')"
    [ $rc -ne 0 ] && tail -3 /tmp/mpv.log
  fi
done
wd $BB devmem 0xf8a2c008 32 0
echo "watchdog ctrl=$($BB devmem 0xf8a2c008 32)"
