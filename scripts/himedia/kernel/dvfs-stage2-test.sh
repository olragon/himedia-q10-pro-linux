#!/bin/bash
# dvfs-stage2-test.sh — ON THE BOX (k23+), run it UNDER q10-wd-run:
#     q10-wd-run /root/dvfs-stage2-test.sh [--only cpu|gpu|soak] [--dur 60] [--soak 60] [--gpu-dur 30] [--cpu-opps "1596000 1200000"]
# docs/261012-himedia-dvfs-stage2.md
#
# CPU: for each OPP, high to low: userspace governor + setspeed, then read back
#   - the voltage at PMC+0x18 (decoded to mV) and the regulator framework's own microvolts,
#   - the APLL fbdiv at CRG+0x294[11:0] (x 6 MHz),
# run a stress-and-verify workload for --dur seconds (N parallel workers, each looping sha256sum of
# a fixed 64 MiB buffer against a KNOWN hash, and gzip|sha256sum against a hash taken at the first
# OPP), sample the SoC temperature, scan dmesg for faults.  ANY hash mismatch, wrong read-back or
# kernel fault = FAIL for that OPP.
# GPU: for each devfreq OPP, high to low: userspace governor + set_freq, read back devfreq cur_freq,
# the CRG selector (0x154[7:5]) and PMC+0x20 (the CORE rail must NOT move), run glmark2-es2-drm (or
# kmscube) for --gpu-dur seconds, count panfrost job/MMU faults.  Then simple_ondemand under load
# and print trans_stat so the governor's transitions are visible.
#
# SOAK (--only soak, also part of `all`): governor schedutil under a pulsed 4-CPU load for --soak
# seconds; every 0.25 s read the hardware frequency, the PMC voltage and the frequency again (a
# sample whose two frequency reads differ is racing a transition and is not judged).  PASS needs
#   - NO sample with a voltage BELOW the OPP voltage of the current frequency (unsafe), and
#   - the voltage EQUAL to it in >= 90 % of the judged samples (stale-high voltage = the k23 bug),
#   - at least 3 distinct frequencies visited (otherwise the governor never moved and proves nothing).
# Prints the (kHz, mV) histogram and every APLL/regulator/OPP kernel message from the run.
#
# Prints one table per part.  Exit 0 = every OPP passed, 1 = at least one FAIL, 3 = refused to start.
# Ends on the performance governor (CPU) and simple_ondemand (GPU).
# The 60 s watchdog + 20 s pet comes from q10-wd-run; a hang resets the box into the stick kernel.
# Fallback if an OPP fails: boot with q10_cpu_vscale=0 on the kernel command line (1150 mV held).
set -u
BB=${BB:-busybox}
ONLY=all; DUR=60; GDUR=30; OPPS=""; SOAK=60
while [ $# -gt 0 ]; do case $1 in
  --only) ONLY=$2; shift 2;; --dur) DUR=$2; shift 2;; --gpu-dur) GDUR=$2; shift 2;;
  --cpu-opps) OPPS=$2; shift 2;; --soak) SOAK=$2; shift 2;; *) echo "unknown arg $1" >&2; exit 3;; esac; done

PMC_CPU=0xf8a23018; PMC_CORE=0xf8a23020; CRG_APLL_LIVE=0xf8a22294; CRG_GPU_STAT=0xf8a22154
REF_SHA=9ec9f8857bf7de7ec289c07f84be9569d2bc454c71091b2fb6400239e9a1c1b1   # 64 MiB AES-128-CTR keystream
BUF=/tmp/dvfs-buf.bin
# Vendor OPP voltages (mV) by kHz — what the DT says; with q10_cpu_vscale=0 every row is 1150.
declare -A VEXP=([396000]=840 [600000]=840 [798000]=870 [1200000]=990 [1596000]=1150)
fail_total=0
CPUFREQ=/sys/devices/system/cpu/cpu0/cpufreq

rd()  { $BB devmem "$1" 32; }
# PMC PWM register -> mV: period must be 0xC9 (201); V = 1150 - 2.5*(duty-1)
pwm_mv() { local v=$(( $(rd "$1") )); local per=$((v & 0xffff)) duty=$((v >> 16))
  [ "$per" -eq 201 ] && [ "$duty" -ge 1 ] && awk -v d=$duty 'BEGIN{printf "%.1f", 1150-2.5*(d-1)}' || echo "BAD(period=$per)"; }
temp_c() { local t; for z in /sys/class/thermal/thermal_zone*; do
    [ -r $z/temp ] && { t=$(cat $z/temp); echo $((t/1000)); return; }; done; echo "?"; }
reg_uv() { local r; for r in /sys/class/regulator/regulator.*; do
    [ "$(cat $r/name 2>/dev/null)" = vdd-cpu ] && { cat $r/microvolts; return; }; done; echo "n/a"; }
dmesg_faults() { dmesg | grep -ciE 'rcu.*stall|oops|BUG:|unable to handle|transition failed|rate_fault|voltage write not retained|vdd-cpu.*(fail|error)|js fault|gpu sched timeout|mmu fault|panfrost.*(error|fail)'; }

scaling_on=1; grep -q 'q10_cpu_vscale=0' /proc/cmdline && scaling_on=0
echo "== dvfs-stage2-test $(date -u +%FT%TZ) kernel $(uname -r) vscale=$scaling_on dur=${DUR}s gpu-dur=${GDUR}s"
echo "   cmdline: $(cat /proc/cmdline)"
dmesg | grep -E 'vdd-cpu|tsensor|cpufreq' | tail -4

# ---------------------------------------------------------------------------------------- CPU --
cpu_part() {
  [ -d $CPUFREQ ] || { echo "no cpufreq on this kernel"; return 3; }
  [ "$(cat $CPUFREQ/scaling_driver)" = cpufreq-dt ] || { echo "scaling_driver is not cpufreq-dt"; return 3; }
  local boot_mv; boot_mv=$(pwm_mv $PMC_CPU)
  echo "boot: PMC+0x18=$(rd $PMC_CPU) = ${boot_mv} mV, regulator=$(reg_uv) uV, fbdiv=$(( $(rd $CRG_APLL_LIVE) & 0xfff ))"
  [ "$(rd $PMC_CORE)" = "0x006D00C9" ] || echo "NOTE: CORE rail PMC+0x20 reads $(rd $PMC_CORE) (boot dump had 0x006D00C9)"
  core0=$(rd $PMC_CORE)

  # Reference buffer + known hash (tests the TOOLING at the boot state before any scaling).
  if [ ! -s $BUF ]; then
    command -v openssl >/dev/null || { echo "no $BUF and no openssl: scp the 64 MiB buffer here"; return 3; }
    openssl enc -aes-128-ctr -K 000102030405060708090a0b0c0d0e0f -iv 00000000000000000000000000000000 -nosalt \
      < /dev/zero 2>/dev/null | head -c 67108864 > $BUF
  fi
  local got; got=$(sha256sum $BUF | cut -d' ' -f1)
  [ "$got" = "$REF_SHA" ] || { echo "REFUSING: buffer hash $got != $REF_SHA (tooling, not DVFS)"; return 3; }
  local gz_ref=""; command -v gzip >/dev/null && gz_ref=$(gzip -1 -c $BUF | sha256sum | cut -d' ' -f1)

  local freqs; freqs=${OPPS:-$(tr ' ' '\n' < $CPUFREQ/scaling_available_frequencies | grep . | sort -rn | tr '\n' ' ')}
  echo userspace > $CPUFREQ/scaling_governor
  local ncpu; ncpu=$(grep -c ^processor /proc/cpuinfo)
  printf "\n%-8s %-8s %-9s %-9s %-9s %-7s %-6s %-7s %-6s %-7s %s\n" set_kHz cur_kHz mV_pmc mV_reg mV_exp fbdiv->MHz iters sha_bad temp_C faults RESULT
  local f
  for f in $freqs; do
    local exp=${VEXP[$f]:-?}; [ $scaling_on -eq 0 ] && exp=1150
    local d0; d0=$(dmesg_faults)
    echo $f > $CPUFREQ/scaling_setspeed; sleep 1
    local cur mv uv fb mhz
    cur=$(cat $CPUFREQ/cpuinfo_cur_freq); mv=$(pwm_mv $PMC_CPU); uv=$(reg_uv)
    fb=$(( $(rd $CRG_APLL_LIVE) & 0xfff )); mhz=$((fb * 6))
    local t0; t0=$(temp_c); local tmax=$t0
    # workers: each loops until the deadline, counts iterations and mismatches into its own file
    local end=$(( $(date +%s) + DUR )) w
    rm -f /tmp/dvfs-w.*
    for w in $(seq 1 $ncpu); do
      ( it=0; bad=0
        while [ "$(date +%s)" -lt $end ]; do
          h=$(sha256sum < $BUF | cut -d' ' -f1); [ "$h" = "$REF_SHA" ] || bad=$((bad+1))
          if [ -n "$gz_ref" ]; then h=$(gzip -1 -c $BUF | sha256sum | cut -d' ' -f1); [ "$h" = "$gz_ref" ] || bad=$((bad+1)); fi
          it=$((it+1))
        done; echo "$it $bad" > /tmp/dvfs-w.$w ) &
    done
    while [ "$(date +%s)" -lt $end ]; do sleep 5; local t; t=$(temp_c); [ "$t" != "?" ] && [ "$t" -gt "$tmax" ] 2>/dev/null && tmax=$t; done
    wait
    local it=0 bad=0 a b; for w in $(seq 1 $ncpu); do read a b < /tmp/dvfs-w.$w 2>/dev/null || { a=0; b=1; }; it=$((it+a)); bad=$((bad+b)); done
    local mv2 cur2 fb2 faults res=PASS
    mv2=$(pwm_mv $PMC_CPU); cur2=$(cat $CPUFREQ/cpuinfo_cur_freq); fb2=$(( $(rd $CRG_APLL_LIVE) & 0xfff ))
    faults=$(( $(dmesg_faults) - d0 ))
    [ "$cur" = "$f" ] && [ "$cur2" = "$f" ] || res="FAIL(freq)"
    # fbdiv reads 0 until the tune path is first used (boot clock path) — accept 0 at the boot rate
    if ! { [ "$fb" -eq 0 ] && [ "$f" -eq 1596000 ]; }; then
      [ "$fb" -eq $((f / 6000)) ] && [ "$fb2" -eq "$fb" ] || res="FAIL(fbdiv)"
    fi
    [ "${mv%.*}" = "$exp" ] && [ "${mv2%.*}" = "$exp" ] || res="FAIL(volt)"
    [ "$exp" != "?" ] && [ "$uv" != "n/a" ] && [ "$uv" -ne $((exp * 1000)) ] 2>/dev/null && res="FAIL(reg)"
    [ "$bad" -eq 0 ] || res="FAIL(hash)"
    [ "$it" -gt 0 ] || res="FAIL(no-iters)"
    [ "$faults" -eq 0 ] || res="FAIL(dmesg)"
    [ "$(rd $PMC_CORE)" = "$core0" ] || res="FAIL(core-rail-moved)"
    [ "$res" = PASS ] || fail_total=$((fail_total+1))
    printf "%-8s %-8s %-9s %-9s %-9s %-7s %-6s %-7s %-6s %-7s %s\n" $f $cur "$mv" "$uv" "$exp" "$fb->${mhz}" $it $bad "$t0->$tmax" $faults "$res"
  done
  echo performance > $CPUFREQ/scaling_governor
  echo "end: governor=$(cat $CPUFREQ/scaling_governor) cur=$(cat $CPUFREQ/cpuinfo_cur_freq) PMC+0x18=$(rd $PMC_CPU) ($(pwm_mv $PMC_CPU) mV) PMC+0x20=$(rd $PMC_CORE)"
  cat $CPUFREQ/stats/trans_table 2>/dev/null | head -8
}

# --------------------------------------------------------------------------------------- SOAK --
soak_part() {
  [ -d $CPUFREQ ] || { echo "no cpufreq"; return 3; }
  grep -qw schedutil $CPUFREQ/scaling_available_governors || { echo "schedutil not available"; return 3; }
  echo schedutil > $CPUFREQ/scaling_governor
  local ncpu; ncpu=$(grep -c ^processor /proc/cpuinfo)
  local d0; d0=$(dmesg | wc -l)
  rm -f /tmp/dvfs-soak.raw
  local end=$(( $(date +%s) + SOAK )) w
  # pulsed load: 4 s all-CPU burn, 4 s idle, so schedutil walks up and down the whole table
  ( while [ "$(date +%s)" -lt $end ]; do
      for w in $(seq 1 $ncpu); do timeout 4 sh -c 'while :; do :; done' & done; wait; sleep 4
    done ) &
  local load=$!
  echo "-- schedutil soak ${SOAK}s (sampling every 0.25 s)"
  while [ "$(date +%s)" -lt $end ]; do
    local f1 v f2
    f1=$(cat $CPUFREQ/cpuinfo_cur_freq); v=$(( $(rd $PMC_CPU) )); f2=$(cat $CPUFREQ/cpuinfo_cur_freq)
    echo "$f1 $f2 $v" >> /tmp/dvfs-soak.raw
    sleep 0.25
  done
  kill $load 2>/dev/null; wait 2>/dev/null
  local exp_tab="396000=${VEXP[396000]} 600000=${VEXP[600000]} 798000=${VEXP[798000]} 1200000=${VEXP[1200000]} 1596000=${VEXP[1596000]}"
  [ $scaling_on -eq 0 ] && exp_tab="396000=1150 600000=1150 798000=1150 1200000=1150 1596000=1150"
  awk -v tab="$exp_tab" 'BEGIN{n=split(tab,a," "); for(i=1;i<=n;i++){split(a[i],kv,"="); E[kv[1]]=kv[2]}}
    { if($1!=$2){racy++; next}
      duty=int($3/65536); mv=1150-2.5*(duty-1); e=E[$1]; j++
      key=$1" kHz @ "mv" mV (OPP "e")"; H[key]++
      if(mv+0.01<e) below++; else if(mv-0.01<=e) eq++; else above++
      F[$1]=1 }
    END{ for(k in H) printf "  %5d x  %s\n", H[k], k
         for(f in F) nf++
         pct = j ? 100*eq/j : 0
         printf "samples=%d judged=%d racy=%d  equal=%d (%.1f%%)  stale-high=%d  BELOW=%d  distinct-freqs=%d\n", NR, j, racy, eq, pct, above, below, nf
         res = (j>0 && below==0 && pct>=90 && nf>=3) ? "PASS" : "FAIL"
         print "SOAK RESULT: " res; exit (res=="PASS" ? 0 : 1) }' /tmp/dvfs-soak.raw | sort -k1,1nr > /tmp/dvfs-soak.out
  grep -v '^SOAK\|^samples' /tmp/dvfs-soak.out; grep '^samples\|^SOAK' /tmp/dvfs-soak.out
  echo "-- kernel messages during the soak (APLL / regulator / OPP):"
  dmesg | tail -n +$((d0 + 1)) | grep -iE 'APLL|vdd-cpu|opp|voltage|regulator|cpufreq' | tail -20
  grep -q '^SOAK RESULT: PASS' /tmp/dvfs-soak.out || fail_total=$((fail_total+1))
  echo "end: cur=$(cat $CPUFREQ/cpuinfo_cur_freq) governor=$(cat $CPUFREQ/scaling_governor) PMC+0x18=$(rd $PMC_CPU)"
}

# ---------------------------------------------------------------------------------------- GPU --
gpu_sel_mhz() { case $(( ($(rd $CRG_GPU_STAT) >> 5) & 7 )) in 7) echo 200;; 4) echo 300;; 1) echo 400;; 6) echo 500;; 3) echo 600;; 5) echo 675;; *) echo "?";; esac; }
gpu_load() {   # $1 seconds; prints an fps-ish result, never fails the script by itself
  # kmscube on the VDP card only: glmark2's jellyfish scene trips the known Mesa/T720 INSTR_INVALID_PC
  # fault at EVERY clock incl. today's 200 MHz (k23v0, 2026-10-12), so it measures the shader, not the
  # OPP; and card0 is simpledrm, not the TV.
  local card; card=$(readlink -f /dev/dri/by-path/platform-f8cc0000.display-controller-card)
  if command -v kmscube >/dev/null; then
    # kmscube treats EOF on stdin as "user interrupted": keep stdin open, render a fixed frame count
    local s e fr=$(( $1 * 60 )); s=$(date +%s%N)
    timeout $(( $1 + 20 )) kmscube -D "$card" -c $fr < <(sleep $(( $1 + 25 ))) >/dev/null 2>&1; e=$(date +%s%N)
    echo "kmscube ${fr}f $(awk -v f=$fr -v ms=$(( (e - s) / 1000000 )) 'BEGIN{printf "%.1f fps", f*1000/ms}')"
  else echo "no kmscube"; fi
}
gpu_part() {
  # kmscube needs DRM master and the GPU to itself: stop the sessions for the GPU part
  systemctl stop q10-desktop q10-kodi q10-web 2>/dev/null; sleep 2
  local dev; dev=$(ls -d /sys/class/devfreq/*gpu* 2>/dev/null | head -1)
  if [ -z "$dev" ]; then
    echo "no GPU devfreq yet: modprobe panfrost"; modprobe panfrost 2>&1 | tail -2; sleep 2
    dev=$(ls -d /sys/class/devfreq/*gpu* 2>/dev/null | head -1)
  fi
  [ -n "$dev" ] || { echo "GPU devfreq did not appear (panfrost probe failed? dmesg | grep -i panfrost)"; dmesg | grep -iE 'panfrost|devfreq' | tail -5; return 3; }
  echo "devfreq: $dev governor=$(cat $dev/governor) avail=$(cat $dev/available_frequencies) cur=$(cat $dev/cur_freq)"
  local core0; core0=$(rd $PMC_CORE); echo "core rail PMC+0x20=$core0 ($(pwm_mv $PMC_CORE) mV, must stay put)"
  grep -q userspace $dev/available_governors || { echo "userspace devfreq governor missing"; return 3; }
  local freqs; freqs=$(tr ' ' '\n' < $dev/available_frequencies | grep . | sort -rn | tr '\n' ' ')
  echo userspace > $dev/governor
  printf "\n%-10s %-10s %-9s %-10s %-9s %-7s %s\n" set_Hz cur_Hz crg_MHz core_mV load faults RESULT
  local f
  for f in $freqs; do
    local d0; d0=$(dmesg_faults)
    echo $f > $dev/userspace/set_freq; sleep 1
    local cur sel res=PASS; cur=$(cat $dev/cur_freq); sel=$(gpu_sel_mhz)
    local out; out=$(gpu_load $GDUR); local cur2; cur2=$(cat $dev/cur_freq)
    local faults=$(( $(dmesg_faults) - d0 ))
    [ "$cur" = "$f" ] && [ "$cur2" = "$f" ] || res="FAIL(freq)"
    [ "$sel" = "$((f / 1000000))" ] || res="FAIL(crg)"
    [ "$(rd $PMC_CORE)" = "$core0" ] || res="FAIL(core-rail-moved)"
    [ "$faults" -eq 0 ] || res="FAIL(js-fault)"
    [ "$res" = PASS ] || fail_total=$((fail_total+1))
    printf "%-10s %-10s %-9s %-10s %-9s %-7s %s\n" $f $cur "$sel" "$(pwm_mv $PMC_CORE)" "$out" $faults "$res"
  done
  echo simple_ondemand > $dev/governor
  echo "-- simple_ondemand under load ${GDUR}s:"; gpu_load $GDUR
  echo "governor=$(cat $dev/governor) cur=$(cat $dev/cur_freq)"; cat $dev/trans_stat 2>/dev/null
  echo "panfrost 'js fault' lines in dmesg (whole boot): $(dmesg | grep -c 'js fault')"
}

rc=0
case $ONLY in all|cpu) cpu_part || rc=$?;; esac
[ $rc -eq 3 ] && exit 3
case $ONLY in all|soak) soak_part || rc=$?;; esac
[ $rc -eq 3 ] && exit 3
case $ONLY in all|gpu) gpu_part || rc=$?;; esac
[ $rc -eq 3 ] && exit 3
echo; echo "== FAILED OPPs: $fail_total"
[ $fail_total -eq 0 ]
