#!/bin/bash
# tv-look-sequence.sh — ON THE BOX: the human TV check. Modes (desktop picture) then Kodi V0 direct
# 1080p and scaled 720p, with a timestamped log so Tim's notes can be matched to each step.
set -u
L=/var/log/q10/tv-look-$(date +%Y%m%d-%H%M%S).log
step() { echo "$(date +%T) STEP $*" | tee -a $L; }
sleep 10
n=1; for m in 1920x1080@60 1920x1080@59.94 1920x1080@50 1280x720@60 1280x720@50; do
  step "$n $m"; /root/mode-test.sh try $m 20 >>$L 2>&1; n=$((n+1)); sleep 3
done
step "6 kodi 1080p direct"; KEEP=1 kodi-box-test /root/h264-1080p-60.mkv 30 direct >>$L 2>&1
step "7 kodi 720p direct scaled"; KEEP=1 kodi-box-test /root/h264-720p-60.mkv 30 direct >>$L 2>&1
step "done"; grep -E "STEP|^freq|^modeset|decoded_fps|vdp_allow_scale" $L | head -40
