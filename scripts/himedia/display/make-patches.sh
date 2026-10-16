#!/bin/bash
# Regenerate patches 0015 (HDMI pixel clock), 0016 (HDMI bridge) and 0017 (VDP mode setting) from the
# display tree, as a diff against the base stack (lib.sh: pristine + every patch below 0015, rebuilt
# here each run - ~20 s - so it can never be stale).  A path that does not exist in the base is a NEW
# file and is diffed against /dev/null.   Output: scripts/himedia/kernel/arm32/.  Then run verify-patches.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=lib.sh
. "$here/lib.sh"
TREE=$ROOT/linux-6.18.55
BASEDIR=$ROOT/base-stack
base_tree "$BASEDIR" >/dev/null
BASE=$BASEDIR/linux-6.18.55
OUT=$K/arm32

one() { # path: modified (has a base) or new
  if [ -f "$BASE/$1" ]; then
    diff -u --label "a/$1" --label "b/$1" "$BASE/$1" "$TREE/$1" || true
  else
    diff -u --label /dev/null --label "b/$1" /dev/null "$TREE/$1" || true
  fi
}
emit() { # patch-file header-file paths...
  local out=$1 hdr=$2; shift 2
  { cat "$here/$hdr"; for f in "$@"; do one "$f"; done; } > "$OUT/$out"
}

emit 0015-clk-hisilicon-hi3798cv200-hdmi-pixel-clock.patch 0015.header.txt \
  include/dt-bindings/clock/histb-clock.h \
  drivers/clk/hisilicon/clk.c drivers/clk/hisilicon/clk.h drivers/clk/hisilicon/Makefile \
  drivers/clk/hisilicon/crg-hi3798cv200.c \
  drivers/clk/hisilicon/clk-hi3798cv200-hdmi.c drivers/clk/hisilicon/clk-hi3798cv200-hdmi.h

emit 0016-drm-bridge-add-histb-hdmi-transmitter.patch 0016.header.txt \
  drivers/gpu/drm/bridge/Kconfig drivers/gpu/drm/bridge/Makefile \
  drivers/gpu/drm/bridge/hisilicon/Kconfig drivers/gpu/drm/bridge/hisilicon/Makefile \
  drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c include/drm/bridge/histb_hdmi.h

emit 0017-drm-hisilicon-histb-vdp-mode-setting-through-the-hdmi-bridge.patch 0017.header.txt \
  drivers/gpu/drm/hisilicon/histb/Kconfig drivers/gpu/drm/hisilicon/histb/Makefile \
  drivers/gpu/drm/hisilicon/histb/histb_vdp.h drivers/gpu/drm/hisilicon/histb/histb_vdp_drv.c \
  drivers/gpu/drm/hisilicon/histb/histb_vdp_mode.c

ls -l "$OUT"/001[567]-*.patch
