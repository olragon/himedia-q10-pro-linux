# Q10 Pro: DVFS stage 2 (CPU voltage + GPU devfreq), kernel k23

**Date:** 2026-10-12. **Kernel:** 6.18.55-k23, built in a COPY of the tree
(`$HIMEDIA_ROOT/kernel-build-arm32-k23`). **Nothing ran on the box.**
Basis: `docs/261012-himedia-dvfs-research.md` (vendor mechanism), `docs/261012-himedia-cpufreq-stage1.md`
(patches 0013/0014, working on the box). k22 stays the boot default; k23 is a candidate.

Evidence tags: **[read]** read in a file/disassembly, **[measured]** measured on the box earlier (boot register
dump `archive/20261012-dvfs-regs-mainline-k19.txt`), **[inferred]** reasoned, **[untested]** no hardware run yet.

## What changed

| File | Change |
| --- | --- |
| `kernel/arm32/0018-regulator-add-hi3798cv200-cpu-pwm-regulator.patch` | new `drivers/regulator/hi3798cv200-cpu-regulator.c` + Kconfig `REGULATOR_HI3798CV200_CPU` + Makefile |
| `kernel/arm32/hi3798cv200.dtsi` | `vdd_cpu` regulator node (PMC+0x18), `cpu-supply` on the 4 CPUs, vendor `opp-microvolt` per OPP |
| `kernel/arm32/hi3798cv200-himedia-q10-pro.dts` | GPU `gpu_opp` table (200/300/400/500 MHz), `operating-points-v2` on `&gpu`, `vdd_gpu` fixed regulator now says 880 mV |
| `build-kernel-arm32.ts` | patch 0018 wired + 3 new REQUIRED `=y` (`REGULATOR_HI3798CV200_CPU`, `DEVFREQ_GOV_USERSPACE`, `DEVFREQ_GOV_PERFORMANCE`). Nothing else touched |
| `kernel/dvfs-stage2-test.sh` | box-side test, runs under `q10-wd-run` |

## CPU voltage

### Provenance of every number
- **Register + formula** [read, stock kernel `cpu_volt_scale`, VA `c07f4364`]: PMC+0x18 = `(duty<<16) | 201`,
  `V = 1150 mV - 2.5 mV x (duty-1)`, 650..1150 mV. Boot value `0x000100C9` = 1150 mV [measured]. The driver's
  selector math (`duty = 201 - sel`, `sel = (uV-650000)/2500`) reproduces the research table:
  840 mV -> duty 125 `0x007D00C9`, 870 -> 113, 990 -> 65, 1150 -> 1.
- **OPP voltages** [read, stock `hi_init_opp_table`, array at VA `0xc1217190`, `{kHz, mV, enabled}`]:
  400/600/800/1200/1600 MHz at 840/840/870/990/1150 mV. These are the `v_b` column (the AVS ceiling), the
  one the vendor kernel registers. The vendor rates are really 396/600/798/1200/1596 MHz (fbdiv 66/100/133/200/266),
  which is what patch 0013 accepts.
- **Settle time** [read, `hi_device_scale` `c07f4934`]: `msleep(10)` after a voltage write, before a clock raise;
  on the way down: clock, `msleep(10)`, voltage. The driver sleeps 10 ms after every write; the OPP core supplies the
  ordering (voltage up before the clock rises, voltage down after the clock falls). The vendor jumps straight to the
  target voltage, no intermediate steps; so does the driver.
- **Community driver** [community, `histb-linux-6.12.y/drivers/regulator/hi3798cv200-pwm-regulator.c`]: same
  register layout and selector math. Differences: we have no GPU variant (the GPU rail is not handled, see below),
  a hard clamp, a bind-time period check, a disable switch, and a read-back message.

### OPP table (k23)

| Rate | fbdiv | PMC+0x18 expected | mV |
| ---: | ---: | --- | ---: |
| 396 MHz | 66 | `0x007D00C9` | 840 |
| 600 MHz | 100 | `0x007D00C9` | 840 |
| 798 MHz | 133 | `0x007100C9` | 870 |
| 1200 MHz | 200 | `0x004100C9` | 990 |
| 1596 MHz (boot) | 266 | `0x000100C9` | 1150 |

### Safety layers
1. **Driver clamp 800..1150 mV** (`HARD_MIN_UV`/`HARD_MAX_UV`), applied to both the DT constraints and every
   `set_voltage_sel`, so a DT typo cannot request 650 mV. DT min is 800 (below the lowest OPP, 840, on purpose); the OPP
   table never names anything under 840. Nothing above 1150 mV and nothing above 1596 MHz is reachable.
2. **Bind-time check:** PWM period must read `201`, else the driver refuses to bind (`-ENODEV`). cpufreq-dt then
   waits for the missing `cpu-supply` and, after the deferred-probe timeout, fails: **no cpufreq at all, CPU stays at
   the boot rate and voltage.** That is the fail-closed outcome; it also removes stage 1 scaling, which is intended.
3. **Read-back after every write.** On mismatch: the old value is written back and `-EIO` is returned, which fails the
   frequency transition (OPP core aborts before touching the clock).
4. **Kill switch.** Kernel command line `q10_cpu_vscale=0` (or DT property `hisilicon,no-voltage-scaling` on the node):
   at probe the rail is forced to 1150 mV (the write only ever goes UP, to the boot value) and `set_voltage` returns
   success without writing, so cpufreq keeps scaling frequency with the voltage held at 1150 mV (that is exactly stage 1).
   The probe message says `voltage scaling DISABLED`.
5. **Watchdog.** `q10-wd-run` around every test: a hang resets the box into the stick kernel.
6. Hardware AVS is **off** at boot (PMC+0x368 = `0xC0`, bit 0 clear) [measured] and we never enable it, so the HPM loop
   does not fight the static voltage. HPM/AVS trimming (research s2.6, "C4") is not implemented.

### What is deliberately not done
- **The CORE rail (PMC+0x20) is never written.** It is shared with video/display and reads `0x006D00C9` = 880 mV at
  boot [measured]. The test script asserts it does not move.
- **Cold compensation not implemented.** The vendor adds +50 mV when T <= 30 C and the rate <= 600 MHz [read, `c07f49b8`].
  On a box that boots at 40-60 C this is unreachable, but a freshly powered box in a cold room could hit it. If a 396/600
  MHz step is unstable below 30 C, that is the reason; the fallback is `q10_cpu_vscale=0`.
- **No HPM-based voltage trimming**: the static `v_b` column is the vendor's fallback value.

### Open points [untested]
- Whether this specific board wires the PWM to a DC-DC at all. The research says "likely yes" (retail box shipping the
  vendor DVFS); step C2 of the research (raise-only, watch HPM codes `PMC+0x7c/0x80`) was never done on the box. The first
  voltage actually lowered is the first proof. If the PWM is not wired, lowering is harmless but pointless: the test would
  pass at every OPP and the power would not change.
- Silicon margin: the vendor table is the vendor's, from their characterisation; this unit's HPM codes at boot
  (`PMC+0x7c = 0x0216D170`, `0x80 = 0x0016D16F`) have not been compared with the vendor target codes (`201/201/256/298/362`).

## GPU devfreq

- **Today's rate: 200 MHz.** The GPU clock (patch 0010) defaults to selector 7 = 200 MHz and no `assigned-clock-rates` is
  set; the boot register `CRG+0x124 = 0x607` agrees [measured]. So 300/400/500 MHz are **above what the GPU runs now**. They are
  what you asked for and they are the vendor's own 880 mV rates [read, research s4.2], but they are new for this GPU, and
  `simple_ondemand` will use them as soon as there is load. The `panfrost` module is blacklisted until loaded, so nothing
  happens until you `modprobe panfrost`. To cap it at today's rate without rebuilding: `echo 200000000 > /sys/class/devfreq/f9200000.gpu/max_freq`.
- **OPPs:** 200/300/400/500 MHz, all `opp-microvolt = <880000>`. 600 (920 mV) and 675 MHz (980 mV) are left out: they need a
  higher core rail than the 880 mV we read at boot, and the core rail is not ours to change. The clock accepts those rates, but
  nothing can ask for them through devfreq.
- **Supply:** the placeholder `regulator-fixed` now carries `regulator-min/max-microvolt = 880000`. That number is no longer
  invented: it is the PMC+0x20 boot value [measured] and the vendor's voltage for 200..500 MHz [read]. The OPP core's
  "set 880 mV" is then a no-op on a fixed regulator, and panfrost's missing-OPP-regulator path is avoided (a fixed regulator
  without a voltage, with OPPs that name one, was the unresolved question in the research, s4.4). No voltage is ever written.
- **Governor:** panfrost registers `simple_ondemand` (upthreshold 45, downdifferential 5) and a devfreq cooling device; no change
  to the driver. The `userspace` and `performance` governors are built in (`=y`) for the test.
- **Fallback:** delete `operating-points-v2 = <&gpu_opp>;` from `&gpu` and panfrost stays at 200 MHz with no devfreq.

## Test plan (you run it; k22 stays the default)

Copy the script: `scp scripts/himedia/kernel/dvfs-stage2-test.sh root@q10.local:/root/` (box needs `openssl` or a staged
`/tmp/dvfs-buf.bin`, `gzip`, `glmark2-es2-drm` or `kmscube`).

0. Boot **`k23v0`** first (`kexec-try.sh k23v0`; identical kernel, only its DTB bootargs carry **`q10_cpu_vscale=0`**, built with `--vscale0`; `kexec-try` takes the command line from the DTB): expect behaviour identical to k22/stage 1.
   `dmesg | grep vdd-cpu` -> `voltage scaling DISABLED: rail held at 1150 mV`. Run the CPU test: every row expects 1150 mV.
   This proves the regulator driver, the OPP/regulator wiring and the settle path before a single voltage drops.
1. Then boot plain `k23` (no flag). `dmesg | grep -E 'vdd-cpu|cpufreq'`: `PMC PWM regulator, 1150 mV now, limits 800..1150 mV, scaling on`.
   `cat /sys/class/regulator/regulator.*/{name,microvolts}`: `vdd-cpu 1150000`; `devmem 0xf8a23018` = `0x000100C9`.
2. One OPP at a time, from the bottom up is the research's order: `q10-wd-run dvfs-stage2-test.sh --only cpu --cpu-opps 1200000 --dur 300`
   then 798000, 600000, 396000 (the lowest voltages last; a 5-minute burn each, per research C3). Then the full pass:
   `q10-wd-run dvfs-stage2-test.sh --only cpu` (60 s per OPP, high to low).
3. GPU: `q10-wd-run dvfs-stage2-test.sh --only gpu` (loads panfrost if needed; 30 s per OPP; then `simple_ondemand` under load with `trans_stat`).
4. Pass criteria per CPU row: read-back frequency, APLL fbdiv (x 6 MHz) and PMC voltage equal the table, regulator framework
   microvolts agree, **0 hash mismatches**, 0 new dmesg faults, core rail unchanged. Per GPU row: devfreq `cur_freq`, CRG selector
   (`0x154[7:5]`) agree, core rail PMC+0x20 unchanged, 0 `js fault`.
5. The script prints a table per part and exits 1 if any row failed.

### Reading a failure
| Symptom | Likely meaning |
| --- | --- |
| `FAIL(hash)` at one OPP, others pass | that voltage is too low for that rate on this unit: keep that OPP at 1150 mV (change its `opp-microvolt`) or use `q10_cpu_vscale=0` |
| box hangs / watchdog reset during a step | same, harder; fallback as above; read pstore (`/sys/fs/pstore`) |
| `FAIL(volt)` with mV_pmc = 1150 at a low OPP | the regulator ignored the request (scaling off, or `set_voltage` not reached): check `dmesg vdd-cpu` |
| `FAIL(reg)` only | PMC and regulator framework disagree: driver bug |
| `FAIL(core-rail-moved)` | something else wrote PMC+0x20: stop |
| no regulator, no cpufreq | the PWM period check failed (`dmesg` says "not binding"); register layout differs from the vendor's |

## Fallbacks, in order
1. Single OPP unstable: raise that OPP's `opp-microvolt` in the dtsi (e.g. 840 -> 900); nothing else changes.
2. Any doubt: boot with `q10_cpu_vscale=0` (cmdline). Frequency scaling continues at 1150 mV.
3. Remove `cpu-supply` lines from the dtsi: stage 1 exactly, no regulator involved.
4. Boot k22 (the default).

## Build
`Q10_KBUILD_ROOT=$HIMEDIA_ROOT/kernel-build-arm32-k23 bun scripts/himedia/build-kernel-arm32.ts --out k23 --localversion k23 --ramlog`
(log (run log)); the fallback image is the same command with `--out k23v0 --vscale0` (log
(run log)). Audio module: `Q10_KBUILD_ROOT=... scripts/himedia/audio/build.sh`.

## Result (static checks only; no boot)
Both builds exit 0, release `6.18.55-k23`. `REGULATOR_HI3798CV200_CPU=y`, `DEVFREQ_GOV_USERSPACE=y`, `DEVFREQ_GOV_PERFORMANCE=y`
asserted by the build; `hi3798cv200-cpu-regulator.o` compiled without warnings. `dtc` decode of `k23.dtb`: `regulator@8a23018`
(reg `0x8a23018` len 4, min `0xC3500`=800 mV, max `0x118C30`=1150 mV), `cpu-supply` on all four CPUs, CPU `opp-microvolt` =
`0xCD140/0xCD140/0xD4670/0xF1B30/0x118C30` = 840/840/870/990/1150 mV, `opp-table-gpu` with four OPPs at `0xD6D80` = 880 mV.
`k23v0.dtb` bootargs end with `q10_cpu_vscale=0`; `k23.dtb` has none.

Artifacts in `$HIMEDIA_ROOT/kernel-build-arm32-k23/`:
`k23`, `k23.zImage`, `k23.dtb`, `k23-modules.tar.gz`, and the fallback `k23v0`, `k23v0.zImage`, `k23v0.dtb`, `k23v0-modules.tar.gz`
(same config). Audio: `$HIMEDIA_ROOT/audio/q10_aiao-6.18.55-k23.ko`.
Not verified: `dvfs-stage2-test.sh` passed `bash -n` only; it has never run on the box (its box-side tools `openssl`, `gzip`,
`glmark2-es2-drm`/`kmscube`, `busybox devmem` are assumed present).

## k23b: schedutil leaves the voltage stranded high (2026-10-12)

**Symptom (box, schedutil, 30 x 1 s):** 28 samples at 396 MHz with 990 mV (PMC `0x004100C9`), one 396/870, one 1596/1150.

**The "two consumers" theory is wrong.** `/sys/class/regulator/*/num_users` prints `rdev->use_count`, the ENABLE count
(`regulator-always-on` + the OPP core's one `regulator_enable`), not the number of `regulator_get` handles. Read in 6.18.55:
`cpufreq-dt` calls `dev_pm_opp_set_regulators()` for cpu0 only (`dt_cpufreq_early_init` skips CPUs already covered by a policy),
cpu1-3 join the same shared `opp_table`, and the regulator core aggregates only consumers that have set a voltage. `cpu-supply`
on all four CPUs is harmless (it only creates device links), so it was left as is.

**Mechanism that fits all 30 samples [inferred, not confirmed: no dmesg was available to me].** `_set_opp()` raises the
voltage BEFORE the clock when scaling up and does not roll it back if the clock step then fails. So: 396/870 (a down step in
flight), then an up request to 1200: voltage -> 990, clock step fails, `current_opp` stays 396, every later request for 396
is "nothing to do" and the 990 mV stays. The clock step can fail for good in patch 0013: a transient APLL busy bit before a
retune went straight to `latch_fault` (permanent `rate_fault`, every later change `-EIO`), and any single failed transition
latched too, even when the rollback succeeded.
**Confirm on the box:** `dmesg | grep -E 'CPU APLL|Failed to set'` ("transition failed", "was busy before", "LATCHED").
If that is empty the mechanism above is wrong and the cause is elsewhere.

**Changes in k23b**
- Patch 0013: wait (up to 100 ms) for a busy APLL instead of latching; a failed transition whose rollback succeeded is retried
  (latch only if the rollback failed or 3 transitions failed in a row; the message says LATCHED or will retry).
- A stranded-HIGH voltage is the safe direction and is not rolled back in the OPP core (rolling back after a clock step of
  unknown outcome could undervolt a CPU running fast). It is repaired by the next successful transition.
- Default governor is now schedutil (`CPU_FREQ_DEFAULT_GOV_SCHEDUTIL=y`, asserted).
- GPU: the committed dts (200/300/400 MHz, 500 removed) is in this build.
- `dvfs-stage2-test.sh --only soak [--soak 60]`: schedutil under a pulsed 4-CPU load, a (kHz, PMC mV) sample every 0.25 s.
  PASS = no sample BELOW the OPP voltage of its frequency, >= 90 % equal, >= 3 distinct frequencies; it prints the histogram and
  the APLL/regulator kernel messages. The judge was run offline on synthetic data (catches a below-OPP and a stale-high sample).

Artifacts: `$HIMEDIA_ROOT/kernel-build-arm32-k23/k23b{,.zImage,.dtb,-modules.tar.gz}`,
`$HIMEDIA_ROOT/audio/q10_aiao-6.18.55-k23b.ko`, log (run log).
