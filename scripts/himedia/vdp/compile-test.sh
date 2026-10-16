#!/bin/bash
# Compile-test the histb-vdp DRM driver (+ clock patch 0012) in the separate vdp-port tree.
# Never touches ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32/ (the .config is only COPIED).
# Usage: compile-test.sh [W=1]
set -euo pipefail
PORT=${VDP_PORT:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/vdp-port}
TREE=$PORT/linux-6.18.55
[ -f "$TREE/.config" ] || cp ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32/linux-6.18.55/.config "$TREE/.config"
[ -f "$TREE/Module.symvers" ] || cp ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32/linux-6.18.55/Module.symvers "$TREE/Module.symvers"
docker run --rm -v "$PORT":/ws -w /ws/linux-6.18.55 himedia-kbuild-arm32:trixie bash -c '
set -e
export ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-
./scripts/config --module DRM_HISI_HISTB_VDP
make olddefconfig >/dev/null
grep -E "^CONFIG_DRM_HISI_HISTB_VDP|^CONFIG_DRM_GEM_DMA_HELPER" .config
make -j"$(nproc)" modules_prepare >/dev/null 2>&1 || make modules_prepare 2>&1 | tail -20
make -j"$(nproc)" '"${1:-}"' drivers/gpu/drm/hisilicon/histb/ drivers/clk/hisilicon/ 2>&1 | tail -60
make -j"$(nproc)" '"${1:-}"' M=drivers/gpu/drm/hisilicon/histb modules 2>&1 | tail -60
ls -la drivers/gpu/drm/hisilicon/histb/*.ko
'
