#!/bin/bash
# q10-boot-timeline.sh [--no-reboot] [max-s=720] — MAC side: reboot the box and log, with Mac
# timestamps, every change in what answers: .56 (kernel IP_PNP up), .57 (init.c ran), .58 (init.sh
# reached its snapshot — i.e. it did NOT switch_root), ssh (:22), and the kernel release + root seen
# over ssh. A drop back to nothing mid-boot is a reset; the gap before the first .56 is U-Boot +
# kernel decompress. Stops once ssh answers on the chained kernel with system state running|degraded.
# docs/261014-himedia-sata-kernel-vs-board.md
set -u
H=${Q10_HOST:-root@q10.local}; H=${H#*@}; MAX=720; REBOOT=1
for a in "$@"; do case $a in --no-reboot) REBOOT=0 ;; *) MAX=$a ;; esac; done
t0=$(date +%s)
if [ $REBOOT = 1 ]; then
  echo "$(date +%T) +0s reboot: $(ssh -o BatchMode=yes -o ConnectTimeout=5 root@$H 'uname -r; findmnt -no SOURCE /' | tr '\n' ' ')"
  ssh -o BatchMode=yes -o ConnectTimeout=5 root@$H 'systemctl reboot' 2>/dev/null
  sleep 3
fi
prev=""; last=""
while [ $(( $(date +%s) - t0 )) -lt "$MAX" ]; do
  s=""
  for ip in 56 57 58; do ping -c1 -t1 192.168.1.$ip >/dev/null 2>&1 && s="$s .$ip"; done
  info=""
  if nc -z -G 1 $H 22 2>/dev/null; then
    s="$s ssh"
    info=$(ssh -o BatchMode=yes -o ConnectTimeout=3 root@$H 'echo "$(uname -r) $(findmnt -no SOURCE /) up=$(cut -d" " -f1 /proc/uptime)s $(grep -o q10.chained=1 /proc/cmdline) $(systemctl is-system-running 2>/dev/null)"' 2>/dev/null)
  fi
  key="$s|$(echo "$info" | awk '{print $1, $2, $4, $5}')"
  [ "$key" != "$prev" ] && echo "$(date +%T) +$(( $(date +%s) - t0 ))s up:${s:- none} ${info}"
  prev=$key
  case "$info" in *q10.chained=1\ running*|*q10.chained=1\ degraded*) echo "done: chained kernel up"; exit 0 ;; esac
  sleep 2
done
echo "TIMEOUT after ${MAX}s"; exit 1
