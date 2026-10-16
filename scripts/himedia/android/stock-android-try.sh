#!/bin/bash
# stock-android-try.sh [watchdog-seconds] — MAC side. Boot the STOCK Android 7 on the Q10 by
# kexec from the running mainline Linux, with the SP805 armed as the safety net, then find out
# what happened. Modelled on kexec-try.sh. Nothing here writes the eMMC or the stick's boot files.
#
#   1. verify the kit locally (SHA256SUMS)       bun run himedia:stock-boot  builds it
#   2. scp kit + q10-stock-android to the box     /var/lib/q10/stock-android, /usr/local/sbin
#   3. box --dry-run (kexec -l, kexec_loaded, kexec -u) — abort if it fails
#   4. box real run (watchdog armed)
#   5. poll: Android (adb / ARP-by-MAC via a LAN box) or Linux back (ssh, new boot_id)
#   6. if Linux is back: collect the persistent log, pstore and ramlog into archive/
#
# ⛔ NOT run by anyone yet. Android WRITES the eMMC (userdata/cache) the moment it boots — that is
# its normal behaviour, not something this script adds. The watchdog reset at ~2x period is an
# unclean stop for Android; ext4 journals make that survivable, not free.
#
# ⚠️ From a tmux/launchd-rooted shell macOS DENIES Local Network, silently: adb to the LAN and a
# Mac-side arp/ping read as "no host". ssh has its own grant, so the Android probes go THROUGH a
# LAN box ($PROBE_VIA, e.g. a Linux box on the same LAN). A direct `adb` is tried too and its
# failure means nothing. Run it from a terminal that has Local Network access.
set -uo pipefail
wds=${1:-178}
[ "$wds" -ge 1 ] && [ "$wds" -le 178 ] || { echo "watchdog period $wds s out of range 1..178" >&2; exit 2; }
KIT=${KIT:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/stock-android-kexec}
H=${BOX:-${Q10_HOST:-root@q10.local}}; BOXMAC=${BOXMAC:-02:00:00:00:10:01}
PROBE_VIA=${PROBE_VIA:?set PROBE_VIA to an ssh host on the box LAN}; ANDROID_IP=${ANDROID_IP:-192.168.1.200}
here=$(cd "$(dirname "$0")/../../.." && pwd)
mkdir -p "$here/archive"
LOG=$here/archive/$(date +%Y%m%d-%H%M%S)-stock-android-try.log
exec > >(tee -a "$LOG") 2>&1
SSH="ssh -o BatchMode=yes -o ConnectTimeout=5"

echo "[local->remote:$H] stock-android-try  watchdog=${wds}s (reset ~$((2 * wds))s)  kit=$KIT  log=$LOG"

# 1. kit
for f in zImage stock-android.dtb ramdisk.gz cmdline.txt SHA256SUMS manifest.json; do
  [ -s "$KIT/$f" ] || { echo "⛔ missing $KIT/$f — run: bun run himedia:stock-boot"; exit 2; }; done
( cd "$KIT" && shasum -a 256 -c SHA256SUMS ) || { echo "⛔ kit fails sha256 verification"; exit 2; }
grep -q "initrd=" "$KIT/cmdline.txt" && { echo "⛔ cmdline.txt carries initrd="; exit 2; }

# 2. box reachable, record identity BEFORE touching anything
base=$($SSH $H uname -r) || { echo "⛔ box not reachable over ssh"; exit 2; }
boot0=$($SSH $H cat /proc/sys/kernel/random/boot_id) || exit 2
$SSH $H 'command -v kexec >/dev/null && test -c /dev/mem' || { echo "⛔ box lacks kexec or /dev/mem"; exit 2; }
echo "box: $base boot_id=$boot0"

$SSH $H "mkdir -p /var/lib/q10/stock-android /var/log/q10" || exit 2
scp -q -o BatchMode=yes "$KIT"/{zImage,stock-android.dtb,ramdisk.gz,cmdline.txt,SHA256SUMS,manifest.json} \
  $H:/var/lib/q10/stock-android/ || exit 2
scp -q -o BatchMode=yes "$here/scripts/himedia/android/stock-android-kexec.sh" $H:/usr/local/sbin/q10-stock-android || exit 2
$SSH $H chmod 755 /usr/local/sbin/q10-stock-android || exit 2

# 3. dry run — proves kexec -l accepts this exact kit and image-size on this exact kernel
echo "--- box dry-run"
$SSH $H "q10-stock-android --dry-run" || { echo "⛔ dry-run failed — NOT proceeding (box untouched)"; exit 3; }

# 4. for real
$SSH $H "q10-ramlog --clear >/dev/null 2>&1; true"
echo "--- box real run"
$SSH $H "q10-stock-android --watchdog $wds" || { echo "⛔ box refused (see its log); box not rebooted"; exit 3; }
t0=$(date +%s); echo "kexec requested at $(date +%H:%M:%S)"

# 5. poll
# macOS has no timeout(1); alarm+exec is enough for a bounded adb call.
tmo() { perl -e 'alarm shift; exec @ARGV' "$@"; }
# Prints the IP of a host that answered the sweep AND carries the box MAC. Only REACHABLE/DELAY
# neighbours count: a STALE entry left by an earlier Android session would be a false positive.
probe_android() {
  $SSH "$PROBE_VIA" "for i in \$(seq 2 254); do ping -c1 -W1 192.168.1.\$i >/dev/null 2>&1 & done; wait; \
    ip neigh show 2>/dev/null | grep -i '$BOXMAC' | grep -E 'REACHABLE|DELAY' | awk '{print \$1}'" 2>/dev/null
}
seen_android=""; android_ip=""; linux_back=""
sleep 15
while [ $(( $(date +%s) - t0 )) -lt $(( 2 * wds + 240 )) ]; do
  # Linux back? (new boot_id => the box went through a reset or a second kexec)
  b=$($SSH $H cat /proc/sys/kernel/random/boot_id 2>/dev/null) && {
    if [ "$b" != "$boot0" ]; then linux_back=$(( $(date +%s) - t0 )); break; fi
    # same boot_id for a long time => kexec never happened
    [ $(( $(date +%s) - t0 )) -gt 90 ] && { echo "⛔ ssh still answers on the ORIGINAL boot ($boot0) after 90 s — kexec did not run"; break; }
  }
  if [ -z "$seen_android" ]; then
    ips=$(probe_android | grep -v '^192\.168\.1\.56$' | head -1)
    if [ -n "$ips" ]; then
      seen_android=$(( $(date +%s) - t0 )); android_ip=$ips
      echo "✅ a host with the box MAC answers at $android_ip after ${seen_android}s — Android (or a different link-layer user)"
      if command -v adb >/dev/null; then
        tmo 15 adb connect "$android_ip:5555" 2>&1 | tail -1
        for q in "getprop ro.build.fingerprint" "uname -a" "cat /proc/cmdline" "cat /proc/cpuinfo | grep -c ^processor"; do
          echo "adb> $q"; tmo 15 adb -s "$android_ip:5555" shell "$q" 2>&1 | head -5; done
        tmo 30 adb -s "$android_ip:5555" shell dmesg > "$here/archive/$(date +%Y%m%d-%H%M%S)-stock-android-dmesg.txt" 2>&1 \
          && echo "stock dmesg saved to archive/"
      fi
    fi
  fi
  sleep 5
done

# 6. verdict
dt=$(( $(date +%s) - t0 ))
if [ -n "$linux_back" ]; then
  echo "❌→ Linux is back after ${linux_back}s (watchdog/panic fell back; window was ~$((2 * wds))s)"
  [ -n "$seen_android" ] && echo "   but Android WAS seen at $android_ip after ${seen_android}s => the stock kernel booted" \
                         || echo "   Android was NOT seen on the LAN. Not proof it did not boot: DHCP lag, no adbd, or TCC (see header)"
  out=$here/archive/$(date +%Y%m%d-%H%M%S)-stock-android-fail-pstore.txt
  $SSH $H 'echo "=== persistent logs"; for f in $(ls -t /var/log/q10/stock-android-*.log | head -1) ; do echo "--- $f"; cat "$f"; done
    for f in /sys/fs/pstore/* /var/lib/systemd/pstore/* /var/lib/systemd/pstore/*/*; do [ -f "$f" ] && { echo "=== $f"; cat "$f"; }; done' > "$out" 2>&1
  $SSH $H 'q10-ramlog 2>&1' >> "$out"
  echo "persistent log + pstore + ramlog -> $out ($(wc -l < "$out") lines)"; tail -30 "$out"
  exit 1
elif [ -n "$seen_android" ]; then
  echo "✅ Android up at $android_ip (seen after ${seen_android}s); watchdog still armed: reset at ~$((2 * wds))s"; exit 0
else
  echo "⛔ nothing answered within ${dt}s: neither Linux (ssh) nor an Android host. The watchdog (~$((2 * wds))s) should still return Linux."
  exit 4
fi
