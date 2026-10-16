#!/bin/bash
# Regenerate patches 0011 (histb-vdp DRM driver) and 0012 (VO/VDP clock gates) from the vdp-port
# working tree. `base/` holds the 0001..0010-patched copies of the files 0011/0012 modify
# (see apply-base-patches.sh). Output: scripts/himedia/kernel/arm32/.
set -euo pipefail
PORT=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/vdp-port
TREE=$PORT/linux-6.18.55
BASE=$PORT/base
OUT=$(cd "$(dirname "$0")/../../.." && pwd)/scripts/himedia/kernel/arm32
HDR=$(dirname "$0")

mod() { # modified file: diff base -> tree
  diff -u --label "a/$1" --label "b/$1" "$BASE/$1" "$TREE/$1" || true
}
new() { # new file
  diff -u --label /dev/null --label "b/$1" /dev/null "$TREE/$1" || true
}

{
  cat "$HDR/0011.header.txt"
  for f in drivers/gpu/drm/hisilicon/Kconfig drivers/gpu/drm/hisilicon/Makefile; do mod "$f"; done
  for f in Kconfig Makefile histb_vdp.h histb_vdp_drv.c histb_vdp_hw.c histb_vdp_zme.c; do
    new "drivers/gpu/drm/hisilicon/histb/$f"
  done
} > "$OUT/0011-drm-hisilicon-histb-vdp-with-video-plane.patch"

{
  cat "$HDR/0012.header.txt"
  mod include/dt-bindings/clock/histb-clock.h
  mod drivers/clk/hisilicon/crg-hi3798cv200.c
} > "$OUT/0012-clk-hisilicon-crg-hi3798cv200-vo-vdp-gates.patch"

ls -la "$OUT"/001[12]-*.patch
