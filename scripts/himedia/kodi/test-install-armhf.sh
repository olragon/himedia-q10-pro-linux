#!/usr/bin/env bash
# Run the real installers (ffmpeg-v4l2req, then kodi-v4l2req) inside a genuine armhf trixie userland
# (docker --platform linux/arm/v7, qemu-user binfmt) and smoke-test the result: apt deps resolve, no missing libs,
# libav* come from /opt/ffmpeg-v4l2req, `kodi-v4l2req --version` runs, a no-DRM start fails cleanly and the presets are seeded.
# Not a hardware test: there is no /dev/dri, /dev/media0 or GPU in the container.
#   scripts/himedia/kodi/test-install-armhf.sh        -> log at $KODI_WORK/test-install-armhf.log
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
KODI_WORK="${KODI_WORK:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kodi-v4l2req}"
FF_WORK="${FF_WORK:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/ffmpeg-v4l2req}"
docker run --rm --platform linux/arm/v7 -v "$KODI_WORK:/k:ro" -v "$FF_WORK:/f:ro" debian:trixie bash -c '
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1
echo "== install ffmpeg-v4l2req";  sh /f/install-ffmpeg-v4l2req.sh install /f/ffmpeg-v4l2req-armhf.tar.gz 2>&1 | tail -6
echo "== install kodi-v4l2req";    sh /k/install-kodi-v4l2req.sh install /k/kodi-v4l2req-armhf.tar.gz 2>&1 | grep -vE "^(Selecting|Preparing|Unpacking|Setting up|Get:|Fetched|Reading|Building|\(Reading|Processing|update-alternatives|Created symlink)" | tail -25
echo "== file / ldd"
file /opt/kodi-v4l2req/lib/kodi/kodi-gbm | cut -c1-120
ldd /opt/kodi-v4l2req/lib/kodi/kodi-gbm | grep -E "not found|libav|libswscale|libswresample|libpostproc|libGLES|libEGL|libgbm" 
echo "== wrapper --version"
export HOME=/root
/usr/local/bin/kodi-v4l2req --version 2>&1 | head -3
echo "== presets seeded?"
ls -l $HOME/.kodi-v4l2req/userdata/ ; cat $HOME/.kodi-v4l2req/userdata/guisettings.xml | grep -v "<!--" | grep -v "^ *-->"
echo "== start without DRM (expected to fail cleanly)"
timeout 90 /usr/local/bin/kodi-v4l2req --standalone 2>&1 | tail -5
echo "-- kodi.log (relevant lines)"
grep -iE "drm|gbm|egl|windowing|prime|ffmpeg|fatal|error|python" $HOME/.kodi-v4l2req/temp/kodi.log 2>/dev/null | head -30
echo "== settings load: seeded preset vs. no file (control)"
grep -nE "CSettings|CDisplaySettings|guisettings|advancedsettings" $HOME/.kodi-v4l2req/temp/kodi.log | cut -c1-230 | head -12
n=$(grep -c "unable to load settings" $HOME/.kodi-v4l2req/temp/kodi.log || true)
[ "$n" = 0 ] && echo "PASS: seeded guisettings.xml loaded (a load failure would Reset() every preset value to default)" || echo "FAIL: guisettings.xml rejected ($n)"
rm -f $HOME/.kodi-v4l2req/userdata/guisettings.xml $HOME/.kodi-v4l2req/temp/kodi.log
KODI_DATA=$HOME/.kodi-v4l2req timeout 90 /opt/kodi-v4l2req/bin/kodi --windowing=gbm --standalone >/dev/null 2>&1
echo "-- control (no guisettings.xml):"
grep -nE "CSettings|CDisplaySettings|guisettings" $HOME/.kodi-v4l2req/temp/kodi.log | cut -c1-230 | head -12
echo "== uninstall"
sh /k/install-kodi-v4l2req.sh uninstall; ls /opt
' 2>&1 | tee "$KODI_WORK/test-install-armhf.log"
