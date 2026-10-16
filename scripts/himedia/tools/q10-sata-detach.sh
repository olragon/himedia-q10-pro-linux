#!/bin/bash
# q10-sata-detach.sh — MAC side: make the SATA disk safe to unplug. Refuses if the root is on it.
# Unmounts anything on it, stops the hotplug mounts from re-attaching it, spins it down (standby) and
# deletes the SCSI device, then confirms nothing is left behind ata1. Before a disk swap or a plug pull.
# docs/261014-himedia-switch-to-wd-disk.md
set -uo pipefail
H=${Q10_HOST:-root@q10.local}
ssh -o BatchMode=yes -o ConnectTimeout=5 $H 'bash -s' <<'BOX'
set -uo pipefail
findmnt -no SOURCE / | grep -q '^/dev/sd' && { echo "FAIL: root is on a SATA disk"; exit 1; }
# no driver loaded (stick root, SATA units off): the disk still spins from power-up. Load the driver so it
# can be put in standby — k26 sets the SATA PHY value before training; the disk stays unmounted.
if ! lsmod | grep -q '^ahci_platform'; then
  uname -r | grep -q -- '-k2[6-9]' || { echo "FAIL: driver not loaded and kernel $(uname -r) < k26 — not training the link"; exit 1; }
  modprobe ahci_platform; for i in $(seq 20); do ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* >/dev/null 2>&1 && break; sleep 1; done
fi
d=$(basename "$(ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* 2>/dev/null | head -1)")
[ -n "$d" ] && [ -b "/dev/$d" ] || { echo "OK: nothing behind ata1 (already detached)"; exit 0; }
echo "disk: /dev/$d $(lsblk -dno SIZE,MODEL,SERIAL /dev/$d)"
systemctl stop q10-sata-hotplug.service 2>/dev/null || true
for m in $(grep "^/dev/$d" /proc/mounts | cut -d' ' -f2); do umount "$m" && echo "umount $m"; done
grep -q "^/dev/$d" /proc/mounts && { echo "FAIL: /dev/$d still mounted"; exit 1; }
sync; hdparm -y /dev/$d >/dev/null && echo "standby"
echo 1 > /sys/block/$d/device/delete; sleep 1
[ -b "/dev/$d" ] && { echo "FAIL: /dev/$d still present"; exit 1; }
echo "OK: /dev/$d spun down and detached — safe to pull the plug"
BOX
