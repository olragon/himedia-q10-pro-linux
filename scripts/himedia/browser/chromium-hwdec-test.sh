#!/bin/bash
# chromium-hwdec-test.sh [features] [secs=25] — ON THE BOX: play /root/clips/play.html (1080p60
# H.264 MP4) in Chromium on the running desktop and report whether Chromium's own V4L2 stateless
# decoder engaged: which chromium process holds /dev/video0 + /dev/media0, box CPU, GPU faults.
# Debian's armhf Chromium contains V4L2VideoDecoderBackendStateless and scans /dev/video%d.
set -u
F=${1:-AcceleratedVideoDecodeLinuxGL,AcceleratedVideoDecodeLinuxZeroCopyGL}; T=${2:-25}
D=$(ls /tmp/.X11-unix | sed -n 's/^X/:/p' | tail -1)
pkill -x chromium 2>/dev/null; sleep 1
CLIP=${CLIP:-h264-1080p-60.mp4}   # any file in /root/clips (mp4 / webm)
echo "<html><body style=margin:0;background:#000><video id=v autoplay muted loop src=\"file:///root/clips/$CLIP\" style=width:100%></video></body></html>" > /tmp/play-hwdec.html
cpu() { awk '/^cpu /{print $2+$3+$4+$7+$8}' /proc/stat; }
j0=$(dmesg | grep -c "js fault")
LD_PRELOAD="${PRELOAD-/usr/local/lib/q10/drm-rdwr-preload.so}" DISPLAY=$D HOME=/root MESA_GLES_VERSION_OVERRIDE=3.0 chromium --no-sandbox --no-first-run \
  --enable-features=$F --enable-accelerated-video-decode --ignore-gpu-blocklist --enable-logging=stderr --v=0 \
  --vmodule="${VMODULE:-*v4l2*=4,*video_decoder*=2,*gpu_video*=2,*mojo_video*=2}" --allow-file-access-from-files --autoplay-policy=no-user-gesture-required ${EXTRA:-} \
  file:///tmp/play-hwdec.html > /var/log/q10/chromium-hwdec.log 2>&1 &
sleep 8; a=$(cpu); sleep "$T"; b=$(cpu)
echo "features=$F  box_cpu=$(( (b-a) ))j/$((T*400))j over ${T}s"
for p in $(pgrep -f "chromium"); do
  ls -l /proc/$p/fd 2>/dev/null | grep -qE "video[0-9]|media[0-9]" && echo "  pid $p holds: $(ls -l /proc/$p/fd | grep -oE "/dev/(video|media)[0-9]+" | sort -u | tr '\n' ' ') type=$(tr '\0' ' ' < /proc/$p/cmdline | grep -oE 'type=[a-z-]+')"
done
echo "  js_faults_new=$(( $(dmesg | grep -c 'js fault') - j0 ))"
grep -iE "v4l2|VideoDecoder|vaapi|Failed|decoder" /var/log/q10/chromium-hwdec.log | grep -v "^$" | sort | uniq -c | sort -rn | head -12
pkill -x chromium
