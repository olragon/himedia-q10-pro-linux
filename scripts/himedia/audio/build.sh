#!/bin/bash
# build.sh — build the Q10 audio driver (q10_aiao.ko) as an EXTERNAL module against the kernel
# tree's CURRENT build (whatever release the last build-kernel-arm32 run left: read below).
# Seconds per iteration, and the .ko loads with insmod on a box running that same release —
# no kernel rebuild, no kexec, no stick write per driver change.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
W=${Q10_KBUILD_ROOT:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32}
OUT=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/audio
mkdir -p "$OUT"
rel=$(cat "$W/linux-6.18.55/include/config/kernel.release")
echo "[local] building q10_aiao.ko against $rel"
docker run --rm --platform linux/arm64 -v "$W:/ws" -v "$here:/src:ro" -v "$OUT:/out" \
  himedia-kbuild-arm32:trixie bash -euc '
    rm -rf /tmp/mod && cp -r /src /tmp/mod
    make -s -C /ws/linux-6.18.55 ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- M=/tmp/mod modules
    cp /tmp/mod/q10_aiao.ko /out/q10_aiao-'"$rel"'.ko
    modinfo /tmp/mod/q10_aiao.ko | grep -E "vermagic|^name"'
ls -l "$OUT/q10_aiao-$rel.ko"
