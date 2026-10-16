#!/bin/bash
# q10-sata-root-make.sh <serial> — MAC side: WIPE the SATA disk with that serial and make it the box's
# root: GPT + one ext4 LABEL=q10root, a copy of the running stick root, and the music library + Android
# data copied ONTO the root (no 4 GB loop images there; the stick keeps its own as the fallback).
# ⛔ DESTRUCTIVE. Refuses unless the disk behind ata1 has exactly <serial> and nothing on it is mounted.
# Does NOT opt in to booting from it — that is `touch /mnt/stick/q10-root-sata` + a reboot.
# Tim approved wiping the Seagate ST3250310AS 5RY02GLK on 2026-10-14.
# docs/261014-himedia-sata-kernel-vs-board.md
set -uo pipefail
SERIAL=${1:?usage: q10-sata-root-make.sh <disk serial>}
H=${Q10_HOST:-root@q10.local}
ssh -o BatchMode=yes -o ConnectTimeout=5 $H SERIAL="$SERIAL" 'bash -s' <<'BOX'
set -euo pipefail
cnt() { dmesg | grep -c "$1" || true; }   # grep -c exits 1 on a zero count; set -e would stop here
lsmod | grep -q '^ahci_platform' && rmmod ahci_platform
systemctl restart q10-sata.service          # driver + vendor PHY tune + retrain
sleep 2
d=$(basename "$(ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* 2>/dev/null | head -1)")
[ -b "/dev/$d" ] || { echo "FAIL: no disk behind ata1"; exit 1; }
s=$(lsblk -dno SERIAL /dev/$d | tr -d ' ')
[ "$s" = "$SERIAL" ] || { echo "FAIL: /dev/$d serial '$s' is not '$SERIAL' — refusing to wipe"; exit 1; }
grep -q "^/dev/$d" /proc/mounts && { echo "FAIL: /dev/$d has a mounted partition"; exit 1; }
echo "disk: /dev/$d $(lsblk -dno SIZE,MODEL,SERIAL /dev/$d) — WIPING"
crc() { smartctl -A /dev/$d | awk '$2=="UDMA_CRC_Error_Count"{print $10}'; }
c0=$(crc); e0=$(cnt "ata1.00: exception"); r0=$(cnt "hard resetting link")

wipefs -a /dev/${d}1 2>/dev/null || true
wipefs -a /dev/$d
sgdisk --zap-all /dev/$d >/dev/null
sgdisk -n1:0:0 -t1:8300 -c1:q10root /dev/$d >/dev/null
blockdev --rereadpt /dev/$d; udevadm settle; sleep 1
mkfs.ext4 -q -F -L q10root -m 1 /dev/${d}1
uuid=$(blkid -s UUID -o value /dev/${d}1); echo "mkfs ok: /dev/${d}1 UUID=$uuid"

M=/mnt/newroot; mkdir -p $M; mount -o noatime /dev/${d}1 $M
trap 'sync; umount '$M' 2>/dev/null || true' EXIT
echo "copy root…";   rsync -aHAXx --numeric-ids / $M/
echo "copy music…";  mkdir -p $M/srv/music;          rsync -aHAX --numeric-ids /srv/music/ $M/srv/music/
echo "copy android…"; mkdir -p $M/var/lib/q10/android; rsync -aHAX --numeric-ids /var/lib/q10/android/ $M/var/lib/q10/android/
# on the disk root, music + Android live on the root itself: drop the two loop-image mounts
sed -i -E 's,^(/mnt/stick/q10-(music|android)\.img .*)$,# on the SATA root this is a directory on the root: \1,' $M/etc/fstab
echo "# root: LABEL=q10root UUID=$uuid on the SATA disk (mounted by the initramfs)" >> $M/etc/fstab
# one tuning caller per boot path: the initramfs loads the driver, q10-sata-phy-tune.service tunes
ln -sf /etc/systemd/system/q10-sata-phy-tune.service $M/etc/systemd/system/sysinit.target.wants/q10-sata-phy-tune.service
rm -f $M/etc/systemd/system/multi-user.target.wants/q10-sata.service $M/etc/systemd/system/multi-user.target.wants/q10-sata-hotplug.service
sync; echo 3 > /proc/sys/vm/drop_caches   # verify must read the DISK, not the page cache
echo "verify (checksum dry-run of /usr and the Android data)…"
n1=$(rsync -aHAXxcn --out-format=%n /usr/ $M/usr/ | wc -l)
n2=$(rsync -aHAXcn --out-format=%n /var/lib/q10/android/ $M/var/lib/q10/android/ | wc -l)
echo "differing files: /usr $n1, android $n2"
df -h $M | tail -1; grep -E "q10-(music|android)\.img|root:" $M/etc/fstab
ls $M/etc/systemd/system/sysinit.target.wants/ | grep q10; ls $M/etc/systemd/system/multi-user.target.wants/ | grep -c q10-sata || true
c1=$(crc); e1=$(cnt "ata1.00: exception"); r1=$(cnt "hard resetting link")
echo "link during wipe+copy: CRC +$((c1-c0)) (total $c1)  exceptions +$((e1-e0))  hard resets +$((r1-r0))"
smartctl -A /dev/$d | grep -E "Temperature_Cel|Reallocated_Sector|Current_Pending"
BOX
