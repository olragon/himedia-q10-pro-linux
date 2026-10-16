#!/bin/sh
# q10-sata-phy-init.sh — the HiSilicon vendor SATA PHY tuning that mainline never writes.
# Installed as /usr/local/sbin/q10-sata-phy-tune. q10-sata.service runs it right after ahci_platform;
# q10-sata-phy-tune.service runs it at sysinit when the INITRAMFS loaded the driver (root on SATA).
#
# ⭐ MEASURED 2026-10-14 (docs/261014-himedia-sata-kernel-vs-board.md): mainline phy-histb-combphy
# writes the Poplar PCIe value nano[0x1] = 0x8 in every mode. On SATA that leaves the box's receiver
# marginal: 10B8B/BadCRC on an IDLE link (4-33 error-seconds a minute) and, under a 2 GB read, 6
# exceptions + 6 hard resets + UDMA/100. The vendor SATA driver (hiahci-phy, stock 3.18) writes 0x4:
# 0 error-seconds in five 60 s windows. nano[0x1] alone decides it (a sweep: 2/4/6 clean, any value
# with bit 3 set errs). With the vendor AHCI port tuning as well, the same 2 GB read gave CRC +0,
# 0 exceptions, 0 resets, UDMA/133.
#
# Values (from the disassembly, docs/261012-himedia-sata-link-down-investigation.md; the vendor
# writes nano first — here it goes LAST, see below):
#   nano[0x1] = 0x4                       (combphy test interface, PERI_CTRL+0x858)
#   AHCI+0x148 &= ~0x100 ; AHCI+0x14c = (v & ~0x1ff) | 0x52
#   AHCI+0x148 &= ~0x100 ; AHCI+0x14c = (v & ~0x3fe00) | 0x8000
#   AHCI+0x174 = 0x0e400000 ; AHCI+0x144 |= 0x680000
# The registers survive COMRESET and libata hard resets; a driver load (combphy POR) resets nano[1] to
# mainline's 0x8, which is why this runs after every load.
# Usage: q10-sata-phy-init.sh [nano1=4]
set -eu
# ⛔ RUN FROM RAM. On a SATA root this script lives on the disk whose link it disturbs: the nano write
# blips the PHY (PHYRdyChg -> libata EH hard reset), and every later exec or PATH lookup that misses
# the page cache then waits on that same EH. Measured 2026-10-14 (k25 boot): 3 hard resets and a 38 s
# boot stall. So: copy busybox + this script to /run (tmpfs) first and use only busybox applets after.
R=/run/q10-sata-tune
if [ "${Q10_TUNE_IN_RAM:-0}" != 1 ]; then
  mkdir -p $R; cp /bin/busybox $R/busybox; cp "$0" $R/tune
  Q10_TUNE_IN_RAM=1 exec $R/busybox sh $R/tune "$@"
fi
BB=$R/busybox
PERI=0xf8a20000
AHCI=0xf9900000
rd() { $BB devmem $(( $1 )) 32; }
wr() { $BB devmem $(( $1 )) 32 $(( $2 )); }
pause() { $BB usleep 21000; }   # vendor delay: ~20 ms

nano() {  # nano ADDR DATA — exactly the vendor helper @ c062f354
  v=$(rd $PERI+0x858)
  v=$(( (v & ~0xf1f000) | ($2 << 20) | ($1 << 12) ))
  wr $PERI+0x858 $v; pause
  wr $PERI+0x858 $(( v | 0x1000000 )); pause
  wr $PERI+0x858 $(( v & ~0x1000000 )); pause
}

# k26+ kernels tune in combphy before the first link training (patch 0020). A userspace retune there
# would only blip a correct link — never run it.
case "$($BB uname -r)" in
  *-k2[6-9]*|*-k[3-9][0-9]*) echo "kernel $($BB uname -r) tunes SATA itself (patch 0020) — nothing to do"; exit 0 ;;
esac
$BB grep -q '^ahci_platform ' /proc/modules || { echo "ahci_platform not loaded — its clocks are off; refusing"; exit 1; }
mode=$(( ($(rd $PERI+0x8) >> 11) & 3 ))
[ "$mode" = 2 ] || { echo "combphy1 not in SATA mode (bits[12:11]=$mode); refusing"; exit 1; }

# ⛔ NOT idempotent by design: nano[1] cannot be read back, and a kexec re-runs the combphy POR (nano
# back to 0x8) without asserting the AHCI reset (0x174 may keep the vendor value), so no register tells
# "already tuned". One caller per boot path instead: q10-sata-phy-tune.service when the initramfs
# loaded the driver (root on SATA; q10-sata.service stays disabled there), q10-sata.service otherwise.
# AHCI port registers FIRST, nano[1] LAST: the nano write is what blips the PHY, and libata's EH starts
# a hard reset ~70 ms later. With the AHCI writes still running behind it (vendor order), that first
# reset failed and the retry came 15 s later (two resets per boot, 2026-10-14). Nothing may change
# after the blip. The probe showed the two settings are independent (vnano / vahci).
v=$(rd $AHCI+0x148); wr $AHCI+0x148 $(( v & ~0x100 )); pause
v=$(rd $AHCI+0x14c); wr $AHCI+0x14c $(( (v & ~0x1ff) | 0x52 )); pause
v=$(rd $AHCI+0x148); wr $AHCI+0x148 $(( v & ~0x100 )); pause
v=$(rd $AHCI+0x14c); wr $AHCI+0x14c $(( (v & ~0x3fe00) | 0x8000 )); pause
wr $AHCI+0x174 0x0e400000; pause
v=$(rd $AHCI+0x144); wr $AHCI+0x144 $(( v | 0x680000 )); pause
nano 0x1 "${1:-4}"
echo "sata phy tuned: nano1=${1:-4} 0x144=$(rd $AHCI+0x144) 0x14c=$(rd $AHCI+0x14c) 0x174=$(rd $AHCI+0x174)"

# ⛔ NO retrain. nano[1] takes effect LIVE — measured 2026-10-14 on an idle link: tuned 0/20 error-s,
# nano1=8 10/30, back to 4 with no COMRESET 0/40. A COMRESET here cost one libata exception per boot
# (in-flight NCQ commands failed + retried: SErr PHYRdyChg CommWake DevExch) and gained nothing. The
# AHCI port registers take effect at the next link training libata does on its own.
