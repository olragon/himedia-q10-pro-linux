#!/bin/bash
# android-session-test.sh [wait-seconds=100] [name] — MAC side: (re)start Android 13 (Waydroid)
# inside cage on the VDP under the SP805 pet loop, wait, then report what booted and grab the TV.
# Log: archive/<ts>-android-session-<name>.log ; screen: archive/<ts>-q10-screen-android-<name>.png
set -uo pipefail
wait=${1:-100}; name=${2:-test}; H=${Q10_HOST:-root@q10.local}
here=$(cd "$(dirname "$0")/../../.." && pwd); log=$here/archive/$(date +%Y%m%d-%H%M%S)-android-session-$name.log
{
echo "=== $(date -Is) android-session-test wait=${wait}s"
ssh -o BatchMode=yes $H 'export XDG_RUNTIME_DIR=/run/cagetest; waydroid session stop >/dev/null 2>&1; sleep 2
  for p in $(pgrep -x cage); do kill $p; done; sleep 2
  systemctl restart waydroid-container; mkdir -p -m 700 $XDG_RUNTIME_DIR; rm -f $XDG_RUNTIME_DIR/wayland-0*
  dmesg -C 2>/dev/null; : > /var/log/q10/android-session.log
  (WLR_DRM_DEVICES=/dev/dri/by-path/platform-f8cc0000.display-controller-card timeout 1800 q10-wd-run cage -s -- q10-android-run > /root/cage-android.log 2>&1 &)
  grep q10.graphics /var/lib/waydroid/waydroid_base.prop'
sleep "$wait"
ssh -o BatchMode=yes $H 'waydroid status | head -2
  echo "boot_completed=$(waydroid shell -- getprop sys.boot_completed)"
  waydroid shell -- sh -c "logcat -d 2>/dev/null | grep -E \"RenderEngine: (version|renderer)|RenderEngine with\" | tail -3
    echo sf_crashes=\$(logcat -d -b crash 2>/dev/null | grep -c \"name: RenderEngine\")
    echo native_crashes=\$(logcat -d -b crash 2>/dev/null | grep -c \"F DEBUG   : pid:\")
    echo java_fatal=\$(logcat -d 2>/dev/null | grep -c \"FATAL EXCEPTION\")
    logcat -d -b crash 2>/dev/null | grep -E \"F DEBUG   : (pid:|      #0[0-2])\" | tail -6
    dumpsys SurfaceFlinger 2>/dev/null | grep -E \"GLES:|Display 0\" | head -3"
  free -m | sed -n 2p; echo "js_faults=$(dmesg | grep -c "js fault")"; tail -3 /var/log/q10/android-session.log'
"$here/scripts/himedia/tools/fbgrab.sh" "android-$name"
} 2>&1 | tee "$log"
