#!/bin/bash
# q10-sata-write-check.sh [MB=1024] [--offset-mb N] — MAC side: NON-DESTRUCTIVE SATA write check.
# The box -> disk direction is what the disk's UDMA_CRC_Error_Count measures, and reads barely use it
# (commands only). So: per 64 MB chunk, read the sectors into RAM, write the SAME bytes back with
# O_DIRECT, drop caches, read again, compare sha256. A failed or partial write leaves identical bytes
# in place — no data on the disk changes. Aborts at the first libata exception or checksum mismatch.
# Needs the disk attached by q10-sata.service (tuned). Ends with the disk in standby and detached.
# Pass: CRC +0, exceptions +0, hard resets +0, every chunk's read-back sha256 equal.
set -uo pipefail
H=${Q10_HOST:-root@q10.local}; MB=1024; OFF=0
while [ $# -gt 0 ]; do case $1 in --offset-mb) OFF=$2; shift 2 ;; *) MB=$1; shift ;; esac; done
ssh -o BatchMode=yes -o ConnectTimeout=5 $H MB=$MB OFF=$OFF 'bash -s' <<'BOX'
set -uo pipefail
cnt() { dmesg | grep -c "$1"; }
d=$(basename "$(ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* 2>/dev/null | head -1)")
[ -n "$d" ] && [ "$d" != "*" ] || { echo "FAIL: no disk behind ata1 (start q10-sata.service first)"; exit 1; }
grep -q "^/dev/$d" /proc/mounts && { echo "FAIL: /dev/$d is mounted"; exit 1; }
echo "disk: /dev/$d $(lsblk -dno SIZE,MODEL,SERIAL /dev/$d)  region ${OFF}..$((OFF + MB)) MB"
crc() { smartctl -A /dev/$d | awk '$2=="UDMA_CRC_Error_Count"{print $10}'; }
smartctl -A /dev/$d | grep -E "UDMA_CRC|Temperature_Cel"
buf=/dev/shm/q10-wcheck.bin; trap 'rm -f $buf' EXIT
c0=$(crc); e0=$(cnt "ata1.00: exception"); r0=$(cnt "hard resetting link")
done_mb=0; fail=""; t0=$(date +%s.%N)
while [ $done_mb -lt $MB ] && [ -z "$fail" ]; do
  at=$((OFF + done_mb))
  dd if=/dev/$d of=$buf bs=1M count=64 skip=$at iflag=direct status=none || { fail="read rc=$? at ${at} MB"; break; }
  a=$(sha256sum < $buf)
  dd if=$buf of=/dev/$d bs=1M count=64 seek=$at oflag=direct conv=notrunc status=none || { fail="write rc=$? at ${at} MB"; break; }
  sync; echo 3 > /proc/sys/vm/drop_caches
  b=$(dd if=/dev/$d bs=1M count=64 skip=$at iflag=direct status=none | sha256sum)
  [ "$a" = "$b" ] || fail="sha256 MISMATCH at ${at} MB"
  done_mb=$((done_mb + 64))
  [ $(cnt "ata1.00: exception") -gt $e0 ] && fail="libata exception by ${done_mb} MB"
done
t1=$(date +%s.%N)
c1=$(crc); e1=$(cnt "ata1.00: exception"); r1=$(cnt "hard resetting link")
awk -v mb=$done_mb -v a=$t0 -v b=$t1 'BEGIN{printf "rewrote + verified %d MB in %.0f s (read+write+read)\n", mb, b-a}'
echo "${fail:+ABORTED: $fail  }CRC errors +$((c1-c0)) (total $c1)  exceptions +$((e1-e0))  hard resets +$((r1-r0))"
dmesg | grep -E "ata1: SATA link up|ata1.00: configured" | tail -2 | sed 's/^\[[^]]*\] //'
sync; hdparm -y /dev/$d >/dev/null; echo 1 > /sys/block/$d/device/delete; echo "disk standby + detached"
BOX
