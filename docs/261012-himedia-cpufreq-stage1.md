# Q10 Pro: CPU frequency scaling, stage 1 (frequency only) + SoC temperature

**Date:** 2026-10-12. **Kernel:** 6.18.55-k20, built in a COPY of the tree
(`$HIMEDIA_ROOT/kernel-build-arm32-cpufreq`, env `Q10_KBUILD_ROOT`), so the
other agent's uncommitted `histb-vdec-core.c` work in the main tree was never touched.
Nothing ran on the box. Research basis: `docs/261012-himedia-dvfs-research.md`.

## What was ported, and from where

| Patch | Content | Source |
| --- | --- | --- |
| `0013-clk-hisilicon-crg-hi3798cv200-cpu-apll-clock.patch` | `clk_cpu` (id `HISTB_CPU_CLK` = 97) in `crg-hi3798cv200.c` | community `histb-linux-6.12.y` commit `79347a39f`, `crg-hi3798cv200.c` `hi3798cv200_cpu_clk`; sequence cross-checked against the stock kernel `mpu_clk_set_rate` (research s2.2) |
| `0014-thermal-add-hi3798cv200-tsensor.patch` | new `drivers/thermal/hi3798cv200_thermal.c` + Kconfig `HI3798CV200_THERMAL` | register map and formula from the stock kernel `mpu_get_temperature` (research s6); NOT the community `hisi_thermal.c` branch |
| `hi3798cv200.dtsi` | CPU `clocks` + `operating-points-v2`, `cpu_opp` table, `tsensor` node, `thermal-zones` | research s3.2 / s6 |
| `build-kernel-arm32.ts` | patches wired, 10 new REQUIRED `=y`, default governor PERFORMANCE, emergency-poweroff delay | |

Id 97 not 88: the community id 88 sits inside our inner-clock window (64..89); 97 is the next free
public id after the VDP gates (96).

### Clock sequence (exactly the vendor/community one)
APLL regs 0x00/0x04 are only READ. A change: wait CRG `0x294` bit 13 (busy) clear (1 ms limit) ->
`0x1b4` = mode(bit2) only, enable(bit3) clear -> `0x1a4` fbdiv -> `0x1a8` frac 0 -> `0x1ac` step int 1
-> `0x1b0` step frac 0 -> `wmb()` -> `0x1b4` = mode|enable -> poll `0x294` until not busy and
`[11:0] == fbdiv` (100 ms limit). Every write is read back and compared (`-EIO` on mismatch). On
timeout/mismatch: cancel, retune to the old fbdiv, verify, latch `rate_fault` (no more changes until
reboot). All waits are `readl_poll_timeout` with an error return; there is no unbounded loop.

Deliberate differences from the community code:
- Exact rates (6 MHz x fbdiv): **396 / 600 / 798 / 1200 / 1596 MHz** (fbdiv 66/100/133/200/266).
  Community used 400/800/1600 with a 10 MHz tolerance. Here a rate is accepted only if fbdiv gives it
  EXACTLY, so a clk request can never silently land on a neighbouring rate.
- Nothing above 1596 MHz can be requested (not in the table).
- A change is refused (`-EOPNOTSUPP`) if the rate read at the start is not one of the five OPPs.
- Only when CRG `0x48[2:0] == 0` (APLL selected); otherwise `-EOPNOTSUPP`. Patch 0005 (SMP) restores
  the saved `0x48`, so this holds after secondary-core bring-up.
- Voltage: no `cpu-supply`, no regulator node; PMC `+0x18` and `+0x20` are never written. Every OPP
  carries `opp-microvolt = <1150000>` (the boot value `0x000100C9`) as documentation only; with no
  regulator the OPP core ignores it, so cpufreq-dt cannot request a voltage change.

### Exact OPP table (`cpu_opp`, `opp-shared`, all four CPUs share `clk_cpu`)

| OPP | fbdiv | CRG `0x294[11:0]` expected | microvolt (unused) | latency |
| ---: | ---: | ---: | ---: | --- |
| 396 MHz | 66 = 0x042 | 0x042 | 1150000 | 110 ms |
| 600 MHz | 100 = 0x064 | 0x064 | 1150000 | 110 ms |
| 798 MHz | 133 = 0x085 | 0x085 | 1150000 | 110 ms |
| 1200 MHz | 200 = 0x0C8 | 0x0C8 | 1150000 | 110 ms |
| 1596 MHz (boot) | 266 = 0x10A | 0x10A | 1150000 | 110 ms |

Note the voltage at the low OPPs is 1150 mV instead of the vendor's 840-990 mV: stage 1 saves only
the frequency-proportional share of the power (research s8, "f-only" column), none of the V^2 share.

### Thermal sensor
PMC `+0x28` control, `+0x30..0x3c` eight 10-bit samples. Per read: write control `0x72`, wait 16 ms,
read the 8 samples, write control 0 (the state found at boot: `PMC+0x28 = 0`, samples `~0x26f`).
`T = ((avg*165 - 20625)/2)/403 - 40` C (millidegrees, integer), plus the trim from
SYSCTRL `+0xf0` (`[21:18]` magnitude in C, bit 22 = subtract; the boot dump reads 0, so trim = 0 on this
unit). `avg == 0` or saturated returns `-EAGAIN`, never an invented temperature. The probe logs the
first reading (`dmesg | grep tsensor`).

**Why 0x72 and not the community 0x6005:** `0x72` is what the stock kernel on THIS box writes (read
from the stock image, `c07f01a4`); `0x6005` is a value in a community tree with no hardware proof for
this board, and its source driver also drops the trim. The meaning of the control bits is unknown, so
we copy the one value known to work on our silicon. Compare them empirically only if `0x72` misbehaves.
Sanity of the formula against the boot dump: avg 0x26f = 623 -> 61.9 C.

Zone `soc-thermal` (polling 1000 ms), one trip: **critical 110 C**, hysteresis 5 C, no cooling map.
Number from vendor data: the vendor DTB has passive/hot trips 95 / 105 C and critical **120 C**
(research s3.2). 110 C sits between the vendor's 105 C "hot" and 120 C critical: it starts an
orderly shutdown before the vendor's own limit while leaving headroom above the 105 C where the
vendor would already be throttling. That is a judgement, not a datasheet value; no silicon limit is
in our data. Kernel config adds `THERMAL_EMERGENCY_POWEROFF_DELAY_MS=10000` (the default 0 means a
hung userspace is never forced off). The box's poweroff/reboot path is weak (mainline `reboot`
hangs, see CLAUDE.md), so on a trip the likely end state is "CPUs idle in a halt", which is still
cooler; it is not a clean power-off.

### Config (all asserted `=y` by the build)
`CPU_FREQ`, `CPUFREQ_DT`, `CPU_FREQ_GOV_PERFORMANCE|USERSPACE|ONDEMAND|SCHEDUTIL`,
`CPU_FREQ_DEFAULT_GOV_PERFORMANCE` (ondemand default turned off and asserted), `THERMAL`,
`THERMAL_OF`, `HI3798CV200_THERMAL`. USERSPACE went from `=m` to `=y` (no modules in the
initramfs). `CPU_FREQ_THERMAL`, `THERMAL_HWMON` were already on.

## Build result
`Q10_KBUILD_ROOT=$HIMEDIA_ROOT/kernel-build-arm32-cpufreq bun scripts/himedia/build-kernel-arm32.ts --out k20 --localversion k20 --ramlog`
exit 0, release `6.18.55-k20`. Artifacts in that directory: `k20` (uImage), `k20.zImage`, `k20.dtb`,
`k20-modules.tar.gz`; audio module `$HIMEDIA_ROOT/audio/q10_aiao-6.18.55-k20.ko`
(`Q10_KBUILD_ROOT=... scripts/himedia/audio/build.sh`). Log: (run log).
Static DTB checks are recorded at the end of this file.

## Test plan (you run it; k19 stays the default)

0. Boot k20 with the usual `kexec-try`, `q10-wd-run` guard around every step. Expect no change in
   behaviour: governor `performance`, 1596 MHz.
1. `dmesg | grep -iE 'tsensor|cpufreq|clk_cpu|APLL'` : tsensor line with a temperature (plausible
   40-80 C), no "transition failed".
2. `cat /sys/devices/system/cpu/cpufreq/policy0/{scaling_driver,scaling_governor,scaling_available_frequencies,cpuinfo_cur_freq}`
   -> `cpufreq-dt`, `performance`, `396000 600000 798000 1200000 1596000`, `1596000`.
3. `cat /sys/class/thermal/thermal_zone0/{type,temp}`; also `hwmon*/temp1_input`. Load with a CPU burn
   and watch it rise.
4. Baseline APLL read-back at 1596: `devmem 0xf8a22004` = `0x0800210A`, `0xf8a22294` low 12 bits
   either 0 (never tuned) or 0x10A. PMC `0xf8a23018` must read `0x000100C9`, `0xf8a23020`
   `0x006D00C9`, and must stay so after every step below.
5. Steps (one at a time, a fresh `q10-wd-run` each):
   `echo userspace > policy0/scaling_governor`, then `echo 1200000 > policy0/scaling_setspeed`,
   then 798000, then 396000, then back to 1596000.
   After EACH step read: `cpuinfo_cur_freq`; `devmem 0xf8a22294` (low 12 bits must equal the table
   fbdiv: 0x0C8 / 0x085 / 0x042 / 0x10A); `devmem 0xf8a221a4` (same value); `devmem 0xf8a22004`
   (must be unchanged `0x0800210A` since APLL cfg is never written); PMC `0x18`/`0x20` unchanged.
   Time a fixed workload (`time sh -c 'i=0; while [ $i -lt 2000000 ]; do i=$((i+1)); done'`, or the
   stress used so far) at each rate and record fps/time: it should scale about linearly with rate.
6. Temperature after 60 s at each rate under the same load: expected to fall as the rate falls.
7. Try an out-of-table request (`echo 1000000 > scaling_setspeed`): it is rounded to an OPP by the
   cpufreq core, never to an unlisted rate.
8. Optional: `ondemand`, then `schedutil`, under `q10-wd-run`; they start from `performance` only
   when you choose them.

Pass: every step reads back the expected fbdiv, no hang, no `rate_fault` message, PMC voltage regs
unchanged, temperature plausible and monotonic with rate.

## Fallback
k19 stays the default boot image; nothing is written to flash. If k20 hangs, the watchdog guard resets
the box into the base kernel. If only a step misbehaves: `echo performance > scaling_governor` (1596),
or remove the `clocks`/`operating-points-v2` lines from the dtsi to get a cpufreq-less k20.

## Risks
- Untested on hardware by anyone (community code has no proof). The tune block has been exercised
  only by reading; the first write is yours.
- Switching APLL fbdiv while CPUs run, via the step engine, is what the vendor does (with two 10 ms
  sleeps around it); latency here is unmeasured. Watch for a hang at the FIRST step down.
- Mid-transition failure leaves the PLL after a rollback attempt; if the rollback also fails the box
  may be at an unknown rate, hence the watchdog guard.
- Sensor control semantics (0x72 bits) unknown; temperature values are unproven until step 3 shows
  them moving with load.
- SMP: patch 0005 rewrites `0x48` during secondary bring-up; cpufreq-dt probes later, but a CPU
  hot-plug after boot would re-run it. Do not hot-plug during a rate test.
- 110 C critical may power the box off in a hot enclosure at 1596 MHz stress; that would be the
  safety working.

## Static checks done (no hardware)
- Build exit 0 twice (second run after removing an unused-variable warning in the tsensor driver);
  no warnings from the two new files; all 242 `ok` option lines, no `MISS`; the required list
  includes the 10 new `=y` options and the "ondemand is not the default governor" and
  "emergency poweroff delay = 10000" asserts. uImage arch=2, DTB appended at the tail, totalsize ok.
- `dtc -I dtb -O dts k20.dtb`: four `cpu@N` carry `clocks` + `operating-points-v2`; `opp-table-cpu`
  has five `opp-hz` (0x179a7b00 = 396000000, 600000000, 798000000, 1200000000, 0x5f210700 =
  1596000000), `temperature-sensor@8a23028` (reg 0x8a23028 len 0x18, `hisilicon,sysctrl` phandle),
  zone `soc-thermal` with `soc-crit` (110000, critical).
- Patch 0013/0014 apply from a pristine tree through the build (files are restored from the tarball
  before every build, so these are the real patches, not edits left in the tree).
- Not done: boot, any runtime check, QEMU (no matching machine for this SoC).
