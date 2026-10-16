#!/bin/bash
# cpufreq-step-test.sh — ON THE BOX (k20+), under q10-wd-run: userspace governor, step the CPU
# 1596 -> 1200 -> 798 -> 600 -> 396 -> 1596 MHz; at each step read cpuinfo_cur_freq, the APLL words
# (CRG 0x00/0x04) and the SoC temperature, and time a fixed workload (sha256 over 64 MB).
# Ends on the performance governor. docs/261012-himedia-cpufreq-stage1.md
set -u
C=/sys/devices/system/cpu/cpu0/cpufreq
echo userspace > $C/scaling_governor
printf "%-8s %-8s %-11s %-11s %-8s %s\n" set_khz cur_khz apll0 apll1 temp_mC sha256_64MB_s
for f in 1596000 1200000 798000 600000 396000 1596000; do
  echo $f > $C/scaling_setspeed; sleep 1
  t0=$(date +%s.%N); head -c 67108864 /dev/zero | sha256sum >/dev/null; t1=$(date +%s.%N)
  printf "%-8s %-8s %-11s %-11s %-8s %s\n" $f $(cat $C/cpuinfo_cur_freq) $(busybox devmem 0xf8a22000 32) \
    $(busybox devmem 0xf8a22004 32) $(cat /sys/class/thermal/thermal_zone0/temp) $(awk -v a=$t0 -v b=$t1 'BEGIN{printf "%.2f", b-a}')
done
echo performance > $C/scaling_governor
echo "governor=$(cat $C/scaling_governor) cur=$(cat $C/cpuinfo_cur_freq)"
cat $C/stats/trans_table 2>/dev/null | head -8
