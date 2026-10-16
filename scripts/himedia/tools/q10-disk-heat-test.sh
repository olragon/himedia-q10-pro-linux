#!/bin/bash
# q10-disk-heat-test.sh [minutes=30] [abort-C=54] — MAC side: how hot does the SATA disk run in the box?
# Attaches the disk the tested-safe way (q10-sata.service: driver + PHY tune on an IDLE, unmounted disk),
# keeps it spinning with NO I/O, and logs disk / SoC temperature every minute. Spins the disk down and
# detaches it at the end, or at once if it reaches abort-C (SMART limit for the ST3250310AS is 55 C).
# The disk must not be mounted or be the root. docs/261014-himedia-sata-kernel-vs-board.md
set -uo pipefail
MIN=${1:-30}; ABORT=${2:-54}; H=${Q10_HOST:-root@q10.local}
ssh -o BatchMode=yes -o ConnectTimeout=5 $H MIN=$MIN ABORT=$ABORT 'bash -s' <<'BOX'
set -uo pipefail
findmnt -no SOURCE / | grep -q '^/dev/sd' && { echo "FAIL: root is on a SATA disk"; exit 1; }
lsmod | grep -q '^ahci_platform' && rmmod ahci_platform
systemctl restart q10-sata.service; sleep 2
d=$(basename "$(ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* 2>/dev/null | head -1)")
[ -b "/dev/$d" ] || { echo "FAIL: no disk behind ata1"; exit 1; }
grep -q "^/dev/$d" /proc/mounts && { echo "FAIL: /dev/$d is mounted"; exit 1; }
hdparm -S 0 /dev/$d >/dev/null 2>&1   # no standby timer during the test: we want the spinning steady state
temp() { smartctl -A /dev/$d | awk '$1==194{print $10}'; }
echo "disk /dev/$d $(lsblk -dno MODEL,SERIAL /dev/$d), spinning idle for ${MIN} min, abort at ${ABORT} C"
for i in $(seq 0 "$MIN"); do
  t=$(temp); soc=$(( $(cat /sys/class/thermal/thermal_zone0/temp) / 1000 ))
  echo "$(date +%T) +${i}m disk ${t} C  soc ${soc} C"
  [ -n "$t" ] && [ "$t" -ge "$ABORT" ] && { echo "ABORT: disk ${t} C >= ${ABORT} C"; break; }
  [ "$i" -lt "$MIN" ] && sleep 60
done
echo "exceptions this boot: $(dmesg | grep -c 'ata1.00: exception' || true)"
sync; hdparm -y /dev/$d >/dev/null; echo 1 > /sys/block/$d/device/delete; echo "disk standby + detached"
BOX
