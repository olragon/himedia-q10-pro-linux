#!/bin/sh
# /usr/lib/systemd/system-shutdown/q10-reset-on-reboot — systemd runs this right before the
# final reboot()/poweroff()/kexec() syscall, with the verb as $1. Every filesystem is already
# unmounted or read-only and synced at this point: the disk data is safe.
#
# ⛔ Mainline has no restart handler for the Hi3798CV200: `reboot` stops at "Restarting system"
# forever, and q10-watchdog-off.service has already disarmed the SP805 — a dead box that never
# falls back (2026-10-11). The vendor kernel restarts by arming the SP805 with a tiny load and
# spinning; do the same here so the hang the kernel is about to enter ends in a reset.
#
# ⛔ ONLY for reboot. Arming it for poweroff/halt made the front power button REBOOT the box
# (Tim, 2026-10-12). Mainline has no power-off handler either, so poweroff ends in a halted CPU;
# the kernel still flushes and spins down the SATA disk inside the syscall. The front panel says
# OFF (the TM1629A keeps its last frame) — then it is safe to pull the plug.
# Not for kexec: kexec-try.sh arms its own long window, and a short one would kill the new kernel.
PANEL=/usr/local/sbin/q10-panel
case "$1" in
  reboot)
    [ -x $PANEL ] && $PANEL text REBOOT 2 >/dev/null 2>&1
    BB=/bin/busybox
    $BB devmem 0xf8a2cc00 32 0x1acce551
    $BB devmem 0xf8a2c000 32 48000000      # 2 s at 24 MHz -> reset ~4 s after the syscall
    $BB devmem 0xf8a2c008 32 3
    $BB devmem 0xf8a2cc00 32 1 ;;
  poweroff|halt)
    sync
    # the halted CPU would leave HDMI showing the last frame: drop the signal, ask the TV to sleep
    for b in /sys/class/graphics/fb[0-9]*/blank; do echo 4 > "$b" 2>/dev/null; done
    command -v cec-ctl >/dev/null && [ -e /dev/cec0 ] && cec-ctl -d 0 --to 0 --standby >/dev/null 2>&1
    [ -x $PANEL ] && $PANEL text " OFF" 7 >/dev/null 2>&1 ;;
  *) exit 0 ;;
esac
