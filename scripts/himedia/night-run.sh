#!/bin/bash
# night-run.sh <build-name> — wait for the Q10 to come back (Tim power-cycles it), then run the
# whole guarded test sequence unattended and log the evidence:
#   1. install the reboot-reset hook (mainline has no restart handler; a plain reboot hung the box)
#   2. kexec-try the test kernel (SP805 armed; failure falls back to the stick kernel + RAM ring)
#   3. on success: SMP, watchdog restart handler, WiFi, HDMI fb, IR, USB, front panel
# Nothing here writes the stick or the eMMC.
set -uo pipefail
name=${1:?usage: night-run.sh <build-name>}
H=${Q10_HOST:-root@q10.local}; SSH="ssh -o BatchMode=yes -o ConnectTimeout=5"
here=$(cd "$(dirname "$0")" && pwd)
echo "[local] waiting for $H (started $(date +%H:%M:%S))"
until $SSH $H true 2>/dev/null; do sleep 20; done
echo "[local->remote:$H] box is back at $(date +%H:%M:%S) on $($SSH $H uname -r)"

$SSH $H 'mkdir -p /usr/lib/systemd/system-shutdown && cat > /usr/lib/systemd/system-shutdown/q10-reset-on-reboot && chmod 755 /usr/lib/systemd/system-shutdown/q10-reset-on-reboot && echo "reboot hook installed"' \
  < "$here/rootfs-units/q10-reset-on-reboot.sh"
$SSH $H 'command -v iw >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q iw wireless-regdb >/dev/null 2>&1; command -v iw'

bash "$here/kexec-try.sh" "$name" 150 || { echo "⛔ test kernel $name failed — see the pstore/ramlog file above"; exit 1; }

echo "=== evidence on $name ==="
$SSH $H '
echo "--- SMP";      nproc; dmesg | grep -iE "hi3798cv200: released|CPU[0-9]+:|smp: Brought|failed to come"
echo "--- watchdog"; dmesg | grep -iE "sp805|watchdog" | head -5; ls /dev/watchdog* 2>&1
echo "--- clock";    date -u +%T
echo "--- hdmi fb";  dmesg | grep -iE "simple-framebuffer|Console: switching"; busybox devmem 0xf8cc7030 32
echo "--- ir";       ls /sys/class/rc; dmesg | grep -i hix5hd2
echo "--- usb";      ls /sys/bus/usb/devices | tr "\n" " "; echo
echo "--- sata";     systemctl is-active q10-sata; lsblk -o NAME,SIZE,MODEL | grep -v loop
echo "--- wifi";     dmesg | grep -iE "brcmfmac|f9c40000|mmc[0-9]: new" | head -12; ip -br link
iw dev 2>&1 | head; ip link set wlan0 up 2>&1; sleep 3; iw dev wlan0 scan 2>&1 | grep -cE "^BSS" | sed "s/^/wifi networks seen: /"
echo "--- panel";    q10-panel keys | tail -1; q10-panel all 4 | tail -1
'
echo "=== done $(date +%H:%M:%S) ==="
