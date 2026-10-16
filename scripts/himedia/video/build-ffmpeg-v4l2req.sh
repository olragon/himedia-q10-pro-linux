#!/usr/bin/env bash
# Build FFmpeg 7.1.5 + Kwiboo's V4L2 Request API hwaccels for Debian trixie armhf (HiMedia Q10 Pro).
# Cross-compiles inside a Debian trixie container (any host arch), installs to /opt/ffmpeg-v4l2req
# on the box (rpath-linked, never touches /lib/arm-linux-gnueabihf/libav*).
#
#   scripts/himedia/video/build-ffmpeg-v4l2req.sh            # prepare source, build, verify, tar
#   WORK=/path JOBS=8 scripts/himedia/video/build-ffmpeg-v4l2req.sh
#
# Long job: run through a tmux/screen window (it runs for a long time).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/ffmpeg-v4l2req}"
JOBS="${JOBS:-8}"
PREFIX=/opt/ffmpeg-v4l2req
IMAGE=himedia-ffmpeg-xbuild

# --- pinned inputs ---------------------------------------------------------
UPSTREAM_TAG=n7.1.5                       # = Debian trixie ffmpeg 7.1.5-0+deb13u1 orig
KWIBOO_REMOTE=https://github.com/Kwiboo/FFmpeg
KWIBOO_BRANCH=v4l2-request-n7.1.3         # n7.1.3 + 14 commits (1 backport + 13 v4l2request)
KWIBOO_BASE=f46e514491172d15bd74b4abb1814cd2f05a763e   # n7.1.3 tip it is built on
KWIBOO_TIP=fad85d9c76611c09b561167ab405c667a0dcdeb7    # last v4l2request commit

mkdir -p "$WORK"; cd "$WORK"

# --- 1. source: replay Kwiboo's 14 commits onto the n7.1.5 tag (same as Debian's orig) -------
if [ ! -d kwiboo-ffmpeg/.git ]; then
  git clone --no-checkout --filter=blob:none "$KWIBOO_REMOTE" kwiboo-ffmpeg
fi
cd kwiboo-ffmpeg
git fetch -q origin "$KWIBOO_BRANCH"
[ "$(git rev-parse FETCH_HEAD)" = "$KWIBOO_TIP" ] || { echo "Kwiboo branch moved: $(git rev-parse FETCH_HEAD) != $KWIBOO_TIP (update pins deliberately)"; exit 1; }
if ! git rev-parse -q --verify v4l2req-$UPSTREAM_TAG >/dev/null; then
  git fetch -q --no-tags https://github.com/FFmpeg/FFmpeg "tag" "$UPSTREAM_TAG"
  git checkout -q -b "v4l2req-$UPSTREAM_TAG" FETCH_HEAD
  git cherry-pick "$KWIBOO_BASE..$KWIBOO_TIP" >/dev/null
fi
git checkout -q "v4l2req-$UPSTREAM_TAG"
SRC_COMMIT=$(git rev-parse HEAD)
echo "source commit: $SRC_COMMIT"
cd "$WORK"
rm -rf src && mkdir src && git -C kwiboo-ffmpeg archive "$SRC_COMMIT" | tar -x -C src
git -C kwiboo-ffmpeg format-patch -q -o "$WORK/patches" "$UPSTREAM_TAG".."$SRC_COMMIT"

# --- 2. build image -------------------------------------------------------
docker build -t "$IMAGE" "$HERE/ffmpeg-v4l2req" 2>&1 | tail -3

# --- 3. cross-build + verify inside the container -------------------------
rm -rf build stage; mkdir -p build stage
docker run --rm -v "$WORK:/w" -e JOBS="$JOBS" -e PREFIX="$PREFIX" -e SRC_COMMIT="$SRC_COMMIT" "$IMAGE" bash -euo pipefail -c '
cd /w/build
export PKG_CONFIG_LIBDIR=/usr/lib/arm-linux-gnueabihf/pkgconfig:/usr/share/pkgconfig
export PKG_CONFIG_SYSROOT_DIR=
CFLAGS_ARCH="-march=armv7-a -mfpu=neon-vfpv4 -mfloat-abi=hard"
/w/src/configure \
  --prefix="$PREFIX" --libdir="$PREFIX/lib" --incdir="$PREFIX/include" \
  --enable-cross-compile --cross-prefix=arm-linux-gnueabihf- --arch=arm --target-os=linux \
  --pkg-config=pkg-config \
  --extra-cflags="$CFLAGS_ARCH -O2" --extra-ldflags="-Wl,-rpath,$PREFIX/lib" \
  --enable-gpl --enable-shared --disable-static --enable-pic \
  --disable-doc --disable-ffplay --disable-htmlpages --disable-manpages --disable-podpages --disable-txtpages \
  --disable-libmfx --disable-omx --disable-sndio --disable-vaapi --disable-vdpau --disable-xlib --disable-sdl2 \
  --enable-v4l2-request --enable-libdrm --enable-libudev \
  --enable-gnutls --enable-libass --enable-libfontconfig --enable-libfreetype --enable-libfribidi \
  --enable-libharfbuzz --enable-libdav1d --enable-libaom --enable-libvpx --enable-libopus \
  --enable-libvorbis --enable-libmp3lame --enable-libwebp --enable-libxml2 --enable-libopenjpeg \
  --enable-libtheora --enable-libspeex --enable-libsoxr --enable-libzimg \
  > /w/configure.out 2>&1 || { tail -40 /w/configure.out; exit 1; }
cp ffbuild/config.log /w/config.log
grep -E "^(v4l2_request|libdrm|libudev)|V4L2_REQUEST" config.h | tr "\n" " " ; echo
make -j"$JOBS" > /w/make.out 2>&1 || { tail -40 /w/make.out; exit 1; }
make install DESTDIR=/w/stage >> /w/make.out 2>&1
S=/w/stage$PREFIX
arm-linux-gnueabihf-strip --strip-unneeded $S/lib/*.so.* $S/bin/*
cd $S/lib
echo "== SONAMEs"; for f in lib*.so.*.*.*; do echo "$f  $(arm-linux-gnueabihf-readelf -d $f | sed -n "s/.*SONAME.*\[\(.*\)\]/\1/p")"; done
echo "== ELF"; file $S/bin/ffmpeg | cut -c1-200
arm-linux-gnueabihf-readelf -A $S/bin/ffmpeg | grep -E "Tag_CPU_arch|Tag_ABI_VFP_args|Tag_FP_arch|Tag_Advanced_SIMD" || true
echo "== strings v4l2_request"; strings -a libavcodec.so.61 | grep -iE "v4l2.?request" | sort -u | head -30
echo "== rpath"; arm-linux-gnueabihf-readelf -d $S/bin/ffmpeg | grep -E "RPATH|RUNPATH"
echo "== NEEDED -> armhf packages"
( for f in $S/bin/ffmpeg $S/bin/ffprobe $S/lib/lib*.so.*.*.*; do arm-linux-gnueabihf-readelf -d $f | sed -n "s/.*NEEDED.*\[\(.*\)\]/\1/p"; done ) | sort -u | { grep -v "^libav\|^libsw\|^libpostproc" || true; } > /w/needed-sonames.txt
: > /w/runtime-deps.txt
while read so; do p=$(dpkg -S "/usr/lib/arm-linux-gnueabihf/$so" "/lib/arm-linux-gnueabihf/$so" 2>/dev/null | head -1 | cut -d: -f1 || true); echo "${p:-UNKNOWN($so)}" >> /w/runtime-deps.txt; done < /w/needed-sonames.txt
sort -u /w/runtime-deps.txt -o /w/runtime-deps.txt; cat /w/runtime-deps.txt | tr "\n" " "; echo
echo "== qemu: ffmpeg -hwaccels"
export LD_LIBRARY_PATH=$S/lib
qemu-arm-static -L / $S/bin/ffmpeg -hide_banner -version | head -3
qemu-arm-static -L / $S/bin/ffmpeg -hide_banner -hwaccels
qemu-arm-static -L / $S/bin/ffmpeg -hide_banner -init_hw_device list 2>&1 | head
qemu-arm-static -L / $S/bin/ffmpeg -hide_banner -buildconf | grep -E "v4l2|libdrm|libudev|cross|march"
' 2>&1 | tee "$WORK/build-verify.log"

# --- 4. package ---------------------------------------------------------------
OUT="$WORK/ffmpeg-v4l2req-armhf.tar.gz"
tar -C "$WORK/stage" --owner=0 --group=0 -czf "$OUT" "${PREFIX#/}" 2>/dev/null || \
  tar -C "$WORK/stage" -czf "$OUT" "${PREFIX#/}"
cp "$HERE/install-ffmpeg-v4l2req.sh" "$WORK/"
( cd "$WORK" && shasum -a 256 ffmpeg-v4l2req-armhf.tar.gz | tee ffmpeg-v4l2req-armhf.tar.gz.sha256 && ls -l ffmpeg-v4l2req-armhf.tar.gz )
echo "source commit: $SRC_COMMIT"
