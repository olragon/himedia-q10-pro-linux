# HiMedia Q10 Pro: display mode switching, 4K, HDR and HDMI audio passthrough - research and plan

Date 2026-10-12. Offline research, no box access, nothing committed, nothing run on hardware.
Tags: **[read]** = read in a named file; **[decoded]** = decoded here from the stock kernel image;
**[inferred]** = reasoned, not observed; **[unknown]** = cannot be settled offline.

Abbreviations.
VT = `~/src/hisilicon-kernel-4.4.35` (vendor SDK, `drivers/msp/drv/...`).
CM = community tree `~/src/histb-linux-6.12.y`
(`drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c`, `drivers/clk/hisilicon/crg-hi3798cv200.c`,
`drivers/gpu/drm/hisilicon/histb/histb-vdp.c`).
K618 = `$HIMEDIA_ROOT/vdp-port/linux-6.18.55` (our kernel base).
STOCK = `$HIMEDIA_ROOT/stock-android-kexec/vmlinux.bin`.

## 0. Verdict (read this first)

1. **The question's premise is wrong in a useful way: this is not a DesignWare HDMI TX.** It is a
   Silicon Image (SiI "imagev200", TPI-register style) HDMI 2.0 TX core with a HiSilicon analog PHY.
   Mainline `dw-hdmi` cannot be used, with or without glue. [read: sec. 1]
2. **The hard part is already written and is in the community tree.** CM has a complete DRM bridge
   for this exact TX (`histb-hdmi.c`, 1,944 lines: EDID over the TX's own DDC master, hot-plug,
   PHY tables, SCDC/scrambling for >340 MHz, VideoPath RGB/444/422/420, deep colour, infoframe
   write for AVI/audio/SPD/vendor/DRM) **and a 25-entry HPLL pixel-clock plan** inside the CRG
   driver, **and** a VDP modeset path that programs DHD0 timing per mode. Every one of the 25 PLL
   presets except 593.407 MHz is a row of the stock vendor kernel's format table, word for word (I
   decoded the table out of STOCK, sec. 2.2).
   So this is a port and a bring-up, not a reverse-engineering job.
3. **Mainline has none of it** (K618: no `bridge/hisilicon`, no HPLL, no HDMI gates). Our patch 0012
   covers 7 VO/VDP gates only.
4. **HDR10 signalling is almost free** once the bridge exists: K618's `drm_hdmi_state_helper`
   builds the DRM infoframe from `HDR_OUTPUT_METADATA`, and CM already maps type DRM to the TX
   buffer (selector 9 = vendor `GEN4 // use this for DRM`). The expensive part of HDR is the
   **10-bit video plane (P010) and 10-bit output**, which we do not have.
5. **Passthrough (AC3/DTS core) is a small step on top of the audio recipe we already have**; HD
   formats (E-AC3 192 kHz, TrueHD, DTS-HD MA) need HBR and are a separate, larger step.

**Smallest first step (no kernel change, no risk of a hang):** a read-only register snapshot on
the box (sec. 5, step 0), then **toggling between the two 1080p60-timing clock plans by rewriting
only the two HPLL words** (`0xf8a22028/0xf8a2202c`: `0x12000000/0x00002063` = 148.500 MHz = 60.000 Hz
<-> `0x12e6a7ef/0x00002062` = 148.352 MHz = 59.940 Hz). Timing is identical for both (2200x1125), so
DHD0, the TX and the AVI infoframe are not touched. **Which plan fastboot left is unknown**: the
stock vendor table gives its own `FMT_1080P_60` the 148.352 plan (sec. 2.2), so the box may already
run 59.94 Hz while every tool calls it "60". It proves, in
one shell script under `q10-wd-run` with a dead-man restore, that (a) we can drive the HPLL from
Linux, (b) the TX PHY/PLL and the TV tolerate a live clock change, (c) the community presets apply
to this board. If it works, 1080p50 (a pure DHD0 retime on the same 148.5 MHz plan) is next.

Recommended architecture after those two experiments: **adopt the community stack** (CRG pixel
clock + `histb-hdmi` bridge + VDP modeset) instead of growing our adopt-only driver, with one
local change: make the bridge probe non-destructive (sec. 5.2).

## 1. Which HDMI TX is it

### 1.1 Identity

| Item | Value | Evidence |
| --- | --- | --- |
| Register window | `0xf8ce0000`, 0x20000 bytes (DT `hdmi@8ce0000`, SPI 88 `tx`, SPI 147 `cec`) | CM `hi3798cv200.dtsi:856-860` [read]; VT `hdmi_2_0/product/Hi3798CV200/hdmi_platform.h:41` `HDMI_CTRL_BASE_ADDR 0xf8ce0000` [read] |
| Sub-blocks | CTRL 0x0000, AIDEO 0x0800, AUDIO 0x1000, HDMITX 0x1800, HDCP1X 0x2000, AON 0x4000, CEC 0x4800, MCU PRAM 0x10000, MCU DRAM 0x18000 | VT `hdmi_product_define.h:63-74` [read] |
| Core family | **Silicon Image "imagev200"**, selected for `hi3798cv200` by `CTRL_DIR := hal/ctrl/imagev200` | VT `drivers/msp/drv/hdmi/Makefile:180-185` [read] |
| Register style | 8-bit registers, one per 32-bit word, 256-byte "pages": `phys = 0xf8ce0000 + ((page<<8 \| reg) << 2)` | VT `imagev200/platform/platform.c:11,24`; CM `HISTB_HDMI_REG()` [read]; the formula was cross-checked against the vendor's own `himm` comments in the audio recipe |
| SiI idioms in the code | `SiiDrv*`, `TPI_INFO_FSEL`, `TPI_DDC_MASTER_EN`, `CBUS`/MHL, `PKT_FILTER`, `TEST_TXCTRL` | VT `si_drv_tx_regs.h`, `si_mod_tx_hdmi.c` [read] |
| 8051 MCU | only used for HDCP 2.2 firmware | VT `hdmi_hal.c:1970-1995`; audio recipe sec. 0.3 [read] |
| DW-HDMI? | **No.** No `design_id/product_id` pair at offset 0; the map is page-based TPI, not `HDMI_IH_*`/`HDMI_FC_*`/`HDMI_MC_*` | structure [read]; no `dw_hdmi`/`designware`/`synopsys` string in the vendor driver (earlier research, `docs/261011-himedia-hdmi-simplefb-research.md` sec. 6) [read] |

**ID registers (the DW trick does not apply, the SiI equivalent does).** Page 0, offsets 0..5
(VT `si_drv_tx_regs.h:37-70`: `VND_IDL 0x0000`, `DEV_IDL 0x0002`, `DEV_IDH 0x0003`,
`DEV_REVL 0x0004`, `DEV_REVH 0x0005`; `TPI_DEV_ID` is page 6 reg 0x1b):

| Register | Physical address |
| --- | --- |
| VND_IDL / VND_IDH | `0xf8ce0000` / `0xf8ce0004` |
| DEV_IDL / DEV_IDH | `0xf8ce0008` / `0xf8ce000c` |
| DEV_REVL / DEV_REVH | `0xf8ce0010` / `0xf8ce0014` |
| TPI_DEV_ID | `0xf8ce186c` |

**No register dump of the HDMI TX, the HPLL or the PHY exists anywhere in the repo or under
`$HIMEDIA_ROOT`** (`vdp-regs-*.txt`, `regs-android-*.txt`, `recon` hold only VDP,
USB, SATA, CRG gates; I grepped for `f8ce`, `f8a22028`). The IDs are therefore **[unknown]** until
step 0 reads them. They are a sanity check only; the vendor code does not gate on them.

### 1.2 Can mainline `dw-hdmi` be the bridge with a small glue? No.

`dw-hdmi` hard-codes the DW register layout (`HDMI_IH_*`, `HDMI_FC_*`, `HDMI_PHY_*`, I2C PHY gate,
`dw_hdmi_plat_data` supplies only mode validation, PHY ops and clock quirks). Every one of those
offsets is wrong for a SiI TPI core, and the PHY here is not Synopsys' either. The correct reuse
is **not** `dw-hdmi` but the same *DRM-level* helpers dw-hdmi users get:
`DRM_BRIDGE_OP_HDMI` + `drm_atomic_helper_connector_hdmi_check` + `drm_scdc_helper`, which CM's
`histb-hdmi.c` already uses and which K618 has (`include/drm/drm_bridge.h:649-691`,
`drivers/gpu/drm/display/drm_hdmi_state_helper.c`) [read].

### 1.3 The PHY and its configuration

HiSilicon in-house analog PHY, configured through page 7 of the same window, in **buckets by TMDS
rate** (not a pixel-clock -> PLL table; the PHY has its own TX PLL, set by a handful of bytes).
CM `histb_hdmi_phy_configure()` (l.~790) writes ~19 registers from a 5-entry table; the vendor has
7 (6 plus a dongle variant).

| TMDS rate | Vendor entry (VT `hdmi_hal.c:411-421`, STB SDK) | CM entry |
| --- | --- | --- |
| < 74.25 MHz | swing 0x19 clk 0x1f term 0xd5 zone 3 fall 0x10 | same |
| 74.25-165 | same, zone 2 | same |
| 165-190 | swing 0x19, zone 1 | swing **0x20**, zone 1 (merged with 190-297) |
| 190-297 | swing 0x20, zone 1 | same |
| 297-340 | swing 0x20, zone 1, fall **0x90** | same |
| >= 340 | swing 0x36 clk 0x12 term 0x7f fine 0x03 zone 0 (dongle: swing 0x3b) | same, no dongle variant |

Differences are confined to 165-190 MHz (no standard mode lives there) and the dongle variant
[read, both files]. Other constants (`PLL_BAND 0x14`, `PLL_LOOP 0x32`, `PLL_VCO 0x68` ...) match
across all rows. Mode switching inside one bucket (60 <-> 59.94 <-> 50 <-> 24 <-> 30) does not
change PHY bytes except `tx_reg_zone` at the 74.25 MHz edge (74.176 MHz -> bucket 0, 74.25 -> 1).

## 2. The video PLL that feeds the VDP pixel clock

### 2.1 What it is

One PLL, **HPLL**, drives both the VDP HD channel (`vo_hd`) and the HDMI pixel clock; they are
separated only by dividers. Registers in the CRG window `0xf8a22000`:

| Register | Offset | Role |
| --- | --- | --- |
| `PERI_CRG_PLL10` = HPLL ctrl0 | 0x28 | `[23:0]` frac, `[26:24]` postdiv1, `[30:28]` postdiv2 |
| `PERI_CRG_PLL11` = HPLL ctrl1 | 0x2c | `[11:0]` fbdiv, `[17:12]` refdiv, `[24:20]` power-down bits, `[25]` DSMPD, `[26]` bypass |
| HPLL lock | 0x150 | bit 4 = lock |
| `PERI_CRG54` | 0xd8 | VO: `[16]` VO_HD_CLK_SEL, `[19:18]` VO_HD_CLK_DIV (0 = /2, 1 = /4, 3 = /1), `[25]` HDMI_CLK_SEL, `[27]` VDP_CLK_SEL, `[29]` VO_HD_HDMI_DIV, `[30]` VOU soft reset, `[31]` vdp_cfg |
| `PERI_CRG67` | 0x10c | HDMI TX bus/core clocks, `[14]` ASCLK_SEL, `[8]`/`[9]` resets |
| `PERI_CRG158` | 0x278 | HDMI pixel: `[2]` pixel gate, `[4]` pixelnx sel, `[5]` osclk sel, `[6]` id sel |
| `PERI_CRG211` | 0x34c | VDP gates, `[20]` hd div0, `[22]` init sel0, `[23]` vo_bp clk sel |

Sources: CM `crg-hi3798cv200.c:88-130` (names), VT `drivers/common/include/hi3798cv200/hi_reg_crg.h`
(`U_PERI_CRG_PLL10/11` at l.134-165, `U_PERI_CRG158` at l.1969) [read].

Rate math (community, matches the vendor plan): `VCO = 24 MHz * (fbdiv + frac/2^24) / refdiv`;
`pixel = VCO / (postdiv1 * postdiv2) / D` with total output divider **D = 4 up to 340 MHz and
D = 2 above** (VO_HD /2 or /1 on top of a fixed /2) (CM `hi3798cv200_hdmi_pixel_find_rate`,
`crg-hi3798cv200.c:1051-1135`) [read]. Example 1080p60: VCO = 24*99/2 = 1188 MHz, postdiv 2*1,
/4 -> 148.5 MHz.

### 2.2 How the vendor programs it per mode (decoded from the stock kernel)

The vendor's per-format table `DISP_FMT_CFG_S[]` (timing + `u32Pll[2]` = HPLL ctrl0/ctrl1 +
format info) is in compiled form in STOCK. I decoded all rows with
`scripts/himedia/display/stock-fmt-table.py` (new, named, reusable; run with no arguments;
table at file offset `0xd0edd0`, stride 0x90). Selected rows **[decoded]**, `pixel` computed with
D = 4 (or 2 where > 340 MHz):

| Format | ctrl0 / ctrl1 | refdiv fbdiv frac | postdiv | pixel clock |
| --- | --- | --- | --- | --- |
| **stock `FMT_1080P_60`** (fmt 0, Hfb 88, 60 Hz label; row repeated once with Hfb 528) | `14e6ae6a` / `00001062` | 1, 98, 0xe6ae6a | 4*1 | **148.352** (VCO 2373.6 MHz) |
| 1080p60 on the VESA-1920x1080 row (fmt 55) | `12000000` / `00002063` | 2, 99, 0 | 2*1 | 148.500 |
| 1080p59.94 (fmt 74) | `12e6a7ef` / `00002062` | 2, 98, 0xe6a7ef | 2*1 | 148.352 |
| 1080p50 (fmt 1) | `12000000` / `00002063` | 2, 99, 0 | 2*1 | 148.500 |
| 1080p30/25/24 | `14000000` / `00002063` | 2, 99, 0 | 4*1 | 74.250 |
| 1080p29.97/23.976, 720p59.94 | `14e6a7ef` / `00002062` | 2, 98, 0xe6a7ef | 4*1 | 74.176 |
| stock `FMT_1080i_60` (fmt 5), `FMT_720P_60` (fmt 7) | `14e6ae6a` / `00002062` | 2, 98, 0xe6ae6a | 4*1 | 74.176 |
| 720p50 | `14000000` / `00002063` | same | 4*1 | 74.250 |
| 576p50 / 480p60 | `14000000` / `00002063` | same | 4*1 | 74.250 (a double-clock 27 MHz mode on the 2x path) |
| 2160p24/25/30 | `11000000` / `00002063` | 2, 99, 0 | 1*1 | 297.000 |
| 2160p23.976/29.97 | `11e6a7ef` / `00002062` | frac 0xe6a7ef | 1*1 | 296.703 |
| 2160p50/60 | `11000000` / `00002063` | same | 1*1 | **594.000** (D = 2, VO_HD_CLK_DIV = /1) |
| VESA 1024x768, 1280x1024 ... | various | | | 65 ... 268.5 |

CM's 25 presets (`crg-hi3798cv200.c:1011-1041`) equal rows of this table word for word (checked
by eye for all of them; the one exception is 593.407 MHz, i.e. 2160p59.94, which has no stock row),
including the `request_rate` vs `rate` split (`74176000/74175750`, `148352000/148351500`,
`593407000/593406000`) **[read vs decoded]**. Pattern worth knowing: **the vendor runs its 60 Hz
CEA formats (`FMT_1080P_60`, 1080i60, 720p60) on the 1000/1001 clock, with the frac `0xe6ae6a`
(refdiv 1 or 2) rather than CM's `0xe6a7ef`; both give 148.3516 MHz to 5 digits.** CM did not adopt
the `e6ae6a` variants; either is a valid 59.94 plan. Notably the community presets already key on the **CEA alternate
clocks 74176 / 148352 / 296703 / 593407 kHz**, which is what a 1000/1001 mode from userspace
carries.

### 2.3 Do mainline clocks cover it? No.

K618's `crg-hi3798cv200.c` has no HPLL, no VO/VDP/HDMI gate and no pixel clock (earlier research
`docs/261011-himedia-hdmi-simplefb-research.md` sec. 5; our 0012 adds 7 gates ids 90..96 because
the community ids 70..77 and 90 collide with our inner-clock window). CM adds, in the CRG driver:
a custom `clk_hw` `clk_hdmi_pixel` (parent `clk_osc` 24 MHz; ops `prepare/enable/round_rate/
set_rate/recalc_rate`, ~480 lines, l.987-1470) with **rollback to the old PLL setting if the new
one does not lock**, plus 9 HDMI gates (`HISTB_HDMI_BUS/CEC/ID/MHL/OS/AS/X/PIXEL_NX/PIXEL_CLK`,
ids 78-86). Porting = rebase onto our 0009/0010/0012 numbering (id renumber) and our 6.18 CRG
file; no API drift (`clk_hw` ops are stable). The HDMI + VDP DT clock lists need the matching ids
(DT `hdmi@8ce0000` clocks list, CM l.862-872 [read]).

### 2.4 Things to confirm on the box (not offline-decidable)

- That the boot HPLL really holds `0x12000000/0x00002063` for 1080p60 and `VO_HD_CLK_SEL`,
  `HDMI_CLK_SEL` are set in CRG54 (the community "plan matches" test does exactly this read).
- **What fastboot actually programmed for "1080p60".** Our adopted mode prints `148500` kHz, but
  that number comes from the DHD0 *totals* (2200 x 1125 x 60), not from a measured clock. If
  fastboot used the vendor `FMT_1080P_60` row, HPLL holds `0x14e6ae6a/0x00001062` and the real
  rate is 59.94 Hz. Step 0 reads it.
- Whether anything else on the SoC depends on HPLL staying at its boot value [unknown]. The audio
  clock uses EPLL 933.888 MHz (`aiao` DT node), not HPLL [read].

## 3. VDP timing generator (DHD0) - what to program for a new mode

We adopt these today (read back by `histb_vdp_hw_read_mode`, patch 0011 l.1033+, and shown by the
boot probe: `1920x1080 60 148500 1920 2008 2052 2200 1080 1084 1089 1125`, `DHD0_CTRL=0x80008010`,
`DHD0_VTTHD=0x83dd0438`, `vdp-regs-k15b.txt`). Writing them is the inverse and is what CM does in
`histb_vdp_program_timing()` (`histb-vdp.c:652-730`) [read]. With `hfront = hsync_start-hdisplay`,
`hsync = hsync_end-hsync_start`, `hback = htotal-hsync_end`, `vfront/vsync/vback` likewise:

| Register | Offset | Value |
| --- | --- | --- |
| `DHD0_HSYNC1` | 0xc008 | `(hdisplay-1) \| ((hback+hsync-1) << 16)` (blanking fields include the sync pulse) |
| `DHD0_HSYNC2` | 0xc00c | `hfront-1` |
| `DHD0_VSYNC` | 0xc004 | `(vdisplay-1) \| ((vback+vsync-1) << 12) \| ((vfront-1) << 22)` |
| `DHD0_PWR` | 0xc014 | `(hsync-1) \| ((vsync-1) << 16)` |
| `DHD0_VPLUS` | 0xc010 | 0 (bottom-field, progressive) |
| `DHD0_VTTHD` | 0xc01c | vblank-IRQ threshold, we already set `vdisplay` |
| `DHD0_SYNC_INV` | 0xc020 | CM keeps the DHD default `HSYNC_INV`; HDMI HS/VS are not inverted |
| `DHD0_DATA_SEL`, `HDMI_CLIP_L/H` | 0xc02c, 0xc090/94 | 0, 0, full |
| `DHD0_CTRL` | 0xc000 | `iop` b4, `hdmi_mode` b14, `twochn_debug` b15, `intf_en` b31, `regup` b0 |
| `VOCTRL` | 0x0000 | `twochn_en` b24, `twochn_mode` b25 (two pixels per clock; the vendor hard-codes it, CM always sets it), clock-gate b31 |
| `GP0_IRESO/ORESO/DLPOS/VLPOS`, `G0_*` | 0x8008.. , 0x7020.. | scanout size = mode size (1:1) |

Check against the vendor: the stock row for 1080p50 carries `Hpw 44, Vpw 5, Hbb 192 (=148+44), Hfb
528` [decoded], which is exactly the encoding above. The sequence CM uses (and the vendor):
stage DHD0 CTRL with `intf_en` off -> write timing and routing -> stage `intf_en` on -> second
`regup`. **Every write needs a `DHD0_CTRL` bit0 `REGUP` strobe to latch.**

Differences between **60 and 59.94** and **24 vs 23.976**: none in DHD0 (identical totals). Only
the HPLL words change. 50 Hz differs by `hfront = 528` (htotal 2640) and nothing else.

What we do not have to write: nothing in the VDP needs a soft reset to change timing live
[inferred]; CM resets because it also takes over from fastboot cold. Resetting (CRG54 b30) drops
the whole pipe and the HDMI link would have to be retrained: avoid in early steps.

## 4. HDR infoframe and audio passthrough

### 4.1 HDR

What the stack provides (all [read]):
- Bridge side: `DRM_BRIDGE_OP_HDMI` with `max_bpc = 12` makes `drmm_connector_hdmi_init()` attach
  `HDR_OUTPUT_METADATA` (K618 `drm_connector.c:620-622`: `if (max_bpc > 8) attach_hdr_...`).
  `drm_atomic_helper_connector_hdmi_check` builds the DRM infoframe
  (`drm_hdmi_state_helper.c:~730-752` `hdmi_generate_hdr_infoframe`) and calls the bridge's
  `hdmi_write_infoframe(HDMI_INFOFRAME_TYPE_DRM)`.
- TX side: CM maps type DRM to TPI selector 9 (`histb_hdmi_infoframe_select`), identical to VT
  `si_mod_tx_hdmi.c:53` (`FSEL__GEN4 0x09 // use this for DRM`). The AVI `Colorspace` (BT.2020)
  is the standard `Colorspace` connector property that the same helper fills.
- Sink side: `drm_edid` parses the HDR static metadata block into `hdr_sink_metadata`
  (K618 `drm_edid.c:5397,5459`), which Kodi reads through the blob.

What is missing (ours):
- **EDID.** Today the connector has no DDC. CM's TX DDC master (`histb_hdmi_read_edid_block`,
  FIFO + segment pointer, ~400 lines) is the only way; the stock `baseparam.img`'s
  `BASE_KEY_EDID_CONTENT` is **512 zero bytes** [read], so no sink data is cached anywhere.
- **10-bit video.** The V0 plane is 8-bit NV12 only; P010/10-bit and tile input are listed as
  "not done" in `docs/261011-himedia-vdp-drm-port.md` sec. 8. DHD0 -> TX at 10 bpc is configured by
  CM (`histb_hdmi_configure_output_depth`: P2T pack mode, PHY depth) but the VDP's own output
  depth for DHD0 [unknown]. HDR10 content can be signalled while carried at 8 bit (banding, PQ
  still decodes) as an intermediate state: useful to prove the TV switches to HDR mode.
- **Vendor HDR core** (`vdp_drv_hdr.c`, VDM/CVM tone mapping) is the closed PQ path; CM and our
  driver keep it in identity/disabled on purpose. HDR10 passthrough needs no tone mapping.
- Dolby Vision, HDR10+, HLG: HLG uses the same DRM infoframe (EOTF code); the others are out.

### 4.2 Audio passthrough

What `hdmi-codec`/the bridge audio helpers give (K618): `DRM_BRIDGE_OP_HDMI_AUDIO` with
`hdmi_audio_prepare(..., hdmi_codec_daifmt, hdmi_codec_params)` where `params->iec` carries the
IEC958 channel status (AES0 bit 1 = non-audio) and `params->cea` the audio infoframe; it also
registers the ELD/"IEC958 Playback Default" controls Kodi uses to detect sink codecs
(`include/drm/drm_bridge.h:695-749, 956-967, 1098-1126`; `drm_hdmi_audio_helper.c`) [read].
CM does **not** use it (no `hdmi-codec` in `histb-hdmi.c`; audio recipe sec. 0.5).

What the TX needs for IEC61937 (from the audio recipe, `docs/261011-himedia-hdmi-audio-recipe.md`):
- Same I2S path as PCM (TX3 -> AIP SD0, N=6144 at 48 kHz, hardware CTS), plus **channel-status
  byte 0 bit 1 = 1** (`I2S_CHST0`, `0xF8CE2878`) - the recipe writes 0 there today.
- **AIAO `bypass_en`** (`TX_DSP_CTRL` bit 27) = 1 and volume/fade off, otherwise the AIAO DSP
  would scale or fade the compressed words and break the bit stream [vendor has the knob:
  `AIAO_LOW_SetBypass`, VT `aiao_v1_1/common/src/hal_aiao_priv.c:2289-2297`; our
  `q10_aiao.c:168` writes bypass 0 explicitly]. The vendor routes compressed audio through
  **SPDIF**, I2S for PCM (`SND_AOP_TYPE_SPDIF "lbr or hbr(ddp)"`, recipe sec. 0.1); the TX accepts
  both (`AUD_MODE` bit 1 SPDIF_EN, `PERI_HDMITX_CTRL0` `0x01` SPDIF / `0x08` HBR).
- Audio InfoFrame: CT = 0 ("refer to stream header"), as the recipe already sends.
- ALSA side: `q10_hw` accepts only `S16_LE`/48 kHz/2 ch (`q10_aiao.c:332-338`); an IEC958
  `AES0 nonaudio` control must exist and be copied to `I2S_CHST0..4` at `trigger START` (or switch
  to ASoC so `hdmi-codec` supplies it, sec. 5 step e).
- Rates: the AIAO clock is EPLL 933.888 MHz = 48 kHz family (192 kHz and 96 kHz reachable by
  divider, **44.1 kHz family not** [inferred from the divider table]). Content at 44.1 is resampled
  in user space; compressed formats are 48/192 kHz anyway.

Passthrough tiers [inferred]:
| Tier | Formats | Needs |
| --- | --- | --- |
| P1 | AC3, DTS core (IEC61937, 2 ch 48 kHz) | CHST0 non-audio bit, AIAO bypass, ALSA IEC958 control |
| P2 | E-AC3 (DD+), DTS-HD HRA | 192 kHz sample packets: AIAO divider, `TPI_AUD_FS`, N=24576 (vendor table `hdmi_hal.c:~357`) |
| P3 | TrueHD, DTS-HD MA | HBR: `AUD_MODE` HBRA_ON, 4 I2S lines (8 ch @ 192 kHz) or SPDIF HBR; unknown whether AIAO TX3 can drive 4 SD lines |

## 5. Staged plan

Common safety net for every hardware step (all exist today):
- Run under `q10-wd-run` (SP805 watchdog, resets into the stick kernel in ~2 min if the shell
  stops petting; pattern: `scripts/himedia/vdp/vdp-reload.sh`). **A bad display mode never needs
  a power cycle by itself: the box keeps its network and ssh**, and every boot restarts from
  fastboot, which reprograms the whole chain at 1080p60. The mode is never persisted (the stock
  mode store is `baseparam.img`, which we do **never** write).
- **Dead-man restore:** the script takes a snapshot of every register it will write (sec. 5.0),
  starts `( sleep 20; restore ) &` before the first write, and cancels it only after the operator
  (or a vblank-rate/FDET check) confirms. This makes "TV blank" self-healing in 20 s without
  waiting for the watchdog.
- Only use modes the sink accepts. Until EDID is read that means 1080p50/60/59.94, which any
  HDTV takes; 24/30 Hz variants are common but not universal [inferred].
- Never reset the VDP (CRG54 b30) or the HDMI core/bus (CRG67 b8/9) in steps a-b: a reset drops the
  link and moves risk from "retime" to "retrain".

### 5.0 Step 0: read-only snapshot (30 min, risk none)

Reads (busybox devmem as root, or via `scripts/himedia/android-reg-dump.sh` style): HDMI IDs
(table in 1.1); `0xf8ce03dc` TEST_TXCTRL (bit1 HDMI mode); AVI infoframe (select 0 at
`0xf8ce1afc`, bytes at `0xf8ce1b00..`); VideoPath FDET `0xf8ce2e00` (status) / `0xf8ce2e30` (pixel count) / `0xf8ce2e38` (line count)
(page B regs 0x80/0x8c/0x8e from CM's defines, `((0xb<<8|reg)<<2)`); PHY page 7 regs
0xb0..0xf8 = `0xf8ce1cc0..0xf8ce1fe0` (`((7<<8|reg)<<2)`, e.g. DATA_SWING 0xb3 = `0xf8ce1ccc`); HPLL `0xf8a22028`, `0xf8a2202c`, `0xf8a22150`; CRG
`0xd8`, `0x10c`, `0x110`, `0x278`, `0x34c`; DHD0 block (already collected). **Pass criteria:** HPLL
equals one of the two known 1080p60-timing plans (`12000000/2063` or the stock `14e6ae6a/1062`;
anything else means the table is not what fastboot used), PHY bytes equal CM bucket 1, TX is in HDMI mode, FDET counts equal 2200 x 1125. A
mismatch means the community tables are not drop-in for this board and every later step must be
re-derived from this snapshot. Effort: 30 minutes plus writing the decode into a named script.

### 5.1 (a) Refresh-rate switching inside the 148.5 MHz family

| Sub-step | Change | Effort | Risk | Test |
| --- | --- | --- | --- | --- |
| a1 | the two 1080p60-timing plans (`12000000/2063` 60.000 Hz <-> `12e6a7ef/2062` 59.940 Hz): **HPLL words only**, no kernel patch, devmem script. Start by reading which one is live (step 0) | 1 h | Very low. A bad HPLL value = no TMDS clock until restored; restore is one write. Lock bit 0x150[4] verifies | measure the real vblank rate (VOINTSTA counter over 60 s, or `modetest` vblank timestamps): the two plans differ by 0.06 Hz, so count over >= 60 s; TX FDET counts unchanged |
| a2 | 1080p50: DHD0 retime (`hfront 528`, htotal 2640), same HPLL; update AVI VIC to 31 via the TPI buffer (audio recipe already shows the buffer procedure) | 2 h script | Low-medium. DHD0 re-latch while TX locked; the TV may re-sync | vblank rate = 50.00; TV OSD shows 50 Hz; AVI readback |
| a3 | Put the above into `histb-vdp`: static mode list (1080p60/59.94/50) on the connector, `atomic_check`/`atomic_enable` call `hw_set_timing()` + `hpll_set()` on mode change, DHD0 intf off/on around it | 1-2 days | Medium. First place a DRM full modeset reaches the hardware | `modetest -s <conn>:1920x1080-50`, then Kodi |
| a4 | 24/23.976/25/30: HPLL words `14000000/2063` (74.25) and `14e6a7ef/2062` (74.176), DHD0 totals 2750/2640/2200 x 1125; PHY bucket `tx_reg_zone` flips at 74.25 | +0.5 day | Medium: new PHY bucket (zone 3 vs 2) | as a2 |

Recover: restore script, then 20 s timer, then watchdog.
What a1 deliberately avoids: Kodi's `23.976` needs the 74.176 plan, which is step a4; 59.94 is
only a proving ground.

### 5.2 (b) Other pixel clocks (720p, SD, 74.25 family) - this is where we should adopt the community stack

Once more than two plans are needed, the hand-written live retime is the wrong layer.
Port, in this order, as local patches **0013..0015** (names illustrative):
1. **CRG**: `clk_hdmi_pixel` + 9 HDMI gates + id renumber (sec. 2.3). 1 day to compile/port,
   half a day to verify `recalc_rate` against the step-0 snapshot (read-only first).
2. **`histb-hdmi` bridge** (CM, 1,944 lines) forward-ported to K618: the only API drift I found is
   `bridge.color_format_property`, which K618 does not have (delete the line); the rest of the
   `drm_bridge_funcs` / `hdmi_*` ops match K618's header [read: `drm_bridge.h:649-691`]. 1 day
   port + 1-2 days bring-up.
3. **Make the bridge probe non-destructive** (our one local change, ~20 lines): CM's probe runs
   `histb_hdmi_vendor_reset_sequence()` + `hw_init()` + `tmds_enable(false)` immediately, which
   blanks the boot display at probe. Defer all of that to the first `atomic_pre_enable` and let
   probe only map regs, enable the DDC master and read EDID/HPD [inferred: the DDC master works on
   fastboot's init; verify at step 0 by reading EDID before any reset]. Without this the display
   goes black at `modprobe` and returns only after our modeset succeeds.
4. **`histb-vdp` modeset**: take CM's `histb_vdp_program_timing()` + enable sequence, keep our
   V0 plane. CM also resets the VDP on enable (`resources_enable`, CRG54 b30): in the "own the
   chain" model that is correct and removes the adopt design's assumption; accept one black
   transition at first modeset, under the watchdog. DT: add `ports` (vdp -> hdmi -> `hdmi-connector`)
   and the 9 clocks/3 resets/perictrl `0x8b0` (all exist in our dtsi: `crg` has `#reset-cells=2`,
   `perictrl` syscon) [read].

Risks and tests: black screen on first modeset (recover by ssh + watchdog; run with `fbdev=0`
and a serial/ssh session open); EDID read must work *before* any video change (test with
`edid-decode` on `/sys/class/drm/*/edid` while the picture is up). Gate the rest on that.

### 5.3 (c) 4K

Split by TMDS rate:

| Sub-step | Mode | Needs | Effort | Risk |
| --- | --- | --- | --- | --- |
| c1 | 2160p24/25/30 (297 MHz) | plan `11000000/2063` (postdiv 1*1, D = 4), DHD0 timing (max 4096x2160 allowed by CM `HISTB_VDP_MAX_*`), PHY bucket 3 (swing 0x20, fall 0x90), G0 at 3840x2160 or a scaled UI | 1 day after b | Medium. No scrambling, so the SCDC path stays off |
| c2 | 2160p50/60 (594 MHz RGB 8 bpc) | SCDC: `drm_scdc_set_high_tmds_clock_ratio` + scrambling (`TXC_DATA_DIV 0x02`, `SCR_CTRL`), VO_HD_CLK_DIV = /1, PHY bucket 4 (swing 0x36, term 0x7f), cable/sink at 18 Gbps | 1-2 days | High on cable/sink; code is in CM and unverified here |
| c3 | 2160p60 4:2:0 (297 MHz TMDS) | TX does 444->422->420 (`histb_hdmi_configure_video_path` YUV420 case, `CLK_RATIO 0x81`), AVI = YCbCr420 | +1 day | Medium; [inferred] untested in CM |

Other 4K costs, not in the community driver: (i) a 1080p UI on a 4K timing needs the **GP0 zoom
(ZME)** enabled; CM explicitly clears both GP0 scaler enables and our 2D-scaler coefficients are
not known for GP0 (the V0 ZME is only partially understood, port doc sec. 4 guess 3). Practical:
render the UI at the native 4K (Kodi can) or accept 1080p UI only up to c1/b; (ii) bandwidth: 4K
ARGB at 60 Hz is ~2 GB/s plus a 4K NV12 V0 stream; DDR is shared with the decoder [unknown whether
that is tight]; (iii) twochn mode is already always on in CM.

### 5.4 (d) HDR

1. After step b (bridge + EDID): `HDR_OUTPUT_METADATA` + `Colorspace=BT2020_YCC/RGB` + `max bpc=10`
   (properties exist automatically, sec. 4.1). Effort ~0.5 day to *see* the DRM infoframe go out
   (`/sys/kernel/debug/dri/*/HDMI-A-1/infoframes/hdr_drm`) and the TV switch mode. Risk: low.
2. 10-bit output: bridge pack mode already supported; the DHD0/HDMI input depth and V0 P010 are
   the real work. Effort: several days; risk medium; depends on decoder VPSS emitting P010 [unknown
   per `docs/261011-himedia-vdp-drm-port.md` sec. 8].
3. Tone mapping is out of scope.

### 5.5 (e) Passthrough

| Step | What | Effort | Risk |
| --- | --- | --- | --- |
| e1 | P1 (AC3/DTS core): fold the audio recipe into the bridge (`DRM_BRIDGE_OP_HDMI_AUDIO` or a local equivalent), `q10_aiao` TX3 + non-audio CHST bit + bypass + IEC958 control. Test with `aplay` of an IEC61937 burst file after setting `IEC958 Playback Default` non-audio; check `CTS_TXHVAL` and `AIP_IN_AUD_ID` per recipe 3.2 | 1-2 days | Low: audio cannot blank video; worst case a loud noise on a wrong-format sink, so test with the AVR volume low |
| e2 | Convert `q10_aiao` to an ASoC CPU DAI so `hdmi-codec` supplies ELD + IEC958 + params (Kodi capability detection depends on the ELD, which depends on EDID, step b) | 2-3 days | Medium: audio architecture change |
| e3 | P2/P3: 192 kHz and HBR | days, unknown | Medium-high: AIAO/TX capability unknown |

## 6. Inferences and open questions (ordered by how much they can change the plan)

1. **Do the community presets and PHY bytes apply to this board?** Step 0 answers it. Everything
   in sec. 5 assumes yes; the PLL words are corroborated by the stock table, the PHY bytes by the
   vendor table, the VDP encoding by our own adopted-mode decode.
2. **Does the TV accept the TX re-syncing without an HDMI core reset?** a1/a2 answer it; if not,
   the retime has to go through the full CM sequence (reset, `hw_init`, TMDS off/on).
3. EDID read while the link is up: untested (the community reads it after a reset-based init).
4. Whether HPLL feeds anything else: assumed no.
5. Whether `VOCTRL.twochn` and `DHD0.twochn_debug` are already set by fastboot at 1080p60: probably
   (CM comment says the vendor hard-codes it); read in step 0.
6. 4K HDMI 2.0 on this board's connector, cable and TV: physical, [unknown].
7. 10-bit DHD0 output and the V0 P010 path: unread, open.
8. HBR on AIAO TX3: unread.

## 7. Where the evidence is

| What | Where |
| --- | --- |
| Community HDMI bridge | `CM drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c` (PHY table l.~244-290, `phy_configure` l.~783, EDID l.~960-1100, infoframes l.~1327-1370, SCDC l.~1374-1420, `pre_enable` l.1487-1580) |
| Community pixel clock / HPLL | `CM drivers/clk/hisilicon/crg-hi3798cv200.c:987-1470` (presets l.1011-1041) |
| Community VDP modeset | `CM drivers/gpu/drm/hisilicon/histb/histb-vdp.c:575-730, 838-918, 965-1012` |
| Vendor format table (decoded) | `scripts/himedia/display/stock-fmt-table.py` against `STOCK` offset `0xd0edd0` |
| Vendor TX register map | `VT drivers/msp/drv/hdmi/hdmi_2_0/hal/ctrl/imagev200/driver/si_drv_tx_regs.h` |
| Vendor PHY table | `VT .../imagev200/hdmi_hal.c:411-421, 572-612` |
| Our adopt driver | `scripts/himedia/kernel/arm32/0011-...patch` (mode read-back at l.1033), `0012-...patch`, `docs/261011-himedia-vdp-drm-port.md` |
| Audio recipe | `docs/261011-himedia-hdmi-audio-recipe.md`; `scripts/himedia/audio/q10_aiao.c` |
| K618 helpers | `include/drm/drm_bridge.h:649-749,956-1126`; `drivers/gpu/drm/display/drm_hdmi_state_helper.c`; `drivers/gpu/drm/drm_connector.c:605-625` |
