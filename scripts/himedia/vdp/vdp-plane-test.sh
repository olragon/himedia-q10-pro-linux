#!/bin/bash
# VDP video-plane test on the box (step 4 of docs/261011-himedia-vdp-drm-port.md §7), watchdog-guarded.
# Shows an NV12 modetest pattern on V0 behind a transparent G0 for <secs>, dumping the VDP
# registers while it is up. Nothing here can see the TV: the dump is the evidence, a human the proof.
# usage: vdp-plane-test.sh [secs=20] [V0 plane id=37] [crtc id=42] [G0 plane id=33]
set -u
S=${1:-20} V0=${2:-37} CRTC=${3:-42} G0=${4:-33} BB=busybox
D=/sys/kernel/debug/dri/$(grep -l histb-vdp /sys/kernel/debug/dri/*/name | head -1 | cut -d/ -f6)
wd() { $BB devmem 0xf8a2cc00 32 0x1acce551; "$@"; $BB devmem 0xf8a2cc00 32 1; }
wd $BB devmem 0xf8a2c000 32 $((90 * 24000000)); wd $BB devmem 0xf8a2c008 32 3
[ "$($BB devmem 0xf8a2c008 32)" = "0x00000003" ] || { echo "watchdog did not arm — refusing to run"; exit 3; }
echo "== regs before"; cat $D/histb_vdp_regs
# -w sets G0 alpha 0 (transparent), -P puts the NV12 pattern on V0; modetest quits on stdin, so hold it.
modetest -M histb-vdp -w $G0:alpha:0 -P $V0@$CRTC:1920x1080@NV12 < <(sleep $S) > /tmp/vdp-modetest.log 2>&1 &
sleep 4
echo "== regs with V0 up"; cat $D/histb_vdp_regs
cat /sys/kernel/debug/dri/*/state 2>/dev/null | grep -A12 "plane\[$V0\]" | head -14
wait; echo "modetest rc=$?"; tail -5 /tmp/vdp-modetest.log
echo "== regs after"; cat $D/histb_vdp_regs | head -12
wd $BB devmem 0xf8a2c008 32 0; echo "watchdog ctrl=$($BB devmem 0xf8a2c008 32)"
dmesg | tail -5
