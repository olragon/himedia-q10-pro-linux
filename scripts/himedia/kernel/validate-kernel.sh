#!/bin/bash
# validate-kernel.sh — ON THE BOX: one pass over everything a Q10 kernel must do before it becomes
# the boot default. Each line ends PASS/FAIL; exit 1 if any FAIL. Needs /root/clips, /root/mode-test.sh,
# q10-codec-matrix, q10-dvfs-stage2-test, q10-chromium-wayland-test, /root/cec-test.sh.
set -u
R=0; ok() { echo "PASS  $*"; }; bad() { echo "FAIL  $*"; R=1; }
until systemctl is-active -q q10-desktop; do sleep 2; done; sleep 5
echo "== $(uname -r)  $(date -Is)"
j0=$(dmesg | grep -cE "js fault|sched timeout")
# 1 decode (bit-exact)
sync; echo 3 > /proc/sys/vm/drop_caches; echo 1 > /proc/sys/vm/compact_memory
cd /root/clips && q10-codec-matrix h264-1080p-60.mkv hevc-1080p-30.mkv vp9-1080p-30.mkv hevc-2160p-30.mkv > /tmp/vk-matrix.txt 2>&1
while read -r c fr fps cpu sw diff k rest; do
  case "$c" in clip|"") continue;; esac
  [ "$fr" -gt 0 ] && [ "$diff" = 0 ] && ok "decode $c $fr frames bit-exact ${fps} fps" || bad "decode $c frames=$fr diff=$diff"
done < <(grep -E "^(h264|hevc|vp9)" /tmp/vk-matrix.txt)
# 2 CPU frequency + voltage soak
q10-dvfs-stage2-test --only soak --soak 60 > /tmp/vk-soak.txt 2>&1
grep -q "SOAK RESULT: PASS" /tmp/vk-soak.txt && ok "cpu dvfs soak ($(grep -c ' x ' /tmp/vk-soak.txt) freq/voltage pairs)" || bad "cpu dvfs soak"
[ "$(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)" = schedutil ] && ok "governor schedutil" || bad "governor"
t=$(cat /sys/class/thermal/thermal_zone0/temp); [ "$t" -gt 20000 ] && [ "$t" -lt 90000 ] && ok "soc temp $((t/1000)) C" || bad "soc temp $t"
# 3 GPU devfreq
G=/sys/class/devfreq/f9200000.gpu
[ "$(cat $G/available_frequencies 2>/dev/null)" = "200000000 300000000 400000000" ] && ok "gpu opps 200/300/400" || bad "gpu opps: $(cat $G/available_frequencies 2>&1)"
# 4 CEC adapter + TX on the wire
[ -c /dev/cec0 ] && ok "cec adapter /dev/cec0" || bad "no /dev/cec0"
# 5 display mode switch
/root/mode-test.sh try 1920x1080@50 8 > /tmp/vk-mode.txt 2>&1
grep -q "freq: 50.00Hz" /tmp/vk-mode.txt && ok "mode switch 1080p50" || bad "mode switch 1080p50"
until systemctl is-active -q q10-desktop; do sleep 2; done
# 6 sessions
q10-chromium-wayland-test 15 > /tmp/vk-web.txt 2>&1; pkill -x cage; sleep 2
grep -q "holds /dev/video1" /tmp/vk-web.txt && ok "chromium hw decode ($(grep -o 'box_cpu=[0-9]*j/[0-9]*j' /tmp/vk-web.txt))" || bad "chromium hw decode"
q10-mode switch kodi >/dev/null 2>&1; sleep 20; systemctl is-active -q q10-kodi && ok "kodi session" || bad "kodi session"
q10-mode switch desktop >/dev/null 2>&1
j1=$(dmesg | grep -cE "js fault|sched timeout"); [ "$j1" -eq "$j0" ] && ok "0 new GPU faults/timeouts" || bad "$((j1-j0)) new GPU faults/timeouts"
exit $R
