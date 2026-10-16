#!/bin/bash
# Install the Q10 desktop pieces onto the box (Mac side): both Xorg display configs, the selector
# that picks one per boot, the session script and the (manual-start) desktop unit.
# usage: install-desktop.sh [${Q10_HOST:-root@q10.local}]
set -euo pipefail
H=${1:-${Q10_HOST:-root@q10.local}}; here=$(cd "$(dirname "$0")" && pwd)
ssh -n -o BatchMode=yes $H 'mkdir -p /usr/local/share/q10-desktop /etc/X11/xorg.conf.d'
scp -q -o BatchMode=yes "$here/10-q10-simpledrm.conf" "$here/10-q10-vdp.conf" $H:/usr/local/share/q10-desktop/
scp -q -o BatchMode=yes "$here/q10-xorg-select" "$here/q10-session" $H:/usr/local/bin/
scp -q -o BatchMode=yes "$here/q10-desktop.service" $H:/etc/systemd/system/
ssh -n -o BatchMode=yes $H 'chmod +x /usr/local/bin/q10-xorg-select /usr/local/bin/q10-session; systemctl daemon-reload; /usr/local/bin/q10-xorg-select; ls -l /etc/X11/xorg.conf.d/'
