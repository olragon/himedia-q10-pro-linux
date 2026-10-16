#!/bin/bash
# install-kernel-chain.sh <build-name> [release] — MAC side: make <build-name> the kernel every
# cold boot chains into (stage 1 = the stick's k14, which is never rewritten).
# Copies zImage + dtb + cmdline (the dtb's own bootargs, like kexec-try.sh) to
# /var/lib/q10/kernels/<name>/ and writes /etc/q10/kernel.conf. The target must already have
# its modules on the box (kexec-try.sh <name> stages them, and proves the kernel boots).
#   install-kernel-chain.sh k16
#   install-kernel-chain.sh --off      remove kernel.conf: cold boots stay on the stick kernel
set -euo pipefail
H=${Q10_HOST:-root@q10.local}; SSH="ssh -o BatchMode=yes -o ConnectTimeout=5"
here=$(cd "$(dirname "$0")" && pwd); B=${Q10_KBUILD_ROOT:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32}
if [ "${1:-}" = "--off" ]; then $SSH $H 'rm -f /etc/q10/kernel.conf; echo "kernel.conf removed"'; exit 0; fi
name=${1:?usage: install-kernel-chain.sh <build-name> | --off}
rel=${2:-$(tar -tzf "$B/$name-modules.tar.gz" | sed -n 's|^lib/modules/\([^/]*\)/.*|\1|p' | head -1)}
args=$(dtc -I dtb -O dts "$B/$name.dtb" 2>/dev/null | sed -n 's/^[[:space:]]*bootargs = "\(.*\)";/\1/p')
[ -n "$args" ] || { echo "⛔ no bootargs in $name.dtb"; exit 2; }
$SSH $H "test -d /lib/modules/$rel" || { echo "⛔ /lib/modules/$rel missing on the box — run kexec-try.sh $name first"; exit 2; }
$SSH $H "mkdir -p /var/lib/q10/kernels/$name /etc/q10"
scp -q -o BatchMode=yes "$B/$name.zImage" $H:/var/lib/q10/kernels/$name/zImage
scp -q -o BatchMode=yes "$B/$name.dtb" $H:/var/lib/q10/kernels/$name/dtb
echo "$args" | $SSH $H "cat > /var/lib/q10/kernels/$name/cmdline"
scp -q -o BatchMode=yes "$here/q10-kexec-chain" $H:/usr/local/sbin/q10-kexec-chain
scp -q -o BatchMode=yes "$here/q10-kexec-chain.service" "$here/q10-kexec-chain-ok.service" $H:/etc/systemd/system/
$SSH $H "cat > /etc/q10/kernel.conf <<EOC
# written by install-kernel-chain.sh $(date +%F)
TARGET_RELEASE=$rel
KDIR=/var/lib/q10/kernels/$name
WATCHDOG=150
EOC
chmod +x /usr/local/sbin/q10-kexec-chain; systemctl daemon-reload
systemctl enable q10-kexec-chain.service q10-kexec-chain-ok.service
rm -f /var/lib/q10/kexec-chain/attempts; q10-kexec-chain status"
