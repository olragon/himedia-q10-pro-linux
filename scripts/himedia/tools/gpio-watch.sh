#!/bin/sh
# gpio-watch.sh [seconds] — RUNS ON THE BOX. Log every change of every GPIO bank's data register
# (PL061 DATA at base+0x3fc, all 8 bits) with a timestamp. Used to find which SoC pins a
# peripheral we cannot see (the front-panel touch-key chip, 2026-10-11) drives: press the keys,
# read which bank/bit moves. Read-only.
secs=${1:-40}
banks="0:0xf8b20000 1:0xf8b21000 2:0xf8b22000 3:0xf8b23000 4:0xf8b24000 5:0xf8004000 6:0xf8b26000 7:0xf8b27000 8:0xf8b28000 9:0xf8b29000 10:0xf8b2a000 11:0xf8b2b000 12:0xf8b2c000"
for b in $banks; do eval "last_${b%%:*}=x"; done
end=$(( $(date +%s) + secs ))
while [ $(date +%s) -lt $end ]; do
  for b in $banks; do n=${b%%:*}; a=${b##*:}
    v=$(busybox devmem $((a + 0x3fc)) 32)
    eval "l=\$last_$n"
    if [ "$v" != "$l" ]; then
      [ "$l" = x ] && echo "init gpio$n data=$v dir=$(busybox devmem $((a + 0x400)) 32)" \
                   || echo "$(date +%T) gpio$n $l -> $v  (changed bits $(printf 0x%02x $(( (l ^ v) & 0xff ))))"
      eval "last_$n=$v"
    fi
  done
done
