#!/bin/sh
# q10-wifi-up — power the AP6255 WiFi module and give its SDIO pads the right voltage, then
# (re)bind the SDIO1 controller so brcmfmac finds the card. MEASURED 2026-10-11 by diffing the
# registers of stock Android (WiFi working) against mainline:
#   - GPIO4_6 is WL_REG_ON: alone it powers the module (DAT0 then held busy).
#   - PERI_SD_LDO (0xf8a2011c) bits [22:20] = sdio1 LDO {bypass,en,vset}: Android 0x2 = LDO on,
#     not bypassed = 1.8 V pads; mainline left 0x6 = bypass = 3.3 V. The module's IO is 1.8 V.
# With both, the card enumerates (mmc2:0001:1-3) and wlan0 comes up with its real MAC.
# Until the kernel does this (pwrseq + an LDO regulator), this runs at boot.
DRV=/sys/bus/platform/drivers/dw_mmc
BB=/bin/busybox
pin() { b=$1; n=$2; v=$3; d=$($BB devmem $((b+0x400)) 32); $BB devmem $((b+0x400)) 32 $(( d | (1<<n) )); $BB devmem $((b + ((1<<n)<<2))) 32 $(( v ? (1<<n) : 0 )); }
[ -e $DRV/f9c40000.mmc ] && echo f9c40000.mmc > $DRV/unbind
pin 0xf8b24000 6 0; sleep 0.3                                    # WL_REG_ON low
l=$($BB devmem 0xf8a2011c 32); $BB devmem 0xf8a2011c 32 $(( (l & ~0x700000) | 0x200000 ))   # 1.8 V
sleep 0.2; pin 0xf8b24000 6 1; sleep 0.3                         # WL_REG_ON high
echo f9c40000.mmc > $DRV/bind
for i in $(seq 1 60); do [ -e /sys/class/net/wlan0 ] && { echo "wlan0 up after ${i}x0.5s"; exit 0; }; sleep 0.5; done
echo "wlan0 did not appear in 30 s"; exit 1   # cold boot: firmware load took ~10.5 s on 2026-10-14
