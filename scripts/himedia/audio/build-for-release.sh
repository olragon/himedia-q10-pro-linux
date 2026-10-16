#!/bin/bash
# build-for-release.sh <release> [<git-rev>] — build q10_aiao.ko for a kernel RELEASE the build tree no
# longer holds (the stick boots 6.18.55-k14; the tree has moved on). The tree's utsrelease.h is set to
# <release> for the build and restored with its mtime afterwards (cp -p), so vermagic matches the box.
#
# ⛔ Only safe when the tree's config still matches that release for everything the module touches.
# Prove it first with the ABI check: build the revision that made the box's CURRENT module, and the
# result must be byte-identical to it apart from the vermagic-independent build id:
#   build-for-release.sh 6.18.55-k14 7c638dc9 && cmp-modules.sh <box .ko> <out>
# <git-rev> builds that revision of q10_aiao.c (default: the working tree).
set -euo pipefail
rel=${1:?release, e.g. 6.18.55-k14}; rev=${2:-}
here=$(cd "$(dirname "$0")" && pwd)
W=${Q10_KBUILD_ROOT:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32}
OUT=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/audio-builds
src=$(mktemp -d); trap 'rm -rf "$src"' EXIT
cp "$here/Kbuild" "$src/"
if [ -n "$rev" ]; then
  git -C "$here" show "$rev:scripts/himedia/audio/q10_aiao.c" > "$src/q10_aiao.c"
  tag=$rev
else
  cp "$here/q10_aiao.c" "$src/"
  tag=$(git -C "$here" rev-parse --short HEAD)$(git -C "$here" diff --quiet -- q10_aiao.c || echo -dirty)
fi
mkdir -p "$OUT"
out="$OUT/q10_aiao-$rel-$tag.ko"
echo "[local] q10_aiao.c @ $tag for $rel (tree is $(cat "$W/linux-6.18.55/include/config/kernel.release"))"
docker run --rm --platform linux/arm64 -v "$W:/ws" -v "$src:/src:ro" -v "$OUT:/out" \
  himedia-kbuild-arm32:trixie bash -euc '
    u=/ws/linux-6.18.55/include/generated/utsrelease.h
    cp -p $u /tmp/utsrelease.h.orig
    trap "cp -p /tmp/utsrelease.h.orig $u" EXIT
    echo "#define UTS_RELEASE \"'"$rel"'\"" > $u
    rm -rf /tmp/mod && cp -r /src /tmp/mod
    make -s -C /ws/linux-6.18.55 ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf- M=/tmp/mod modules
    cp /tmp/mod/q10_aiao.ko "/out/'"$(basename "$out")"'"
    modinfo /tmp/mod/q10_aiao.ko | grep -E "^vermagic"'
grep -q "6.18.55" "$W/linux-6.18.55/include/generated/utsrelease.h" && cat "$W/linux-6.18.55/include/generated/utsrelease.h"
echo "$out"
