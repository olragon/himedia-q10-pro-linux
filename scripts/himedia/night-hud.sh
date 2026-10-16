#!/bin/bash
# night-hud.sh <night-run log> — after night-run.sh finishes, install the front-panel clock:
# rebuild q10-panel on the box (text/clock modes), install q10-hud.service, show "1234" for
# 20 s (a known pattern to compare with the decoded map), then start the clock.
set -uo pipefail
log=${1:?usage: night-hud.sh <night-run log>}
H=${Q10_HOST:-root@q10.local}; SSH="ssh -o BatchMode=yes -o ConnectTimeout=5"
here=$(cd "$(dirname "$0")" && pwd)
until grep -qE "=== done|⛔" "$log" 2>/dev/null; do sleep 30; done
until $SSH $H true 2>/dev/null; do sleep 20; done
echo "[local->remote:$H] installing the panel clock on $($SSH $H uname -r)"
$SSH $H 'cat > /tmp/q10-panel.c && gcc -O2 -Wall -o /usr/local/sbin/q10-panel /tmp/q10-panel.c && echo built' < "$here/tools/q10-panel.c"
$SSH $H 'cat > /etc/systemd/system/q10-hud.service' < "$here/rootfs-units/q10-hud.service"
$SSH $H 'q10-panel text 1234 2; sleep 20; q10-panel text "12:34" 2; sleep 10; systemctl daemon-reload; systemctl enable --now q10-hud.service; sleep 3; systemctl is-active q10-hud.service'
echo "=== hud done $(date +%H:%M:%S) ==="
