# shellcheck shell=bash
# Shared by make-patches.sh and verify-patches.sh: the base stack = pristine 6.18.55 + every patch
# below 0015, applied in the order build-kernel-arm32.ts applies them.  Patches 0015..0017 are generated
# against, and verified on, exactly that tree - so they stay correct when 0013/0014 (or anything else)
# changes underneath them.
ROOT=${Q10_KBUILD_ROOT:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32-display}
K=$(cd "$(dirname "${BASH_SOURCE[0]}")/../kernel" && pwd)

# apply <patch> : prints offsets/fuzz, returns non-zero on a reject
apply() {
  local out
  echo "== $(basename "$1")"
  out=$(patch -p1 --no-backup-if-mismatch < "$1" 2>&1) || { echo "$out"; echo "REJECT in $1"; return 1; }
  echo "$out" | grep -E "fuzz|offset|FAILED" | head -5 || true
}

# base_tree <dir> : <dir>/linux-6.18.55 = pristine + the stack below 0015
base_tree() {
  rm -rf "$1"; mkdir -p "$1"
  tar xf "$ROOT/linux-6.18.55.tar.xz" -C "$1"
  ( cd "$1/linux-6.18.55" || exit 1
    for p in "$K"/0001-*.patch "$K"/arm32/0006-*.patch "$K"/arm32/0007-*.patch "$K"/arm32/0008-*.patch \
             "$K"/arm32/0009-*.patch "$K"/arm32/0010-*.patch "$K"/arm32/0011-*.patch "$K"/arm32/0012-*.patch \
             "$K"/arm32/0013-*.patch "$K"/arm32/0014-*.patch "$K"/arm32/0003-*.patch "$K"/arm32/0004-*.patch \
             "$K"/arm32/0005-*.patch; do
      [ -f "$p" ] && { apply "$p" || exit 1; }
    done
    perl -pi -e 's{depends on \(ARCH_HISI && ARM64\) \|\| COMPILE_TEST}{depends on ARCH_HISI || COMPILE_TEST}' drivers/phy/hisilicon/Kconfig
  )
}
