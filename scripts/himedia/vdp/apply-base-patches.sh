#!/bin/bash
# Apply the base himedia patch stack (0001..0010, in build-kernel-arm32.ts order) to a pristine
# 6.18.55 tree, for compile-testing the VDP patches. Usage: apply-base-patches.sh <tree> [--with-vdp]
set -euo pipefail
TREE=${1:?tree}
K=$(cd "$(dirname "$0")/../../.." && pwd)/scripts/himedia/kernel
cd "$TREE"
for p in $K/0001-*.patch $K/arm32/0006-*.patch $K/arm32/0007-*.patch $K/arm32/0008-*.patch \
         $K/arm32/0009-*.patch $K/arm32/0010-*.patch $K/arm32/0003-*.patch $K/arm32/0004-*.patch \
         $K/arm32/0005-*.patch; do
  echo "== $(basename $p)"; patch -p1 --no-backup-if-mismatch < "$p" >/dev/null
done
# 0002 is a one-line sed (see build-kernel-arm32.ts)
perl -pi -e 's{depends on \(ARCH_HISI && ARM64\) \|\| COMPILE_TEST}{depends on ARCH_HISI || COMPILE_TEST}' drivers/phy/hisilicon/Kconfig
if [ "${2:-}" = "--with-vdp" ]; then
  for p in $K/arm32/0011-*.patch $K/arm32/0012-*.patch; do
    [ -f "$p" ] || continue
    echo "== $(basename $p)"; patch -p1 --no-backup-if-mismatch < "$p" >/dev/null
  done
fi
echo applied
