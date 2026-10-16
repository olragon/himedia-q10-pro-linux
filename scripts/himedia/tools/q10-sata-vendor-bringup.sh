#!/bin/sh
# q10-sata-vendor-bringup.sh — reproduce the stock kernel's SATA bring-up IN ORDER, without any
# mainline SATA driver, and read the port's link status raw. Answers one question: does the PHY see
# the disk when initialised the vendor way? (docs/261012-himedia-sata-link-down-investigation.md)
#
# Order = stock 3.18: hiclk_prepare_hiahci (CRG98 combphy1 = 0xd00) -> clocks -> hiahci_phy_init
# (mode check, nano[1]=4, CRG42=0xf, AHCI port vendor regs, PxCMD spin-up, 100 ms, nano[0x19]=2|3)
# -> hiahci_phy_power_on (PERI_CTRL+0x8 |= 0x400).
# ⛔ Touching AHCI registers with its clocks off can hang the bus: the SP805 is armed for the whole
# run (reset at ~2x60 s), and the clocks are enabled before the first AHCI access.
# Leaves ahci_platform UNLOADED so the raw state can be inspected; reload with
#   q10-modprobe-guarded ahci_platform 60 40
set -u
BB=/bin/busybox
PERI=0xf8a20000; CRG=0xf8a22000; AHCI=0xf9900000
rd() { $BB devmem $(( $1 )) 32; }
wr() { $BB devmem $(( $1 )) 32 $(( $2 )); }
ms() { $BB usleep $(( $1 * 1000 )); }
wd() { $BB devmem 0xf8a2cc00 32 0x1acce551; "$@"; $BB devmem 0xf8a2cc00 32 1; }
nano() { v=$(rd $PERI+0x858); v=$(( (v & ~0xf1f000) | ($2 << 20) | ($1 << 12) ))
         wr $PERI+0x858 $v; ms 20; wr $PERI+0x858 $(( v | 0x1000000 )); ms 20; wr $PERI+0x858 $(( v & ~0x1000000 )); ms 20; }
ssts() { s=$(rd $AHCI+0x128); printf 'PxSSTS=%s (DET=%d SPD=%d IPM=%d) PxSERR=%s\n' "$s" $((s & 0xf)) $(((s >> 4) & 0xf)) $(((s >> 8) & 0xf)) "$(rd $AHCI+0x130)"; }

echo "q10: sata vendor bring-up — watchdog armed 60s" > /dev/kmsg; sync
wd sh -c "$BB devmem 0xf8a2c000 32 $((60 * 24000000)); $BB devmem 0xf8a2c008 32 3"

lsmod | grep -q '^ahci_platform' && rmmod ahci_platform && echo "ahci_platform unloaded"
v=$(rd $CRG+0x188); wr $CRG+0x188 $(( (v & ~0xff00) | 0xd00 ))          # combphy1: clk on, mux 3, out of reset
v=$(rd $CRG+0xa8);  wr $CRG+0xa8  $(( (v & ~0x100) | 0xf ))              # SATA clocks on, controller out of reset
ms 5
v=$(rd $PERI+0x858); wr $PERI+0x858 $(( (v & ~0x80000000) | 1 )); ms 5    # codec on, EP refclk out (mainline init minus its nano writes)
[ $(( ($(rd $PERI+0x8) >> 11) & 3 )) = 2 ] || { echo "combphy1 not in SATA mode"; wd $BB devmem 0xf8a2c008 32 0; exit 1; }
nano 0x1 0x4
wr $CRG+0xa8 $(( $(rd $CRG+0xa8) | 0xf ))
v=$(rd $AHCI+0x148); wr $AHCI+0x148 $(( v & ~0x100 )); ms 20
v=$(rd $AHCI+0x14c); wr $AHCI+0x14c $(( (v & ~0x1ff) | 0x52 )); ms 20
v=$(rd $AHCI+0x148); wr $AHCI+0x148 $(( v & ~0x100 )); ms 20
v=$(rd $AHCI+0x14c); wr $AHCI+0x14c $(( (v & ~0x3fe00) | 0x8000 )); ms 20
wr $AHCI+0x174 0x0e400000; ms 20
v=$(rd $AHCI+0x144); wr $AHCI+0x144 $(( v | 0x680000 )); ms 20
wr $AHCI+0x118 0x600000; ms 20
wr $AHCI+0x118 0x600002; ms 20
ms 100
echo "after spin-up:"; ssts
if [ $(( ($(rd $AHCI+0x128) >> 8) & 0xf )) = 0 ]; then nano 0x19 2; echo "nano[0x19]=2:"; ssts; fi
if [ $(( ($(rd $AHCI+0x128) >> 8) & 0xf )) = 0 ]; then nano 0x19 3; echo "nano[0x19]=3:"; ssts; fi
v=$(rd $PERI+0x8); wr $PERI+0x8 $(( v | 0x400 )); ms 100                  # hiahci_phy_power_on
echo "after phy power-on:"; ssts
# one more spin-up / COMRESET by hand: PxSCTL.DET=1 for >1 ms, then 0
v=$(rd $AHCI+0x12c); wr $AHCI+0x12c $(( (v & ~0xf) | 1 )); ms 10; wr $AHCI+0x12c $(( v & ~0xf )); ms 200
echo "after manual COMRESET:"; ssts

wd $BB devmem 0xf8a2c008 32 0
echo "q10: sata vendor bring-up done — watchdog disarmed" > /dev/kmsg
echo "regs: CRG42=$(rd $CRG+0xa8) CRG98=$(rd $CRG+0x188) PERI8=$(rd $PERI+0x8) CFG=$(rd $PERI+0x858) 144=$(rd $AHCI+0x144) 14c=$(rd $AHCI+0x14c) 174=$(rd $AHCI+0x174) CMD=$(rd $AHCI+0x118)"
