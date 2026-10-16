#!/bin/bash
# install-session.sh — ON THE BOX, as root: install the Q10 session switcher. Idempotent.
#   sudo ./install-session.sh [--no-apt]     install / refresh
#   sudo ./install-session.sh --uninstall    restore the previous behaviour (the fallback path)
# Backs up every file it replaces (and the prior enable-state of q10-desktop) to
# /var/lib/q10/session/backup/. Starts and stops NOTHING: the running session is not disturbed;
# the new boot flow takes effect on the next boot (or: systemctl start q10-session-menu).
# Names: the CLI is q10-mode (NOT q10-session: /usr/local/bin/q10-session is the X session script).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root"; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
LIB=/usr/local/lib/q10-session; SBIN=/usr/local/sbin; UNITS=/etc/systemd/system
BK=/var/lib/q10/session/backup; STATE=$BK/state.env
UNIT_FILES="q10-swap.service q10-video-stack.service q10-session-boot.service q10-session-menu.service q10-kodi.service q10-web.service q10-android.service q10-hotkey.service"
LIB_FILES="q10common.py q10mode.py q10menu.py q10hotkey.py q10-video-stack q10-android-run q10-android-splash.py q10-desktop-start q10-swap q10-web-run"
LINKS="q10-mode:q10mode.py q10-menu:q10menu.py q10-hotkey:q10hotkey.py"
DROPIN=$UNITS/q10-desktop.service.d/10-q10-session.conf

# backup <dest>: keep the first pre-existing copy only (a re-run must not overwrite the true original)
backup() { local d=$1 b; b=$BK/$(echo "$d" | tr / _); if [ -e "$d" ] || [ -L "$d" ]; then [ -e "$b" ] || [ -L "$b" ] || cp -a "$d" "$b"; fi; }
put() { local src=$1 dst=$2 mode=$3; if [ -e "$dst" ] && ! cmp -s "$src" "$dst"; then backup "$dst"; fi; install -m "$mode" "$src" "$dst"; }

if [ "${1:-}" = "--uninstall" ]; then
  systemctl disable --now q10-hotkey.service q10-session-boot.service 2>/dev/null || true
  for u in $UNIT_FILES; do rm -f "$UNITS/$u"; done
  rm -f "$DROPIN"; rmdir "$UNITS/q10-desktop.service.d" 2>/dev/null || true
  for l in $LINKS; do rm -f "$SBIN/${l%%:*}"; done
  rm -rf "$LIB"
  # put back anything we replaced
  for b in "$BK"/*; do
    [ -e "$b" ] || [ -L "$b" ] || continue
    n=$(basename "$b"); [ "$n" = state.env ] && continue
    dst=$(echo "/$n" | tr _ / ); cp -a "$b" "$dst" 2>/dev/null || echo "WARN could not restore $dst"
  done
  # q10-desktop: back to its previous enable-state
  [ -f "$STATE" ] && . "$STATE"
  case "${DESKTOP_ENABLED:-disabled}" in enabled) systemctl enable q10-desktop.service ;; *) systemctl disable q10-desktop.service 2>/dev/null || true ;; esac
  systemctl daemon-reload
  echo "uninstalled. q10-desktop.service enable-state restored to: ${DESKTOP_ENABLED:-disabled}. Logs/default kept in /var/lib/q10/session, /var/log/q10."
  exit 0
fi

mkdir -p "$BK" "$LIB" /var/log/q10 /var/lib/q10/kodi
if [ "${1:-}" != "--no-apt" ]; then
  # fonts: the menu wants DejaVu; python3-evdev: input for menu and hotkey; python3-pil: drawing
  apt-get install -y --no-install-recommends python3-evdev python3-pil fonts-dejavu-core
fi
for p in evdev PIL; do python3 -c "import $p" 2>/dev/null || { echo "python3 module $p missing (run without --no-apt)"; exit 1; }; done

# record how q10-desktop behaved BEFORE us, once
if [ ! -f "$STATE" ]; then
  echo "DESKTOP_ENABLED=$(systemctl is-enabled q10-desktop.service 2>/dev/null || echo disabled)" > "$STATE"
  echo "DEFAULT_TARGET=$(systemctl get-default)" >> "$STATE"
fi

for f in $LIB_FILES; do
  put "$here/$f" "$LIB/$f" 755
done
for l in $LINKS; do
  [ -e "$SBIN/${l%%:*}" ] && [ ! -L "$SBIN/${l%%:*}" ] && backup "$SBIN/${l%%:*}"
  ln -sfn "$LIB/${l##*:}" "$SBIN/${l%%:*}"
done
for u in $UNIT_FILES; do put "$here/$u" "$UNITS/$u" 644; done
mkdir -p "$UNITS/q10-desktop.service.d"
put "$here/q10-desktop.service.d/10-q10-session.conf" "$DROPIN" 644
systemctl daemon-reload

# desktop no longer autostarts via graphical.target; the session chooser does
systemctl disable q10-desktop.service 2>/dev/null || true
systemctl enable q10-session-boot.service q10-hotkey.service q10-swap.service
[ -f /var/lib/q10/session/default ] || /usr/local/sbin/q10-mode set-default desktop
echo "installed. Not started: boot picks it up, or now: systemctl start q10-hotkey; systemctl start q10-session-menu"
/usr/local/sbin/q10-mode list
