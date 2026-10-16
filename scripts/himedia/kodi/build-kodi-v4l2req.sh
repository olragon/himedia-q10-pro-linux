#!/usr/bin/env bash
# Build Kodi 21.2 "Omega" (Debian trixie source 2:21.2+dfsg-4 + the v4l2request hwdevice backport) for Debian trixie armhf:
# GBM windowing + GLES 2.0 renderer, linked against the side-by-side FFmpeg in /opt/ffmpeg-v4l2req, installed to /opt/kodi-v4l2req.
#
#   scripts/himedia/kodi/build-kodi-v4l2req.sh
#   WORK=/path JOBS=6 scripts/himedia/kodi/build-kodi-v4l2req.sh
#
# Long job: run through a tmux/screen window (it runs for a long time).
# Needs the FFmpeg tarball from scripts/himedia/video/build-ffmpeg-v4l2req.sh (headers + libs to link against).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kodi-v4l2req}"
FFMPEG_TAR="${FFMPEG_TAR:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/ffmpeg-v4l2req/ffmpeg-v4l2req-armhf.tar.gz}"
JOBS="${JOBS:-6}"
PREFIX=/opt/kodi-v4l2req
IMAGE=himedia-kodi-xbuild
DEB=https://deb.debian.org/debian/pool/main/k/kodi
V=21.2+dfsg
SRC="kodi-$V"

# sha256 of the pinned Debian source package files (from kodi_21.2+dfsg-4.dsc)
declare -A SHA=(
  ["kodi_$V.orig.tar.xz"]=5421d1b72a737935325bf4dd2fb6a5564dca2a4835b291edae78f31c91c4edc3
  ["kodi_$V.orig-libdvdnav-embedded.tar.xz"]=b35ef8b3f8ed78227ff98cf90003fc12d5f3452eda74c22405a30be043f53ce2
  ["kodi_$V.orig-libdvdread-embedded.tar.xz"]=cbdaae4af536654a0f3dab452cf66a58b08ceba69c3e26bf70a4d71de6811a8b
  ["kodi_$V.orig-repo-resources-embedded.tar.xz"]=d5eb28b685eeab7596a9c915478185e16bc208baa97f6a74dc1322a8ced93ff1
  ["kodi_$V-4.debian.tar.xz"]=507ac84faf4cad62fdf318fac0a419abc93f7edd2b8885ca1528d26c94fe2520
  ["kodi_$V-4.dsc"]=5b649b9b0954d27064f68ab7255639009fc5951ac78990ab5628dcea8f3685db
)

# REPACK=1: skip source + build, re-run verify + package on the existing stage/ (e.g. after editing presets/ or the installer)
[ -f "$FFMPEG_TAR" ] || { echo "missing $FFMPEG_TAR (run build-ffmpeg-v4l2req.sh first)"; exit 1; }
mkdir -p "$WORK/dl"; cd "$WORK"

# --- 1. source: pinned Debian package, then our patches ---------------------------------------------
for f in "${!SHA[@]}"; do
  [ -f "dl/$f" ] || curl -sfL -o "dl/$f" "$DEB/$f"
  echo "${SHA[$f]}  dl/$f" | shasum -a 256 -c - >/dev/null || { echo "checksum mismatch: $f"; exit 1; }
done
docker build -t "$IMAGE" "$HERE" 2>&1 | tail -2
if { [ "${REUSE_BUILD:-0}" = 1 ] || [ "${REPACK:-0}" = 1 ]; } && [ -d "src/$SRC" ]; then echo "REUSE_BUILD/REPACK: keeping existing patched source (mtimes preserved)"; else
rm -rf srcx src; mkdir srcx src
docker run --rm -v "$WORK:/w" -v "$HERE/patches:/patches:ro" "$IMAGE" bash -euo pipefail -c "
  cd /w/srcx && dpkg-source -x --no-check /w/dl/kodi_$V-4.dsc > /w/dpkg-source.log 2>&1   # applies Debian's quilt series (FFmpeg 7, pcre2, libdvd, ...)
  cd $SRC
  for p in /patches/*.patch; do echo \"apply \$p\"; patch -p1 --no-backup-if-mismatch < \$p; done
  if find . -name '*.rej' | grep .; then exit 1; fi
  mv /w/srcx/$SRC /w/src/$SRC"
rm -rf srcx
fi
cp "$HERE/toolchain-armhf.cmake" "$HERE/container-build.sh" "$HERE/container-verify.sh" "$WORK/"
cp "$FFMPEG_TAR" "$WORK/ffmpeg-v4l2req-armhf.tar.gz"

if [ "${REPACK:-0}" != 1 ]; then
# --- 2. cross-build -------------------------------------------------------------------------------------
rm -rf stage
docker run --rm -v "$WORK:/w" -e JOBS="$JOBS" -e PREFIX="$PREFIX" -e SRC="$SRC" -e REUSE_BUILD="${REUSE_BUILD:-0}" "$IMAGE" bash /w/container-build.sh 2>&1 | tee "$WORK/build.log"
[ "${PIPESTATUS[0]}" = 0 ] || { echo "BUILD FAILED (see $WORK/build.log, make.out, cmake-configure.out)"; exit 1; }
fi

# --- 3. verify under qemu-arm-static ----------------------------------------------------------------------
docker run --rm -v "$WORK:/w" -e PREFIX="$PREFIX" -e SRC="$SRC" "$IMAGE" bash /w/container-verify.sh 2>&1 | tee "$WORK/build-verify.log"

# --- 4. package ----------------------------------------------------------------------------------------------
OUT="$WORK/kodi-v4l2req-armhf.tar.gz"
mkdir -p "$WORK/stage$PREFIX/share/q10-presets" && cp "$HERE"/presets/*.xml "$WORK/stage$PREFIX/share/q10-presets/"
tar -C "$WORK/stage" -czf "$OUT" "${PREFIX#/}"
cp "$HERE/install-kodi-v4l2req.sh" "$WORK/"
( cd "$WORK" && shasum -a 256 kodi-v4l2req-armhf.tar.gz | tee kodi-v4l2req-armhf.tar.gz.sha256 && ls -l kodi-v4l2req-armhf.tar.gz )
