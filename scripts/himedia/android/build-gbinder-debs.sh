#!/bin/bash
# build-gbinder-debs.sh — MAC side: build the armhf .debs Waydroid needs (libglibutil, libgbinder,
# python3-gbinder) in a Debian 13 armhf container, by running waydroid-install.sh's own `build` step
# (same pinned commits, same dpkg-buildpackage). Output: ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/waydroid/debs/.
# Why: the box runs from a 15 GB FAT32 stick; ~400 MB of compilers on its 4 GB root is waste, and the
# first build on the SATA root left no copy anywhere (2026-10-13).
# Push to the box:  scp debs/*.deb ${Q10_HOST:-root@q10.local}:/var/lib/q10/waydroid-build/
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
OUT=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/waydroid/debs; mkdir -p "$OUT"
docker run --rm --platform linux/arm/v7 -v "$here:/src:ro" -v "$OUT:/out" debian:trixie bash -euc '
  apt-get update -qq && apt-get install -y -q curl ca-certificates git >/dev/null
  bash /src/waydroid-install.sh build
  cp /var/lib/q10/waydroid-build/*.deb /out/
  dpkg -I /out/libgbinder_*_armhf.deb | grep -E "Package|Version|Architecture"'
ls -la "$OUT"
