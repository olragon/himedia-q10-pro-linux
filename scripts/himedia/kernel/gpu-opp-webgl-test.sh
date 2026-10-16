#!/bin/bash
# gpu-opp-webgl-test.sh <Hz> [secs=60] — ON THE BOX (k23+), fresh boot, desktop running: pin the GPU
# clock (devfreq userspace) and run the Chromium WebGL page (chrome-gpu-probe.py + gpu-test.html) —
# a far heavier GPU load than kmscube, which never tripped the 500 MHz hang. Reports fps, new js
# faults and gpu sched timeouts (a timeout = the GPU hung at this clock).
set -u
F=${1:?Hz}; T=${2:-60}; G=/sys/class/devfreq/f9200000.gpu
until systemctl is-active -q q10-desktop; do sleep 2; done; sleep 8
echo userspace > $G/governor; echo $F > $G/max_freq; echo $F > $G/min_freq
j0=$(dmesg | grep -c "js fault"); t0=$(dmesg | grep -c "sched timeout")
echo "GPU pinned at $(cat $G/cur_freq) Hz"
cd /root && timeout $((T+60)) python3 chrome-gpu-probe.py --label opp$F --secs $T 2>&1 | grep -E '"fps_median"|"webgl"' | tr -d ' ,'
pkill -x chromium
echo "new_js_faults=$(( $(dmesg | grep -c 'js fault') - j0 )) new_sched_timeouts=$(( $(dmesg | grep -c 'sched timeout') - t0 ))"
echo simple_ondemand > $G/governor; echo 200000000 > $G/min_freq
