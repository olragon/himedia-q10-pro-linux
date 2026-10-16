#!/bin/bash
# install-sata-hotplug.sh — ON THE BOX, as root. Idempotent. Run on every root the box can boot.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
command -v hdparm >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends hdparm psmisc >/dev/null || true
install -m 755 "$here/q10-sata-hotplug" /usr/local/sbin/q10-sata-hotplug
install -m 755 "$here/../tools/q10-sata-phy-init.sh" /usr/local/sbin/q10-sata-phy-tune
install -m 644 "$here/q10-sata.service" /etc/systemd/system/q10-sata.service
install -m 644 "$here/q10-sata-phy-tune.service" /etc/systemd/system/q10-sata-phy-tune.service
install -m 644 "$here/q10-sata-hotplug.service" /etc/systemd/system/q10-sata-hotplug.service
systemctl daemon-reload
systemctl enable q10-sata-phy-tune.service   # inert unless the initramfs loaded ahci_platform
# enabling stays a separate, deliberate step (q10-sata was disabled for the bad link, 2026-10-12)
[ "${Q10_SATA_ENABLE:-0}" = 1 ] && systemctl enable --now q10-sata.service q10-sata-hotplug.service
/usr/local/sbin/q10-sata-hotplug status
