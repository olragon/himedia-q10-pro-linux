#!/bin/sh
# Install / uninstall the side-by-side mpv (v4l2request hwdec) on the Q10 Pro (Debian trixie armhf).
#   sudo ./install-mpv-v4l2req.sh install  [tarball]   # default ./mpv-v4l2req-armhf.tar.gz
#   sudo ./install-mpv-v4l2req.sh uninstall
# Needs /opt/ffmpeg-v4l2req (install-ffmpeg-v4l2req.sh) first: the binary's RUNPATH points at its libav*.
# Never touches /usr/bin/mpv or /lib/arm-linux-gnueabihf/libav*. Wrapper: /usr/local/bin/mpv-v4l2req.
set -eu
P=/opt/mpv-v4l2req
FF=/opt/ffmpeg-v4l2req
case "${1:-}" in
install)
  T="${2:-mpv-v4l2req-armhf.tar.gz}"
  [ -f "$T" ] || { echo "tarball $T not found"; exit 1; }
  [ -x "$FF/bin/ffmpeg" ] || { echo "$FF missing: install ffmpeg-v4l2req first"; exit 1; }
  if [ -f "$T.sha256" ]; then (cd "$(dirname "$T")" && sha256sum -c "$(basename "$T").sha256"); fi
  # runtime packages = readelf NEEDED of the build (runtime-deps.txt) + libgles2/mesa dri for the panfrost GLES path
  apt-get install -y --no-install-recommends \
    libarchive13t64 libasound2t64 libass9 libdisplay-info2 libdrm2 libegl1 libgbm1 libgles2 libgl1-mesa-dri \
    libx11-6 libxext6 libxpresent1 libxrandr2 libxss1 libxv1 \
    libjpeg62-turbo liblcms2-2 liblua5.2-0 libplacebo349 libpulse0 libuchardet0 libzimg2 zlib1g || echo "WARN: adjust package names; run: ldd $P/bin/mpv | grep 'not found'"
  tar -C / -xzf "$T"
  # Wrapper only; no PATH shadowing of Debian's mpv. Config dir is separate so Debian mpv.conf is not shared by accident.
  printf '#!/bin/sh\nexec %s/bin/mpv "$@"\n' "$P" > /usr/local/bin/mpv-v4l2req
  chmod 755 /usr/local/bin/mpv-v4l2req
  ldd "$P/bin/mpv" | grep 'not found' && echo "MISSING libs above" || echo "all libs resolved"
  "$P/bin/mpv" --version | head -2
  "$P/bin/mpv" --hwdec=help | grep -i v4l2request || echo "WARN: no v4l2request in --hwdec=help"
  ;;
uninstall)
  rm -rf "$P" /usr/local/bin/mpv-v4l2req
  echo removed
  ;;
*) echo "usage: $0 install [tarball] | uninstall"; exit 2;;
esac
