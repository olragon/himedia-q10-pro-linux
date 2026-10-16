#!/bin/bash
# reboot-chain-test.sh — MAC side: cold-reboot the Q10 and follow the boot chain
# (U-Boot -> stick k14 -> q10-kexec-chain -> target kernel -> session). Reports every kernel the
# box answers on, then the chain log, the session log and the screen. Log: archive/<ts>-reboot-chain.log
set -uo pipefail
H=${Q10_HOST:-root@q10.local}; SSH="ssh -o BatchMode=yes -o ConnectTimeout=4"
here=$(cd "$(dirname "$0")/../../.." && pwd); log=$here/archive/$(date +%Y%m%d-%H%M%S)-reboot-chain.log
{
echo "[local->remote:$H] reboot-chain-test $(date +%T)"
target=$($SSH $H '. /etc/q10/kernel.conf; echo $TARGET_RELEASE') || { echo "⛔ box unreachable"; exit 2; }
echo "target=$target"; $SSH $H 'q10-kexec-chain status | head -1; sync; (sleep 1; systemctl reboot) >/dev/null 2>&1 &'
t0=$(date +%s); last=""; sleep 20
while [ $(( $(date +%s) - t0 )) -lt 600 ]; do
  r=$($SSH $H 'echo "$(uname -r) chained=$(grep -c q10.chained /proc/cmdline) up=$(cut -d. -f1 /proc/uptime)s"' 2>/dev/null) || r=""
  [ -n "$r" ] && [ "$r" != "$last" ] && { echo "+$(( $(date +%s) - t0 ))s  $r"; last=$r; }
  case "$r" in "$target chained=1"*) break ;; esac
  sleep 4
done
echo "--- final after $(( $(date +%s) - t0 ))s"
sleep 25
$SSH $H 'uname -r; cat /proc/cmdline; q10-kexec-chain status; tail -4 /var/log/q10/session.log; systemctl is-active q10-video-stack q10-session-boot q10-desktop q10-hotkey; echo js_faults=$(dmesg | grep -c "js fault")'
"$here/scripts/himedia/tools/fbgrab.sh" reboot-chain
} 2>&1 | tee "$log"
