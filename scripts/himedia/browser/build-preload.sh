#!/bin/bash
# build-preload.sh — MAC side: build drm-rdwr-preload.so for the Q10 (armhf) in a Debian 13 container,
# so a root without a compiler (the stick) still gets Chromium's HW-video shim.
# Output: ${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/browser/drm-rdwr-preload.so
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd); OUT=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/browser; mkdir -p "$OUT"
docker run --rm --platform linux/arm/v7 -v "$here:/src:ro" -v "$OUT:/out" debian:trixie bash -euc '
  apt-get update -qq && apt-get install -y -qq gcc libc6-dev >/dev/null
  gcc -shared -fPIC -O2 -o /out/drm-rdwr-preload.so /src/drm-rdwr-preload.c -ldl
  file /out/drm-rdwr-preload.so 2>/dev/null || ls -la /out/drm-rdwr-preload.so'
