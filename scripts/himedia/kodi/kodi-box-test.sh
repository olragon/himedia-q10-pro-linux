#!/bin/bash
# kodi-box-test.sh — on the box: play one clip in kodi-v4l2req (GBM) and measure it.
# usage: kodi-box-test.sh <clip> [seconds=30] [preset=direct|gles]
# Runs itself under q10-wd-run (SP805 armed 60 s + pet loop: a hung kernel resets to the stick in ~2 min).
# Stops q10-desktop (GBM needs DRM master) and restarts it on exit. Fresh profile per run.
# Reports: HW-decode proof (kodi.log DRMPRIME line + kodi holding /dev/media0 + /dev/video0),
# kodi CPU seconds over the window, system CPU, panfrost js faults, V0/G0 plane state, dropped frames.
set -u
[ -z "${Q10_WD:-}" ] && Q10_WD=1 exec q10-wd-run "$0" "$@"
clip=${1:?clip}; secs=${2:-30}; preset=${3:-direct}
[ -e /dev/media0 ] || { echo "no /dev/media0 — load histb_vpss + histb_vdec first"; exit 4; }
export KODI_DATA=/root/.kodi-v4l2req-test-$preset KODI_V4L2REQ_PRESET=$preset
[ "${KEEP:-0}" = 1 ] || rm -rf "$KODI_DATA"   # KEEP=1: warm profile (first run does add-on/repo jobs on JobWorker)
# a warm profile remembers the resume point, so the clip would start near its end: drop the bookmark db
rm -f "$KODI_DATA"/userdata/Database/MyVideos*.db
# and the previous run's log, or the "codec opened" wait below matches the OLD line at once and the
# window swallows ~15 s of Kodi start-up (measured 2026-10-12: a false 24 fps)
rm -f "$KODI_DATA"/temp/kodi*.log
was_desktop=$(systemctl is-active q10-desktop)
[ "$was_desktop" = active ] && systemctl stop q10-desktop
cleanup() {
  [ -n "${kp:-}" ] && { kill "$kp" 2>/dev/null; sleep 3; pkill -9 -x kodi-gbm 2>/dev/null; }
  [ "$was_desktop" = active ] && systemctl start q10-desktop
}
trap cleanup EXIT
dmesg -C; echo "kodi-test: $preset $(basename "$clip")" > /dev/kmsg
kodi-v4l2req "$clip" > /tmp/kodi-test.out 2>&1 & 
L=$KODI_DATA/temp/kodi.log
# window starts 3 s after the video codec opens (Kodi's GUI start takes ~18 s and must not count)
for i in $(seq 60); do grep -q "CDVDVideoCodec.*::Open\|Creating video codec" "$L" 2>/dev/null && break; sleep 1; done
sleep 3
kp=$(pgrep -x kodi-gbm | head -1)
[ -n "$kp" ] || { echo "kodi-gbm not running"; tail -20 /tmp/kodi-test.out; exit 5; }
T=/sys/kernel/tracing; echo > $T/trace
echo 1 > $T/events/v4l2/v4l2_dqbuf/enable; echo 1 > $T/events/drm/drm_vblank_event_queued/enable
fds() { ls -l /proc/$kp/fd 2>/dev/null | grep -oE '/dev/(media|video)[0-9]+' | sort -u | tr '\n' ' '; }
pcpu() { awk '{print $14+$15}' /proc/$kp/stat; }
scpu() { awk '/^cpu /{print $2+$3+$4+$7+$8}' /proc/stat; }   # user nice system irq softirq — NOT $6 iowait
threads() { for t in /proc/$kp/task/*; do echo "$(cat $t/comm | tr ' ' _) $(awk '{print $14+$15}' $t/stat)"; done | awk '{a[$1]+=$2} END{for(k in a) print k, a[k]}' | sort; }
threads > /tmp/kodi-thr0
p0=$(pcpu); s0=$(scpu); t0=$(date +%s%N)
sleep "$secs"
p1=$(pcpu); s1=$(scpu); t1=$(date +%s%N); held=$(fds)
alsa=$(for f in /proc/asound/card*/pcm*p/sub0/status; do [ -e "$f" ] && awk '/^state|^hw_ptr/{printf "%s ",$0}' "$f"; done)
echo 0 > $T/events/v4l2/v4l2_dqbuf/enable; echo 0 > $T/events/drm/drm_vblank_event_queued/enable
# v4l2_dqbuf type: VIDEO_CAPTURE(_MPLANE) = decoded pictures; vblank_event_queued = page flips Kodi asked for
dec=$(grep v4l2_dqbuf $T/trace | grep -cE "type = VIDEO_CAPTURE")
flips=$(grep -c drm_vblank_event_queued $T/trace); lost=$(grep -c "LOST" $T/trace)
D=$(ls -d /sys/kernel/debug/dri/*/ | while read d; do grep -q histb "$d/name" 2>/dev/null && echo "$d"; done | head -1)
planes=$([ -n "$D" ] && awk '/^plane\[/{p=$0} /fb=/{print p" "$0}' "$D/state" | sed 's/  */ /g')
wall=$(awk -v a=$t0 -v b=$t1 'BEGIN{printf "%.1f",(b-a)/1e9}')
echo "=== kodi $preset $(basename "$clip") window=${wall}s"
echo "kodi_cpu_s=$(awk -v d=$((p1-p0)) 'BEGIN{printf "%.2f",d/100}') sys_cpu_s=$(awk -v d=$((s1-s0)) 'BEGIN{printf "%.2f",d/100}') (4 cores)"
echo "decoded_fps=$(awk -v n=$dec -v w=$wall 'BEGIN{printf "%.1f",n/w}') flips_per_s=$(awk -v n=$flips -v w=$wall 'BEGIN{printf "%.1f",n/w}') trace_lost=$lost"
echo "alsa: ${alsa:-no card}"
echo "fds_held: ${held:-none}"
echo "js_faults=$(dmesg | grep -c 'js fault') oops=$(dmesg | grep -ciE 'oops|BUG:')"
echo "planes: ${planes:-unknown}"
# a rejected atomic commit (e.g. V0 asked to scale without allow_scale=1 -> ERANGE) makes Kodi re-show
# the last good frame while decode still runs at full rate — decoded_fps alone would hide it
echo "atomic_commit_failures=$(grep -c 'test commit failed' "$L") egl_errors=$(grep -c 'EGL_DEBUG_MSG_ERROR' "$L") vdp_allow_scale=$(cat /sys/module/histb_vdp/parameters/allow_scale)"
threads > /tmp/kodi-thr1
echo "top threads (cpu s): $(join /tmp/kodi-thr0 /tmp/kodi-thr1 | awk '{d=($3-$2)/100; if(d>0.2) printf "%s=%.2f\n",$1,d}' | sort -t= -k2 -rn | head -6 | tr '\n' ' ')"
echo "--- kodi.log"
grep -E "creating .* hwdevice|DRMPRIME::Open|using decoder|ffmpeg\[.*\] Using|VideoPlayer.*CodecDRMPRIME|CRendererDRMPRIME|RendererDRMPRIMEGLES|Creating renderer|Opening video stream|skipped|dropped|ERROR|OpenSink|Sink.*format|InitSink" "$L" | sed 's/^[0-9: .-]*T:[0-9]* *//' | sort | uniq -c | sort -rn | head -25
cp "$L" "/root/kodi-test-$preset-$(basename "$clip").log"
