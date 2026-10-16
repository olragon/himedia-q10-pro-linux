#!/bin/sh
# Install / uninstall the side-by-side FFmpeg v4l2request build on the Q10 Pro (Debian trixie armhf).
#   sudo ./install-ffmpeg-v4l2req.sh install  [tarball]   # default ./ffmpeg-v4l2req-armhf.tar.gz
#   sudo ./install-ffmpeg-v4l2req.sh uninstall
# Never touches /lib/arm-linux-gnueabihf/libav*. Debian's ffmpeg/mpv keep working untouched.
# Opt-in per command: LD_LIBRARY_PATH=/opt/ffmpeg-v4l2req/lib <cmd>, or /opt/ffmpeg-v4l2req/bin/ffmpeg directly.
set -eu
P=/opt/ffmpeg-v4l2req
case "${1:-}" in
install)
  T="${2:-ffmpeg-v4l2req-armhf.tar.gz}"
  [ -f "$T" ] || { echo "tarball $T not found"; exit 1; }
  if [ -f "$(dirname "$T")/ffmpeg-v4l2req-armhf.tar.gz.sha256" ]; then (cd "$(dirname "$T")" && sha256sum -c ffmpeg-v4l2req-armhf.tar.gz.sha256); fi
  apt-get install -y --no-install-recommends \
    libaom3 libass9 libbz2-1.0 libdav1d7 libdrm2 libfontconfig1 libfreetype6 libfribidi0 libgnutls30t64 \
    libharfbuzz0b liblzma5 libmp3lame0 libopenjp2-7 libopus0 libsoxr0 libspeex1 libtheoradec1 libtheoraenc1 \
    libudev1 libvorbis0a libvorbisenc2 libvpx9 libwebp7 libwebpmux3 libxml2 libzimg2 zlib1g || echo "WARN: adjust package names; run: ldd $P/bin/ffmpeg | grep 'not found'"
  tar -C / -xzf "$T"
  # DELIBERATELY no ld.so.conf.d entry: system-wide it would make Debian's mpv/kodi load OUR libav* too.
  # Opt-in wrappers instead (fallback-safe):
  for b in ffmpeg ffprobe; do
    printf '#!/bin/sh\nexec env LD_LIBRARY_PATH=%s/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH} %s/bin/%s "$@"\n' "$P" "$P" "$b" > /usr/local/bin/${b}-v4l2req
    chmod 755 /usr/local/bin/${b}-v4l2req
  done
  printf '#!/bin/sh\nexport LD_LIBRARY_PATH=%s/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}\nexec "$@"\n' "$P" > /usr/local/bin/with-ffmpeg-v4l2req
  chmod 755 /usr/local/bin/with-ffmpeg-v4l2req
  ldd "$P/bin/ffmpeg" | grep 'not found' && echo "MISSING libs above" || echo "all libs resolved"
  "$P/bin/ffmpeg" -hide_banner -hwaccels
  ;;
uninstall)
  rm -rf "$P" /usr/local/bin/ffmpeg-v4l2req /usr/local/bin/ffprobe-v4l2req /usr/local/bin/with-ffmpeg-v4l2req /etc/ld.so.conf.d/ffmpeg-v4l2req.conf
  ldconfig; echo removed
  ;;
*) echo "usage: $0 install [tarball] | uninstall"; exit 2;;
esac
