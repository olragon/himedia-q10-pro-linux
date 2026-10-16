#!/bin/bash
# q10-sata-root-restore.sh <serial> <backup.tar.zst> — MAC side: WIPE the SATA disk with that serial and
# make it the box's root from a q10-root-backup.sh archive of an earlier SATA root (so it carries that
# root's state: SATA-root fstab, music + Android data as directories). GPT + one ext4 LABEL=q10root.
# ⛔ DESTRUCTIVE. Refuses unless: root is not on SATA, kernel >= k26, the disk behind ata1 has exactly
# <serial>, nothing on it is mounted, and the archive lists. Does NOT opt in to booting from it — that is
# renaming /mnt/stick/q10-root-sata-chained.off back + a reboot.
# Tim approves each wipe by serial. docs/261014-himedia-switch-to-wd-disk.md
set -uo pipefail
SERIAL=${1:?usage: q10-sata-root-restore.sh <serial> <backup.tar.zst>}; TAR=${2:?backup archive}
H=${Q10_HOST:-root@q10.local}; M=/mnt/newroot
[ -f "$TAR" ] || { echo "FAIL: no $TAR"; exit 1; }
want=$(zstd -dc "$TAR" | tar -tf - | wc -l | tr -d ' ') || { echo "FAIL: archive does not list"; exit 1; }
echo "$(date +%T) archive $TAR: $want entries"

# 1. guards, wipe, mkfs, mount (on the box)
ssh -o BatchMode=yes -o ConnectTimeout=5 $H SERIAL="$SERIAL" M="$M" 'bash -s' <<'BOX' || exit 1
set -euo pipefail
cnt() { dmesg | grep -c "$1" || true; }
findmnt -no SOURCE / | grep -q '^/dev/sd' && { echo "FAIL: root is on a SATA disk"; exit 1; }
uname -r | grep -q -- '-k2[6-9]' || { echo "FAIL: kernel $(uname -r) < k26"; exit 1; }
lsmod | grep -q '^ahci_platform' || modprobe ahci_platform
ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* >/dev/null 2>&1 || \
  for h in /sys/class/ata_port/ata1/device/host*/scsi_host/host*; do echo '- - -' > "$h/scan"; done
for i in $(seq 30); do ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* >/dev/null 2>&1 && break; sleep 1; done
d=$(basename "$(ls -d /sys/class/ata_port/ata1/device/host*/target*/*/block/* 2>/dev/null | head -1)")
[ -b "/dev/$d" ] || { echo "FAIL: no disk behind ata1"; exit 1; }
# serial from the disk itself: lsblk reads udev's db, which is empty after a SCSI rescan (seen 2026-10-15)
s=$(smartctl -i /dev/$d | awk -F': *' '/^Serial Number/{print $2}' | tr -d ' ')
[ "$s" = "$SERIAL" ] || { echo "FAIL: /dev/$d serial '$s' is not '$SERIAL' — refusing to wipe"; exit 1; }
grep -q "^/dev/$d" /proc/mounts && { echo "FAIL: /dev/$d has a mounted partition"; exit 1; }
smartctl -A /dev/$d | awk '$2=="UDMA_CRC_Error_Count"{print $10}' > /run/q10-restore.crc0
echo "$(cnt 'ata1.00: exception') $(cnt 'hard resetting link')" > /run/q10-restore.err0
echo "disk: /dev/$d $(lsblk -dno SIZE,MODEL,SERIAL /dev/$d) — WIPING"
wipefs -a /dev/${d}1 2>/dev/null || true
wipefs -a /dev/$d; sgdisk --zap-all /dev/$d >/dev/null
sgdisk -n1:0:0 -t1:8300 -c1:q10root /dev/$d >/dev/null
blockdev --rereadpt /dev/$d; udevadm settle; sleep 1
mkfs.ext4 -q -F -L q10root -m 1 /dev/${d}1
echo "mkfs ok: /dev/${d}1 UUID=$(blkid -s UUID -o value /dev/${d}1)"
mkdir -p $M; mount -o noatime /dev/${d}1 $M; echo "$d" > /run/q10-restore.dev
BOX

# 2. stream the archive in
echo "$(date +%T) restoring…"
zstd -dc "$TAR" | ssh -o BatchMode=yes $H "tar -xpf - --numeric-owner --acls --xattrs -C $M" \
  || { echo "FAIL: restore stream"; ssh $H "umount $M"; exit 1; }

# 3. fix the root comment, verify, unmount (on the box)
ssh -o BatchMode=yes $H M="$M" WANT="$want" 'bash -s' <<'BOX'
set -uo pipefail
cnt() { dmesg | grep -c "$1" || true; }
d=$(cat /run/q10-restore.dev); uuid=$(blkid -s UUID -o value /dev/${d}1)
sed -i -E "s,^# root: LABEL=q10root UUID=[0-9a-f-]+ ,# root: LABEL=q10root UUID=$uuid ," $M/etc/fstab
have=$(cd $M && find . -path ./lost+found -prune -o -print | wc -l)
echo "entries on disk $have (archive $WANT; sockets are not archived, lost+found not counted)"
[ -x $M/sbin/init ] || [ -L $M/sbin/init ] || echo "FAIL: no /sbin/init"
grep "root:" $M/etc/fstab; du -sh $M/var/lib/q10/android 2>/dev/null
sync; umount $M
read c0 < /run/q10-restore.crc0; read e0 r0 < /run/q10-restore.err0
c1=$(smartctl -A /dev/$d | awk '$2=="UDMA_CRC_Error_Count"{print $10}')
echo "link during wipe+restore: CRC +$((c1-c0)) (total $c1)  exceptions +$(( $(cnt 'ata1.00: exception') - e0 ))  hard resets +$(( $(cnt 'hard resetting link') - r0 ))"
smartctl -A /dev/$d | grep -E "Temperature_Cel|Reallocated_Sector|Current_Pending"
BOX
echo "$(date +%T) done. Opt in: ssh $H 'mv /mnt/stick/q10-root-sata-chained.off /mnt/stick/q10-root-sata-chained'"
