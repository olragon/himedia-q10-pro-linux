#!/bin/bash
# q10-disk-temp-log.sh [interval-s=60] [alert-C=53] — MAC side: log the Q10's SATA disk temperature
# forever, one line per interval: disk C (SMART 194), SoC C, kernel, uptime, root device. A box that
# does not answer logs "down" and the loop keeps going, so it survives reboots and power cuts.
# Lines at or above alert-C are marked ALERT (the ST3250310AS SMART limit is 55 C).
# docs/261014-himedia-sata-kernel-vs-board.md
set -u
IV=${1:-60}; ALERT=${2:-53}; H=${Q10_HOST:-root@q10.local}
while true; do
  r=$(ssh -o BatchMode=yes -o ConnectTimeout=4 $H 'echo "$(smartctl -A /dev/sdb 2>/dev/null | awk "\$1==194{print \$10}")|$(( $(cat /sys/class/thermal/thermal_zone0/temp) / 1000 ))|$(uname -r)|$(cut -d. -f1 /proc/uptime)|$(findmnt -no SOURCE /)|$(cut -d" " -f1 /proc/loadavg)"' 2>/dev/null)
  if [ -z "$r" ]; then echo "$(date +%T) down"
  else
    IFS='|' read -r disk soc rel up root load <<<"$r"
    mark=""; [ -n "$disk" ] && [ "$disk" -ge "$ALERT" ] && mark="  ALERT >= ${ALERT} C"
    echo "$(date +%T) disk ${disk:-?} C  soc ${soc} C  load ${load}  ${rel} up ${up}s root ${root}${mark}"
  fi
  sleep "$IV"
done
