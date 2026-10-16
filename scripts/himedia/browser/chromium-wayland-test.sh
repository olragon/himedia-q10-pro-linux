#!/bin/bash
# chromium-wayland-test.sh [secs=25] — ON THE BOX: Chromium as a native Wayland client inside cage
# (VDP), playing /root/clips/play.html with the V4L2 stateless decoder. Question: does the Wayland
# path (linux-dmabuf to the compositor) show hardware-decoded frames where ANGLE-on-X11 stays blank?
# Stops the desktop for the run and restarts it. Grab the TV from the Mac with fbgrab.sh.
set -u
T=${1:-25}; R=/run/q10-chromewl; mkdir -p -m 700 $R
CLIP=${CLIP:-h264-1080p-60.mp4}
echo "<html><body style=margin:0;background:#000><video id=v autoplay muted loop src=\"file:///root/clips/$CLIP\" style=width:100%></video></body></html>" > /tmp/play-wl.html
systemctl stop q10-desktop q10-kodi 2>/dev/null; sleep 2
cpu() { awk '/^cpu /{print $2+$3+$4+$7+$8}' /proc/stat; }
F=${FEATURES:-AcceleratedVideoDecoder,AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL}
XDG_RUNTIME_DIR=$R WLR_DRM_DEVICES=/dev/dri/by-path/platform-f8cc0000.display-controller-card \
LD_PRELOAD=/usr/local/lib/q10/drm-rdwr-preload.so MESA_GLES_VERSION_OVERRIDE=3.0 \
  timeout $((T+20)) cage -s -- chromium --ozone-platform=wayland --no-sandbox --no-first-run --kiosk \
  --enable-features=$F --ignore-gpu-blocklist --enable-logging=stderr --vmodule="${VMODULE:-*v4l2*=1}" ${EXTRA:-} \
  --allow-file-access-from-files --autoplay-policy=no-user-gesture-required \
  file:///tmp/play-wl.html > /var/log/q10/chromium-wayland.log 2>&1 &
sleep 10; a=$(cpu); sleep "$T"; b=$(cpu)
echo "box_cpu=$((b-a))j/$((T*400))j over ${T}s"
for p in $(pgrep -f chromium); do ls -l /proc/$p/fd 2>/dev/null | grep -qE "video1" && echo "  pid $p holds /dev/video1 ($(tr '\0' ' ' < /proc/$p/cmdline | grep -oE 'type=[a-z-]+'))"; done
grep -E "stateless API|ImageProcessor|Backend failure|ERROR" /var/log/q10/chromium-wayland.log | sort | uniq -c | head -8
