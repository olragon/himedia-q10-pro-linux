# HiMedia Q10 Pro: HDMI via simple-framebuffer over the boot-logo framebuffer

Date 2026-10-11. Read-only research; no hardware touched. Decoder: `bun scripts/himedia/hdmi-fb-decode.ts` (pure, no hardware).

Confidence tags: **[read]** = read in a named source file; **[inferred]** = reasoned from sources, not read as such; **[unknown]** = not determinable offline.
Vendor tree = `~/src/hisilicon-kernel-4.4.35` (VT). Note: `$HIMEDIA_ROOT/kernel-refs/hisilicon-kernel-4.4.35` does NOT exist; only the `opensource` copy does.

## 0. Summary

- The boot logo is drawn on graphics layer **G0** (HIFB_LAYER_HD_0) [read: VT `drivers/msp/drv/hifb/inc/drv_hifb_logo.h:52`], at 1920x1080 ARGB8888, output 1080p60 [read: baseparam.img, see 2]. This is the stock *config*; what fastboot programmed on this unit is [unknown] until the registers are read.
- The **buffer physical address cannot be found offline**. fastboot.img is a binary with no source in the tree; its buffer is an MMZ allocation named `HIFB_DispBuf_HD` [read: strings in fastboot.img @0x7c8e4]. Read `G0_ADDR` (0xf8cc7010) with devmem.
- Mainline 6.18 registers **no** VO/VDP/HDMI/VDAC clock in its hi3798cv200 CRG driver, so `clk_disable_unused` cannot gate them [read: `crg-hi3798cv200.c` clock table, see 5]. `clk_ignore_unused` is cheap insurance, not a requirement.
- The HDMI TX is a **HiSilicon-own IP** (not Synopsys DesignWare) [inferred, strong; see 6].

## 1. devmem read list (physical addresses)

VDP base = `0xf8cc0000` [read: VT `drivers/msp/drv/vo/vdp_v4_0/hal/98cv200/inc/vdp_define.h:83`]. Offsets from VT `drivers/common/include/hi3798cv200/hi_reg_vdp.h` lines 38320-38350, 38789+ [read]. G0 is layer index 0; other gfx layers are at +0x200 each (`GFX_OFFSET 0x200`, `GFX_MAX 6`, vdp_define.h:111/52) [read]. Run all reads as root: `busybox devmem 0x<addr> 32`.

| Address | Register | Meaning | Decode |
|---|---|---|---|
| 0xf8cc7000 | G0_CTRL | layer control | bit31 `surface_en` (layer on), bit28 `mute_en`, bits[7:0] `ifmt` pixel format, bit26 `read_mode`, bit24 `flip_en`, bit25 `dcmp_en` (must be 0 for plain scanout) |
| 0xf8cc7004 | G0_UPD | reg-update strobe | bit0 `regup`; not needed |
| 0xf8cc7010 | **G0_ADDR** | **framebuffer physical address** | full 32 bits |
| 0xf8cc7018 | G0_NADDR | next/second buffer address | compare with G0_ADDR; differs if double-buffered |
| 0xf8cc701c | **G0_STRIDE** | line pitch | bits[15:0]; unit **[unknown]** (see 1.1) |
| 0xf8cc7020 | **G0_IRESO** | input size | bits[11:0] = width-1, bits[23:12] = height-1 [read: `vdp_hal_gfx.c:105-106` writes `u32Wth - 1`] |
| 0xf8cc7024 | G0_SFPOS | source window start | x/y offset into buffer; expect 0 |
| 0xf8cc7080 | G0_DFPOS | display window start | expect 0 |
| 0xf8cc7084 | G0_DLPOS | display window end | expect (1919, 1079)-ish; if different from IRESO the layer is scaled/positioned |
| 0xf8cc7088 / 0xf8cc708c | G0_VFPOS / G0_VLPOS | video-plane window | compare with DFPOS/DLPOS |
| 0xf8cc8000 | GP0_CTRL | graphics processor 0 | bit30 `mute_en` must be 0 |
| 0xf8cc8008 / 0xf8cc800c | GP0_ORESO / GP0_IRESO | GP0 out/in size | in != out means GP0 zoom engine is scaling the logo |
| 0xf8ccc000 | DHD0_CTRL | HD channel 0 | bit31 `intf_en`, bit4 `iop` (1 = progressive), bit14 `hdmi_mode` |
| 0xf8ccc004 | DHD0_VSYNC | vertical timing | vact bits[11:0] (value-1 convention [inferred]), vbb [21:12], vfb [31:22] |
| 0xf8ccc008 | DHD0_HSYNC1 | horizontal timing | hact bits[15:0], hbb [31:16] |

Pixel format table, `ifmt` [read: VT `vdp_define.h:622-661`]:

| ifmt | format | simple-framebuffer `format` |
|---|---|---|
| 0x42 | RGB565 | `r5g6b5` |
| 0x49 | ARGB1555 | `a1r5g5b5` |
| 0x50 | RGB888 24bpp | `r8g8b8` |
| 0x60 | KRGB888 | `x8r8g8b8` |
| 0x68 | ARGB8888 | `a8r8g8b8` |
| 0xef | ABGR8888 | no simplefb name (byte order differs); check [unknown] |
| 0xe8 | RGBA8888 | no simplefb name |

Memory-order caveat [inferred]: the vendor name ARGB8888 is a register-field name; whether the byte order in memory is B,G,R,A (little-endian ARGB, what simplefb `a8r8g8b8` means) was not verified. Verify by dumping the buffer start (see 1.2) and viewing a colour.

Other registers worth one read each (diagnostic):
- CRG (base 0xf8a22000 [inferred from the offsets in `hi_reg_crg.h`; confirm in our dtsi `crg` node]): `0xf8a220d8` PERI_CRG54 (VO clocks), `0xf8a2210c` PERI_CRG67 (HDMI TX ctrl clocks), `0xf8a22110` PERI_CRG68 (HDMI PHY reset), `0xf8a2211c` PERI_CRG71 (VDAC) [read: `hi_reg_crg.h` offsets 0xd8/0x10c/0x110/0x11c].
- HDMI TX block 0xf8ce0000 [read: `hdmi_2_0/product/Hi3798CV200/hdmi_product_define.h:63`]; PHY block 0xf8ce1800 (`HDMI_TX_BASE_ADDR_HDMITX 0x1800`) [read].

### 1.1 Stride unit
Vendor code writes the caller's `u32Stride` straight to `surface_stride` [read: `vdp_hal_gfx.c:199-214`], bits[15:0]. The register layout names no unit. For a 1920 px ARGB8888 layer, bytes = 7680 (0x1E00). **If G0_STRIDE reads 0x1E00 it is bytes; if it reads 0x1E0 (480) it is 16-byte units** [inferred; either reading is self-checking against width x 4]. The decoder prints a WARNING if stride < width x bpp/8. [unknown until read]

### 1.2 Check the buffer holds real pixels
`busybox devmem` reads one word. To dump: `dd if=/dev/mem bs=4096 skip=$((ADDR/4096)) count=1 | xxd | head` requires a /dev/mem that allows the range (our kernel needs `CONFIG_DEVMEM=y` and not `STRICT_DEVMEM` blocking RAM; stock Android kernel has no /dev/mem [read: docs/261010-himedia-boot-ladder-results.md]). Use the Linux build, not Android.

## 2. What the stock config says (baseparam.img)

Parsed from `$HIMEDIA_ROOT/emmc-dump/baseparam.img` (record = 32-byte name, 4-byte length, data), table `BASE_TABLE_DISP0` [read]:

| key | value | meaning |
|---|---|---|
| BASE_KEY_FMT | 0 | `HI_UNF_ENC_FMT_1080P_60 = 0` [read: VT `drivers/sdk/msp-include/hi_unf_video.h:111`] -> 1080p60 |
| BASE_KEY_VIRSCW / VIRSCH | 0x780 / 0x438 | 1920 x 1080 virtual screen |
| BASE_KEY_PF | 9 | `HIFB_BOOT_FMT_8888` [read: `drv_hifb_logo.h:51`] -> ARGB8888, 32 bpp [read: `drv_hifb_logo.c:777-790`] |
| BASE_KEY_DISP_L/T/R/B | 0 | no screen offset |
| BASE_KER_HDMI_VIDEOMODE | 0 | auto |

Caveats:
- This is the **saved** config. fastboot may re-pick a mode from the TV's EDID at boot (there is an EDID table in baseparam, `BASE_TABLE_HDMI`/`BASE_KEY_EDID_CONTENT`). The register reads in 1 decide. [inferred]
- DISP1 (SD channel) is irrelevant for HDMI.
- Parser sanity: values for DISP0 timings are all 0 because fixed formats carry no custom timing (expected for a standard format) [inferred].

## 3. The framebuffer address: what is and is not known

- fastboot.img (1 MiB, `$HIMEDIA_ROOT/emmc-dump/fastboot.img`) contains the logo code symbols: `Logo_Main`, `HI_GFX_ADP_CreateLayer`, `OPTM_GfxOpenLayer`, `HIFB_DispBuf_HD`, `boot logo show!!!`, source name `gfx/kernel-logo/hi_gfx_layer.c` [read: strings]. No source is in the tree, and the first bytes of the image look encrypted/obfuscated [read: xxd], so I did not disassemble it. The address is computed at runtime from an MMZ allocator. **[unknown]**
- The logo image itself: `logo.img` is entirely 0xFF (empty) and `logobak.img` holds the real data (`LOGO_TABLE`, `LOGO_KEY_LEN` = 0x17A7A = 96,890 bytes, i.e. a compressed image decoded at boot) [read: xxd/python on both]. fastboot has the strings "there is no logo param!" / "there is no logobak param!", so it falls back to logobak [inferred].
- Existing measurements (docs/261010-himedia-boot-ladder-results.md:156): under **Android** the MMZ is `0x77C00000-0x7B3FFFFF` and the highest allocation `0x7A582FFF` sits "behind the framebuffer". That is Android's allocation after the vendor kernel re-opened HIFB, **not** proof of where fastboot's logo buffer is [inferred]. The logo buffer may be inside or near that range. Treat 0x77C00000-0x7B3FFFFF as the **search window** only.
- Size to reserve: stride x height = 7680 x 1080 = 8,294,400 = 0x7E9000 bytes for one 1920x1080 ARGB8888 buffer [computed]. Reserve the whole window rounded up (e.g. 0x800000 = 8 MiB), and if G0_NADDR differs from G0_ADDR, reserve both.
- Important interaction: our own ramoops sits at `0x7A800000` and the dts says the region above Android's last allocation is free [read: our `hi3798cv200-himedia-q10-pro.dts:88-95`]. If the logo buffer is in that tail, the ramoops block would overwrite the picture. Re-check once G0_ADDR is known. [inferred risk]
- Also: U-Boot loads our uImage at `0x7E700000` (`bootcmd=mmc read 0 0x7E700000 ...` [read: bootargs.img]). Not related to the buffer unless G0_ADDR is near it; confirm not overlapping.

## 4. Draft DT snippet

Fill `<ADDR>`, `<SIZE>`, `<STRIDE>`, `<FMT>` from section 1 with `bun scripts/himedia/hdmi-fb-decode.ts G0_CTRL=.. G0_ADDR=.. G0_STRIDE=.. G0_IRESO=..` which prints this node.

```dts
/ {
	reserved-memory {
		#address-cells = <1>;
		#size-cells = <1>;
		ranges;

		/* boot-logo scanout buffer; VDP DMA keeps reading it, so no-map */
		bootfb: framebuffer@<ADDR> {
			reg = <<ADDR> <SIZE>>;   /* SIZE >= STRIDE*1080; expected 0x7e9000, round to 0x800000 */
			no-map;
		};
	};

	chosen {
		#address-cells = <1>;
		#size-cells = <1>;
		ranges;

		framebuffer0: framebuffer@<ADDR> {
			compatible = "simple-framebuffer";
			reg = <<ADDR> <SIZE>>;
			memory-region = <&bootfb>;     /* optional; if used, do not duplicate reg in chosen on newer kernels */
			width = <1920>;                /* expected from baseparam, VERIFY with G0_IRESO */
			height = <1080>;               /* expected, VERIFY */
			stride = <7680>;               /* expected if G0_STRIDE is in bytes, VERIFY (1.1) */
			format = "a8r8g8b8";           /* expected for ifmt 0x68; VERIFY ifmt */
			status = "okay";
		};
	};
};
```

Notes:
- Values filled: width 1920, height 1080, stride 7680, format a8r8g8b8 are **expected from baseparam + vendor tables [inferred]**, not read from a running fastboot. Address and size are [unknown].
- Alpha: with `a8r8g8b8` the hardware treats the top byte as alpha if the layer has alpha blending enabled; if console text appears invisible, switch the node to `x8r8g8b8` (alpha ignored by simplefb anyway) and also write 0xFF alpha in userspace. [inferred]
- Kernel needs `CONFIG_FB_SIMPLE` or `CONFIG_DRM_SIMPLEDRM`, plus `CONFIG_FRAMEBUFFER_CONSOLE` for a text console. Not checked against our current config. [unknown]
- Do not describe the VDP as a display device: with no driver, anything in the DT beyond simplefb does nothing.

## 5. Clock and power protection

Facts [read]:
- Mainline `drivers/clk/hisilicon/crg-hi3798cv200.c` (6.18.55 in `$HIMEDIA_ROOT/kernel-build/linux-6.18.55`) registers only: OSC/APB/AHB, MMC, UART, I2C, SPI, SDIO, PCIe, ETH, COMBPHY, USB2, USB3, SATA (via our patch 0001), IR, TIMER. **No VO, VDP, VDAC, HDMI or CRG54/67/68/71 entry.** So `clk_disable_unused` has no clock object for them and cannot switch them off.
- The bits that keep the pipeline alive, if you want to verify them from devmem [read: `hi_reg_crg.h`]:
  - PERI_CRG54 @0xd8: bit0 `vo_bus_cken`, bit2 `vo_sd_cken`, bit4 `vo_hd_cken` (HD channel clock), bit31 `vdp_cfg_cken`, bit30 `vou_srst_req` (reset, must stay 0), bits[27:25]/[29] clock source selects.
  - PERI_CRG67 @0x10c: bit0 `hdmitx_ctrl_bus_cken`, bit4 `hdmitx_ctrl_os_cken`, bit5 `hdmitx_ctrl_as_cken`, bit8/9 resets.
  - PERI_CRG68 @0x110: bit4 `hdmitx_phy_srst_req`.
  - PERI_CRG71 @0x11c: VDAC chop clock (analog output only; irrelevant to HDMI).

Judgment [inferred]:
- Primary risk is **not** clock gating but (a) **memory reuse** (the page allocator or ramoops overwriting the scanout buffer; fix with `reserved-memory ... no-map`), (b) **a driver in our tree that resets or touches CRG54/67/68** (none today; the SATA/USB/ETH nodes use other registers and `resets = <&crg 0xa8 ..>`/`0xb0` offsets only), and (c) a future reset-controller probe that asserts everything. Do not add `resets` for these offsets.
- Pass `clk_ignore_unused` on the cmdline during bring-up. It also keeps unrelated clocks, so remove it once stable. Naming the clocks in the simplefb node is **impossible** here (no clock object exists); do not add `clocks = <...>`.
- `pd_ignore_unused` is irrelevant: this SoC has no genpd domains in our tree [inferred].
- 4.4.35 `PERI_CRG54` etc. bit layout is the cv200 variant [read]; an ES/other-stepping layout differs (`drv_disp_hal.c:289` handles `DISP_CV200_ES_*`). Our chip's stepping is not known to match. [unknown]

## 6. HDMI TX IP identity

**HiSilicon-own, not Synopsys DesignWare [inferred, strong].**
- The Hi3798CV200 build uses `hdmi_2_0` with a `product/Hi3798CV200/` directory [read: VT `drivers/msp/drv/hdmi/hdmi_2_0/product/Hi3798CV200/hdmi_product_define.h`]. (`hdmi_1_4` is Silicon Image-derived `si_*` code and is for older chips; `hdmi_1_4/drv_reg_proc.h` lists cv100 at a different base 0xff100000 [read].) Which of 1_4/2_0 is selected is a Kconfig/cfg item not present in the tree, so "cv200 = 2_0" is inferred from the product directory.
- Register map in that header: base 0xf8ce0000 with sub-blocks CTRL 0x0000, "AIDEO"(video) 0x0800, AUDIO 0x1000, HDMITX 0x1800 (PHY/tx core), HDCP1X 0x2000, AON 0x4000, CEC 0x4800, **MCU PRAM 0x10000 / DRAM 0x18000** [read: lines 63-73]. An 8051 firmware MCU (`C8051_PRAM_BASE_ADDR 0xf8cf0000` in `hdmi_hal.c:84`) is not a DesignWare feature.
- A grep of `hdmi_2_0` for `dw_hdmi|designware|synopsys` returns nothing [read].
- Consequence: mainline's `dw-hdmi` bridge does not apply. Mainline has no driver for this block, matching docs/261011-himedia-peripherals-plan.md:35. The simplefb plan depends on the bootloader having left HDMI running.

## 7. Unknowns and next steps

1. Run the section-1 reads on the box (needs the user; I did not touch it). Feed them to the decoder.
2. [unknown] G0_ADDR / size / stride unit / ifmt / whether fastboot chose a different mode from EDID.
3. [unknown] whether the display survives the handoff to our kernel at all (fastboot -> U-Boot -> `bootm`): our kernel boots from a stick through U-Boot; whether that path re-initialises the VDP is not determinable offline. If the logo is on screen at the moment our kernel starts, it is alive.
4. [unknown] whether the VDP keeps reading a buffer that Linux later overwrites: the `no-map` reservation prevents Linux from using it.
5. If the screen goes black during kernel boot, read DHD0_CTRL bit31 and CRG54 bits to distinguish "channel disabled" from "buffer unreadable".

## 8. Sources read

- `VT/drivers/common/include/hi3798cv200/hi_reg_vdp.h` (G0/GP0/DHD0 offsets and bitfields)
- `VT/drivers/msp/drv/vo/vdp_v4_0/hal/98cv200/inc/vdp_define.h`, `vdp_hal_gfx.c` (ifmt table, base address, layer stride, IRESO encoding)
- `VT/drivers/common/include/hi3798cv200/hi_reg_crg.h` (CRG54/67/68/71 bits)
- `VT/drivers/msp/drv/hifb/inc/drv_hifb_logo.h`, `src/drv_hifb_logo.c` (logo layer, boot format codes)
- `VT/drivers/msp/drv/hdmi/hdmi_2_0/product/Hi3798CV200/hdmi_product_define.h`, `hdmi_1_4/drv_reg_proc.h`
- `emmc-dump/baseparam.img`, `logobak.img`, `logo.img`, `fastboot.img`, `bootargs.img`
- mainline `crg-hi3798cv200.c` (6.18.55), our `hi3798cv200-himedia-q10-pro.dts`
