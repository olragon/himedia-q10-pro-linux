#!/bin/sh
# Install / uninstall the "Play in mpv (HW)" Chromium bridge on the Q10 Pro (run ON the box, as root).
#   sudo ./install-mpv-bridge.sh install      # run from this directory (copies extension/, mpv_hw_host.py, ...)
#   sudo ./install-mpv-bridge.sh uninstall
# Extension loading: --load-extension via /etc/chromium.d (ExtensionInstallForcelist needs a CRX + update URL; see docs).
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR=/usr/share/q10/mpv-bridge-extension
HOST_DIR=/usr/local/lib/q10
HOST="$HOST_DIR/mpv_hw_host.py"
NMH_DIR=/etc/chromium/native-messaging-hosts
NMH="$NMH_DIR/vn.himedia.mpv_hw.json"
FLAGS=/etc/chromium.d/q10-mpv-bridge
LOG=/var/log/q10-mpv-bridge.log

case "${1:-}" in
install)
  [ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
  apt-get install -y --no-install-recommends python3 yt-dlp
  command -v mpv-v4l2req >/dev/null || echo "WARN: /usr/local/bin/mpv-v4l2req missing (install-mpv-v4l2req.sh)"
  mpv-v4l2req --gpu-context=help 2>&1 | grep -q x11egl || echo "WARN: this mpv has no x11egl context; the host will refuse under X (needs the X11 mpv build)"

  ID="$(python3 "$HERE/extension-id.py" "$HERE/extension/manifest.json")"
  rm -rf "$EXT_DIR"; mkdir -p "$EXT_DIR" "$HOST_DIR" "$NMH_DIR"
  cp -r "$HERE/extension/." "$EXT_DIR/"
  install -m 755 "$HERE/mpv_hw_host.py" "$HOST"
  sed -e "s|@HOST_PATH@|$HOST|" -e "s|@EXT_ID@|$ID|" "$HERE/native-host-manifest.json.in" > "$NMH"
  chmod 644 "$NMH"
  touch "$LOG"; chmod 666 "$LOG"
  [ -d /etc/chromium.d ] || { echo "no /etc/chromium.d: is Debian's chromium installed?"; exit 1; }
  printf '# Q10 mpv bridge: load the unpacked extension (written by install-mpv-bridge.sh)\nexport CHROMIUM_FLAGS="$CHROMIUM_FLAGS --load-extension=%s"\n' "$EXT_DIR" > "$FLAGS"
  if grep -hs 'disable-features' /etc/chromium.d/* | grep -v '^#' | grep -q .; then echo "NOTE: another /etc/chromium.d file sets --disable-features; if the extension does not load, see docs (DisableLoadExtensionCommandLineSwitch)."; fi
  echo "extension id: $ID"
  echo "host manifest: $NMH"; cat "$NMH"
  echo "host self-test:"; python3 - "$HOST" <<'PY'
import struct, subprocess, sys
m = b'{"action":"ping"}'
p = subprocess.run([sys.argv[1]], input=struct.pack("=I", len(m)) + m, capture_output=True, timeout=30)
print(p.stdout[4:].decode(), p.stderr.decode())
PY
  echo "Restart Chromium fully (pkill chromium) for the flag and host to take effect."
  ;;
uninstall)
  [ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
  rm -rf "$EXT_DIR" "$HOST" "$NMH" "$FLAGS" /run/q10-mpv-bridge.pid
  rmdir "$HOST_DIR" /usr/share/q10 2>/dev/null || true
  echo "removed (log $LOG kept; yt-dlp left installed)"
  ;;
*) echo "usage: $0 install | uninstall"; exit 2;;
esac
