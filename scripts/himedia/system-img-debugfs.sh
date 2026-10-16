#!/bin/sh
# Read-only peek into the stock Android system.img (ext4) via debugfs in ONE throwaway debian container.
# usage: system-img-debugfs.sh '<debugfs request>' ['<debugfs request>' ...]
#        system-img-debugfs.sh --sh '<shell script run INSIDE the container; /system.img is mounted ro>'
#   e.g. system-img-debugfs.sh 'ls -l /etc/firmware/ap6335' 'cat /etc/firmware/ap6335/config.txt'
#   e.g. system-img-debugfs.sh --sh 'debugfs -R "dump /lib/libbt-vendor.so /t.so" /system.img; strings /t.so | grep -i gpio'
# The image is mounted :ro and debugfs opens it read-only (no -w). Dumps land in the container, which is --rm'd.
# Nothing is written under $HIMEDIA_ROOT.
set -eu
IMG="${SYSTEM_IMG:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/emmc-dump/system.img}"
PRE='command -v debugfs >/dev/null || { apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq e2fsprogs binutils >/dev/null 2>&1; }; command -v strings >/dev/null || apt-get install -y -qq binutils >/dev/null 2>&1'
if [ "${1:-}" = "--sh" ]; then
  docker run --rm -e DEBIAN_FRONTEND=noninteractive -v "$IMG:/system.img:ro" debian:trixie sh -c "$PRE; $2"
else
  docker run --rm -e DEBIAN_FRONTEND=noninteractive -v "$IMG:/system.img:ro" debian:trixie sh -c "$PRE"'; for r in "$@"; do echo "### debugfs: $r"; debugfs -R "$r" /system.img 2>/dev/null; done' sh "$@"
fi
