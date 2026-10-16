#!/bin/bash
# test-on-box.sh [after-log] — install q10_aiao.ko for the box's running release, load it with
# the SP805 armed, play a 440 Hz tone and MEASURE what the hardware does (no ears needed):
#   - TX_WS_CNT (+0x20, 24-bit frame counter) must advance 48 000/s if MCLK/BCLK/FS are right
#   - TX_BUFF_RPTR (+0x8C) must advance and wrap while playing
# Optional arg: a log to wait on ("=== ir done") so it runs after the other night jobs.
set -uo pipefail
H=${Q10_HOST:-root@q10.local}; SSH="ssh -o BatchMode=yes -o ConnectTimeout=5"
OUT=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/audio
if [ -n "${1:-}" ]; then until grep -qE "=== ir done" "$1" 2>/dev/null; do sleep 30; done; fi
until $SSH $H true 2>/dev/null; do sleep 20; done
rel=$($SSH $H uname -r)
ko="$OUT/q10_aiao-$rel.ko"
[ -f "$ko" ] || { echo "⛔ no module built for $rel ($ko) — run audio/build.sh against that tree"; exit 2; }
echo "[local->remote:$H] q10_aiao for $rel"
$SSH $H "mkdir -p /lib/modules/$rel/extra && cat > /lib/modules/$rel/extra/q10_aiao.ko && depmod -a $rel" < "$ko"
$SSH $H 'command -v speaker-test >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q alsa-utils >/dev/null 2>&1; command -v speaker-test'
$SSH $H '
# ⛔ disarm = control 0 ONLY: a LOAD of 0 expires at once, and with RESEN still set that resets.
arm()    { busybox devmem 0xf8a2cc00 32 0x1acce551; busybox devmem 0xf8a2c000 32 $1; busybox devmem 0xf8a2c008 32 3; busybox devmem 0xf8a2cc00 32 1; }
disarm() { busybox devmem 0xf8a2cc00 32 0x1acce551; busybox devmem 0xf8a2c008 32 0; busybox devmem 0xf8a2cc00 32 1; }
echo "q10: audio test — watchdog armed 60s" > /dev/kmsg; sync
arm 1440000000
modprobe -v q10_aiao; rc=$?
dmesg | grep -iE "q10-aiao|q10_aiao" | tail -6
cat /proc/asound/cards
[ $rc -eq 0 ] || { disarm; exit 1; }
rd() { busybox devmem $1 32; }
(speaker-test -D hw:Q10,0 -c 2 -r 48000 -F S16_LE -t sine -f 440 -l 3 >/tmp/st.log 2>&1) &
sleep 2
for p in 0xf8cd2200:TX2 0xf8cd3100:SPDIF1; do b=${p%%:*}; n=${p##*:}
  w1=$(( $(rd $((b+0x20))) & 0xffffff )); r1=$(rd $((b+0x8c))); sleep 1
  w2=$(( $(rd $((b+0x20))) & 0xffffff )); r2=$(rd $((b+0x8c)))
  echo "$n: frames/s = $(( (w2 - w1 + 0x1000000) % 0x1000000 ))  rptr $r1 -> $r2  dsp_ctrl $(rd $((b+4)))"
done
wait; tail -4 /tmp/st.log
echo "underruns: $(grep -ci underrun /tmp/st.log)"
disarm; echo "watchdog disarmed"
'
echo "=== audio done $(date +%H:%M:%S) ==="
