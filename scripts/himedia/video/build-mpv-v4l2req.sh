#!/usr/bin/env bash
# Build mpv 0.40.0 + the v4l2request hwdec (Kwiboo PR #14511, adapted) for Debian trixie armhf (HiMedia Q10 Pro),
# linked against the side-by-side FFmpeg in /opt/ffmpeg-v4l2req. Installs to /opt/mpv-v4l2req on the box.
#
#   scripts/himedia/video/build-mpv-v4l2req.sh
#   WORK=/path JOBS=4 scripts/himedia/video/build-mpv-v4l2req.sh
#   X11=0 scripts/himedia/video/build-mpv-v4l2req.sh      # DRM-only build (the original artifact)
#
# X11=1 (default) also builds the X11 window system + EGL-on-X11 (--gpu-context=x11egl) beside the DRM context, so mpv can run
# inside a live X session (DRM master is taken by Xorg). Output name differs per variant:
#   X11=1 -> mpv-v4l2req-x11-armhf.tar.gz     X11=0 -> mpv-v4l2req-armhf.tar.gz
#
# Long job: run through a tmux/screen window (it runs for a long time).
# Needs the FFmpeg tarball from build-ffmpeg-v4l2req.sh (headers + libs to link against).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${WORK:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/mpv-v4l2req}"
FFMPEG_TAR="${FFMPEG_TAR:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/ffmpeg-v4l2req/ffmpeg-v4l2req-armhf.tar.gz}"
JOBS="${JOBS:-4}"
X11="${X11:-1}"
if [ "$X11" = 1 ]; then XOPT=enabled; VARIANT=mpv-v4l2req-x11-armhf; else XOPT=disabled; VARIANT=mpv-v4l2req-armhf; fi
PREFIX=/opt/mpv-v4l2req
FFPREFIX=/opt/ffmpeg-v4l2req
IMAGE=himedia-mpv-xbuild
PATCH="$HERE/mpv-v4l2req/0001-hwdec-add-v4l2request-hwcontext.patch"

MPV_TAG=v0.40.0                                        # = Debian trixie mpv 0.40.0-3 orig
MPV_COMMIT=e48ac7ce08462f5e33af6ef9deeac6fa87eef01e    # peeled tag commit

[ -f "$FFMPEG_TAR" ] || { echo "missing $FFMPEG_TAR (run build-ffmpeg-v4l2req.sh first)"; exit 1; }
mkdir -p "$WORK"; cd "$WORK"

# --- 1. source: v0.40.0 + the adapted PR patch --------------------------------------------
if [ ! -d mpv-git/.git ]; then git clone -q --filter=blob:none https://github.com/mpv-player/mpv mpv-git; fi
cd mpv-git
git fetch -q --tags origin
[ "$(git rev-parse "$MPV_TAG^{commit}")" = "$MPV_COMMIT" ] || { echo "tag $MPV_TAG moved"; exit 1; }
git checkout -q -f --detach "$MPV_COMMIT"
git reset -q --hard "$MPV_COMMIT"; git clean -qfd
git -c user.name=build -c user.email=build@localhost am -q "$PATCH"
SRC_COMMIT=$(git rev-parse HEAD)
echo "source commit: $SRC_COMMIT (base $MPV_COMMIT + $(basename "$PATCH"))"
cd "$WORK"
rm -rf src && mkdir src && git -C mpv-git archive "$SRC_COMMIT" | tar -x -C src

# --- 2. image + FFmpeg sysroot -------------------------------------------------------------
docker build -t "$IMAGE" "$HERE/mpv-v4l2req" 2>&1 | tail -3
cp "$FFMPEG_TAR" "$WORK/ffmpeg-v4l2req-armhf.tar.gz"
cp "$HERE/mpv-v4l2req/cross-armhf.ini" "$WORK/"

# --- 3. cross-build + verify -----------------------------------------------------------------
rm -rf build stage; mkdir -p build stage
docker run --rm -v "$WORK:/w" -e XOPT="$XOPT" -e JOBS="$JOBS" -e PREFIX="$PREFIX" -e FFPREFIX="$FFPREFIX" "$IMAGE" bash -euo pipefail -c '
tar --warning=no-unknown-keyword -C / -xzf /w/ffmpeg-v4l2req-armhf.tar.gz        # headers, .pc files, libs at the same path as on the box
cd /w/src
meson setup /w/build --cross-file /w/cross-armhf.ini --prefix="$PREFIX" --libdir=lib --buildtype=release \
  -Dcplayer=true -Dlibmpv=false -Dtests=false -Dmanpage-build=disabled -Dhtml-build=disabled \
  -Dv4l2request=enabled -Ddrm=enabled -Dgbm=enabled -Degl=enabled -Degl-drm=enabled -Dgl=enabled \
  -Dx11=$XOPT -Degl-x11=$XOPT -Dwayland=disabled -Dvulkan=disabled -Dvaapi=disabled -Dvdpau=disabled \
  -Dlua=lua5.2 -Dalsa=enabled -Dpulse=enabled -Dlibarchive=enabled -Duchardet=enabled -Djpeg=enabled \
  > /w/meson-setup.out 2>&1 || { tail -60 /w/meson-setup.out; exit 1; }
sed -n "/^mpv /,\$p" /w/meson-setup.out | tail -90
ninja -C /w/build -j"$JOBS" > /w/ninja.out 2>&1 || { tail -60 /w/ninja.out; exit 1; }
DESTDIR=/w/stage meson install -C /w/build >> /w/ninja.out 2>&1
S=/w/stage$PREFIX
arm-linux-gnueabihf-strip --strip-unneeded $S/bin/mpv
echo "== ELF"; file $S/bin/mpv | cut -c1-220
arm-linux-gnueabihf-readelf -A $S/bin/mpv | grep -E "Tag_CPU_arch|Tag_ABI_VFP_args|Tag_FP_arch|Tag_Advanced_SIMD" || true
echo "== dynamic"; arm-linux-gnueabihf-readelf -d $S/bin/mpv | grep -E "RPATH|RUNPATH"
echo "== config.h"; grep -E "HAVE_(V4L2REQUEST|DRM|GBM|EGL_DRM|EGL_X11|EGL|GL|DMABUF_INTEROP_GL|DMABUF_INTEROP_PL|LUA|ALSA|PULSE|X11|WAYLAND) " /w/build/config.h
echo "== NEEDED -> armhf packages"
arm-linux-gnueabihf-readelf -d $S/bin/mpv | sed -n "s/.*NEEDED.*\[\(.*\)\]/\1/p" | sort -u | { grep -v "^libav\|^libsw\|^libc\.so\|^libm\.so\|^ld-linux\|^libdl\|^libpthread" || true; } > /w/needed-sonames.txt
: > /w/runtime-deps.txt
while read so; do p=$(dpkg -S "/usr/lib/arm-linux-gnueabihf/$so" "/lib/arm-linux-gnueabihf/$so" 2>/dev/null | head -1 | cut -d: -f1 || true); echo "${p:-UNKNOWN($so)}" >> /w/runtime-deps.txt; done < /w/needed-sonames.txt
sort -u /w/runtime-deps.txt -o /w/runtime-deps.txt; tr "\n" " " < /w/runtime-deps.txt; echo
echo "== qemu: mpv -version"
qemu-arm-static -L / $S/bin/mpv --version | head -12
echo "== qemu: mpv --gpu-context=help"
qemu-arm-static -L / $S/bin/mpv --gpu-context=help 2>&1 | head -20
echo "== qemu: mpv --hwdec=help"
qemu-arm-static -L / $S/bin/mpv --hwdec=help 2>&1 | head -60
echo "== qemu: ldd-ish (libav* resolved from rpath?)"
LD_TRACE_LOADED_OBJECTS=1 qemu-arm-static -L / $S/bin/mpv 2>&1 | grep -E "libav|libsw|not found" || true
' 2>&1 | tee "$WORK/build-verify.log"

# --- 4. package -----------------------------------------------------------------------------------
OUT="$WORK/$VARIANT.tar.gz"
tar -C "$WORK/stage" -czf "$OUT" "${PREFIX#/}"
cp "$HERE/install-mpv-v4l2req.sh" "$WORK/"
( cd "$WORK" && shasum -a 256 $VARIANT.tar.gz | tee $VARIANT.tar.gz.sha256 && ls -l $VARIANT.tar.gz )
echo "source commit: $SRC_COMMIT"
