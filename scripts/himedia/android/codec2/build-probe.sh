#!/usr/bin/env bash
# Build v4l2req-probe (bionic armv7a) against the stage-bionic FFmpeg from build-ffmpeg-bionic.sh.
# Output: $WORK/probe/{v4l2req-probe,libavcodec.so,libavutil.so,...} — push the dir into the container.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BASE="${BASE:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}}"; WORK="${WORK:-$BASE/android-hwvideo}"
TC="$BASE/android-ndk/android-ndk-r27c/toolchains/llvm/prebuilt/darwin-x86_64"
CC="$TC/bin/armv7a-linux-androideabi33-clang"; S="$WORK/stage-bionic/vendor"
[ -f "$S/lib/libavcodec.so" ] || { echo "run build-ffmpeg-bionic.sh first"; exit 1; }
mkdir -p "$WORK/probe"
"$CC" -O2 -Wall -I"$S/include" "$HERE/v4l2req-probe.c" -L"$S/lib" -lavcodec -lavutil \
  -Wl,-rpath,'$ORIGIN' -o "$WORK/probe/v4l2req-probe"
cp "$S"/lib/libav{codec,util}.so "$S"/lib/libsw{resample,scale}.so "$WORK/probe/"
file "$WORK/probe/v4l2req-probe"
"$TC/bin/llvm-readelf" -d "$WORK/probe/v4l2req-probe" | grep -E "NEEDED|RUNPATH"
