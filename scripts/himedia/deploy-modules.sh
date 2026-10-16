#!/bin/bash
# deploy-modules.sh <modules.tar.gz> [host] — install a kernel build's modules into the LIVE
# rootfs over ssh, blacklist the risky ones from auto-load, and install the guarded loader.
# The modules only work with the uImage from the SAME build (vermagic); boot that uImage first,
# or install ahead of the reboot — /lib/modules/<release> is per-kernel, so it is harmless.
set -euo pipefail
tgz=${1:?usage: deploy-modules.sh <modules.tar.gz> [host]}; host=${2:-${Q10_HOST:-root@q10.local}}
here=$(cd "$(dirname "$0")" && pwd)
S="ssh -o BatchMode=yes $host"
echo "[local->remote:$host] modules $(basename "$tgz") ($(du -h "$tgz" | cut -f1))"
$S 'tar -xzf - -C /' < "$tgz"
rel=$(tar -tzf "$tgz" | sed -n 's|^lib/modules/\([^/]*\)/.*|\1|p' | head -1)
$S "depmod -a $rel && ls /lib/modules/$rel/kernel/drivers/ata/ahci_platform.ko*"
# ⛔ Blacklist = no udev auto-load at boot. `modprobe <name>` still works, which is the point.
$S 'cat > /etc/modprobe.d/q10-sata.conf' <<'CONF'
# Q10: SATA once hung the box at boot. Load by hand: q10-modprobe-guarded phy_histb_combphy; then ahci_platform
blacklist phy_histb_combphy
blacklist ahci_platform
CONF
$S 'cat > /usr/local/sbin/q10-modprobe-guarded && chmod 755 /usr/local/sbin/q10-modprobe-guarded' < "$here/tools/q10-modprobe-guarded.sh"
$S 'sync; ls -l /etc/modprobe.d/q10-sata.conf /usr/local/sbin/q10-modprobe-guarded'
echo "✅ modules for $rel installed"
