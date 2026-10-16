#!/bin/bash
# night-ir.sh <night-hud log> — after the panel clock is installed, install the remote's keymap
# (NEC address 0x10, 70 keys from the stock /etc/key.xml — docs/261011-himedia-ir-keymap-audio-research.md)
# so the IR receiver (rc0, ir-hix5hd2) turns button presses into key events.
set -uo pipefail
log=${1:?usage: night-ir.sh <night-hud log>}
H=${Q10_HOST:-root@q10.local}; SSH="ssh -o BatchMode=yes -o ConnectTimeout=5"
here=$(cd "$(dirname "$0")" && pwd)
until grep -qE "=== hud done" "$log" 2>/dev/null; do sleep 30; done
$SSH $H 'command -v ir-keytable >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q ir-keytable >/dev/null 2>&1; command -v ir-keytable'
$SSH $H 'mkdir -p /etc/rc_keymaps && cat > /etc/rc_keymaps/himedia_q10.toml' < "$here/rootfs-units/himedia_q10.toml"
# Persist: udev runs ir-keytable -a on rc device add, which reads /etc/rc_maps.cfg.
$SSH $H 'grep -q himedia_q10 /etc/rc_maps.cfg 2>/dev/null || echo "hix5hd2-ir * himedia_q10.toml" >> /etc/rc_maps.cfg; [ -e /sys/class/rc/rc0 ] && ir-keytable -s rc0 -c -w /etc/rc_keymaps/himedia_q10.toml 2>&1 | tail -2; ir-keytable -s rc0 2>&1 | head -6 || echo "no rc0 on this kernel (IR is in the k* test kernels)"'
echo "=== ir done $(date +%H:%M:%S) ==="
