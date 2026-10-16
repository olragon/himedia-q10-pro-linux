#!/bin/bash
# vdec-build-module.sh — rebuild histb-vdec.ko (and histb-vpss.ko) for the kernel tree's CURRENT
# release as an out-of-image module build (same approach as audio/build.sh). Output:
#   ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/vdec-port/histb-vdec-<release>.ko  (+ histb-vpss)
# usage: vdec-build-module.sh [dest-name-suffix]   (default: release)
set -euo pipefail
W=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32
OUT=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/vdec-port
rel=$(cat "$W/linux-6.18.55/include/config/kernel.release")
echo "[local] building histb-vdec.ko against $rel"
docker run --rm --platform linux/arm64 -v "$W:/ws" himedia-kbuild-arm32:trixie bash -euc '
    make -C /ws/linux-6.18.55 ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- M=drivers/media/platform/hisilicon modules > /tmp/kbuild.log 2>&1 || { tail -40 /tmp/kbuild.log; exit 1; }; tail -12 /tmp/kbuild.log
    modinfo /ws/linux-6.18.55/drivers/media/platform/hisilicon/histb-vdec.ko | grep -E "vermagic|^name"'
cp "$W/linux-6.18.55/drivers/media/platform/hisilicon/histb-vdec.ko" "$OUT/histb-vdec-${1:-$rel}.ko"
cp "$W/linux-6.18.55/drivers/media/platform/hisilicon/histb-vpss.ko" "$OUT/histb-vpss-${1:-$rel}.ko"
ls -l "$OUT/histb-vdec-${1:-$rel}.ko" "$OUT/histb-vpss-${1:-$rel}.ko"
