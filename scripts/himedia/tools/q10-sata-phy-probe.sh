#!/bin/sh
# q10-sata-phy-probe.sh <secs> <config>... — BOX side: judge SATA PHY tuning with ZERO disk-media I/O.
#
# Per config: SATA controller + combo PHY 1 held in reset and released (clean slate), PHY tuned the
# config's way, port spun up + one COMRESET by hand, then <secs> one-second idle windows: PxSERR is
# cleared each second and any non-zero reading counts as an error second. An idle SATA link still
# carries ALIGN/SYNC primitives, so 10B8B / disparity errors show up without a sector being read.
# ahci_platform must NOT be loaded (no libata, no IDENTIFY, no sd attach); the script unloads it.
# The SP805 is armed for the whole run and petted every second, so a bus hang resets the box.
#   configs: main  mainline combphy init (nano 1=8 c=9 1a=4)
#            vend  vendor hiahci-phy init (nano 1=4, AHCI 14c/174/144, nano19=2|3 only if IPM=0, PERI+8 b10)
#            v19-2 / v19-3   vendor, nano19 forced to 2 / 3
#            vahci mainline nano + vendor AHCI port regs only
#            vnano vendor nano 1=4 only, no AHCI regs
#            vnano-nob10  nano 1=4 without PERI+8 bit 10 · main-b10  mainline nano + bit 10
#            n4c9  nano 1=4 + c=9 + 1a=4 + bit 10 · n8  nano 1=8 alone + bit 10
#            n1-<v>  nano 1=<v> alone (sweep), no bit 10
#            <cfg>@g1        the same with PxSCTL.SPD=1 (cap the link at 1.5 Gbps)
# docs/261014-himedia-sata-kernel-vs-board.md
set -u
BB=/bin/busybox
PERI=0xf8a20000; CRG=0xf8a22000; AHCI=0xf9900000; WDT=0xf8a2c000
rd() { $BB devmem $(( $1 )) 32; }
wr() { $BB devmem $(( $1 )) 32 $(( $2 )); }
ms() { $BB usleep $(( $1 * 1000 )); }
wdu() { $BB devmem $((WDT + 0xc00)) 32 0x1acce551; "$@"; $BB devmem $((WDT + 0xc00)) 32 1; }
pet() { wdu $BB devmem $((WDT + 0xc)) 32 1; }                  # WdogIntClr reloads the counter
nano() { v=$(rd $PERI+0x858); v=$(( (v & ~0xf1f000) | ($2 << 20) | ($1 << 12) ))
         wr $PERI+0x858 $v; ms 20; wr $PERI+0x858 $(( v | 0x1000000 )); ms 20; wr $PERI+0x858 $(( v & ~0x1000000 )); ms 20; }
setb() { v=$(rd $1); wr $1 $(( v | $2 )); }
clrb() { v=$(rd $1); wr $1 $(( v & ~$2 )); }
serr_names() { s=$1; o=""
  for b in 0:I-recov 1:M-comm-recov 8:T-data-integrity 9:C-persist-comm 10:P-protocol 11:E-internal \
           16:N-phyrdy-chg 17:I-phy-internal 18:W-comwake 19:B-10b8b 20:D-disparity 21:C-crc \
           22:H-handshake 23:S-link-seq 24:T-transport 25:F-unk-fis 26:X-exchanged; do
    [ $(( (s >> ${b%%:*}) & 1 )) = 1 ] && o="$o ${b#*:}"; done; echo "${o:- none}"; }

secs=${1:?usage: q10-sata-phy-probe.sh <secs> <config>...}; shift
[ $# -gt 0 ] || { sed -n 2,18p "$0"; exit 2; }
lsmod | grep -q '^ahci_platform' && { rmmod ahci_platform || exit 1; echo "ahci_platform unloaded"; }

echo "q10: sata phy probe ($*) — watchdog armed 30s" > /dev/kmsg; sync
wdu sh -c "$BB devmem $WDT 32 $((30 * 24000000)); $BB devmem $((WDT + 8)) 32 3"
trap 'wdu $BB devmem $((WDT + 8)) 32 0; echo "q10: sata phy probe done — watchdog disarmed" > /dev/kmsg' EXIT

probe() {
  cfg=${1%@*}; cap=0; [ "$1" != "$cfg" ] && cap=1
  # clean slate: controller (CRG 0xa8 b8-11) + combphy1 POR (CRG 0x188 b12) in reset, then out
  # ⛔ clocks on BEFORE the first AHCI access: rmmod ahci_platform gates them, and an access to a
  # gated block hangs the bus
  setb $CRG+0xa8 0xf; ms 2
  wr $AHCI+0x118 0; setb $CRG+0x188 0x1000; setb $CRG+0xa8 0xf00; ms 10
  v=$(rd $CRG+0x188); wr $CRG+0x188 $(( (v & ~0xff00) | 0xd00 )); ms 2
  v=$(rd $CRG+0xa8);  wr $CRG+0xa8  $(( (v & ~0xf00) | 0xf )); ms 5
  clrb $PERI+0x858 0x80000000; setb $PERI+0x858 1; ms 5        # codec on, EP refclk out
  [ $(( ($(rd $PERI+0x8) >> 11) & 3 )) = 2 ] || { echo "$1: combphy1 not in SATA mode"; return 1; }
  clrb $PERI+0x8 0x400
  case $cfg in
    main|vahci|main-b10) nano 0x1 0x8; nano 0xc 0x9; nano 0x1a 0x4 ;;
    vend|v19-2|v19-3|vnano|vnano-nob10) nano 0x1 0x4 ;;
    n4c9) nano 0x1 0x4; nano 0xc 0x9; nano 0x1a 0x4 ;;
    n8) nano 0x1 0x8 ;;
    n1-*) nano 0x1 $(( ${cfg#n1-} )) ;;
    *) echo "unknown config $cfg"; return 1 ;;
  esac
  case $cfg in vend|v19-2|v19-3|vahci)
    clrb $AHCI+0x148 0x100; ms 20; v=$(rd $AHCI+0x14c); wr $AHCI+0x14c $(( (v & ~0x1ff) | 0x52 )); ms 20
    clrb $AHCI+0x148 0x100; ms 20; v=$(rd $AHCI+0x14c); wr $AHCI+0x14c $(( (v & ~0x3fe00) | 0x8000 )); ms 20
    wr $AHCI+0x174 0x0e400000; ms 20; setb $AHCI+0x144 0x680000; ms 20 ;;
  esac
  [ $cap = 1 ] && wr $AHCI+0x12c 0x310 || wr $AHCI+0x12c 0x300   # IPM transitions off; SPD cap or none
  wr $AHCI+0x118 0x600000; ms 20; wr $AHCI+0x118 0x600002; ms 100   # spin-up device (vendor order)
  case $cfg in
    vend) [ $(( ($(rd $AHCI+0x128) >> 8) & 0xf )) = 0 ] && nano 0x19 2
          [ $(( ($(rd $AHCI+0x128) >> 8) & 0xf )) = 0 ] && nano 0x19 3 ;;
    v19-2) nano 0x19 2 ;; v19-3) nano 0x19 3 ;;
  esac
  case $cfg in vend|v19-2|v19-3|vnano|main-b10|n4c9|n8) setb $PERI+0x8 0x400; ms 100 ;; esac
  v=$(rd $AHCI+0x12c); wr $AHCI+0x12c $(( (v & ~0xf) | 1 )); ms 10; wr $AHCI+0x12c $(( v & ~0xf ))  # COMRESET
  i=0; while [ $i -lt 20 ] && [ $(( $(rd $AHCI+0x128) & 0xf )) != 3 ]; do ms 50; i=$((i + 1)); done
  ms 300; pet
  s0=$(rd $AHCI+0x128); wr $AHCI+0x130 0xffffffff
  n=0; acc=0; t=0
  while [ $t -lt "$secs" ]; do
    sleep 1; pet; e=$(rd $AHCI+0x130)
    [ $(( e )) != 0 ] && { n=$((n + 1)); acc=$(( acc | e )); wr $AHCI+0x130 0xffffffff; }
    t=$((t + 1))
  done
  s1=$(rd $AHCI+0x128)
  printf '%-9s link %s -> %s  DET=%d SPD=%d  error-seconds %d/%d  bits:%s\n' "$1" "$s0" "$s1" \
    $((s1 & 0xf)) $(((s1 >> 4) & 0xf)) $n "$secs" "$(serr_names $acc)"
  echo "          regs 144=$(rd $AHCI+0x144) 14c=$(rd $AHCI+0x14c) 174=$(rd $AHCI+0x174) CFG=$(rd $PERI+0x858) PERI8=$(rd $PERI+0x8)"
}

for c in "$@"; do probe "$c"; done
