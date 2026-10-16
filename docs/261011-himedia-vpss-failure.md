# Q10 Pro: VPSS "post-processing failed, state=0x8d" - diagnosis and fix

Date 2026-10-11. Kernel 6.18.55-k14 AArch32. Driver `drivers/media/platform/hisilicon/histb-vpss.c` in `$HIMEDIA_ROOT/vdec-port/linux-6.18.55`, patch `scripts/himedia/kernel/arm32/0008-media-hisilicon-histb-vdec-vpss-from-6.12.patch`.

Tags: **[read]** = seen in source or vendor headers, **[inferred]** = reasoned from what was read, **[tested]** = run here (host build only; nothing ran on the box).

## 1. Symptom

The VDH now decodes H.264 correctly (300/300 pictures, `h264_raw_ebsp=0`). Every picture then fails in VPSS detile (tile -> linear NV12), and the capture buffer stays zero, which shows as solid green:

```
histb-vpss f8cb0000.video-post-processing: post-processing failed, state=0x8d   (x300)
```

This is the **first time VPSS detile ever ran**. Before today, every picture failed in the VDH, so `postprocess_work` was never queued (`261011-himedia-vdec-decode-error.md` sec. "Why the frames are solid green"). "k12 VPSS probed fine" only shows that probe passed. It does not show a working job. [read]

## 2. state=0x8d decoded by name

The bit layout comes from `U_VPSS_RAWINT`/`U_VPSS_INTMASK` in the vendor `drivers/common/drv/include/hi3798cv200/hi_reg_vpss.h:1053-1073` [read]. The driver's `HISTB_VPSS_INT_*` defines match it [read].

| bit | name | in 0x8d | meaning |
|---|---|---|---|
| 0 | `eof` | **set** | input frame fully read |
| 1 | `timeout` | - | |
| 2 | `bus_w_err` | **set** | **an AXI write was rejected** |
| 3 | `eof_end` | **set** | job finished (output side done) |
| 4 | `vhd0_tunl` | - | |
| 5 | `dcmp_err` | - | |
| 6 | `bus_r_err` | - | reads were all accepted |
| 7 | `ip_used` | **set** | node consumed |
| 8 | `ip_using_err` | - | |

So the engine **ran the whole job**. It fetched the node, read the tile surface (no `bus_r_err`), and reached end-of-frame, but **the interconnect refused at least one of its writes**. The driver treats `bus_w_err` as an error, returns `-EIO`, and the frame is dropped. [read + inferred]

## 3. Cause

### 3.1 Primary: `VPSS_CTRL.prot` was 0, which is SECURE (fixed)

`VPSS_CTRL.prot` is bits [24:23] (`U_VPSS_CTRL`, hi_reg_vpss.h) [read]. The BSP sets it in every node builder through `VPSS_REG_SetProtEn(pu32AppVir, stInInfo.bSecure)` (`vpss_hal_3798cv200.c:1743, 1974, 2146, 2321`, and `SetUHDNode`) [read]:

```c
/* vpss_reg_3798cv200.c:518 */
if (u32Prot == HI_TRUE)  VPSS_CTRL.bits.prot = 0x0;   /* secure job */
else                     VPSS_CTRL.bits.prot = 0x2;   /* normal job */
```

Our driver, which inherits this from the community 6.12 tree, wrote `prot = 0` with the comment "prot[24:23]=0 (not secure)". `histb_vpss_build_node()` never set it at all, so the value was 0. **That comment has the meaning backwards: 0 is the secure value.** Bit 1 is AxPROT[1], "non-secure" [read for the values; the AxPROT reading is inferred from the 0x0/0x2 encoding].

Why this produces exactly 0x8d [inferred]: the box boots the stock TEE (the 40 MiB TEE partition, which handles the secure-video path). The secure-video firewall must stop a *secure* media master from writing decoded pixels into *normal* memory, because that is how protected content would leak. It has no reason to stop the same master from *reading* normal memory. The VPSS issued every transaction as secure. So the reads (node, tile surface) passed, and the writes (VHD0 Y/C to the capture buffer) were refused. The result is `bus_w_err` with no `bus_r_err`, and a buffer that stays zero. The VDH, which works, does not go through this attribute.

### 3.2 Secondary: `VPSS_STT_W_ADDR` was 0 (fixed)

Every BSP node builder, including `VPSS_HAL_SetUHDNode` (the one `build_node()` copies), calls `VPSS_REG_SetSttWrAddr(pu32AppVir, u32stt_w_phy_addr)`. That address is a 32 KiB buffer (`VPSS_STTWBC_SIZE (32*1024)`, `vpss_sttinf.h:124`; allocated in `VPSS_STTINFO_SttWbcInit`) [read]. Our detile node left it at 0 after the `memset`, and the DEI node wrote 0 explicitly [read]. If the engine writes statistics on every job, the target is **physical 0**. On this ARM32 kernel that is the 16 KiB below `swapper_pg_dir` at phys 0x4000. The write could therefore also be the rejected one. **Once `prot` is non-secure it could also land, which would corrupt memory next to the kernel page tables.** For that reason the two fixes ship together, and there is no switch that turns the STT buffer off. [read for the vendor; inferred for the risk]

### 3.3 Checked and excluded (or left as a residual)

| candidate | finding | tag |
|---|---|---|
| Clock rate / mux | The BSP sets `PERI_CRG60.vpss_clk_sel = 1`, which means 400 MHz ("0:333, 1:400, 2:300", `vpss_reg_3798cv200.c:74`). Our driver forces `clk_set_rate(400 MHz)` and checks the result. The parent order in 0009 (333/400/300) matches. A wrong clock would not cause a *bus* error. | read |
| Reset order | BSP: srst=1, clk_sel, cken=1, srst=0, then TIMEOUT, INTMASK 0xfe, INTCLR. Ours: assert, set_rate, enable, deassert, MISC, TIMEOUT, INTMASK 0xfe, INTCLR. Equivalent. | read |
| VPSS SMMU | The non-SMMU BSP build writes `RCH_BYPASS = WCH_BYPASS = 0xffffffff` in the node (`vpss_hal_3798cv200.c:1917-1919, 2092-2094`). Ours does the same. The SMMU block at +0xf000 is never programmed in that build. It is now dumped on failure (`scr`, `intraw_s/ns`, fault addresses). | read |
| Node buffer cache | `node` and `zme_coef` come from `dma_alloc_coherent`. The `vmap` path in `histb-dma.h` is used only for the staging, tile and capture buffers. A stale node would also give wrong *reads* or a hang, not a clean `bus_w_err`. | read + inferred |
| Output alignment | 1280x720 NV12: stride 1280 = 64 x 20, height 720 = 16 x 45, and C = Y + 1280 x 720. `detile()` already requires `output_stride >= ALIGN(width, 64)` for direct output. | read |
| MISC / outstanding | `0x03006466` is the same constant as BSP `ResetAppReg` (`vpss_reg_3798cv200.c:151`). | read |
| Destination inside a firewalled top-of-DDR window | Stock booted with `mem=1993M`, so 0x7C900000-0x80000000 was not given to Android. Our DT gives Linux all 2 GiB, and CMA runs from 0x76800000 to 0x7E800000, so part of it overlaps that window. A capture buffer up there could be write-protected for every master. **Not excluded**: see the A/B switch `force_staging` and the addresses printed by the new report. | inferred |

## 4. The fix (histb-vpss.c, regenerated into 0008)

1. **`prot` module parameter, default 2 (non-secure).** `histb_vpss_build_node()` now sets `FIELD_PREP(HISTB_VPSS_CTRL_PROT, prot & 3)`. The DEI node path, which used to clear the field, now sets it the same way. Its comment is corrected.
2. **STT write-back buffer.** Probe allocates 32 KiB with `dma_alloc_coherent` and rejects it if the address is above 32 bits. The detile and DEI nodes both point `STT_W_ADDR` at it. The buffer is freed in `remove` and on the probe error paths.
3. **`force_staging` module parameter, default 0.** When set, the VPSS writes its own staging buffer and the CPU copies the result to the capture buffer. This discriminates between "the attribute is wrong" and "the destination address is refused".
4. **Self-explanatory failure report** (`histb_vpss_report_failure()`), which replaces the bare `state=%#x` line. It prints:
   - the state bits **by name**, with a plain sentence for `bus_w_err` / `bus_r_err`;
   - the job as requested: node `ctrl`, `prot`, input size, stride, height-align, tile address and size, output size, stride and Y/C addresses, whether the target is the capture buffer or staging, the STT address, and `clk_get_rate()`;
   - the registers the engine latched: CTRL/CTRL2/CTRL3, IMGSIZE, NXT2 ctrl/Y/C/stride, VHD0 ctrl/size/Y/C/stride, STT_W, RCH/WCH bypass, RAWINT, EOF count, MISC, PNEXT;
   - the VPSS SMMU words: SCR, INTRAW_S/NS, ERR_WRADDR_S/NS, FAULT_ADDR_WR_S/NS (offsets 0xf000, 0xf014, 0xf024, 0xf2f4, 0xf308, 0xf330, 0xf340, all read from hi_reg_vpss.h).
   
   Probe now logs `registered native tile post-processor (prot=2, stt=0x...)`.

`histb-vdec-core.c` is unchanged.

Build [tested]: `make W=1 drivers/media/platform/hisilicon/histb-vpss.o drivers/media/platform/hisilicon/` in `himedia-kbuild-arm32:trixie` (`ARCH=arm CROSS_COMPILE=arm-linux-gnueabihf-`, vdec-port tree) gave **0 errors, 0 warnings**, `make_exit=0` (`vdec-port/logs/vpssfail-build.log`, (run log)). The module link and the 0008 re-apply on pristine 6.18.55 + 0001-0007 with `patch -p1` are checked by `scripts/himedia/vpss-fix-verify.sh`. The result is in section 6. `kernel-build-arm32/` was not touched.

The patch helper `scripts/himedia/vdec-regen-core-patch.py` now takes any number of hisilicon tree files (`<0008> <file> [<file> ...]`). The regenerated 0008 round-trips byte-identically for `histb-vpss.c` and `histb-vdec-core.c` [tested].

Backups: `vdec-port/histb-vpss.c.pre-vpssfail`, `vdec-port/0008.pre-vpssfail`. Not committed.

## 5. Hardware test

Install the new `histb-vpss.ko`. `histb-vdec.ko` is unchanged. On the box:

```
modprobe -r histb-vdec histb-vpss
insmod histb-vpss.ko            # default prot=2
modprobe histb-vdec             # or insmod histb-vdec.ko
dmesg | grep "tile post-processor"     # expect "(prot=2, stt=0x...)"
dmesg -C; rm -f /tmp/fr*.png
gst-launch-1.0 filesrc location=h264-720p.h264 ! h264parse ! v4l2slh264dec ! videoconvert ! pngenc ! multifilesink location=/tmp/fr%03d.png
dmesg > /tmp/vpss-a.txt
grep -c "post-processing failed" /tmp/vpss-a.txt   # expect 0
grep -c "decode failed" /tmp/vpss-a.txt            # expect 0 (unchanged)
ls /tmp/fr*.png | wc -l                            # expect 300; open fr000 / fr150: real picture, not green
```

A/B to confirm the cause:

```
# B: re-introduce the secure attribute only (the STT buffer stays valid, so this is safe)
echo 0 > /sys/module/histb_vpss/parameters/prot
dmesg -C; gst-launch-1.0 ... (same pipeline) ; dmesg > /tmp/vpss-b.txt
grep -m3 "vpss job\|failed" /tmp/vpss-b.txt
echo 2 > /sys/module/histb_vpss/parameters/prot

# C (only if A still fails with bus_w_err): move the destination off the capture buffer
echo 1 > /sys/module/histb_vpss/parameters/force_staging
dmesg -C; gst-launch-1.0 ... ; dmesg > /tmp/vpss-c.txt
```

The parameters are 0644 and are read when each node is built, so they take effect on the next frame without reloading the module.

Reading the result:

- **A clean, B fails with `[eof|bus_w_err|eof_end|ip_used]`**: the cause is the secure attribute (3.1). Done.
- **A clean, B also clean**: the firewall does not care about `prot`, so the zero STT address (3.2) was the rejected write. Keep both fixes.
- **A still fails with `bus_w_err`**: read the `vpss job:` line. If `out ... y=` is at or above `0x7c900000`, the destination is inside the window stock never used (3.3, last row). Run C. If C is clean, carve 0x7C900000-0x80000000 out of the DT (`/memreserve/` or a `no-map` reserved-memory node) so that CMA stays below it. If C also fails, send the three `vpss job/live/smmu` lines.
- **A fails with `bus_r_err`, or with a new bit**: the bit is now named in the log. Send the three lines.

Caveat on C [inferred]: with `force_staging`, the CPU writes the capture buffer before `histb_vdec_capture_begin_cpu_access()` runs `finish` (sync-for-cpu). That ordering is safe on the Cortex-A53 because it carries out a data-cache invalidate by MVA as clean-and-invalidate. It is a diagnostic switch, not a production path.

## 6. Verify run [tested]

`scripts/himedia/vpss-fix-verify.sh` (log (run log)):

- Pristine `linux-6.18.55.tar.xz` (read only, from `kernel-build-arm32/`), extracted to `vdec-port/verify/`, then 0001, 0003-0007 (0002 by hand, as in the port report), then **0008 and 0009 with `patch -p1 --batch`**. Result: `APPLY-OK`, with no hunk, fuzz or reject lines.
- `histb-vpss.c` and `histb-vdec-core.c` in that tree are **byte-identical** to the working tree (`VPSS-IDENTICAL`, `VDEC-IDENTICAL`).
- `make W=1 KBUILD_MODPOST_WARN=1 M=drivers/media/platform/hisilicon modules` gave **0 compiler warnings, 0 errors**, `make_exit=0`, and produced `histb-vpss.ko` (116,600 B, sha256 `2d8bf8d2...c38b`) and `histb-vdec.ko`. modpost reports "undefined" for every external symbol because this tree has no `Module.symvers`. That is the same known non-finding as in the port report.
- `modinfo`-style check: the strings `parm=prot:` and `parm=force_staging:` are present in the .ko.

The first verify run ((run log)) stalled because `tools/verify.sh` re-extracts over an existing patched tree, and `patch` then asks on the tty whether a patch is "reversed". The script now deletes `verify/linux-6.18.55` first and runs patch with `--batch`. `tools/verify.sh` itself is unchanged.
