#!/bin/bash
# wd-play.sh <clip-in-/sdcard/Download> [seconds] — run from the Mac. Plays a clip in Android's
# gallery3d MovieActivity on the Q10 and prints what the display path did with it:
# CodeauroraVideoView FRAMES/DROP, new SurfaceFlinger tombstones, composer/SF errors, system load.
# Step 0 of docs/261012-himedia-android-hw-video.md. Needs the Android session RUNNING (q10-mode switch android).
#   scripts/himedia/android/codec2/wd-play.sh q10t-720p30.mkv 20
set -euo pipefail
BOX=${BOX:-${Q10_HOST:-root@q10.local}}
CLIP=${1:?clip name under /sdcard/Download}; SECS=${2:-20}
ssh -o BatchMode=yes "$BOX" CLIP="$CLIP" SECS="$SECS" 'bash -s' <<'EOF'
set -u
D=/root/.local/share/waydroid/data
sh_() { waydroid shell -u 2000 -- sh -c "$1"; }
for i in $(seq 1 40); do sh_ "service check activity" 2>/dev/null | grep -q "found" && break; sleep 3; done
sh_ "service check activity" | grep -q "found" || { echo "NO ACTIVITY SERVICE (system_server not up)"; exit 2; }
before=$(ls $D/tombstones 2>/dev/null | grep -v '\.pb$' | sort | tail -1)
sh_ "logcat -c; am force-stop com.android.gallery3d" >/dev/null 2>&1
sh_ "am start -W -a android.intent.action.VIEW -d file:///sdcard/Download/$CLIP -t video/x-matroska -n com.android.gallery3d/.app.MovieActivity" | grep -E "Status|Error|Exception"
sleep 6
echo "== load during playback"; top -b -n1 | sed -n 3p
echo "== SF layers while playing"; waydroid shell -- dumpsys SurfaceFlinger | grep -E "composition type|usesClientComposition|buffer: slot|geomBufferSize" | head -8
sleep "$SECS"
echo "== Codeaurora"; waydroid shell -- logcat -d | grep -E "CodeauroraVideoView: (CODEC_VIDEO|FRAMES|RESOLUTION)" | cut -c1-160
echo "== SF / HWC trouble"; waydroid shell -- logcat -d | grep -E "SurfaceFlinger|composer|hwcomposer|RenderEngine|libgallium" | grep -E " E | F |abort|crash" | tail -6 | cut -c1-200
sleep 3
after=$(ls $D/tombstones 2>/dev/null | grep -v '\.pb$' | sort | tail -1)
[ "$before" != "$after" ] && { echo "== NEW TOMBSTONE $after"; sed -n 5,9p $D/tombstones/$after | cut -c1-120; } || echo "== no new tombstone"
EOF
