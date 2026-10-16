#!/bin/bash
# compile.sh — compile-test display-port sources inside the display COPY tree (never the shared
# kernel-build-arm32 tree: another agent edits files there). Seconds per run, no kexec, no stick.
#   compile.sh [W=1] <dir/ or file.o> ...     e.g.  compile.sh W=1 drivers/clk/hisilicon/ drivers/gpu/drm/bridge/hisilicon/
#   compile.sh modules <dir> ...              build the .ko files of M= dirs
# The tree must already carry a .config + Module.symvers (a previous full build leaves both).
# Q10_CFG_M="DRM_HISI_HISTB_HDMI DRM_HISI_HISTB_VDP" turns those symbols into =m first (default: the display pair).
set -euo pipefail
ROOT=${Q10_KBUILD_ROOT:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32-display}
args=("$@")
W=""
if [ "${args[0]:-}" = "W=1" ]; then W="W=1"; args=("${args[@]:1}"); fi
mode=objs
if [ "${args[0]:-}" = "modules" ]; then mode=modules; args=("${args[@]:1}"); fi
[ ${#args[@]} -gt 0 ] || { echo "usage: compile.sh [W=1] [modules] <dir|obj> ..."; exit 2; }
docker run --rm --platform linux/arm64 -v "$ROOT:/ws" -w /ws/linux-6.18.55 himedia-kbuild-arm32:trixie bash -c '
set -e
export ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-
for sym in '"${Q10_CFG_M:-DRM_HISI_HISTB_HDMI DRM_HISI_HISTB_VDP}"'; do ./scripts/config --module $sym; done
make olddefconfig >/dev/null
mode='"$mode"'; W='"$W"'
shift 0
for t in '"${args[*]}"'; do
  if [ "$mode" = modules ]; then
    make -j"$(nproc)" $W M=$t modules 2>&1 | tail -80
  else
    make -j"$(nproc)" $W $t 2>&1 | tail -80
  fi
done'
