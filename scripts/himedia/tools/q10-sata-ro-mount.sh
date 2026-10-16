#!/bin/bash
# q10-sata-ro-mount.sh mount|umount [mountpoint=/mnt/sata-ro] — MAC side: attach the SATA disk and mount
# its first partition READ-ONLY with no journal replay (ext4 `ro,noload` — a plain `ro` still replays an
# unclean journal, which is a write), or unmount it and leave the disk in standby, detached.
# Refuses when the root is on SATA. For looking at / backing up a disk without changing a byte.
# docs/261014-himedia-switch-to-wd-disk.md
set -uo pipefail
OP=${1:?usage: q10-sata-ro-mount.sh mount|umount [mountpoint]}; MP=${2:-/mnt/sata-ro}; H=${Q10_HOST:-root@q10.local}
here=$(cd "$(dirname "$0")" && pwd)
case $OP in
mount)
  ssh -o BatchMode=yes -o ConnectTimeout=5 $H MP="$MP" 'bash -s' <<'BOX'
set -uo pipefail
findmnt -no SOURCE / | grep -q '^/dev/sd' && { echo "FAIL: root is on a SATA disk"; exit 1; }
uname -r | grep -q -- '-k2[6-9]' || { echo "FAIL: kernel $(uname -r) < k26 — not training the link"; exit 1; }
lsmod | grep -q '^ahci_platform' || modprobe ahci_platform
# driver loaded but the disk was detached (device/delete): rescan ata1's SCSI host to bring it back
ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* >/dev/null 2>&1 || \
  for h in /sys/class/ata_port/ata1/device/host*/scsi_host/host*; do echo '- - -' > "$h/scan"; done
for i in $(seq 20); do ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* >/dev/null 2>&1 && break; sleep 1; done
d=$(basename "$(ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* 2>/dev/null | head -1)")
# a disk coming out of standby spins up before its partition table is read (~7 s): wait for the partition
for i in $(seq 30); do [ -b "/dev/${d}1" ] && break; sleep 1; done
[ -b "/dev/${d}1" ] || { echo "FAIL: no /dev/${d}1"; exit 1; }
mkdir -p "$MP"; mount -t ext4 -o ro,noload "/dev/${d}1" "$MP" || exit 1
echo "OK: /dev/${d}1 ($(lsblk -dno MODEL,SERIAL /dev/$d)) ro,noload at $MP — $(df -h "$MP" | awk 'NR==2{print $3" used"}')"
BOX
  ;;
umount)
  ssh -o BatchMode=yes -o ConnectTimeout=5 $H "umount '$MP' && echo 'umount $MP'" || exit 1
  bash "$here/q10-sata-detach.sh"
  ;;
*) echo "usage: q10-sata-ro-mount.sh mount|umount [mountpoint]"; exit 2 ;;
esac
