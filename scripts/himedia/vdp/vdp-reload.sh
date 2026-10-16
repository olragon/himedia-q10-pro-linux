#!/bin/bash
# vdp-reload.sh [modprobe params...] — on the box: reload histb_vdp with new module parameters
# (e.g. allow_scale=1 for the V0 ZME scaler) under q10-wd-run. Stops q10-desktop first (it holds the
# card) and restarts it after. Parameters are 0444, so a reload is the only way to change them.
# A hang during unbind/probe stops the watchdog pets -> reset into the stick kernel in ~2 min.
set -u
[ -z "${Q10_WD:-}" ] && Q10_WD=1 exec q10-wd-run "$0" "$@"
was=$(systemctl is-active q10-desktop)
[ "$was" = active ] && systemctl stop q10-desktop
sleep 2
echo "vdp-reload: rmmod histb_vdp (refcnt $(cat /sys/module/histb_vdp/refcnt 2>/dev/null))" > /dev/kmsg
rmmod histb_vdp || { echo "rmmod failed: $(lsof /dev/dri/card* 2>/dev/null | tail -n +2 | awk '{print $1}' | sort -u | tr '\n' ' ')"; [ "$was" = active ] && systemctl start q10-desktop; exit 3; }
echo "vdp-reload: modprobe histb_vdp $*" > /dev/kmsg
modprobe -v histb_vdp "$@"; rc=$?
sleep 3
echo "rc=$rc allow_scale=$(cat /sys/module/histb_vdp/parameters/allow_scale 2>/dev/null)"
ls -l /dev/dri/by-path/ | grep -o 'platform-.*'
dmesg | grep -iE "histb.vdp|histb_vdp" | tail -6
[ "$was" = active ] && systemctl start q10-desktop
exit $rc
