#!/bin/bash
# Prove the SHIPPED patches (not the working tree) apply and build: fresh 6.18.55 tree in
# vdp-port/verify/, 0001..0010 + 0011 + 0012 via apply-base-patches.sh, then compile-test.sh on it.
set -euo pipefail
V=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/vdp-port/verify
rm -rf "$V"; mkdir -p "$V"
tar xf ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32/linux-6.18.55.tar.xz -C "$V"
"$(dirname "$0")/apply-base-patches.sh" "$V/linux-6.18.55" --with-vdp
VDP_PORT="$V" "$(dirname "$0")/compile-test.sh" W=1
diff -r -q ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/vdp-port/linux-6.18.55/drivers/gpu/drm/hisilicon/histb "$V/linux-6.18.55/drivers/gpu/drm/hisilicon/histb" \
  | grep -v "\.o\|\.ko\|\.cmd\|modules.order\|Module.symvers\|\.mod" || true
echo VERIFY-DONE
