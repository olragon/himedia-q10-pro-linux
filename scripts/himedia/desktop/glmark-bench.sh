#!/bin/bash
# GPU benchmark on the box: glmark2 (GLES2) under the running X desktop and/or straight on KMS.
# Watchdog-guarded; the GPU is a module that was untested until 2026-10-11.
# usage: glmark-bench.sh x11|drm [extra glmark2 args]
set -u
mode=${1:-x11}; shift || true; BB=busybox
wd() { $BB devmem 0xf8a2cc00 32 0x1acce551; "$@"; $BB devmem 0xf8a2cc00 32 1; }
# ⛔ LOAD is 32-bit at 24 MHz: the longest period is 178 s. 300 s overflowed (2026-10-11) and
# armed some other window. Arm 60 s and PET from a background loop: a real hang (no pets) resets
# the box in ~2 min; a long benchmark that is merely slow never does.
wd $BB devmem 0xf8a2c000 32 $((60 * 24000000)); wd $BB devmem 0xf8a2c008 32 3
[ "$($BB devmem 0xf8a2c008 32)" = "0x00000003" ] || { echo "watchdog did not arm — refusing to run"; exit 3; }
( while sleep 20; do wd $BB devmem 0xf8a2c00c 32 1; done ) & petter=$!
# Keep GPU faults and any panic on the console, so pstore (console-ramoops) holds them after a reset.
old_printk=$(cut -f1 /proc/sys/kernel/printk); echo 7 > /proc/sys/kernel/printk
dmesg -C 2>/dev/null; echo "glmark-bench start $mode" > /dev/kmsg
c0=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat); s=$(date +%s)
case $mode in
  x11) DISPLAY=:0 timeout 580 glmark2-es2 --fullscreen "$@" ;;
  drm) timeout 580 glmark2-es2-drm "$@" ;;
esac 2>&1 | grep --line-buffered -E "GL_RENDERER|GL_VERSION|\] |Score" ; rc=${PIPESTATUS[0]}   # line-buffered: a reset must not eat the output
c1=$(awk '/^cpu /{print $2+$3+$4}' /proc/stat); e=$(date +%s)
echo "mode=$mode rc=$rc wall_s=$((e-s)) cpu_s=$(awk -v t=$((c1-c0)) 'BEGIN{printf "%.1f",t/100}')"
kill $petter 2>/dev/null; wd $BB devmem 0xf8a2c008 32 0; echo "watchdog ctrl=$($BB devmem 0xf8a2c008 32)"
echo "$old_printk" > /proc/sys/kernel/printk
echo "panfrost faults during run: $(dmesg | grep -c 'js fault')"; dmesg | grep -E "panfrost" | grep -v "js fault" | tail -5
