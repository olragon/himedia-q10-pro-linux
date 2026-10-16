# HiMedia Q10 Pro: a DRM/KMS driver for the Hi3798CV200 VDP, with a hardware NV12 video plane

Date 2026-10-11. Compile-tested only; **nothing here has run on hardware.**
Tags: **[read]** = read in a named file:line, **[inferred]** = reasoned from sources, **[tested]** = compiled here.
Hardware results are the owner's to add (section 7).

Abbreviations: VT = `~/src/hisilicon-kernel-4.4.35/drivers/msp/drv/vo/vdp_v4_0/hal/98cv200` (vendor SDK),
HR = `.../drivers/common/include/hi3798cv200/hi_reg_vdp.h`, CM = community `~/src/histb-linux-6.12.y/drivers/gpu/drm/hisilicon/histb/histb-vdp.c`.

## 1. What was delivered

| File (in `scripts/himedia/kernel/arm32/`) | What |
| --- | --- |
| `0011-drm-hisilicon-histb-vdp-with-video-plane.patch` | the driver: `drivers/gpu/drm/hisilicon/histb/{Kconfig,Makefile,histb_vdp.h,histb_vdp_drv.c,histb_vdp_hw.c,histb_vdp_zme.c}` + 2 hook lines in `hisilicon/{Kconfig,Makefile}` |
| `0012-clk-hisilicon-crg-hi3798cv200-vo-vdp-gates.patch` | 7 CRG gates, ids 90..96, 6 of them `CLK_IS_CRITICAL` (see 4) |
| `vdp-dt-snippet.dtsi` | the `vdp: display-controller@8cc0000` node + PART B enable |

Tooling (`scripts/himedia/vdp/`): `apply-base-patches.sh` (0001..0010 in build-script order; 0002 is the `perl` one-liner), `compile-test.sh`, `make-patches.sh` (regenerates 0011/0012 from the work tree), `verify-patches.sh` (fresh tree -> apply SHIPPED patches -> build), `dt-test.sh`.

**Kconfig to enable:** `CONFIG_DRM_HISI_HISTB_VDP=m`. It `select`s `DRM_GEM_DMA_HELPER` (already `=m` in the current config), `DRM_KMS_HELPER` (`=y`), `DRM_CLIENT_SELECTION` (`=y`). Already present and needed: `DRM_FBDEV_EMULATION=y`, `DRM_SIMPLEDRM=y`, `CMA=y`. `build-kernel-arm32.ts` still has to be taught to apply 0011/0012 (after 0010) and to set the symbol; that edit is left to the integrator on purpose.

**Compile evidence [tested]:** fresh 6.18.55 tree, 0001..0010 + 0011 + 0012 applied with `patch -p1`, ARCH=arm, gcc 14 trixie cross, `make W=1` on `drivers/gpu/drm/hisilicon/histb/` and `drivers/clk/hisilicon/` -> 0 errors, 0 warnings, `histb-vdp.ko` (137 KB) links against the real `Module.symvers` (every symbol resolves). The DT snippet compiles with `dtc` against our dtsi + board dts (`dtc exit: 0`, clocks decode to 90..96). Log: (run log).

## 2. Design: ADOPT, do not program

The boot-programmed HDMI link is the one thing that cannot be rebuilt (no HDMI TX driver, no PLL driver). So the driver reads the running pipe and only drives the layers on top of it.

| Piece | Adopted (read, never written) | Programmed |
| --- | --- | --- |
| Mode | `DHD0_CTRL/HSYNC1/HSYNC2/VSYNC/PWR` decoded into the one `drm_display_mode`; probe fails with `-ENODEV` if `intf_en`=0 or interlaced | nothing. `DHD0_VTTHD` threshold 1 is set to `vdisplay` for the vblank IRQ (that register is an interrupt trigger, not timing) |
| Clocks / resets / HDMI | everything. No VDP soft reset (CRG 0xd8 bit 30 is not exposed), no PLL, no CRG write beyond what the clock framework does for the gates in 0012 | -- |
| G0 -> GP0 -> CBM route | left as fastboot set it (the community driver rewrites it, CM:652-690) | -- |
| Primary plane = **G0** | `G0_CTRL` bits other than ifmt/enable are re-asserted to the **measured** boot value `0xCC00C368` flags | `G0_ADDR/NADDR/STRIDE(16 B units)/IRESO/SFPOS/DFPOS/DLPOS/VFPOS/VLPOS/CBMPARA/ALPHA/SMMU_BYPASS0/DCMP_*/CTRL`, then `G0_UPD`+`GP0_UPD` (the community pair-latch, CM:470-478) |
| Overlay plane = **V0** | -- | V0 layer, VP0, video colour core (VDM + CVM1 identity), `MIXV0_MIX`, and **one** mixer word: `CBM_MIX1 = VP0 \| GP0<<4 = 0x21` |

Plane/CRTC/connector model: CRTC `DHD0` (atomic; enable only does `drm_crtc_vblank_on` -- **disabling the CRTC switches the planes off, it never stops DHD0**); primary `G0` (XRGB8888/ARGB8888, `alpha` property, immutable zpos 1); overlay `V0` (NV12/NV21, immutable zpos 0, `COLOR_ENCODING` BT.601/709, `COLOR_RANGE` limited/full); connector HDMI-A, always connected, one mode, no DDC; encoder TMDS. Layer order: **video below graphics** (CBM prio0 = VP0, prio1 = GP0, as the vendor does).

Zero-copy: `DRM_GEM_DMA_DRIVER_OPS` (PRIME import via `drm_gem_dma_prime_import_sg_table`, which refuses a non-contiguous dma-buf, so a scattered buffer fails the import loudly instead of being scanned wrongly) + `drm_gem_fb_create`. Dumb buffers are 16-byte pitch aligned. Vertical crop = start address, horizontal crop = `V0_CPOS`.

simpledrm hand-over: `aperture_remove_conflicting_devices(G0_ADDR, stride*height, "histb-vdp")` at probe -- only the boot framebuffer's address range is named. The reserved-memory region is never released.

## 3. Register map used

All offsets are inside the 64 KiB window at `0xf8cc0000` (`VDP_BASE_ADDR`, VT `inc/vdp_define.h:83`). Layer strides: video `VID_OFFSET 0x800` (`vdp_define.h:109`). Offsets from HR (`37483-38633`, the struct comments). "src" = where the *sequence* comes from.

| Block | Registers (offset) | src |
| --- | --- | --- |
| global | `VOINTSTA 0x04`, `VOMSKINTSTA 0x08` (write 1 = clear), `VOINTMSK 0x0c`; bit0 = `dhd0vtthd1` | HR `U_VOINTMSK`; CM:1143 (`histb_vdp_irq`) |
| DHD0 | `CTRL 0xc000` (`intf_en` b31, `iop` b4), `VSYNC 0xc004`, `HSYNC1 0xc008`, `HSYNC2 0xc00c`, `PWR 0xc014`, `VTTHD 0xc01c` | HR `U_DHD0_*`; inverse of CM:652-690; **measured** `CTRL=0x80008010` |
| G0 | `CTRL 0x7000 UPD 0x7004 ADDR 0x7010 NADDR 0x7018 STRIDE 0x701c IRESO 0x7020 SFPOS 0x7024 SMMU 0x7028 CBMPARA 0x7030 DCMP 0x7050-58 DFPOS..VLPOS 0x7080-8c ALPHA 0x7094` | CM:69-91, CM:480-; **measured** ADDR/STRIDE/IRESO/CBMPARA |
| GP0 | `UPD 0x8004` (latch only) | CM:470-478 |
| V0 | `CTRL 0x800 UPD 0x804 PRERD 0x820 IRESO 0x828 ORESO 0x82c CBMPARA 0x838 PARAUP 0x840 CPOS 0x844 H/L/V/C COEFAD 0x850-5c DFPOS/DLPOS/VFPOS/VLPOS 0x860-6c BK 0x870 ALPHA 0x874 MUTE_BK 0x878 HSP 0x8c0 HL/HCOFFSET 0x8c4/8 VSP 0x8d8 VSR 0x8dc VOFFSET/VBOFFSET 0x8e0/4 SMMU_BYPASS0 0x9a0 P0LADDR/P0CADDR/P0STRIDE 0xa04/08/0c 16REGIONENL 0xf00` | HR `37548+`; sequence VT `vdp_drv_vid.c:88-492` (layer), `:495-660` (crop+addr), `:960-1190` (ZME), `vdp_hal_vid.c:167,242,417,441,458,508,537,555,579,826,847,1483,1699,1973,2018` |
| VP0 | `CTRL 0x6000 UPD 0x6004 IRESO 0x6008 GALPHA 0x6020 DFPOS 0x6040 DLPOS 0x6044 VFPOS 0x6048 VLPOS 0x604c` | VT `vdp_drv_vid.c:402-409`, `vdp_hal_vid.c:75,2941-3100` |
| video colour core | `VDM_CTRL 0x3400`, `VDM_YUV2RGB_CTRL 0x3500`, `_COEF00..08 0x3504-24`, `_SCALE2P 0x354c`, `_IN_DC 0x3550-58`, `_OUT_DC 0x355c-64`, `VDM_RGB2LMS_* 0x3600-28`, `CVM_CTRL 0x3900` (`cvm_sel` b1), `CVM1_LMS2IPT_* 0x3a00-3c`, `HDR_UPD 0x3f84` | VT `vdp_drv_vid.c:106-146` (identity), `:1209-1458` (csc), `vdp_hal_hdr.c:607,690,753,1113,1126,2216` |
| mixers | `MIXV0_MIX 0xb008` (prio = layer id + 1), `CBM_MIX1 0xb408` (VP0=1, GP0=2; prio0 bottom) | VT `vdp_hal_comm.c:784`, `vdp_software_selfdefine.c:332-333`, `vdp_define.h:892-909` |
| CRG (patch 0012) | `0xd8` b0 `vo_bus`, b4 `vo_hd`, b31 `vdp_cfg`; `0x34c` b0 `vo_bp`, b11 `vdp_g0`, b13 `vdp_v0`, b14 `vdp_hd` | community `crg-hi3798cv200.c:1719-1737`; VT `hi_reg_crg.h` `U_PERI_CRG54` |

V0 setup as programmed (all from VT `vdp_drv_vid.c` unless noted): `ifmt=3` (semi-planar 4:2:0, `vdp_define.h:547`), `req_ctrl=3` (VID0, `vdp_software_selfdefine.c:308`), `nosec=1`, `lm/chm_rmode=1`, `ifir_mode=3` (6-tap, `:291`), `data_width=0` (8 bit), `pre_rd_en`, `16REGIONENL=1`, SMMU bypass for regions 0/1. ZME: scaler on, `zme_in_fmt=4:2:0`, `zme_out_fmt=4:2:2`, chroma vertical phase `-(4096>>2)>>1 = -512` (`VdpZmeComnSet`, `:1470-1560`), `hfir_order=1` (forced on CV200, `vdp_hal_vid.c:1964`), ratios `in*2^20/out` (H) and `in*2^12/out` (V) (`:1464-1465`).

## 4. What is solid, what is a guess

**Solid (compile-checked and matches two independent sources):** DHD0 mode decode (inverse of the community encoder; consistent with the measured `0x80008010`); the G0 write set (identical to what the community driver does on this chip, and the flags equal the measured boot `G0_CTRL`); `CBM_MIX1 = 0x21` and `MIXV0_MIX` (vendor init); the VDM/CVM1 identity values (the community builds the same Q14 identity for CVM2); V0 geometry registers (read from the vendor HAL).

**Guesses -- each can be wrong, none can hang by itself, and each has a runtime knob:**

1. **YUV->RGB scale/units** (`csc_shift`, `csc_scale2p` module parameters). The vendor feeds the closed PQ library's matrix to `VDM_YUV2RGB_*` with `scale2p=10`; I use a computed Q10 matrix and `scale2p=10`. The CVM convention (`unity = 2^(scale2p-1)`) would suggest a factor-2 error. Symptom if wrong: picture twice as bright/dark. Fix without rebuild: `modprobe histb-vdp csc_scale2p=11` (or `csc_shift=9/11`). The input DC (`Y -16<<6`, `C -128<<6`, 14-bit domain) follows the vendor's `csc_in_dc * 16`; sign is [inferred].
2. **V0 stride unit**: written as **bytes** (the vendor passes the frame stride straight through, `vdp_hal_intf.c:607`). G0 is 16-byte units (measured). Symptom if wrong: picture sheared/stretched horizontally. Fix: poke `V0_P0STRIDE` (0x0a0c) with pitch/16 and see.
3. **ZME coefficient packing for scaling.** The VDP ZME is the same IP as the VPSS ZME (which works on this chip, patch 0008), so its tables and 10/16-bit packing are reused. The vertical *luma* table is 6-tap in the vendor path and its packing is unknown. Therefore **scaling is OFF by default** (`allow_scale=0`: the plane check rejects anything but 1:1); 1:1 runs luma/horizontal FIRs in copy mode (the way the VPSS port does a 1:1 job) and only the vertical chroma FIR (4:2:0 -> 4:2:2) uses a table (the 4-tap one, which matches the VPSS 4T packing). Letterboxing/scaling is meanwhile a user-space job (let the compositor or `gst videoscale` produce a window-sized NV12 buffer; or `allow_scale=1` to try the ZME).
4. **`uv_order`**: NV21 sets bit 11, NV12 clears it. [inferred]
5. **HDR core other bits** (`VDM_CTRL` bits above `v_vdm_en`, `HDR_CTRL`): the vendor's SDR video path does not set them (its `#if 0` block, `vdp_drv_vid.c:151-181`), so they stay as fastboot left them.
6. **Interrupt**: same line/bit the community driver uses (SPI 90, `VOINTSTA` bit0). The status is *acknowledged by writing `VOMSKINTSTA`* as the community does; `VOINTMSK` is written wholesale (only bit0 ever set).

**Clock patch 0012, and why six gates are `CLK_IS_CRITICAL`.** The research doc (`261011-himedia-hdmi-simplefb-research.md` sec. 5) established that no clock object exists for these gates, so `clk_disable_unused()` cannot close them. Registering them would change that: with the module blacklisted nothing consumes them and the framework would gate the very clocks the boot logo scans out through. `CLK_IS_CRITICAL` makes the registration a no-op for the display (it only sets bits that are already set). Only `vdp_v0` (13 in 0x34c; the boot logo uses G0, not V0 [inferred]) is a normal gate: `histb-vdp` enables it in probe, *before* any V0 register is touched. The soft reset `0xd8` b30 is not exposed on purpose.

## 5. Risks, and how to recover

| Risk | Effect | Recovery |
| --- | --- | --- |
| `CBM_MIX1` wrongly ordered or V0 chain produces black | video plane black or G0 hidden | `rmmod histb-vdp` restores the boot `CBM_MIX1` and G0. The `V0` write set is only reached when an NV12 plane is enabled, so a plain `modprobe` + console cannot trigger it |
| V0 fetch from a bad address (stride/addr unit wrong) | garbage picture; V0 has no SMMU (bypass) so it reads physical RAM. A read of TEE memory might raise an AXI error | the decoder buffers are in CMA below the vendor media zone; `nosec_flag=1` is set. Watchdog + reboot if it hangs |
| the module owns the display after `modprobe` | `simpledrm` is evicted and **does not come back**: its platform device is unregistered by the aperture handoff, and re-probing it needs a reboot. After `rmmod`, G0 is pointed back at the (black) boot buffer, HDMI stays alive, but there is **no console until reboot** | arm the SP805 before `modprobe`; reboot to get simpledrm + fbcon back. The kexec/pstore loop of the goal doc works as before |
| IRQ storm ("irq 90: nobody cared") | the line is disabled by the kernel; vblank events then time out | vblank is only unmasked on demand; if seen, load with `fbdev=0` and test with `modetest` (no vblank client) to confirm |
| CMA | the fbdev console buffer (8 MiB XRGB 1080p) + decoder capture buffers share the default CMA (128 MiB in the vdec snippet) | `fbdev=0` removes the console buffer |
| opaque primary hides the video | the overlay is *below* G0, an XRGB primary is opaque | set the primary plane's `alpha` to 0 (`modetest -w <G0>:alpha:0`) or use ARGB with a transparent buffer |
| `clk_disable_unused` closes `vdp_v0` while the module is not loaded | none for the boot logo (G0). Only an issue if fastboot ran V0 for something [unknown] | confirm by reading `V0_CTRL` (0xf8cc0800) once before loading |

What can blank the screen: any write to DHD0 timing/DATA_SEL (none exists), a VDP soft reset (none), gating `vo_hd`/`vdp_hd`/`bp` (kept critical), or the G0 layer being disabled by `drm_atomic_helper_shutdown` (that is the `rmmod` path, and it is followed by `histb_vdp_hw_restore_boot`).
What can hang: an MMIO access to a V0 register while the V0 clock is off [unknown whether that stalls the bus] -- avoided by enabling the clock first; an AXI error from V0/G0 reading protected memory -- avoided by non-secure flags and CMA buffers.

## 6. Debug aids (no rebuild needed)

- `/sys/kernel/debug/dri/<n>/histb_vdp_regs` -- ~40 registers (CTRL/IRESO/HSP/VSP/addresses/mixers/VDM/CVM). Read it before and after the first video frame.
- `allow_poke=1` adds `/sys/kernel/debug/dri/<n>/histb_vdp_poke` (write `0xOFFSET 0xVALUE`, offset < 0x10000, word aligned) for live retuning of scale/stride/order.
- module parameters: `allow_scale`, `csc_scale2p`, `csc_shift`, `fbdev`, `allow_poke` (all 0444, set at `modprobe`).

## 7. Hardware test plan (owner runs it; every step under the SP805 watchdog)

0. Baseline: `cat /sys/kernel/debug/dri/*/name` (expect `simpledrm`), read `0xf8cc0800` (V0_CTRL) and `0xf8cc7000` (G0_CTRL = 0xCC00C368) with devmem; keep the module out of `q10-untested.conf`'s boot list.
1. Arm the watchdog, then `modprobe histb-vdp fbdev=0` (no console buffer yet). Expect in dmesg: `adopting bootloader mode 1920x1080 ...`, then a new `/dev/dri/cardN` named `histb-vdp`. The TV may flash once while simpledrm goes away; it must keep a picture.
2. `modetest -M histb-vdp` and `modetest -M histb-vdp -p`: expect crtc `DHD0`, connector HDMI-A with one mode `1920x1080`, planes `G0` (primary, XRGB8888/ARGB8888) and `V0` (overlay, NV12/NV21, properties `zpos`, `COLOR_ENCODING`, `COLOR_RANGE`).
3. Primary: `modetest -M histb-vdp -s <conn>:1920x1080` -- a colour bar must appear. Then `modetest -M histb-vdp -w <G0 id>:alpha:0` should make it transparent (black).
4. Video plane test pattern: `modetest -M histb-vdp -P <V0 id>@<crtc id>:1920x1080@NV12` (the pattern is generated into a dumb NV12 buffer). Expected: colour bars *through* the transparent G0. Failure modes map to guesses 1-4 above: too bright/dark -> `csc_scale2p`; sheared -> stride unit; wrong colours -> `uv_order` / `COLOR_ENCODING`; black -> dump the registers.
5. Zero-copy decode: `gst-launch-1.0 filesrc location=clip.mp4 ! qtdemux ! h264parse ! v4l2slh264dec ! kmssink driver-name=histb-vdp plane-id=<V0 id> can-scale=false -v` with G0 alpha already 0. Verify the buffers are imported, not copied: the CPU should stay near idle and `kmssink` debug (`GST_DEBUG=kmssink:5`) must not mention a dumb-buffer copy. 1080p buffers are 1920x1088 with a crop meta -> the plane's source height must come out as 1080 (`histb_vdp_regs`: `V0_IRESO` height 1079).
6. Benchmark (decoder -> display): `... ! fpsdisplaysink video-sink="kmssink driver-name=histb-vdp plane-id=<V0 id>" text-overlay=false sync=false -v` for the fps; CPU from `top -b -n 5` (or `perf stat -a`) on the same clip as the existing decode benchmark (HW decode alone: 98 fps at 1080p, 0.22 s user per 300 frames, (an unpublished note)). The decoder->`fakesink` figure is the ceiling; the interesting number is how close `kmssink` gets with a dumb sync (`sync=false`) and whether the VDP's DMA slows the decoder (shared DDR).
7. Only after 1-6: `fbdev=1` (console), then `allow_scale=1` and a half-size window (`-P <V0>@<crtc>:960x540+480+270*1`) to try the ZME.
8. Recovery drill once: `rmmod histb-vdp` -> HDMI must stay up (black), then reboot to get simpledrm back.

## 8. Not done / for later

- `build-kernel-arm32.ts` integration (apply 0011/0012; set the Kconfig symbol); module blacklist line for the rootfs.
- Scaled playback and the 6-tap vertical luma table (needs either the closed PQ tables or a register capture from the stock Android kernel, which does run this exact path: `himd.l` can dump `0xf8cc0800-0xf8cc0fff` and `0xf8cc3400-3a3c` while a video plays -- that single dump would settle guesses 1-3 and 5).
- 10-bit / P010 (HEVC Main10) and tile input -- the decoder converts to linear NV12 through the VPSS, so V0 only needs 8-bit linear for now.
- HDMI EDID / hot-plug: the connector is a fixed "connected" with one mode.
