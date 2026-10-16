#!/bin/bash
# q10-sata-read-check.sh [MB=2048] [--nano1 V] — MAC side: READ-ONLY SATA link check under the real driver.
# Loads the SATA driver under the watchdog (q10-sata.service, started — NOT enabled). With --nano1,
# rewrites combo-PHY nano register 0x1 right after the driver's own phy_init (mainline writes 0x8,
# the vendor SATA driver 0x4 — docs/261014-himedia-sata-kernel-vs-board.md) and retrains the link.
# With --vendor, also writes the vendor AHCI port tuning (0x14c/0x174/0x144, hiahci_phy_init) before
# the retrain. Then reads the disk raw with O_DIRECT in STAGES and ABORTS at the first libata
# exception: 64 MB in 16 MB chunks, then the rest up to MB in 128 MB chunks. Writes nothing to the disk.
# Pass: CRC +0, exceptions +0, hard resets +0. Ends with the disk in standby and detached.
set -uo pipefail
H=${Q10_HOST:-root@q10.local}; MB=2048; NANO1=""; VENDOR=0
while [ $# -gt 0 ]; do case $1 in --nano1) NANO1=$2; shift 2 ;; --vendor) VENDOR=1; shift ;; *) MB=$1; shift ;; esac; done
ssh -o BatchMode=yes -o ConnectTimeout=5 $H MB=$MB NANO1="$NANO1" VENDOR=$VENDOR 'bash -s' <<'BOX'
set -uo pipefail
BB=/bin/busybox; PERI=0xf8a20000; AHCI=0xf9900000
rd() { $BB devmem $(( $1 )) 32; }
wr() { $BB devmem $(( $1 )) 32 $(( $2 )); }
nano() { v=$(rd $PERI+0x858); v=$(( (v & ~0xf1f000) | ($2 << 20) | ($1 << 12) ))
         wr $PERI+0x858 $v; $BB usleep 20000; wr $PERI+0x858 $(( v | 0x1000000 )); $BB usleep 20000; wr $PERI+0x858 $(( v & ~0x1000000 )); $BB usleep 20000; }
cnt() { dmesg | grep -c "$1"; }
disk() { basename "$(ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* 2>/dev/null | head -1)"; }
# a fresh probe every run: with ahci_platform still loaded, restarting the unit is a no-op and the
# detached disk never comes back
lsmod | grep -q '^ahci_platform' && rmmod ahci_platform
systemctl restart q10-sata.service; echo "q10-sata: $(systemctl is-active q10-sata.service)"; sleep 3
d=$(disk); [ -n "$d" ] || { echo "FAIL: no disk behind ata1"; dmesg | grep -iE "ata1" | tail -8; exit 1; }
echo "driver link: $(dmesg | grep -E 'ata1: SATA link up' | tail -1 | sed 's/^\[[^]]*\] //')"
if [ -n "$NANO1" ]; then
  nano 0x1 $(( NANO1 ))
  if [ "$VENDOR" = 1 ]; then
    v=$(rd $AHCI+0x148); wr $AHCI+0x148 $(( v & ~0x100 )); v=$(rd $AHCI+0x14c); wr $AHCI+0x14c $(( (v & ~0x1ff) | 0x52 ))
    v=$(rd $AHCI+0x148); wr $AHCI+0x148 $(( v & ~0x100 )); v=$(rd $AHCI+0x14c); wr $AHCI+0x14c $(( (v & ~0x3fe00) | 0x8000 ))
    wr $AHCI+0x174 0x0e400000; v=$(rd $AHCI+0x144); wr $AHCI+0x144 $(( v | 0x680000 ))
    echo "vendor AHCI tuning: 144=$(rd $AHCI+0x144) 14c=$(rd $AHCI+0x14c) 174=$(rd $AHCI+0x174)"
  fi
  e=$(cnt "ata1: SATA link up")
  v=$(rd $AHCI+0x12c); wr $AHCI+0x12c $(( (v & ~0xf) | 1 )); $BB usleep 10000; wr $AHCI+0x12c $(( v & ~0xf ))  # COMRESET; libata EH revalidates
  for i in $(seq 1 30); do [ $(cnt "ata1: SATA link up") -gt $e ] && dmesg | grep -q "ata1.00: configured" && break; sleep 1; done
  sleep 2; echo "nano1=$NANO1 link: $(dmesg | grep -E 'ata1: SATA link up' | tail -1 | sed 's/^\[[^]]*\] //')"
  d=$(disk)
fi
echo "disk: /dev/$d $(lsblk -dno SIZE,MODEL,SERIAL /dev/$d)"
crc() { smartctl -A /dev/$d | awk '$2=="UDMA_CRC_Error_Count"{print $10}'; }
smartctl -A /dev/$d | grep -E "UDMA_CRC|Temperature_Cel"
c0=$(crc); e0=$(cnt "ata1.00: exception"); r0=$(cnt "hard resetting link"); s0=$(cnt "ata1: SATA link up")
done_mb=0; t0=$(date +%s.%N); fail=""
chunk() { dd if=/dev/$d of=/dev/null bs=1M count=$1 skip=$done_mb iflag=direct status=none || fail="dd rc=$?"
          done_mb=$((done_mb + $1)); [ $(cnt "ata1.00: exception") -gt $e0 ] && fail="libata exception at ${done_mb} MB"; }
while [ $done_mb -lt 64 ] && [ -z "$fail" ]; do chunk 16; done
while [ $done_mb -lt $MB ] && [ -z "$fail" ]; do chunk 128; done
t1=$(date +%s.%N)
c1=$(crc); e1=$(cnt "ata1.00: exception"); r1=$(cnt "hard resetting link")
awk -v mb=$done_mb -v a=$t0 -v b=$t1 'BEGIN{printf "raw read %.1f MB/s (%d MB)\n", mb/(b-a), mb}'
echo "${fail:+ABORTED: $fail  }CRC errors +$((c1-c0)) (total $c1)  exceptions +$((e1-e0))  hard resets +$((r1-r0))"
dmesg | grep -E "ata1: SATA link up|ata1.00: configured" | tail -2 | sed 's/^\[[^]]*\] //'
sync; hdparm -y /dev/$d >/dev/null; echo 1 > /sys/block/$d/device/delete; echo "disk standby + detached"
BOX
