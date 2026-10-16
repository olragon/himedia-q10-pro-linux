#!/bin/bash
# q10-sata-link-test.sh — measure SATA link quality under load, so a PHY change is judged by numbers.
#   q10-sata-link-test.sh <mountpoint> [MB=1024]      direct write + read-back, then the error deltas
#   q10-sata-link-test.sh --retrain                  detach + rescan the disk (link retrains with the
#                                                    current PHY registers); only when unmounted
# Reports: MB/s write/read, UDMA_CRC_Error_Count delta (corrupted FIS on the wire, retried), libata
# exceptions and hard resets during the run, negotiated speed / UDMA mode.
set -uo pipefail
PORT=ata1
disk() { basename "$(ls -d /sys/class/ata_port/$PORT/device/host*/target*/*/block/* 2>/dev/null | head -1)"; }
crc() { smartctl -A "/dev/$(disk)" 2>/dev/null | awk '$2=="UDMA_CRC_Error_Count"{print $10}'; }
cnt() { dmesg | grep -c "$1"; }

if [ "${1:-}" = "--retrain" ]; then
  d=$(disk); [ -n "$d" ] || { echo "no disk"; exit 1; }
  grep -q "^/dev/$d" /proc/mounts && { echo "/dev/$d is mounted — unmount first"; exit 1; }
  h=$(basename "$(ls -d /sys/class/ata_port/$PORT/device/host* | head -1)")
  echo 1 > "/sys/block/$d/device/delete"; sleep 2
  echo "- - -" > "/sys/class/scsi_host/$h/scan"; sleep 6
  dmesg | grep -E "$PORT: SATA link|$PORT.00: configured" | tail -2
  exit 0
fi

mnt=${1:?usage: q10-sata-link-test.sh <mountpoint> [MB] | --retrain}; mb=${2:-1024}
f="$mnt/.q10-link-test.bin"
c0=$(crc); e0=$(cnt "$PORT.00: exception"); r0=$(cnt "hard resetting link")
t0=$(date +%s.%N)
dd if=/dev/urandom of=/tmp/.q10-pattern bs=1M count=16 status=none
for i in $(seq 1 $((mb / 16))); do cat /tmp/.q10-pattern; done | dd of="$f" bs=1M oflag=direct iflag=fullblock status=none
sync; t1=$(date +%s.%N)
echo 3 > /proc/sys/vm/drop_caches
dd if="$f" of=/dev/null bs=1M iflag=direct status=none; t2=$(date +%s.%N)
rm -f "$f" /tmp/.q10-pattern
c1=$(crc); e1=$(cnt "$PORT.00: exception"); r1=$(cnt "hard resetting link")
awk -v mb="$mb" -v a="$t0" -v b="$t1" -v c="$t2" 'BEGIN{printf "write %.1f MB/s  read %.1f MB/s  (%d MB)\n", mb/(b-a), mb/(c-b), mb}'
echo "CRC errors +$((c1 - c0)) (total $c1)  exceptions +$((e1 - e0))  hard resets +$((r1 - r0))"
dmesg | grep -E "$PORT: SATA link up|$PORT.00: configured for" | tail -2
