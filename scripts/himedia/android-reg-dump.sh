#!/bin/bash
# android-reg-dump.sh [mainline|android] — dump the SAME register windows from whichever OS the
# Q10 is running, so mainline can be diffed against the stock Android state that WORKS
# (WiFi SDIO, S/PDIF pads, GPIO levels). Android: adb + vendor `himd.l`; mainline: ssh + devmem.
#   android  : the box booted stock Android (stick out), adb on 192.168.1.200:5555
#   mainline : ${Q10_HOST:-root@q10.local}
# Output: archive/<ts>-q10-regs-<os>.txt (one "addr value" per line, diffable).
set -uo pipefail
os=${1:?usage: android-reg-dump.sh android|mainline}
here=$(cd "$(dirname "$0")/../.." && pwd)
out="$here/archive/$(date +%Y%m%d-%H%M%S)-q10-regs-$os.txt"
# name base length
WINDOWS="ioconfig 0xf8a21000 0x200
sata_ahci 0xf9900000 0x200
peri_combphy 0xf8a20800 0x80
peri_hi 0xf8a20000 0x40
crg 0xf8a22000 0x300
peri 0xf8a20000 0x200
sysctrl 0xf8000000 0x100
sdio1_host 0xf9c40000 0x100
aiao_com 0xf8cd0000 0x40
aiao_crg 0xf8cd0140 0x80
aiao_tx2 0xf8cd2200 0xb0
aiao_spdif1 0xf8cd3100 0xb0
spdifer1 0xf8cd5000 0x40
aiao_crg_all 0xf8cd0100 0x100
aiao_tx3 0xf8cd2300 0xb0
aiao_spdif0 0xf8cd3000 0xb0
spdifer0 0xf8cd4000 0x40
hdmi_ctrl 0xf8ce0000 0x2000"
for b in 0 1 2 3 4 5 6 7 8 9 10 11 12; do
  base=$(( b == 5 ? 0xf8004000 : 0xf8b20000 + b * 0x1000 ))
  WINDOWS="$WINDOWS
gpio${b}_dir $(printf 0x%x $((base + 0x400))) 0x4
gpio${b}_data $(printf 0x%x $((base + 0x3fc))) 0x4"
done
{
echo "# Q10 register dump — $os — $(date)"
while read -r name base len; do
  [ -n "$name" ] || continue
  echo "## $name $base $len"
  if [ "$os" = android ]; then
    adb -s 192.168.1.200:5555 shell -n "himd.l $base $len" 2>&1 | tr -d '\r'
  else
    ssh -n -o BatchMode=yes ${Q10_HOST:-root@q10.local} "a=\$(( $base )); e=\$(( $base + $len )); while [ \$a -lt \$e ]; do printf '%08x: %s\n' \$a \$(busybox devmem \$a 32); a=\$((a+4)); done"
  fi
done <<< "$WINDOWS"
} > "$out"
echo "$out ($(wc -l < "$out") lines)"
