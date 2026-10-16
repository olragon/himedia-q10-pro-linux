#!/bin/sh
# Install / uninstall the side-by-side Kodi 21.2 (GBM + GLES, DRM PRIME with the v4l2request hwdevice) on the Q10 Pro (Debian trixie armhf).
#   sudo ./install-kodi-v4l2req.sh install  [tarball]   # default ./kodi-v4l2req-armhf.tar.gz
#   sudo ./install-kodi-v4l2req.sh uninstall            # removes /opt/kodi-v4l2req and the wrapper; keeps ~/.kodi-v4l2req (profile)
# Needs /opt/ffmpeg-v4l2req (install-ffmpeg-v4l2req.sh) first: the binary's RUNPATH points at its libav*.
# Never touches /usr/bin/kodi, Debian's kodi packages, /lib/arm-linux-gnueabihf/libav*, or ~/.kodi.
# Wrapper: /usr/local/bin/kodi-v4l2req  (profile in ~/.kodi-v4l2req, first run seeded from the presets).
set -eu
P=/opt/kodi-v4l2req
FF=/opt/ffmpeg-v4l2req
case "${1:-}" in
install)
  T="${2:-kodi-v4l2req-armhf.tar.gz}"
  [ -f "$T" ] || { echo "tarball $T not found"; exit 1; }
  [ -x "$FF/bin/ffmpeg" ] || { echo "$FF missing: install ffmpeg-v4l2req first"; exit 1; }
  if [ -f "$(dirname "$T")/kodi-v4l2req-armhf.tar.gz.sha256" ]; then (cd "$(dirname "$T")" && sha256sum -c kodi-v4l2req-armhf.tar.gz.sha256); fi
  # runtime packages = readelf NEEDED of kodi-gbm mapped with dpkg -S in the trixie build container (runtime-deps.txt),
  # plus what is dlopen'd and so invisible to NEEDED: mesa EGL/GBM/panfrost DRI, python3 stdlib (add-ons), tzdata, xkb data (libinput keymaps)
  apt-get install -y --no-install-recommends \
    libasound2t64 libass9 libcap2 libcrossguid0 libcurl3t64-gnutls libdate-tz3 libdbus-1-3 libdisplay-info2 libdrm2 libegl1 libfmt10 \
    libfreetype6 libfribidi0 libfstrcmp0 libgbm1 libgcrypt20 libgles2 libharfbuzz0b libinput10 libkissfft-float131 liblcms2-2 liblzo2-2 \
    libmicrohttpd12t64 libpcre2-8-0 libpulse0 libpython3.13 libspdlog1.15 libsqlite3-0 libtag2 libtinyxml2-11 libtinyxml2.6.2v5 libudev1 \
    libudfread0 libxkbcommon0 libxml2 libxslt1.1 zlib1g \
    libegl-mesa0 libgl1-mesa-dri python3 tzdata xkb-data \
    || echo "WARN: adjust package names; run: ldd $P/lib/kodi/kodi-gbm | grep 'not found'"
  tar -C / -xzf "$T"
  # Wrapper only: no PATH shadowing of Debian's kodi. Separate profile dir so Debian Kodi's ~/.kodi is never shared by accident.
  # Preset (first run only, never overwrites): direct = DRM PRIME decoder + video-plane renderer; gles = DRM PRIME decoder + EGL/GLES renderer.
  cat > /usr/local/bin/kodi-v4l2req <<'WRAP'
#!/bin/sh
P=/opt/kodi-v4l2req
export KODI_DATA="${KODI_DATA:-$HOME/.kodi-v4l2req}"
U="$KODI_DATA/userdata"
mkdir -p "$U"
case "${KODI_V4L2REQ_PRESET:-direct}" in
  gles) G=guisettings-gles-renderer.xml ;;
  *)    G=guisettings.xml ;;
esac
[ -e "$U/guisettings.xml" ]      || cp "$P/share/q10-presets/$G" "$U/guisettings.xml"
[ -e "$U/advancedsettings.xml" ] || cp "$P/share/q10-presets/advancedsettings.xml" "$U/advancedsettings.xml"
exec "$P/bin/kodi" --windowing=gbm "$@"
WRAP
  chmod 755 /usr/local/bin/kodi-v4l2req
  ldd "$P/lib/kodi/kodi-gbm" | grep 'not found' && echo "MISSING libs above" || echo "all libs resolved"
  ldd "$P/lib/kodi/kodi-gbm" | grep -E 'libavcodec|libavutil'
  "$P/lib/kodi/kodi-gbm" --version | head -2
  ;;
uninstall)
  rm -rf "$P" /usr/local/bin/kodi-v4l2req
  echo "removed $P (profile ~/.kodi-v4l2req left in place; apt packages left installed)"
  ;;
*) echo "usage: $0 install [tarball] | uninstall"; exit 2;;
esac
