#!/bin/bash
# install-power-hud.sh — ON THE BOX, as root: power key = real shutdown, panel shows SAVING -> OFF.
# Idempotent. Run on every root the box can boot (SATA root AND the stick's rootfs.img).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
install -D -m 755 "$here/q10-reset-on-reboot.sh" /usr/lib/systemd/system-shutdown/q10-reset-on-reboot
install -D -m 644 "$here/q10-hud-shutdown.service" /etc/systemd/system/q10-hud-shutdown.service
install -D -m 644 "$here/logind-q10-power.conf" /etc/systemd/logind.conf.d/q10-power.conf
# the power-key daemon (needs the session lib: q10common/q10mode; standby works without sessions too)
mkdir -p /usr/local/lib/q10-session
for f in q10power.py q10common.py q10mode.py q10menu.py; do
  [ -f "$here/../session/$f" ] && install -m 755 "$here/../session/$f" /usr/local/lib/q10-session/$f
done
install -D -m 644 "$here/../session/q10-power.service" /etc/systemd/system/q10-power.service
systemctl daemon-reload
systemctl enable q10-hud-shutdown.service q10-power.service
systemctl restart q10-power.service
# logind re-reads its config on reload; never restart it (that ends every session)
systemctl reload systemd-logind 2>/dev/null || kill -HUP "$(pidof systemd-logind)" 2>/dev/null || true
echo "installed: power key press = standby/wake, hold 3 s = shutdown (SAVING -> OFF); reboot -> REBOOT"
