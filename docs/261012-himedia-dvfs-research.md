# Q10 Pro: CPU DVFS and GPU devfreq, offline research

**Date:** 2026-10-12. **Status:** research only. Nothing ran on the box, nothing was written to it.
Hi3798CV200, 4x Cortex-A53 (AArch32), mainline 6.18.55 (`scripts/himedia/kernel/arm32/`).

Evidence tags: **[read]** = read in a file or disassembly, address given. **[inferred]** = reasoned,
not observed. **[community]** = taken from the `histb-linux-6.12.y` tree (author `hiper25`, commit
`79347a39f`, 2026-10-02; no hardware proof, so every number from it is cross-checked below).
VA = kernel virtual address of the stock 3.18 vendor kernel; file offset = VA - `0xc0008000`.
Disassembly tool: `scripts/himedia/disasm-stock-capstone.py` (new, capstone, no docker). Symbols:
`stock-kallsyms.py`.

## 1. Verdict

1. **CPU DVFS is feasible and the whole mechanism is now known.** Clock = APLL fbdiv "tune" registers
   in the CRG. Voltage = one 32-bit PWM register in the PMC block at `0xf8a23018`. Both are plain MMIO,
   no I2C PMIC. Every number in the vendor table was read from the stock kernel image.
2. **Mainline needs three small pieces, all of which already exist in the community tree:** a settable
   CPU clock in `crg-hi3798cv200.c`, a 178-line PWM regulator driver, and a ~25-line tsensor addition
   to `hisi_thermal.c`. Then `cpufreq-dt` + an OPP table in DT. Mainline `pwm-hibvt` is **not** the
   right block (the voltage PWM is two registers in the PMC, not the PWM controller).
3. **GPU devfreq is feasible for frequency. Voltage is a trap.** The "vdd-gpu" PWM (`0xf8a23020`) is
   the SoC **core** rail (the vendor names its code `core_volt_scale`), not a GPU-only rail. Lowering
   it to suit a slow GPU may under-volt VDEC/VDP/VPSS. Do frequency-only first.
4. **Thermal sensor exists**: PMC `0xf8a23028` (control) and `0xf8a23030..3c` (8 samples). A hwmon
   reading comes free from the thermal core once a driver registers the zone.
5. **First safe step (no kernel build, no risk of damage): read-only register dump** of CRG
   (`0x48 0x00 0x04 0x1a4..0x1b4 0x294 0x124 0x154`), PMC (`0x18 0x20 0x28 0x30..0x3c 0x58..0x88 0x368`)
   and SYSCTRL (`0xc4 0xf0`) under mainline, and better, the same dump under **stock Android at several
   cpufreq settings**. That tells us the boot voltage, which decides everything else. Section 7.

**Biggest unknown:** the boot voltage of the CPU and core rails (PMC `0x18`, `0x20`). U-Boot sets it,
we have never read it. Until we do, only "lower the frequency at the voltage we booted with" is safe.

## 2. How the vendor kernel does CPU DVFS (answers Q1)

### 2.1 Where it lives [read]

The stock kernel has **no device-tree OPP for the CPU**: the vendor DTB CPU nodes carry no
`operating-points`, no `clocks`, no `cpu-supply`
(`$HIMEDIA_ROOT/extracted/Q10_PRO_v2.1.4_Android_7_31-05-2019_AndroidPC/_dtb/boot.img+0x8b5220.dts` lines 38-70).
The logic is an SDK driver, `hi_pm` (`PMOC_DRV_ModInit`, VA `c07f1880`), a cpufreq driver
`hi_cpufreq_*` (`c07f5068..c07f585c`) and helpers `mpu_*` / `core_*` / `opp_*` (`c07f3350..c07f4f40`).
Source path string in the image: `.../sdk/source/kernel/linux-3.18.y/drivers/cpufreq/...`.

| Piece | VA (file off.) | Role |
| --- | --- | --- |
| `mpu_clk_set_rate` | `c07f3380` (0x7eb380) | set CPU rate by APLL fbdiv |
| `mpu_init_clocks` | `c07f36d0` | read boot state from CRG `0x48`, seed the rate |
| `cpu_volt_scale(mV)` | `c07f4364` (0x7ec364) | write the CPU voltage PWM |
| `core_volt_scale(mV)` | `c07f4780` | write the CORE voltage PWM |
| `cpu_avs_thread` | `c07f4518` | software HPM voltage loop, +-10 mV |
| `hi_device_scale` | `c07f4934` | the ordering: volt, 10 ms, clock (up) or clock, 10 ms, volt (down) |
| `hi_cpufreq_target` | `c07f52b0` | cpufreq `->target`, calls `hi_device_scale` |
| `mpu_get_temperature` | `c07f017c` | tsensor read |
| `hi_init_opp_table` | `c11ef798` | registers the OPP list |
| PMC `ioremap` | `c07f1a3c..c07f1a58` | `mov r0,#0x3000; movt r0,#0xf8a2; r1=0x1000` -> **PMC = `0xf8a23000`, size 0x1000** |

### 2.2 The clock: APLL fbdiv tune, not a mux [read]

`mpu_clk_set_rate` (`c07f3380`) never writes the APLL registers `0x00/0x04`. It only **reads** them
(`c07f3410..c07f3428`) for the divider fields, then writes the new feedback divider into a separate
"tune" block:

| CRG reg | Field | Evidence |
| --- | --- | --- |
| `0x00` | `[26:24]` postdiv1, `[30:28]` postdiv2 | `ubfx r0,r2,#0x18,#3`; `lsr r2,r2,#0x1c` (`c07f3420`, `3428`) |
| `0x04` | `[11:0]` fbdiv, `[17:12]` refdiv | `ubfx r1,r1,#0xc,#6` (`c07f3424`); `ubfx r3,r3,#0,#0xc` (`c07f3808`) |
| `0x1a4` | `[11:0]` new fbdiv | `bfi r2,r0,#0,#0xc` then `str [r3,#0x1a4]` (`c07f345c..3460`) |
| `0x1a8` | `[23:0]` frac, cleared | `bfc r2,#0,#0x18` (`c07f3468`) |
| `0x1ac` | `[11:0]` step int = 1 | `bfi r2,r1(=1),#0,#0xc` (`c07f3474`) |
| `0x1b0` | `[23:0]` step frac, cleared | `c07f3480` |
| `0x1b4` | bit 2 set, bit 3 cleared then set (start pulse) | `c07f348c..34a8` |
| `0x294` | bit 13 = busy, `[11:0]` = live fbdiv | `tst r3,#0x2000` poll (`c07f34b0`, loop with a delay call `34bc..34d8`), `ubfx r0,r0,#0,#0xc` (`c07f37f0`) |

**The APLL layout you assumed is correct** [read]: rate = 24 MHz x fbdiv / (refdiv x postdiv1 x postdiv2).
Check on the live value: `0x12000000` -> postdiv1 2, postdiv2 1; `0x0800210A` -> fbdiv 0x10A = 266,
refdiv 2; 24 x 266 / 4 = **1596 MHz**. (Bit 27 of `0x04` is set; its meaning is unknown.) The other
pair `0x08/0x0c = 0x12000000 / 0x0200307D` decodes to fbdiv 125, refdiv 3, postdiv 2x1 = **500 MHz**
[inferred decode; consumer unknown].

fbdiv for a rate is `floor(rate_kHz * postdiv1*postdiv2*refdiv / 24000)` (the reciprocal constant
`0x057619F1` = 91,625,969 = 2^41/24000, `c07f343c..3448`; I recomputed it). So the vendor's "400/800/1600"
are really **396 / 798 / 1596 MHz** (fbdiv 66 / 133 / 266). The boot value `266` is the top
vendor OPP, so **the box boots at the top OPP** [read + inferred].

The rate read-back tolerance is 9999 kHz (`movw lr,#0x270f`, `c07f3818`), the same as the community
driver's 10 MHz. Cross-check: the community `hi3798cv200_cpu_apll_tune()` writes exactly the registers
above, in the same order. **Two independent readings agree.**

**Fixed-rate source mux, CRG `0x48` [2:0]** (`mpu_init_clocks`, jump table at `c07f3724`, [read]):
`0`=APLL (programmable), `1`=200, `2`=800, `3`=1350, `4`=24, `5`=1200, `6`=400, `7`=600 MHz. The vendor
leaves it at 0 and uses APLL tuning for every change; `mpu_clk_init` (`c07f3350`) only sets bit 9 of
`0x48` once. Our own SMP patch 0005 already uses the mux (`0x206` then `0x606`: select 400 MHz, bit 10 =
switch strobe) on every secondary-core bring-up and restores the saved value
(`docs/261011-himedia-ports-wifi-smp-research.md` s4.2), so the mux path is exercised on this
board at 400 MHz already.

### 2.3 The voltage: one PWM register in the PMC [read]

`cpu_volt_scale` (`c07f4364`): rejects mV <= 649 ("Do not change volt"), clamps mV > 1150 to 1150, then

    duty  = 1 + ((1150 - mV) * 2) / 5          (0xcccccccd reciprocal, c07f43c0..43dc)
    reg   = (duty << 16) | 0xC9                (period = 201)
    PMC+0x18 = reg                             (c07f43e8, c07f4400)

so `V = 1150 mV - 2.5 mV x (duty - 1)`, range **650-1150 mV in 2.5 mV steps, period 201**. The read-back
(`mpu_get_volt`, `c07f46d4`): `reg>>16 == 0 -> 1150`, else `1150 - (5*duty - 5)/2`. The **core** rail is
the same code at `PMC+0x20` (`core_volt_scale`, `c07f4780`, store at `c07f481c`). The GPU regulator
(`hi3798cv2x_gpu_regulator_set_voltage`, `c0648d04`) writes `0xf8a23020` using the same formula with
min/max taken from the DT (650000 / 1150000 uV, dts line 626-627), and the same period 201.

**No I2C PMIC, no PWM-controller block.** All three go straight to `PMC+0x18/0x20` [read]. PMC base
confirmed three ways: the `ioremap` above; the GPU DT node `reg = <0xf8a23020 4>`; the community DT
`vdd_cpu@0x8a23018`.

Ordering and settling [read, `hi_device_scale` `c07f4934`]:
- **Up:** `cpu_volt_scale` (`c07f4a14`), unlock, `msleep(10)` (`c07f4a20`), then `hi_clk_set_rate`.
- **Down:** clock first (`c07f4a8c..4a98`), `msleep(10)`, then voltage (`c07f4ac0`).
- Hardware AVS is switched off around the change (`CPU_AVS_Enable(0)`: clears bit 0 of `PMC+0x368`,
  `c07f44a4..44e8`).
- **Cold compensation:** if temperature <= 30 C and the target rate <= 600 MHz (`0x927c0`), the vendor
  adds **+50 mV** (`c07f49b8..4a84`, `addls sb,r8,#0x32`). The HPM target gets +25 at <= 30 C and
  <= 800 MHz (`c07f3510..351c`). Mainline would need this too if the box is ever cold.

### 2.4 The vendor tables [read]

CPU table, VA `0xc12e4b5c` (file `0x12dcb5c`), 16 bytes per row = `{kHz, hpm_target, v_a, v_b}`:

| Rate (kHz) | hpm target | v_a (mV) | v_b (mV) | actual with fbdiv |
| --- | ---: | ---: | ---: | --- |
| 400000 | 201 | 840 | 840 | 396 MHz |
| 600000 | 201 | 840 | 840 | 600 |
| 800000 | 256 | 840 | 870 | 798 |
| 1200000 | 298 | 880 | 990 | 1200 |
| 1500000 | 331 | 970 | 1100 | 1500 |
| 1600000 | 362 | 1020 | 1150 | 1596 |

`v_a` < `v_b`: the AVS thread (`cpu_avs_thread`, `c07f4518`) moves the voltage in **10 mV steps**
(`add r0,r0,#0xa` / `sub r0,r0,#0xa`, `c07f4664`, `4670`) between two limits, so `v_a` is the floor
and `v_b` the ceiling [inferred from the loop; the stores of the two limits are indirect and I did not
trace them]. **The OPP the kernel actually registers uses `v_b`**: `hi_init_opp_table` reads the array
at VA `0xc1217190` (file `0x120f190`), 12-byte entries `{kHz, mV, enabled}`:

    400000 840 1 | 600000 840 1 | 800000 870 1 | 1200000 990 1 | 1600000 1150 1

**1500 MHz is in the clock table but not in the OPP list.** These five rows are the safe static table.

HPM targets by chip class (table at VA `0xc12e4bcc`, 20-byte rows `{kHz, class0..3}`; class =
`[SYSCTRL+0xc4] >> 24`, 0 if >= 4, `c07f3520..352c`; the SYSCTRL base is [inferred] from the helper
names `HI_DRV_SYS_*`):

| kHz | class 0 | 1 | 2 | 3 |
| --- | ---: | ---: | ---: | ---: |
| 400000, 600000 | 201 | 201 | 201 | 201 |
| 800000 | 256 | 256 | 229 | 232 |
| 1000000 | 272 | 272 | 272 | 272 |
| 1200000 | 298 | 298 | 290 | 284 |
| 1500000 | 331 | 331 | 331 | 331 |
| 1600000 | 362 | 362 | 357 | 346 |

(The community IP1004 board table, `0xe5`=229 at 800 MHz and `0x110`=272 at 1.2 GHz, are other-chip-class
values from this same table; **do not copy them to the Q10 Pro**.)

### 2.5 PWM register -> mV for our table

`reg = (duty<<16) | 0xC9`, `duty = 1 + (1150-mV)*2/5` (computed, formula from 2.3):

| mV | duty | PMC reg |
| ---: | ---: | --- |
| 840 | 125 | `0x007D00C9` |
| 870 | 113 | `0x007100C9` |
| 880 | 109 | `0x006D00C9` |
| 920 | 93 | `0x005D00C9` |
| 980 | 69 | `0x004500C9` |
| 990 | 65 | `0x004100C9` |
| 1100 | 21 | `0x001500C9` |
| 1150 | 1 | `0x000100C9` |

### 2.6 HPM / AVS in one paragraph

HPM = on-die ring-oscillator speed monitor. CPU: `PMC+0x78` `[5:0]` divider, bit 24 enable, bit 26
monitor; `PMC+0x84` `[31:24]`=1 period and `[21:12]` target; results in `PMC+0x7c` and `+0x80`, four
10-bit codes each (`[9:0]`, `[21:12]`), summed twice and `>>3` (`c07f4570..45ac`). The hardware AVS
enable is bit 0 of `PMC+0x368` (`c07f44dc..44e8`). Community `hi3798cv200-avs.c` agrees register for
register [community]. AVS is an optimisation (it trims voltage to the silicon); the static `v_b` column
is the vendor's fallback.

## 3. What mainline needs (answers Q2)

Answer to the three sub-questions:

- **Does mainline `crg-hi3798cv200.c` expose a settable CPU clock?** No. The copy in
  `kernel-refs/crg-hi3798cv200.c` has gates only (`0x48` bits 4/6/10 are unrelated gates). The
  community tree has `HISTB_CPU_CLK` (88) with `set_rate` [community, `crg-hi3798cv200.c:606-984`].
- **Is the PWM block supported by `pwm-hibvt`?** Irrelevant: the voltage "PWM" is two PMC registers.
  `pwm-hibvt` drives the separate PWM controller. A tiny `regulator_ops` driver is the right shape.
- **Need `cpufreq-dt`?** Yes. Our `.config` already has `CPUFREQ_DT=y`, `CPUFREQ_DT_PLATDEV=y`, `PM_OPP=y`,
  `PM_DEVFREQ=y`, `THERMAL_HWMON=y`, `CPU_FREQ_THERMAL=y`, `DEVFREQ_THERMAL=y`, `DEVMEM=y`
  (`kernel-build-arm32/linux-6.18.55/.config`) [read]. No new Kconfig except the two new drivers.

### 3.1 Patch plan (numbers continue our arm32 series, which ends at 0012)

| # | Patch | Source | Notes |
| --- | --- | --- | --- |
| 0013 | `clk: hisilicon: crg-hi3798cv200: add the CPU (APLL) clock`, `HISTB_CPU_CLK = 62` | port community lines 606-984 | id 62 is free: ours end at 61 (GPU), `CRG_NR_CLKS` is 128. Keep the community guards (only when `0x48[2:0]==0`; read back and verify; roll back to the old fbdiv; latch a fault). Add: reject any rate above 1600 MHz; refuse to run if the boot fbdiv is not one of the OPP fbdivs. |
| 0014 | `regulator: add hi3798cv200 PMC PWM regulators` (`vdd-cpu` `0xf8a23018`, `vdd-gpu`/core `0xf8a23020`) | port community `hi3798cv200-pwm-regulator.c` | period must read back 201 or return `-EIO` (the driver already does). 10 ms settle for CPU, 1 ms for GPU/core. |
| 0015 | `thermal: hisi_thermal: add Hi3798CV200 tsensor` | port community lines 42-47, 318-341, 427-430, 472-485, 633-651 | **change the start value**, see section 6. Registers in the HW block must be tsensor `reg = <0x8a23028 0x18>`. |
| 0016 | DT: OPP table + `cpu-supply` + `clocks` + thermal zone | below | |
| 0017 (optional, later) | `cpufreq: hi3798cv200 HPM/AVS` | community `hi3798cv200-avs.c` | not needed for static DVFS. |

All of these are untested on real hardware by their authors; I read the community code and cross-checked
the register-level behaviour against the vendor image (sections 2.2, 2.3, 6).

### 3.2 DT snippets

Stage 1 (frequency only, **no regulator**, safe by construction, see section 7). Boot rate is 1596
MHz; the table's top row uses that actual rate:

```dts
&{/cpus} {
	cpu_opp: opp-table-cpu {
		compatible = "operating-points-v2";
		opp-shared;
		opp-396000000  { opp-hz = /bits/ 64 <396000000>;  clock-latency-ns = <110000000>; };
		opp-600000000  { opp-hz = /bits/ 64 <600000000>;  clock-latency-ns = <110000000>; };
		opp-798000000  { opp-hz = /bits/ 64 <798000000>;  clock-latency-ns = <110000000>; };
		opp-1200000000 { opp-hz = /bits/ 64 <1200000000>; clock-latency-ns = <110000000>; };
		opp-1596000000 { opp-hz = /bits/ 64 <1596000000>; clock-latency-ns = <110000000>; };
	};
};
&{/cpus/cpu@0} { clocks = <&crg HISTB_CPU_CLK>; operating-points-v2 = <&cpu_opp>; #cooling-cells = <2>; };
&{/cpus/cpu@1} { clocks = <&crg HISTB_CPU_CLK>; operating-points-v2 = <&cpu_opp>; };
&{/cpus/cpu@2} { clocks = <&crg HISTB_CPU_CLK>; operating-points-v2 = <&cpu_opp>; };
&{/cpus/cpu@3} { clocks = <&crg HISTB_CPU_CLK>; operating-points-v2 = <&cpu_opp>; };
```

The 110 ms latency is the community figure [community]; the vendor policy latency is 300 us
(`movw r3,#0x93e0; movt r3,#4` = 300000 ns, `c07f55c4..55d4`) but its real path includes two 10 ms
sleeps. Use 110 ms with `ondemand`/`schedutil` so the governor does not thrash.
**Open:** the PLL ramp time (step int = 1) has not been measured; time it.

Stage 2 (voltage), after the boot voltage is known. Per-OPP `opp-microvolt` from the vendor OPP list:

```dts
	vdd_cpu: regulator@8a23018 {                 /* soc-relative, phys 0xf8a23018 */
		compatible = "hisilicon,hi3798cv200-cpu-regulator";
		reg = <0x8a23018 0x4>;
		regulator-name = "vdd-cpu";
		regulator-min-microvolt = <840000>;
		regulator-max-microvolt = <1150000>;
		regulator-always-on; regulator-boot-on;
	};
	/* opp-798000000 { opp-hz = ...; opp-microvolt = <870000>; } etc. */
	/* 396 -> 840000, 600 -> 840000, 798 -> 870000, 1200 -> 990000, 1596 -> 1150000 */
```

Stage 2a variant, even safer: set `regulator-min-microvolt = regulator-max-microvolt = <boot V>` and
give every OPP `opp-microvolt = <boot V>`. The regulator then rewrites the value it already has. This
proves the regulator driver and the settle path before any voltage actually changes.

Thermal zone [vendor trips, read from the DTB: 0x17318 = 95000, 0x19a28 = 105000, 0x1d4c0 = 120000,
hysteresis 0x1388 = 5000, polling 1000 / 100 ms]:

```dts
thermal-zones {
	soc-thermal {
		polling-delay = <1000>; polling-delay-passive = <100>;
		thermal-sensors = <&tsensor 0>;
		trips {
			soc_passive: passive { temperature = <95000>;  hysteresis = <5000>;  type = "passive"; };
			soc_hot:     hot     { temperature = <105000>; hysteresis = <5000>;  type = "passive"; };
			soc_crit:    crit    { temperature = <120000>; hysteresis = <5000>;  type = "critical"; };
		};
		cooling-maps {
			map-cpu { trip = <&soc_passive>; cooling-device = <&cpu0 THERMAL_NO_LIMIT THERMAL_NO_LIMIT>; };
			map-gpu { trip = <&soc_hot>;     cooling-device = <&gpu  THERMAL_NO_LIMIT THERMAL_NO_LIMIT>; };
		};
	};
};
tsensor: temperature-sensor@8a23028 { compatible = "hisilicon,hi3798cv200-tsensor";
	reg = <0x8a23028 0x18>; #thermal-sensor-cells = <1>; };
```

Interactions with existing patches [read]: patch 0005 rewrites CRG `0x48` (mux 400 MHz, then restores)
on every secondary-core start. It restores the saved value, so it is harmless with the APLL path
(selector 0). Keep the CPU clock driver from running during SMP bring-up (cpufreq-dt probes after
`smp_init`, so it is already ordered that way).

## 4. GPU (answers Q3)

### 4.1 Clock [read, matches our patch 0010]

`hiclk_set_rate_gpu` (`c0630d34`): the rate table at VA `0xc0d07b90` (file `0xcffb90`) is
`{200 MHz:7, 300:4, 400:1, 500:6, 600:3, 675:5}`. Sequence: read `CRG+0x124`; clear `[2:0]` and bit 10;
OR the selector; write with bit 9; then OR `0x600`; poll `CRG+0x154[7:5]` (`ubfx r3,r3,#5,#3`) for the
selector (`c0630e04..0e3c`). Gate/reset: `CRG+0xd4` bit 0 gate, bit 4 reset (`c0630d04..0d2c`,
`c0630e98..0eb0`). This is the same as our `0010-clk-hisilicon-crg-hi3798cv200-gpu-clock.patch` and the
community driver, so **the clock side of GPU devfreq already works in our tree**.

### 4.2 Vendor GPU table [read]

Vendor DTB `gpu@0xf9200000` (`boot.img+0x8b5220.dts:643`): `operating-points` in (kHz, uV):

    200000 880000 | 300000 880000 | 400000 880000 | 500000 880000 | 600000 920000 | 675000 980000

(decoded from `0x30d40 0xd6d80 0x493e0 0xd6d80 0x61a80 0xd6d80 0x7a120 0xd6d80 0x927c0 0xe09c0 0xa4cb8 0xef420`.)
Supply `mali-supply = <&vdd-gpu>`, the regulator at `0xf8a23020`, range 650000..1150000 uV. The vendor
Mali driver also has GPU AVS (`kbase_avs_*`, `c09f2970..c09f2b04`: ioremaps PMC `0xf8a23000` size 0x200,
uses `PMC+0x68` and `PMC+0x74`) [read].

### 4.3 Voltage domain: the GPU shares the CORE rail [inferred, strong]

`PMC+0x20` is called `core_volt_scale`/`core_init_volt`/`core_get_volt` in the PM driver, with debug
text `"CORE: Level1 volt = %d(mv), Level2 ..., Level3 ..."` and `COREProcWrite`. The only DT node for
`0xf8a23020` is the "vdd-gpu" regulator. So the one register holds the rail that feeds the GPU **and
whatever else is on the core rail** (video decode, VPSS, VDP...). It is separate from the CPU rail
(`PMC+0x18`). **Do not lower this register to save GPU power**: the VDEC/VDP work we proved
(`docs/261011-himedia-*-port-report.md`) runs on whatever U-Boot set. Raising it for GPU 675 MHz
(980 mV) is within the vendor range, but is only needed if the boot value is below 980 mV.

### 4.4 Mainline plan for GPU

panfrost (6.18.55) does devfreq when the DT has an OPP table:
`panfrost_devfreq_init` -> `devm_pm_opp_set_regulators("mali")` (missing regulator is tolerated,
`-ENODEV` swallowed) -> `devm_pm_opp_of_add_table` (`gpu-port/linux-6.18.55/drivers/gpu/drm/panfrost/panfrost_devfreq.c:150-170`)
[read]. It uses `simple_ondemand` and registers a devfreq cooling device (`DEVFREQ_THERMAL=y`).

Stage G1, frequency only:

```dts
gpu_opp: opp-table-gpu {
	compatible = "operating-points-v2";
	opp-200000000 { opp-hz = /bits/ 64 <200000000>; };
	opp-300000000 { opp-hz = /bits/ 64 <300000000>; };
	opp-400000000 { opp-hz = /bits/ 64 <400000000>; };
	opp-500000000 { opp-hz = /bits/ 64 <500000000>; };
	opp-600000000 { opp-hz = /bits/ 64 <600000000>; };
	opp-675000000 { opp-hz = /bits/ 64 <675000000>; };
};
&gpu { operating-points-v2 = <&gpu_opp>; };
```

**Open and untested:** our DT has a `regulator-fixed` placeholder for `mali-supply` with no voltage
(`docs/261011-himedia-gpu-port-report.md` s3). An OPP without `opp-microvolt` plus a regulator that
has no voltage may make the OPP core call `regulator_set_voltage` with 0 and fail [inferred; I did not
trace `_set_opp_voltage`]. Resolve this on the build machine by compiling with `dev_pm_opp` debug
before the box sees it. Fallback: drop `mali-supply` from the GPU node if panfrost tolerates a
dummy regulator, or give the placeholder `regulator-min/max-microvolt` equal to the boot core voltage
once that is read.

The cap: **the top OPP is only safe if the core rail is at or above 980 mV at boot** (vendor table).
Before reading the register, run G1 with a table capped at 500 MHz (880 mV in the vendor table).

Stage G2: add the core PWM regulator with `regulator-min = regulator-max = boot V` and
`opp-microvolt = <boot V>`; only after the CPU stages are proven.

## 5. Why the CPU and GPU voltages are independent

CPU rail: `PMC+0x18`; core rail (GPU + media): `PMC+0x20`. Two registers, two code paths, two rails
(`cpu_volt_scale` / `core_volt_scale`). A CPU DVFS patch must not touch `0x20`. The community DT agrees
(`vdd_cpu@8a23018`, `vdd_gpu@8a23020`).

## 6. Thermal sensor (answers Q4)

Yes, on-chip, inside the PMC block [read, `mpu_get_temperature` `c07f017c`]:

1. `PMC+0x28 = 0x72` (`mov r2,#0x72; str r2,[r3,#0x28]`, `c07f01a4..01b4`), start sampling.
2. Read `PMC+0x30, 0x34, 0x38, 0x3c`; each holds two 10-bit samples (`[9:0]`, `[25:16]`); 8 samples
   (`c07f01b8..01d4`); `avg = sum >> 3`.
3. `T(C) = (((avg*165 - 20625) / 2) / 403) - 40`, i.e. `(avg-125)*165/806 - 40`
   (constants `0xa5`=165, `0x5091`=20625, `0xa29ecf17` reciprocal ~403, `-0x28`; `c07f01d8..0204`).
4. Calibration trim from SYSCTRL (base [inferred]): `[SYSCTRL+0xf0]`, 4-bit magnitude in `[21:18]`,
   sign in bit 22 (0 = add, 1 = subtract) (`c07f020c..0228`). **The community driver omits this
   trim.** Add it (or log the raw register) so a hwmon reading is not off by up to 15 C.

The community driver writes `0x6005` to the control register and waits 16 ms [community]; the vendor
image on **our** box writes `0x72` and reads at once. Use the vendor value for our silicon and compare
the two empirically (read-only, section 7 step 1) before trusting either. Unknown: what the control
bits mean.

Vendor policy [read, DTB]: passive trips 95 C and 105 C, critical 120 C, 5 C hysteresis. The PM driver
also has its own `temperature_control_thread` (`c07f1328`) with the message `"Tsensor is extremly high,
suspend system!!"` (`c07f1570`); thresholds not traced.

Readout: once the zone exists, `CONFIG_THERMAL_HWMON=y` (already set) gives
`/sys/class/hwmon/hwmonN/temp1_input` and `/sys/class/thermal/thermal_zoneN/temp` with no extra code
[inferred from the thermal core, not observed].

## 7. Safety and staged test plan (answers Q5)

### 7.1 What is safe and why

| Action | Risk | Why |
| --- | --- | --- |
| Reading PMC/CRG/SYSCTRL | none | read-only. (A read of a write-sensitive register could in theory have side effects; none of the registers above is a clear-on-read.) [inferred] |
| Lowering frequency at constant voltage | very low | CMOS at lower f and same V has more timing margin. The only real risk is the transition mechanism (PLL tune or mux hang). Vendor does exactly this. |
| Raising voltage (never above 1150 mV) | low | 1150 mV is the vendor's own maximum and the regulator's own range. Cost: heat. |
| Lowering voltage | **the dangerous direction** | below the silicon's need the CPU corrupts silently and hangs. Needs the HPM feedback or a known-good table. |
| Raising frequency above the boot rate | **do not** | the boot rate (1596 MHz) is already the vendor's top OPP. |
| Writing `PMC+0x20` (core rail) | **risk to video/GPU** | shared domain, section 4.3 |

### 7.2 The SP805 guard

SP805 at `0xf8a2c000`, lock `0xf8a2cc00` (magic `0x1acce551`), 24 MHz clock, independent of the APLL.
The repo already drives it (`scripts/himedia/rootfs-units/q10-reset-on-reboot.sh`): load, control `3`
(reset + interrupt enable), then lock. Behaviour: the **second** expiry resets, so reset time is about
2 x load. Rules:

1. Disarm nothing: `q10-watchdog-off.service` disarms at boot; every test script arms its own guard.
2. Guard length: `load = 10 s x 24 MHz = 240000000` -> reset <= ~20 s after the last pet. Each test
   step is a **separate invocation**: arm, one register change, a short verification, pet, then either
   restore or proceed.
3. A script, not hand typing, so a typo cannot skip the guard. (Proposed:
   `scripts/himedia/dvfs-probe.sh`, busybox `devmem` is present on the rootfs.) The script must restore
   the saved CRG `0x48` / PMC values on any non-zero exit.
4. Before every step, `kexec-try.sh` style: the box must already be in a known state where a hard reset
   brings it back to Android/our rootfs ((an unpublished note) reboot rule).

### 7.3 Stages (stop at the first surprise; each stage is its own doc entry)

| Stage | Action | Pass criterion |
| --- | --- | --- |
| **A0** (Android, read-only) | With stock Android, set the userspace governor (`CONFIG_CPU_FREQ_DEFAULT_GOV_USERSPACE=y` in the vendor defconfig) to each of 400/600/800/1200/1600 and dump PMC `0x18`, `0x20`, `0x7c`, `0x80`, `0x28..0x3c`, CRG `0x294`, `0x154`. | The PMC `0x18` readout matches table 2.5 for each rate. This is the only measurement of the board's *real* V/F pairs. |
| **A1** (mainline, read-only) | Dump CRG `0x00 0x04 0x48 0x124 0x154 0x1a4..0x1b4 0x294`, PMC `0x18 0x20 0x28..0x3c 0x58 0x64 0x68 0x74 0x78..0x88 0x368`, SYSCTRL `0xc4 0xf0`. Decode PWM mV. | Boot voltages known. Decide the voltage plan from here. |
| **A2** (mainline, read-only, tsensor) | Write `0x72` to PMC `0x28`, read `0x30..0x3c` x10 under idle and under a CPU burn. | Reading plausible (30-80 C), moves with load. If it does not, section 6 is wrong, stop. |
| **B1** (frequency down, no voltage) | Mux path (patch 0005 already proves `0x206`/`0x606` -> 400 MHz): guard, write the mux, time a fixed busy loop, restore. Then the APLL path: guard, tune fbdiv 266 -> 200 (600 MHz) -> 133 (798) etc., read `0x294`, time the loop, restore. Note the 396/798 reality. | Loop time scales with frequency; `0x294` reads the commanded fbdiv; no hang. |
| **B2** (kernel, frequency only) | Patch 0013 + DT stage 1, no regulator. `schedutil`/`ondemand`. Run `stress-ng`/`sysbench` while stepping rates; log temperature. | `scaling_available_frequencies` lists the 5 rates; load follows frequency; no hangs over 1 h; temperature falls with rate. |
| **B3** (optional) | Compare power: wall meter at idle, 400 MHz vs 1596 MHz (no voltage change). Inference: dynamic power ~ f, so ~25% at 400 MHz. | measurement. |
| **C1** (regulator driver, no change) | Patch 0014, `min = max = boot V`, OPPs at boot V. | `/sys/class/regulator/*/microvolts` equals the A1 value; PMC `0x18` unchanged. |
| **C2** (raise only) | Raise `0x18` by 20 mV at a time (up to 1150), watch HPM `0x7c/0x80`. | HPM codes **rise** with voltage. If they do not, the PWM is not wired to a regulator on this board; stop. (HPM sensitivity is [inferred].) |
| **C3** (voltage down per table) | One OPP at a time from the bottom: 396 MHz @ 840 mV, 600 @ 840, 798 @ 870, 1200 @ 990, with 5-minute burns and the SP805 guard each. | stable at every OPP, HPM code >= the vendor target for that rate (`201/201/256/298/362`). |
| **C4** | Only then consider the +50 mV cold rule (<= 30 C and <= 600 MHz) and HPM trimming (patch 0017). | optional. |
| **G1 / G2** | GPU as in section 4.4, after C3. | panfrost devfreq changes rate under load, no GPU hang. |

Rollback at any stage: remove the DT stage / the module, or hard-reset (the guard does it). Nothing
here writes flash.

### 7.4 What we do not know (blocks voltage work)

1. Boot values of PMC `0x18` and `0x20` (only A0/A1 can tell us).
2. Whether the Q10 Pro board wires the CPU PWM to the regulator (the board is a retail Android box that
   ships the vendor's DVFS, so likely yes; verify with A0 and C2).
3. Chip class (`SYSCTRL+0xc4 >> 24`) and the HPM/AVS bin.
4. Real PLL tune latency.
5. Whether `PMC+0x28 = 0x72` and `0x6005` give the same temperature.
6. The meaning of CRG `0x1b4` bits 2/3 beyond "mode, enable pulse", and of APLL `0x04` bit 27.
7. Power draw numbers (needs a meter): no measurement exists.

## 8. Expected benefit [inferred, no measurement]

Dynamic power relative to 1596 MHz @ 1150 mV, using P ~ f V^2 (leakage and board power ignored):

| OPP | f-only | f and vendor v_b |
| --- | ---: | ---: |
| 396 MHz | 25% | 13% (at 840 mV) |
| 600 MHz | 38% | 20% |
| 798 MHz | 50% | 29% (at 870 mV) |
| 1200 MHz | 75% | 55% (at 990 mV) |

For a media box that idles in Kodi at low CPU load the larger win is the idle-time voltage and thermal
headroom; for sustained load the 1200 MHz point at 990 mV is the sweet spot. None of this is measured.

## 9. Artifacts

- `scripts/himedia/disasm-stock-capstone.py` (new, uncommitted): disassemble a VA range of the stock
  kernel with capstone, resolves literal pools and strings. Dumps used here live in
  `$HIMEDIA_ROOT/stock-android-kexec/dis-*.s` and `kallsyms.txt`.
- Proposed, not written: `scripts/himedia/dvfs-probe.sh` (the guarded read/step script of 7.2/7.3).
- Sources read: stock kernel `stock-android-kexec/vmlinux.bin`; vendor DTB
  `extracted/.../_dtb/boot.img+0x8b5220.dts`; `docs/vendor-arm32/*`;
  community `histb-linux-6.12.y` `crg-hi3798cv200.c`, `hi3798cv200-avs.c`,
  `hi3798cv200-pwm-regulator.c`, `hisi_thermal.c`, `hi3798cv200.dtsi`,
  `hi3798cv200-dvbip-1004-arm64.dts`; our `0005`/`0010` patches and the GPU port report.
