#!/bin/bash
# q10-sata-root-soak.sh [N=3] | --after-power-cut — MAC side: reboot the box N times and, after each boot, check that it
# came up on the chained kernel with the root on the SATA disk and that the SATA link logged ZERO
# libata exceptions and hard resets in that boot. Stops at the first boot that is not clean.
# --after-power-cut: no reboot by us — wait (up to 30 min) for the box to stop answering, i.e. for a
# human to pull the plug, then time the cold boot and run the same one-boot check.
# Uses q10-boot-timeline.sh for the reboot + timing. docs/261014-himedia-sata-kernel-vs-board.md
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd); H=${Q10_HOST:-root@q10.local}; COLD=0; N=${1:-3}
if [ "${1:-}" = --after-power-cut ]; then
  COLD=1; N=1
  echo "$(date +%T) waiting for the power cut (box must stop answering ping)…"
  t=0; while ping -c1 -t1 "${H#*@}" >/dev/null 2>&1; do sleep 2; t=$((t + 2)); [ $t -ge 1800 ] && { echo "FAIL: no power cut within 30 min"; exit 1; }; done
  echo "$(date +%T) box is down — waiting for the cold boot"
fi
for i in $(seq 1 "$N"); do
  echo "=== boot $i/$N$([ $COLD = 1 ] && echo ' (cold)')"
  if [ $COLD = 1 ]; then bash "$here/q10-boot-timeline.sh" --no-reboot 900 || { echo "FAIL: cold boot did not come up"; exit 1; }
  else bash "$here/q10-boot-timeline.sh" 600 || { echo "FAIL: boot $i did not come up"; exit 1; }; fi
  r=$(ssh -o BatchMode=yes -o ConnectTimeout=5 $H 'echo "$(uname -r)|$(findmnt -no SOURCE /)|$(dmesg | grep -c "ata1.00: exception" || true)|$(dmesg | grep -c "hard resetting link" || true)|$(smartctl -A /dev/sdb 2>/dev/null | awk "\$1==194{print \$10}")|$(smartctl -A /dev/sdb 2>/dev/null | awk "\$2==\"UDMA_CRC_Error_Count\"{print \$10}")|$(dmesg | grep -o "SATA mode: nano\[0x1\] = 0x4" | head -1)"')
  IFS='|' read -r rel root exc rst temp crc tuned <<<"$r"
  echo "boot $i: kernel $rel  root $root  exceptions $exc  hard-resets $rst  disk ${temp} C  CRC $crc  [$tuned]"
  case "$rel|$root" in *-k26\|/dev/sd*) ;; *) echo "FAIL: not k26 on a SATA root"; exit 1 ;; esac
  [ "$exc" = 0 ] && [ "$rst" = 0 ] || { echo "FAIL: SATA errors in boot $i"; exit 1; }
done
echo "PASS: $N boots on the SATA root, 0 exceptions, 0 hard resets"
