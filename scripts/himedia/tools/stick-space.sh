#!/bin/bash
# stick-space.sh — ON THE BOX, as root: lay out the 15 GB FAT32 boot stick for every session.
#   grow-root      rootfs.img 3.5 GB -> 4095 MiB (FAT32 caps a file at 4 GiB - 1), ext4 grown online
#   android-img    q10-android.img 4095 MiB ext4 (LABEL=q10android) at /var/lib/q10/android, with
#                  /var/lib/waydroid, /etc/waydroid-extra and the image downloads bind-mounted from it
#   status
# Idempotent. Back up rootfs.img first (tools/stick-backup.sh rootfs.img --freeze on the Mac).
# ⛔ Never touches uImage, never the eMMC. docs/261013-himedia-stick-full-sessions.md
set -euo pipefail
S=/mnt/stick; MAX=$((4095 * 1024 * 1024)); A=/var/lib/q10/android
mountpoint -q $S || { echo "⛔ $S not mounted"; exit 1; }

grow_root() {
  local loop size; loop=$(losetup -j $S/rootfs.img | cut -d: -f1)
  [ -n "$loop" ] || { echo "⛔ rootfs.img is not a loop device"; exit 1; }
  size=$(stat -c %s $S/rootfs.img)
  if [ "$size" -lt $MAX ]; then
    echo "rootfs.img $size -> $MAX bytes (vfat zero-fills the new tail)"
    truncate -s $MAX $S/rootfs.img; sync
  fi
  losetup -c "$loop"
  resize2fs "$loop"
  df -h /
}

android_img() {
  local img=$S/q10-android.img
  if [ ! -e $img ]; then
    echo "creating $img ($MAX bytes)"
    truncate -s $MAX $img.part && mkfs.ext4 -q -F -L q10android -m 0 $img.part && sync && mv $img.part $img
  fi
  mkdir -p $A /var/lib/waydroid /etc/waydroid-extra /var/lib/q10/waydroid-images
  grep -q "q10-android.img" /etc/fstab || cat >> /etc/fstab <<EOF
# Android 13 (Waydroid): images + data on their own image file (the root stops at 4 GB on FAT32)
$img $A ext4 loop,noatime,nofail,x-systemd.requires-mounts-for=$S 0 0
$A/waydroid /var/lib/waydroid none bind,nofail,x-systemd.requires-mounts-for=$A 0 0
$A/waydroid-extra /etc/waydroid-extra none bind,nofail,x-systemd.requires-mounts-for=$A 0 0
$A/downloads /var/lib/q10/waydroid-images none bind,nofail,x-systemd.requires-mounts-for=$A 0 0
EOF
  systemctl daemon-reload
  mountpoint -q $A || mount $A
  mkdir -p $A/waydroid $A/waydroid-extra $A/downloads
  for m in /var/lib/waydroid /etc/waydroid-extra /var/lib/q10/waydroid-images; do mountpoint -q $m || mount $m; done
  # one target per findmnt: given several it prints nothing and exits 1 (that stopped this under set -e)
  for m in $A /var/lib/waydroid /etc/waydroid-extra /var/lib/q10/waydroid-images; do
    findmnt -n -o TARGET,SOURCE,SIZE,AVAIL "$m"; done
}

case "${1:-}" in
  grow-root) grow_root ;;
  android-img) android_img ;;
  status) ls -la $S; df -h / $A 2>/dev/null; grep -E "q10-(android|music)" /etc/fstab ;;
  *) sed -n 2,8p "$0"; exit 2 ;;
esac
