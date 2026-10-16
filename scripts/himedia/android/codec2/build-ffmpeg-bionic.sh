#!/usr/bin/env bash
# Cross-build the Kwiboo FFmpeg (v4l2request hwaccels) for ANDROID BIONIC armv7a with the NDK, on the Mac.
# This is the libavcodec/libavutil an Android codec2 service (ffmpeg_codec2) would link.
# docs/261012-himedia-android-hw-video.md
#
#   scripts/himedia/android/codec2/build-ffmpeg-bionic.sh
#
# Inputs : the pinned Kwiboo n7.1.5 tree that build-ffmpeg-v4l2req.sh already prepared (src/),
#          the NDK (r27c darwin zip), drm_fourcc.h from linux v6.12 uapi (the only libdrm piece used).
# Patch  : patches/0001-v4l2request-udev-free-android.patch  (drop libudev + libdrm link deps:
#          Android has neither; /dev/media* + /dev/video* are scanned directly).
# Output : $WORK/stage-bionic/{lib,include}  + verification of SONAMEs, ELF arch, v4l2request symbols.
# Long job: a tmux/screen window (it runs for a long time)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${BASE:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}}"
WORK="${WORK:-$BASE/android-hwvideo}"
SRC_PRISTINE="${SRC_PRISTINE:-$BASE/ffmpeg-v4l2req/src}"
NDK_ZIP="$BASE/android-ndk/android-ndk-r27c-darwin.zip"
NDK="$BASE/android-ndk/android-ndk-r27c"
API="${API:-33}"                       # Android 13
JOBS="${JOBS:-8}"

[ -f "$SRC_PRISTINE/configure" ] || { echo "run build-ffmpeg-v4l2req.sh first (no $SRC_PRISTINE)"; exit 1; }
[ -d "$NDK" ] || { echo "== unpack NDK"; unzip -q -o "$NDK_ZIP" -d "$BASE/android-ndk"; }
TC="$NDK/toolchains/llvm/prebuilt/darwin-x86_64"
CC="$TC/bin/armv7a-linux-androideabi$API-clang"
[ -x "$CC" ] || { echo "no compiler $CC"; exit 1; }

mkdir -p "$WORK"; cd "$WORK"
# drm_fourcc.h: header-only use (DRM_FORMAT_* fourccs) -> vendored from kernel uapi, no libdrm
if [ ! -f drm-inc/drm_mode.h ]; then
  mkdir -p drm-inc
  for f in drm_fourcc.h drm.h drm_mode.h; do
    curl -fsS "https://raw.githubusercontent.com/torvalds/linux/v6.12/include/uapi/drm/$f" -o "drm-inc/$f"
  done
fi

rm -rf src-bionic build-bionic stage-bionic
mkdir src-bionic build-bionic stage-bionic
cp -R "$SRC_PRISTINE"/. src-bionic/
( cd src-bionic && patch -p1 < "$HERE/patches/0001-v4l2request-udev-free-android.patch" )

cd build-bionic
../src-bionic/configure \
  --prefix=/vendor --libdir=/vendor/lib --incdir=/vendor/include \
  --enable-cross-compile --target-os=android --arch=arm --cpu=armv7-a \
  --cc="$CC" --cxx="$CC++" --ar="$TC/bin/llvm-ar" --nm="$TC/bin/llvm-nm" \
  --ranlib="$TC/bin/llvm-ranlib" --strip="$TC/bin/llvm-strip" \
  --sysroot="$TC/sysroot" \
  --extra-cflags="-I$WORK/drm-inc -O2 -fPIC -mfpu=neon -DANDROID" \
  --enable-shared --disable-static --enable-pic --disable-symver \
  --disable-programs --disable-doc --disable-avdevice --disable-avformat --disable-avfilter \
  --disable-postproc --disable-network --disable-autodetect \
  --disable-everything \
  --enable-decoder=h264,hevc,vp9,vp8,mpeg2video,mpeg4,av1 \
  --enable-parser=h264,hevc,vp9,vp8,mpeg4video,mpegvideo,av1 \
  --enable-v4l2-request \
  --enable-hwaccel=h264_v4l2request,hevc_v4l2request,vp9_v4l2request,mpeg2_v4l2request,vp8_v4l2request \
  > "$WORK/configure-bionic.out" 2>&1 || { tail -40 "$WORK/configure-bionic.out"; exit 1; }
cp ffbuild/config.log "$WORK/config-bionic.log"
grep -E "CONFIG_V4L2_REQUEST|CONFIG_H264_V4L2REQUEST_HWACCEL|CONFIG_HEVC_V4L2REQUEST_HWACCEL|CONFIG_HWCONTEXT|HAVE_V4L2_REQUEST" config.h config_components.h | head
make -j"$JOBS" > "$WORK/make-bionic.out" 2>&1 || { tail -40 "$WORK/make-bionic.out"; exit 1; }
make install DESTDIR="$WORK/stage-bionic" >> "$WORK/make-bionic.out" 2>&1

S="$WORK/stage-bionic/vendor/lib"
echo "== libs";      ls -la "$S"/*.so* | awk '{print $5, $9}'
echo "== ELF";       file "$S"/libavcodec.so* | head -2
echo "== SONAME/NEEDED"; for f in "$S"/libav*.so "$S"/libsw*.so; do [ -f "$f" ] && "$TC/bin/llvm-readelf" -d "$f" | grep -E "SONAME|NEEDED" | tr '\n' ' ' && echo; done
echo "== udev/drm linkage (must be none)"; "$TC/bin/llvm-readelf" -d "$S"/libavutil.so | grep -E "udev|drm" || echo "none"
echo "== v4l2request compiled in (hwaccels are static tables, so look at strings, not dynsyms)"
strings -a "$S"/libavcodec.so | grep -E "^(h264|hevc|vp9|vp8|mpeg2)_v4l2request$" | sort -u
strings -a "$S"/libavutil.so | grep -E "^/dev/media%d$|^Using V4L2 media driver" | sort -u
echo "== done (stage: $WORK/stage-bionic)"
