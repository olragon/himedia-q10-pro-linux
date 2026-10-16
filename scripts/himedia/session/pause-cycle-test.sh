#!/bin/bash
# pause-cycle-test.sh — MAC side: Android cold start -> desktop (Android paused) -> Android (resumed)
# -> Kodi -> Android, timing each switch and grabbing the TV. Log: archive/<ts>-pause-cycle.log
set -uo pipefail
H=${Q10_HOST:-root@q10.local}; here=$(cd "$(dirname "$0")/../../.." && pwd)
log=$here/archive/$(date +%Y%m%d-%H%M%S)-pause-cycle.log
box() { ssh -o BatchMode=yes $H "$@"; }
grab() { "$here/scripts/himedia/tools/fbgrab.sh" "$1" | tail -1 | xargs -I{} magick {} -format "  screen $1 mean=%[fx:mean]\n" info:; }
mem() { box 'CG=/sys/fs/cgroup/lxc.payload.waydroid; echo "  android resident=$(( $(cat $CG/memory.current 2>/dev/null || echo 0)/1048576 ))MB swap=$(( $(cat $CG/memory.swap.current 2>/dev/null || echo 0)/1048576 ))MB frozen=$(cat $CG/cgroup.freeze 2>/dev/null)"; free -m | sed -n 2,3p | sed "s/^/  /"'; }
{
echo "=== $(date +%T) pause-cycle-test"
box 't=$(date +%s); q10-mode switch android >/dev/null 2>&1; for i in $(seq 1 120); do waydroid shell -u 2000 -- dumpsys activity activities 2>/dev/null | grep -m1 topResumed | grep -q launcher && break; sleep 3; done; echo "android cold start -> launcher: $(( $(date +%s)-t ))s"'
grab cold-android; mem
box 't=$(date +%s%N); q10-mode switch desktop >/dev/null 2>&1; echo "-> desktop: $(( ($(date +%s%N)-t)/1000000 ))ms (command)"'
sleep 12; grab paused-desktop; mem
box 't=$(date +%s%N); q10-mode switch android >/dev/null 2>&1; echo "-> android resume: $(( ($(date +%s%N)-t)/1000000 ))ms (command)"'
sleep 3; grab resumed-android-3s; mem
box 't=$(date +%s%N); q10-mode switch kodi >/dev/null 2>&1; echo "-> kodi: $(( ($(date +%s%N)-t)/1000000 ))ms (command)"'
sleep 15; grab paused-kodi; mem
box 't=$(date +%s%N); q10-mode switch android >/dev/null 2>&1; echo "-> android resume: $(( ($(date +%s%N)-t)/1000000 ))ms (command)"'
sleep 3; grab resumed-android-from-kodi; mem
box 'tail -8 /var/log/q10/session.log; echo js_faults=$(dmesg | grep -c "js fault")'
} 2>&1 | tee "$log"
