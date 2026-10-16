# HiMedia Q10 Pro: Mali-T720 on mainline Panfrost (6.18.55, AArch32)

Date 2026-10-11. Status: **compile-tested only**. Nothing ran on the box.
Tags: **[tested]** = observed in a build here, **[read]** = taken from a source file, **[inferred]** = reasoned, not observed.

## Deliverables (in `scripts/himedia/kernel/arm32/`)

| File | What |
| --- | --- |
| `0010-clk-hisilicon-crg-hi3798cv200-gpu-clock.patch` | GPU clock (gate + soft reset + 6-rate selector), `HISTB_GPU_CLK = 61`. Applies on top of 0001-0009 [tested: `git apply --check` on the tree with 0001-0009 + 0002 sed]. |
| `0011-...` | **Not needed.** `"arm,mali-t720"` is already in Panfrost's match table with `default_data` (`panfrost_drv.c:941`, 6.18.55) [read]. `modinfo panfrost.ko` lists `of:N*T*Carm,mali-t720` [tested]. The GPU id table has `GPU_MODEL(t720, 0x720)` [read]. |
| `gpu-dt-snippet.dtsi` | Parts A (nodes) and B (enable). Compiled together with our dtsi + dts [tested]. |

## 1. Clock patch 0010: what and why

The GPU clock is one object over three CRG registers [read: vendor `clk-higpu.c`, community `crg-hi3798cv200.c`]:

- `0xd4` bit 0 gate, bit 4 soft reset (1 = asserted)
- `0x124` `[2:0]` selector, bit 9 bypass, bit 10 switch request
- `0x154` `[7:5]` selector actually running (read-only)

Rates (selector): 200 (7), 300 (4), 400 (1), 500 (6), 600 (3), 675 (5) MHz [read, identical in vendor and community].

**Id collision.** The community id 54 is our `HISTB_SATA_TX0_CLK`. Used ids: SATA 51-54, SDIO1 55-56, VDEC/VPSS 57-60. The next free public id is **61**; the driver-private ids start at 64 and `CRG_NR_CLKS` is 128, so 61 fits [read from the patched tree].

**Where I deliberately differ from the community driver**

1. **`enable()` releases the soft reset.** Vendor sequence: set `SRST|CKEN`, clear `SRST`, then program the rate. The community `enable()` sets bit 4 and never clears it. Bit 4 is "asserted" in the vendor code, so on that tree the GPU is released only if something else clears it later and in the right order. That is [inferred] from reading both sources; I did not test the community tree. Panfrost deasserts `resets` *before* it enables the clock (`panfrost_device_init`: `reset_init`, then `clk_init`), which would not help. Here the clock owns the pulse and the DT carries **no `resets`**.
2. **Fail closed.** If `0x154` does not confirm the selector within 1 ms after the gate opens, the gate is closed again and `enable()` returns `-ETIMEDOUT`. Panfrost then fails probe. It never runs at an unverified rate. (The vendor loop ignores the failure.)
3. **Simpler.** No `rate_fault` state machine and no sleeping mutex. Every sequence is short and runs under one spinlock with an atomic poll, so it is legal under the clk enable lock. The chosen selector is stored, so `assigned-clock-rates` set before the first enable survives the first enable (the vendor `enable()` always resets to 200 MHz; that would silently undo it).
4. `determine_rate` instead of the deprecated `round_rate`. `CLK_SET_RATE_UNGATE` makes the CCF open the gate around `set_rate`, so a switch always happens on a running clock. I assume the switch needs a running clock because the community driver goes out of its way to ungate for it [inferred, not measured].
5. The community OPP/regulator ordering machinery is dropped: this tree has no GPU voltage control (see section 3).

## 2. How Panfrost avoids touching GPU registers before the clock is on

Verified by reading `panfrost_device_init` in 6.18.55 [read]:

1. `panfrost_reset_init`: only `reset_control_*`; with no `resets` in the DT it is a no-op.
2. `panfrost_clk_init`: `clk_get_rate` reads **CRG 0x154** (not a GPU register, so safe), then `clk_prepare_enable`.
3. `panfrost_devfreq_init`, `panfrost_regulator_init`: no GPU register access.
4. Only after that: `panfrost_gpu_init`, which does the first read of `GPU_ID` in the GPU window.

`default_data` does **not** set `GPU_PM_RT`, so Panfrost keeps the clock enabled for the device lifetime; runtime PM only does the GPU's internal power-off. The clock is therefore opened exactly once, at probe, before any GPU read. If `enable()` fails (selector never locks), the GPU window is never touched. A bus hang is still possible if the clock is on but the GPU is held in reset or has no power; see risks.

## 3. DT snippet: decisions

- **Inside `&soc`, soc-relative `reg = <0x9200000 0x4000>`** (phys `0xf9200000`). The community tree put the GPU at the top level only to escape the soc node's **1 GiB** `dma-ranges`. Ours is `<0x0 0x0 0x80000000>` (2 GiB), which covers all RAM (`mem=1993M`), so the workaround is not needed. Keeping it in `&soc` matches vdec/vpss. If RAM ever grows past 2 GiB, widen the soc `dma-ranges`, not this node.
- **IRQs** SPI 142 job, 141 mmu, 143 gpu [read: community dtsi]. I could not cross-check them against the vendor kernel: the 4.4 kernel tree has no Mali driver (the Mali kernel module ships separately in the SDK). **Tag: community-sourced, unverified on hardware.** A wrong order shows up as a Panfrost job timeout or an MMU fault storm.
- **`compatible = "arm,mali-t720"` only.** The community `hisilicon,hi3798cv200-mali` string is in no binding and in no driver table, so it adds a `dt_binding_check` complaint and nothing else.
- **`mali-supply` = fixed regulator, no OPP table, no voltage changes.** The SoC has a core-voltage PWM at `0xf8a23020` (the vendor regulator driver `hi3798cv200-regulator.c` and the community `hi3798cv200-pwm-regulator.c` write it). Whether the Q10 Pro wires that PWM to a DC-DC is **unknown** [inferred]. Writing it blind could under-volt or over-volt the core, and a mistake there is a hang or hardware stress, not a bad frame. So: no controllable regulator, no OPP, no devfreq (`panfrost_devfreq_init` continues without it when there is no OPP table: `-ENODEV` is swallowed [read]). The `regulator-fixed` carries no `regulator-{min,max}-microvolt`: we do not know the voltage and a number there would be invented.
- **Rate.** Default is the clock's 200 MHz. `assigned-clock-rates = <400000000>` is in the snippet commented out. The community OPP table has 200-500 MHz at 880 mV and 600 MHz at 920 mV [read], so 400 MHz is a reasonable first step on whatever voltage the bootloader left, but "reasonable" is an inference. Do it only after 200 MHz is stable.
- **No `dma-coherent`**: the T720 has no ACE-Lite port [inferred].
- **No `resets`**, see 1.1.
- **No power domain.** The vendor clock driver has no GPU power-domain call [read], so I assume the GPU rail is always on and the only gating is the clock and the soft reset [inferred].

## 4. Kconfig

Already set in `$HIMEDIA_ROOT/kernel-build-arm32/linux-6.18.55/.config` [read, and `olddefconfig` kept all of it, tested]:

```
CONFIG_DRM_PANFROST=m
CONFIG_DRM_SCHED=m                      (select; module gpu-sched)
CONFIG_DRM_GEM_SHMEM_HELPER=y           (select)
CONFIG_IOMMU_SUPPORT=y                  (select)
CONFIG_IOMMU_IO_PGTABLE_LPAE=y          (select)
CONFIG_PM_DEVFREQ=y                     (select)
CONFIG_DEVFREQ_GOV_SIMPLE_ONDEMAND=y    (select)
CONFIG_WANT_DEV_COREDUMP                (select)
```

Depends: `DRM`, `ARM`, `!GENERIC_ATOMIC64`, `MMU`. `CONFIG_ARM_LPAE` is **not** required (phys_addr_t stays 32-bit; the Mali page tables are their own 64-bit LPAE-format tables). That is the same arrangement as the RK3288 [inferred from upstream usage, not tested here]. The CRG driver itself is already built in: `crg-hi3798cv200.o` compiled in the check build [tested]. `CONFIG_INITRAMFS_SOURCE="/irfs"` points at a path that does not exist in my work tree, so my check build blanked it. This does not affect the deliverables.

## 5. Build

Work tree `$HIMEDIA_ROOT/gpu-port/linux-6.18.55`, pristine 6.18.55 + 0001 + 0002 (sed on line 48 only, the `PHY_HISTB_COMBPHY` line; the file has five identical lines) + 0003-0009 + my 0010 [tested]. Scripts: `gpu-port/build.sh`, `gpu-port/build-full.sh` (in the work dir; move to `scripts/himedia/` if you want to keep them).

```
docker run --rm --platform linux/arm64 -v $HIMEDIA_ROOT/gpu-port:/ws -w /ws/linux-6.18.55 \
  himedia-kbuild-arm32:trixie bash -c 'export ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-; \
  make olddefconfig && make -j$(nproc) drivers/clk/hisilicon/ drivers/gpu/drm/panfrost/ && make -j$(nproc) dtbs'
```

Results [tested] (logs in (run log) and (run log)):

```
RC_CLK_W1=0     make W=1 drivers/clk/hisilicon/crg-hi3798cv200.o   (0 warnings)
RC_OBJ=0        drivers/clk/hisilicon/ + drivers/gpu/drm/panfrost/ (LD [M] panfrost.o)
RC_DTB=0        hi3798cv200-himedia-q10-pro.dtb and ...-pro-gpu.dtb (DTC, no warnings)
RC_DTBS=0       make dtbs
RC_FULL=0       make zImage modules   ->  panfrost.ko 463576 bytes, zImage 11864848 bytes
```

An earlier `make M=drivers/gpu/drm/panfrost modules` failed with ~190 undefined symbols; that is an artefact of building a single module dir without a full `Module.symvers`, not a defect. The full `zImage modules` build links `panfrost.ko` cleanly with no modpost errors.

Decoded `...-pro-gpu.dtb` [tested]: `gpu@9200000` has `clocks = <0x03 0x3d>` (0x3d = 61, phandle of `crg`), three interrupts `0x8e/0x8d/0x8f` (142/141/143), `mali-supply` → `regulator-vdd-gpu`, `status = "okay"`. The plain `...-q10-pro.dtb` has no gpu node. Both new dtbs live only in the work tree (`arch/arm/boot/dts/hisilicon/` + Makefile line); the repo `.dts`/`.dtsi` are untouched.

**Not done:** `dt_binding_check` / `CHECK_DTBS` (no dt-schema in the image), `checkpatch`, any run on hardware.

## 6. Risks

1. **Clock on, GPU dead = bus hang.** If the GPU is clocked but still in reset, unpowered, or the interrupt/reg map is wrong, the first `GPU_ID` read can stall the AXI bus and freeze the whole SoC (no oops, no log). 0010 releases the reset itself, but whether bit 4 is truly the Mali reset on this SoC comes from vendor code and the community DT (`resets = <&crg 0xd4 4>`) [read], not from a measurement.
2. **Unknown core voltage.** No voltage control is a deliberate choice (3). 200 MHz should be safe on any sane boot voltage; 400 MHz+ is not verified. The 600/675 MHz points need the 920 mV+ rails the stock firmware sets; do not use them here.
3. **Rate-switch handshake.** If `0x154` never reports the selector, `enable()` fails and Panfrost does not probe (error: `hi3798cv200: GPU clock selector 7 did not lock`). That is a safe failure; look at CRG `0x124`/`0x154` with `devmem`.
4. **IRQ numbers and window are community values**, not cross-checked with the vendor kernel.
5. **CMA / simpledrm.** The display stays on simpledrm. Panfrost provides only `/dev/dri/renderD128`. Mesa composites through `kmsro` (render on panfrost, scan out from the simpledrm dumb buffer), which costs one copy per frame and is not zero-copy. GPU buffers use shmem + the Mali MMU, not CMA, so the 128M CMA is not consumed by Panfrost itself [inferred].
6. **32-bit userspace.** Mesa panfrost for T720 (Midgard) works on 32-bit ARM, but I did not check the distro's Mesa build options.
7. `CLK_GET_RATE_NOCACHE` means every `clk_get_rate` reads `0x154` (a CRG register); harmless, but it is a register read per call.

## 7. Hardware test plan

Do this on the serial/ssh console, SP805 watchdog (already used by our boot ladder) armed so a bus hang resets the board instead of freezing it.

1. Boot the new kernel + `...-pro-gpu.dtb`. Before loading anything: `ls /sys/class/devfreq` should be empty and `cat /sys/kernel/debug/clk/clk_gpu/clk_enable_count` (needs debugfs) should show 0 [inferred layout].
2. Confirm the clock provider alone is healthy: `dmesg | grep -i clk`; there must be no complaint at boot (the gate is closed until the driver asks).
3. Arm the watchdog: open `/dev/watchdog` and set a 30 s timeout, **and keep a loop petting it** that you can kill. Then `modprobe gpu-sched; modprobe panfrost` in the foreground, with `dmesg -w` open on the serial console.
4. Expected (shape from upstream T720 logs, exact feature words unverified):
   ```
   panfrost f9200000.gpu: clock rate = 200000000
   panfrost f9200000.gpu: mali-t720 id 0x720 major 0x1 minor 0x? status 0x0
   panfrost f9200000.gpu: Features: L2:0x... Shader:0x... Tiler:0x... Mem:0x... MMU:0x... AS:0x... JS:0x...
   panfrost f9200000.gpu: shader_present=0x... l2_present=0x...
   [drm] Initialized panfrost 1.5.0 for f9200000.gpu on minor 1
   ```
   `clock rate = 200000000` proves the selector read-back matches table index 0. The `mali-t720 id 0x720` line proves the first GPU register read worked. If the board resets after `modprobe`: kill the pet loop earlier to confirm it was the read, then suspect risk 1 first.
5. If the id line is missing: `panfrost ... Fatal error during GPU init` and/or `-ENODEV`: check `cat /proc/interrupts | grep gpu` for three entries and compare the id with the SDK's Mali.
6. After a clean probe: `ls -l /dev/dri/` (expect `card0` simpledrm + `renderD128`), `cat /sys/kernel/debug/clk/clk_gpu/clk_rate`.
7. Mesa checks: `eglinfo -B` (or `EGL_PLATFORM=surfaceless eglinfo`) should report renderer `Mali-T720 (Panfrost)`; `MESA_LOADER_DRIVER_OVERRIDE=panfrost glxinfo -B` under Xorg/Wayland; `kmscube -D /dev/dri/card0` is the display test (this exercises the kmsro copy; a scanout failure there is not a GPU failure); `glmark2-es2-drm --off-screen` for a stress pass.
8. Stress: run `glmark2-es2-drm --off-screen` for 5+ minutes, then `dmesg` for `gpu sched timeout` / `mmu fault`. A job timeout under load with a clean probe points at IRQ mapping or voltage (risk 2/4), not the clock.
9. Only then uncomment `assigned-clock-rates = <400000000>`, re-run (7)-(8) and read `clk_rate` to confirm 400000000.
10. Cleanup: `rmmod panfrost` should leave the clock gate closed (`clk_enable_count` back to 0).
