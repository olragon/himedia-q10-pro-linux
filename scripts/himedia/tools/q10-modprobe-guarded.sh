#!/bin/sh
# q10-modprobe-guarded <module> [seconds] [settle] — load a kernel module with the SP805 armed.
#
# ⭐ Why: a driver that hangs the only CPU (the first built-in SATA boot, 2026-10-11) leaves the
# box dead with no log. Armed first, a hang resets the box within ~2x <seconds> into the same
# kernel (the module is blacklisted from auto-load, so the next boot reaches ssh), and this
# boot's console survives in ramoops: read it from /var/lib/systemd/pstore/ (systemd-pstore
# archives /sys/fs/pstore there at boot). The stage lines below go to kmsg, so the log says
# exactly which modprobe was running when it died.
# SP805: reset fires at the SECOND expiry of LOAD, so the window is ~2x <seconds>.
# ⛔ [settle]: libata probes ports ASYNCHRONOUSLY, so modprobe returns before link training and
# error handling run — disarming at once would leave the risky part unguarded. Stay armed for
# <settle> more seconds (a hung CPU never gets to the disarm). Keep settle < 2x seconds.
set -u
m=${1:?usage: q10-modprobe-guarded <module> [seconds]}
secs=${2:-45}
# SP805 LOAD is 32-bit at 24 MHz: >178 s wraps silently into a different window (2026-10-11).
[ "$secs" -ge 1 ] && [ "$secs" -le 178 ] || { echo "watchdog period $secs s out of range 1..178" >&2; exit 2; }
settle=${3:-0}
BB=/bin/busybox
wd() { $BB devmem 0xf8a2cc00 32 0x1acce551; "$@"; $BB devmem 0xf8a2cc00 32 1; }
echo "q10: guarded modprobe $m — watchdog armed ${secs}s (reset at ~$((2*secs))s)" > /dev/kmsg
sync
wd sh -c "$BB devmem 0xf8a2c000 32 $((secs * 24000000)); $BB devmem 0xf8a2c008 32 3"
modprobe -v "$m"; rc=$?
echo "q10: guarded modprobe $m rc=$rc — settling ${settle}s, still armed" > /dev/kmsg
$BB sleep "$settle"
wd $BB devmem 0xf8a2c008 32 0
echo "q10: guarded modprobe $m returned rc=$rc — watchdog disarmed (ctrl=$($BB devmem 0xf8a2c008 32))" > /dev/kmsg
echo "rc=$rc"; exit $rc
