# HiMedia Q10 Pro (Hi3798CV200): AIAO + Tianlai ADAC programming recipe

Date: 2026-10-11. Scope: a register-level recipe for a mainline 6.18 AArch32 ALSA driver
that plays 48 kHz / S16_LE / stereo from a DDR ring buffer to **(A)** the internal DAC (RCA)
and **(B)** S/PDIF TX. Source: the vendor SDK kernel 4.4.35 at
`~/src/hisilicon-kernel-4.4.35` (read-only). The box ran a 3.18 build of
the same SDK, so the source is authoritative but its match to the box is **inferred**.

Builds on `docs/261011-himedia-ir-keymap-audio-research.md` (addresses), and corrects two
points in it (see the end).

## Conventions

- `V/` = `drivers/msp/drv/aiao/aiao_v1_1/`; `CI/` = `drivers/common/include/hi3798cv200/`.
- **[read]** = I read the line cited. **[inferred]** = derived from code structure, names or
  arithmetic. **[unknown]** = not answerable from this source.
- The build flags in force for `hi3798cv200` [read, `V/Makefile`]:
  `HI_TIANLAI_V600` (l.102-103), `HI_AIAO_TIMER_SUPPORT` (l.117-118),
  `AIAO_PLL_933MHZ` (`V/common/include/hal_aiao_common.h:63`).
  **Not** set: `HI_SND_HDMI_I2S_SPDIF_MUX` (l.63-64 is mv200/mv200_a/mv296 only).
  `HI_SND_MUTECTL_SUPPORT` is board-config dependent (l.40, `CFG_HI_SND_MUTECTL_SUPPORT`);
  this recipe assumes it is **off** [inferred: no mute GPIO is known on the Q10].
- Every register in this IP is 32-bit, little-endian, and the vendor uses read-modify-write
  bit-field writes. Values below are the result of those writes. A field that the vendor never
  writes keeps its reset value, and I mark it.

## 1. Which port drives which jack

| Output | AIAO port | Evidence |
|---|---|---|
| Internal DAC → RCA | **I2S TX2** (`AIAO_PORT_TX2` = 0x12), clock from **TX CRG2**, I2S data source TX2 | [read] `V/ao/drv_ao_op.c:59-66` (`DAC0` → TX2 unless platform S28); `V/common/src/audio_util.c:1102-1119` (cv200 is **S40**, not S28); `V/common/src/hal_aiao.c:1647-1651` (default src/CRG = port index) |
| S/PDIF (optical + coax) | **SPDIF TX1** (`AIAO_PORT_SPDIF_TX1` = 0x21) | [read] `V/ao/drv_ao_op.c:83` (`SPDIF0` → SPDIF_TX1) |
| HDMI (for reference) | I2S TX3 (I2S) or SPDIF TX0 | [read] `V/ao/drv_ao_op.c:92,105` |

The hardware-capability word the vendor hard-codes for cv200 is `0x030D0001`
(`V/common/src/hal_aiao_priv.c:749-751`) [read]: bits 0 (RX0), 16/18/19 (TX0/TX2/TX3),
24/25 (SPDIF TX0/TX1). That matches the table: TX2 and SPDIF TX1 exist. [inferred]

Optical and coax: one SPDIF engine (TX1) is the only consumer-SPDIF port in the vendor's map;
both jacks carry the same stream unless the board splits them. Whether both jacks are wired to
the same pad: **[unknown]**.

## 2. Block addresses

| Block | Physical base | Evidence |
|---|---|---|
| AIAO common (top int, mux, CRG) | `0xF8CD0000` | [read] `hal_aiao_common.h:86`, `hal_aiao_priv.c:501` |
| AIAO CRG sub-block | `0xF8CD0100` | [read] `hal_aiao_common.h:90`, `hal_aiao_priv.h:1482-1486` |
| I2S TX port *n* | `0xF8CD2000 + 0x100*n` → **TX2 = `0xF8CD2200`** | [read] `hal_aiao_common.h:92,100`, `hal_aiao_priv.c:509-512` |
| SPDIF-TX DMA port *n* | `0xF8CD3000 + 0x100*n` → **SPDIF TX1 = `0xF8CD3100`** | [read] `hal_aiao_common.h:93,101`, `hal_aiao_priv.c:514-519` |
| SPDIF encoder ("SPDIFER") *n* | `0xF8CD4000 + 0x1000*n` → **SPDIFER1 = `0xF8CD5000`** | [read] `hal_aiao_common.h:94,102`, `hal_aiao_priv.c:521-526` |
| CRG (PERI_CRG69/70) | `0xF8A22000` | [read] `drivers/common/include/hi_reg_common.h:19` |
| PERI (Tianlai ADAC0/1/2, QoS) | `0xF8A20000` | [read] `hi_reg_common.h:17` |

Map the whole AIAO window: 0x10000 bytes (`hal_aiao_common.h:97`, `hal_aiao_priv.c:494`).

### 2.1 Register offsets (all [read] from struct layouts; offsets computed from the `Reserved[]` arithmetic)

AIAO common, `S_AIAO_COM_REGS_TYPE`, `V/common/include/hal_aiao_priv.h:1461-1493`:

| Off | Name | Bits used here |
|---|---|---|
| 0x000 | AIAO_INT_ENA | per-port enable: RX ch n = bit n, **TX ch n = bit 16+n**, **SPDIF-TX ch n = bit 24+n**; with TIMER_SUPPORT bits 27/28 = timer0/1 (l.106-143) |
| 0x004 | AIAO_INT_STATUS | same layout, masked status (l.146-183) |
| 0x008 | AIAO_INT_RAW | same layout, raw (l.186-223) |
| 0x00C | HW_CAPABILITY | (l.226-263) |
| 0x020 | SPDIF_TX_MUX | pad *k*: `port_sel` [8k+2:8k], `port_en` [8k+3] (l.266-287) |
| 0x024 | HW_VERSION | |
| 0x02C | AIAO_SWITCH_TX_BCLK | 4-bit `inner_bclk_ws_sel_tx_0n` at [4n+3:4n] (l.311-329) |
| 0x030 | AIAO_STATUS | [0] `srst_rdy` (l.332-344) |
| 0x034 | OUT_STANDING | [2:0] `vhb_outst_num` (l.347-359) |
| 0x100 + 8*n | I2S_RX_CRG[n] CFG0/CFG1 (n = 0..5; timer CRG at 0x130/0x138) | |
| **0x140 + 8*n** | **I2S_TX_CRG[n] CFG0, +4 CFG1** → TX CRG2 = 0x150/0x154 | l.1483-1485 |
| **0x180 + 8*n** | **SPDIF_CRG[n] CFG0, +4 CFG1** → SPDIF CRG1 = 0x188/0x18C | l.1486 |

The TX CRG base is 0x140 with or without `HI_AIAO_TIMER_SUPPORT` (6 RX + 2 timer, or 8 RX,
are both 8 entries of 8 bytes). [inferred, arithmetic]

I2S TX port and SPDIF-TX port share one layout (`hal_aiao_priv.h:1517-1561`):

| Off | Name | Notes |
|---|---|---|
| 0x00 | TX_IF_ATTRI / SPDIFTX_IF_ATTRI | l.697-719 / l.956-972 |
| 0x04 | TX_DSP_CTRL | mute, volume, fade, bypass, **tx_enable [28]**, **tx_disable_done [29]** (l.722-743) |
| 0x08 | TX_DSP_STATUS | [6:0] mute_fade_vol |
| 0x20 | TX_WS_CNT | [23:0] debug frame counter |
| 0x24 | TX_BCLK_CNT | [23:0] debug bit-clock counter |
| **0x80** | **TX_BUFF_SADDR** | full 32-bit physical start address (`unsigned int`, l.1526) |
| **0x84** | **TX_BUFF_SIZE** | [23:0] bytes (l.788-799) |
| **0x88** | **TX_BUFF_WPTR** | [23:0] byte offset from SADDR (l.802-813) |
| **0x8C** | **TX_BUFF_RPTR** | [23:0] byte offset from SADDR (l.816-827) |
| 0x90 | TX_BUFF_ALEMPTY_TH | [23:0] bytes (l.830-841) |
| 0x94 | TX_TRANS_SIZE | [23:0] bytes, "period" (l.844-855) |
| 0x98 | TX_RPTR_TMP | [23:0] |
| 0xA0 | TX_INT_ENA | l.872-890 |
| 0xA4 | TX_INT_RAW | l.893-911 |
| 0xA8 | TX_INT_STATUS | l.914-932 |
| 0xAC | TX_INT_CLR | l.935-953 |

Per-port interrupt bits (ENA/RAW/STATUS/CLR all alike, `hal_aiao_common.h:356-374`):
0 `trans` (period done), 1 `empty`, 2 `alempty`, 3 `bfifo_empty`, 4 `ififo_empty`, 5 `stop`,
6 `mfade` (mute-fade done), 7 `dat_break`.

SPDIF encoder, `S_AIAO_SPDIFER_REGS_TYPE`, `hal_aiao_priv.h:1563-1584`:

| Off | Name | Fields |
|---|---|---|
| 0x00 | SPDIF_CTRL | [0] `spdif_en` (l.1209-1220) |
| 0x04 | SPDIF_CONFIG | [0] `txdata_en`, [2:1] `mode` (l.1223-1235). Vendor writes whole word 0 = PCM, 1 = compressed (`hal_aiao_priv.c:2617,2624`) |
| 0x08/0x0C/0x10 | SPDIF_INTRUPT / INTR_MASK / INTR_STATE | L/R FIFO empty/single (l.1238-1286) |
| 0x20 | SPDIF_CH_STATUS1 | L: [0] use_a, [1] use_b (non-PCM), [2] use_c (copy), [5:3] use_d (pre-emph), [7:6] mode; R: same at +8 (l.1289-1309) |
| 0x24 | SPDIF_CH_STATUS2 | [7:0] L category, [15:8] R category (l.1312-1324) |
| 0x28 | SPDIF_CH_STATUS3 | [3:0] L src nb, [7:4] L ch nb, [11:8] R src nb, [15:12] R ch nb (l.1327-1341) |
| 0x2C | SPDIF_CH_STATUS4 | [3:0] L fs, [5:4] L clk accuracy, [11:8] R fs, [13:12] R accuracy (l.1344-1359) |
| 0x30 | SPDIF_CH_STATUS5 | [0] L bit_max, [3:1] L bit_width, [7:4] L orig fs; R at +8 (l.1362-1378) |
| 0x40-0x50 | SPDIF_USER_DATA1..5 | |
| 0xF0 | SPDIF_EDITION | |

CRG and PERI (`CI/hi_reg_crg.h`, `CI/hi_reg_peri.h`):

| Address | Name | Fields |
|---|---|---|
| `0xF8A22114` | PERI_CRG69 | [0] `adac_cken`, [4] `adac_srst_req` (`hi_reg_crg.h:997-1012`, offset l.2797) |
| `0xF8A22118` | PERI_CRG70 | [0] `aiao_cken`, [4] `aiao_srst_req`, [16:12] `aiaoclk_skipcfg`, [17] `aiaoclk_loaden`, [21:20] `aiao_mclk_sel`, **[22] `aiao_clk_sel`** (`hi_reg_crg.h:1014-1035`, l.2798; `drivers/common/drv/include/hi3798cv200/hi_reg_crg.h:1018-1027` agrees) |
| `0xF8A22030/34` | PERI_CRG_PLL12/13 | `epll_ctrl0` [30:0], `epll_ctrl1` [27:0] (`hi_reg_crg.h:173,188,2747-2748`) |
| `0xF8A20044` | PERI_QOS_CFG0 | [2:0] `aiao_arqos`, [6:4] `aiao_awqos` (`hi_reg_peri.h:81-104,1030`) |
| `0xF8A20110` | PERI_TIANLA_ADAC0 | see §5 (`hi_reg_peri.h:435-460,1051`) |
| `0xF8A20114` | PERI_TIANLA_ADAC1 | see §5 (`hi_reg_peri.h:462-479,1052`) |
| `0xF8A20160` | PERI_TIANLA_ADAC2 | see §5 (`hi_reg_peri.h:649-...,1065`) |

`hal_aiao_priv.h:62-103` also defines a `U_S40_AIAO_SYS_CRG` with `aiao_clk_sel` at **bit 8**.
`AIAO_HW_PowerOn` does not use that type; it uses `U_PERI_CRG70` (`hal_aiao_priv.c:565`),
so **bit 22 is the one the shipped code writes** [read].

## 3. Clocks: MCLK / BCLK / FS for 48 kHz

The per-port MCLK is a **fractional (NCO-style) divider off the audio PLL**, 27-bit increment:
`mclk = F_pll * mclk_div / 2^27` [inferred from the table comment
`crg = mclk * FS * pow(2, CRG_POW) / ARM_BPLL_FREQ` (`hal_aiao_priv.c:343`) and the numbers].
F_pll = 933.888 MHz "EPLL" for cv200 (`hal_aiao_common.h:63`).

Check (arithmetic, [inferred]): `0x001AF286 * 933.888e6 / 2^27 = 12 287 995 Hz` = 256 × 48 kHz
(−0.4 ppm; the vendor table truncates, the rounded value would be 0x1AF287).

Table, 933.888 MHz variant (`hal_aiao_priv.c:341-359`) [read], 48 kHz column:

| MCLK | 128 fs | 256 fs | 384 fs | 512 fs | 1024 fs |
|---|---|---|---|---|---|
| `mclk_div` | 0x000D7943 | **0x001AF286** | 0x00286BCA | 0x0035E50D | 0x006BCA1B |
| (44.1 kHz) | 0x000C6102 | 0x0018C205 | 0x00252308 | 0x0031840A | 0x00630815 |

The row is chosen by `BCLK_DIV * FCLK_DIV` (`GetMclkCrg`, `hal_aiao_priv.c:405-462`).
`BCLK_DIV` = MCLK/BCLK, `FCLK_DIV` = BCLK/FS. The register holds an **index**, not the ratio:

- `aiao_bclk_div` index into `{1,3,2,4,6,8,12,16,24,32,48,64,8,8,8,8}` (`hal_aiao_priv.c:134-137,479-492`)
- `aiao_fsclk_div` index into `{16,32,48,64,128,256}` (`hal_aiao_priv.c:139-142,464-477`)

| Port | Vendor ratios | MCLK | BCLK | `mclk_div` | CFG1 bclk idx | CFG1 fs idx | Evidence |
|---|---|---|---|---|---|---|---|
| I2S TX2 (DAC) | FCLK_DIV 64, BCLK_DIV 4 | 256 fs = 12.288 MHz | 64 fs = 3.072 MHz | 0x001AF286 | **3** | **3** | [read] `hal_aiao.c:1460-1474` |
| SPDIF TX1 | FCLK_DIV 128, BCLK_DIV 2 | 256 fs = 12.288 MHz | 128 fs = 6.144 MHz | 0x001AF286 | **2** | **4** | [read] `hal_aiao.c:1569-1578` |

The SPDIF BCLK of 128 fs is the bi-phase-mark cell rate for 64 time slots per frame [inferred].

**EPLL.** No AIAO code writes PERI_CRG_PLL12/13 (grep of `V/`) [read]; `aiao_mclk_sel = 0`
selects it for 933 MHz builds (`hal_aiao_priv.c:590-594`) [read]. Who programs EPLL to
933.888 MHz (fastboot reg table? mainline `crg-hi3798cv200.c`?) is **[unknown]** — read
`0xF8A22030/34` on the box before trusting the table. If EPLL is not at 933.888 MHz, recompute
`mclk_div = round(mclk * 2^27 / F_epll)`.

## 4. Recipe (A): internal DAC on I2S TX2

All writes in order. "RMW" = read-modify-write of the named field only.

### A.1 AIAO global power-up (once, shared with B) — `AIAO_HW_PowerOn`, `hal_aiao_priv.c:562-686` [read]

| # | Address | Write | Meaning |
|---|---|---|---|
| 1 | `0xF8A22118` CRG70 | RMW [4] `aiao_srst_req` = 1 | hold AIAO in reset |
| 2 | `0xF8CD0030` AIAO_STATUS | poll [0] `srst_rdy` == 0 | vendor polls 10 times with no delay, fails if never 0 (l.571-584) |
| 3 | CRG70 | RMW [21:20] `aiao_mclk_sel` = 0 | MCLK source = EPLL 933.888 MHz (l.588-599) |
| 4 | CRG70 | RMW [0] `aiao_cken` = 1; `udelay(1)` | bus/working clock on (l.601-604) |
| 5 | CRG70 | RMW [4] `aiao_srst_req` = 0 | release reset (l.606-608) |
| 6 | AIAO_STATUS | poll [0] `srst_rdy` == 1 | (l.610-623) |
| 7 | CRG70 | RMW [22] `aiao_clk_sel` = 1 | AIAO bus clock 50 MHz (0 = 100 MHz per comment l.664) |
| 8 | CRG70 | RMW [17] `aiaoclk_loaden` = 0 | |
| 9 | CRG70 | RMW [16:12] `aiaoclk_skipcfg` = 0 | |
| 10 | CRG70 | RMW [17] `aiaoclk_loaden` = 1 | latch skipcfg (l.658-677) |
| 11 | `0xF8CD000C` HW_CAPABILITY | read, must be ≠ 0 | vendor's liveness check (l.680-683) |
| 12 | `0xF8CD0034` OUT_STANDING | RMW [2:0] = 2 | bus outstanding transactions (`AIAO_HW_SetOutstanding`, l.720-723, called l.736) |
| 13 | `0xF8CD0000` AIAO_INT_ENA | vendor: `0x07FFFFFF` | all port bits (`hal_aiao.c:390`). Minimal: set only bit 18 (TX2) and/or 25 (SPDIF TX1) |

Expected CRG70 after A.1: `0x00420001` if the other bits reset to 0 [inferred].

### A.2 Ring buffer (port stopped) — `PortBufInit`→`AIAO_HW_SetBuf`, `hal_aiao_func.c:108-169`, `hal_aiao_priv.c:1155-1170` [read]

| # | Address | Value | Meaning |
|---|---|---|---|
| 1 | `0xF8CD2280` TX_BUFF_SADDR | DMA (bus) address | 32-bit physical; **128-byte aligned** (`hal_aiao_func.c:124-127`, `hal_aiao_common.h:143`) |
| 2 | `0xF8CD2284` TX_BUFF_SIZE | bytes | multiple of 128, ≤ 0xFFFF80 (`hal_aiao_common.h:144-145`); vendor = period × periods (`hal_aiao_func.c:57-90`) |
| 3 | `0xF8CD2288` TX_BUFF_WPTR | 0 | byte offset written by software |
| 4 | `0xF8CD228C` TX_BUFF_RPTR | 0 | byte offset advanced by hardware; writable while stopped |
| 5 | `0xF8CD2290` TX_BUFF_ALEMPTY_TH | period bytes | vendor sets threshold = period (`hal_aiao_func.c:166`) |
| 6 | `0xF8CD2294` TX_TRANS_SIZE | period bytes | multiple of 128 (`hal_aiao_func.c:72-85`); vendor default 2048 B × 4 periods (`hal_aiao_common.h:158`, `V/common/include/hal_aiao.h:32-41` `PERIOND_NUM 4` for cv200) |

### A.3 Interface / clock — `AIAO_HW_SetIfAttr`, `hal_aiao_priv.c:1502-1557` [read]

Order the vendor uses: data-select, ch-num, bit-depth, source-select, then master clock, then
duplicate clock.

| # | Address | Field writes | Evidence |
|---|---|---|---|
| 1 | `0xF8CD2200` TX_IF_ATTRI | [25:24] sd0_sel=0, [27:26] sd1_sel=1, [29:28] sd2_sel=2, [31:30] sd3_sel=3 | identity SD map (l.1514-1517; defaults `hal_aiao.c:1475-1478`) |
| 2 | TX_IF_ATTRI | [5:4] `tx_ch_num` = 1 (2 ch) | l.2200-2215 (0=1ch, 1=2ch, 3=8ch) |
| 3 | TX_IF_ATTRI | [3:2] `tx_i2s_precision` = 1 (16-bit) | l.2105-2118 (0=8, 1=16, 2=24) |
| 4 | TX_IF_ATTRI | [23:20] `tx_sd_source_sel` = 2 (`AIAO_TX2`) | l.2042-2045 |
| 5 | TX_IF_ATTRI | [1:0] `tx_mode` = 0 (I2S; 1 = PCM) | `AIAO_LOW_SetI2SMode` l.2122-2131, called l.1453 |
| 6 | `0xF8CD0150` I2S_TX_CRG[2].CFG0 | [26:0] `aiao_mclk_div` = **0x001AF286** | l.1899-1907 |
| 7 | `0xF8CD0154` I2S_TX_CRG[2].CFG1 | [3:0] bclk_div = 3, [6:4] fsclk_div = 3, [10] bclk_oen = 0, [11] bclk_sel = 0, [13] bclkout_pctrl = 0 | l.1908-1926 (I2S forces pctrl 0, l.1922-1926) |
| 8 | CFG1 | [8] `aiao_cken` = 1 | `AIAO_LOW_SetTxCrgClkEn`, l.1864-1867, called l.1465 |
| 9 | `0xF8CD002C` AIAO_SWITCH_TX_BCLK | [11:8] `inner_bclk_ws_sel_tx_02` = **10** (= enum `AIAO_TX_CRG2`, 8+2) | `AIAO_HW_SetI2SDulicateClk` runs even in master mode (l.1545, l.1929-2006) |
| 10 | TX_IF_ATTRI | [1:0] tx_mode = 0 again | l.2006 |

Packed: `TX_IF_ATTRI = 0xE4200014` (trackmode 0, sd_offset 0, `tx_spd_i2s_sel` [19] left at
reset because `HI_SND_HDMI_I2S_SPDIF_MUX` is off) [inferred, arithmetic].
`I2S_TX_CRG[2].CFG1 = 0x00000133` (`aiao_srst_req` [9] never written by the vendor) [inferred].

### A.4 Interrupt and DSP defaults — `iHAL_AIAO_P_Open` + `PortSetUserDefaultCongfig`, `hal_aiao_func.c:540-555,189-201` [read]

| # | Address | Value | Meaning |
|---|---|---|---|
| 1 | `0xF8CD22A0` TX_INT_ENA | `0x00000001` | only `trans` (period done) (`hal_aiao_func.c:544`) |
| 2 | `0xF8CD2200` TX_IF_ATTRI | RMW [18:16] `tx_trackmode` = 0 (stereo), `udelay(10)` before and after | `AIAO_HW_SetTrackMode` l.1671-1689, `AIAO_LOW_SetTrackMode` l.2146-2156 |
| 3 | TX_DSP_CTRL | [19:16] fade_in_rate = 4, [23:20] fade_out_rate = 3, [1] mute_fade_en = 1, [0] mute_en = 0, [14:8] volume = **0x79** (0 dB), [27] bypass_en = 0 | defaults `hal_aiao.c:1486-1492`; fields l.722-743; volume clamp 0x28..0x7F (`hal_aiao_priv.c:2269-2286`, `hal_aiao_common.h:117-119`) |

### A.5 Tianlai ADAC v600 power-up — `ADAC_TIANLAI_Init`, `V/common/src/hal_tianlai_adac_v600.c:536-542` [read]

The vendor calls this **after** the AIAO port is opened (`drv_ao_op.c:493` open, `:962` init)
[read]. Field names follow the HAL's own unions in `V/common/include/hal_tianlai_adac_v600.h`,
which differ from `CI/hi_reg_peri.h` for ADAC1 (see §5).

`Digfi_ADACEnable` (l.449-482):

| # | Address | Write |
|---|---|---|
| 1 | `0xF8A22114` CRG69 | RMW [0] `adac_cken` = 1; `udelay(10)` |
| 2 | `0xF8A20160` ADAC2 | RMW [13] `RST` = 1, then RMW [13] = 0 (analog reset pulse, no delay) |
| 3 | ADAC2 | RMW [25] `clksel` = 0 ("2DIV") |
| 4 | ADAC2 | RMW [24] `clkdgesel` = 1 (sample on falling edge) |
| 5 | CRG69 | RMW [4] `adac_srst_req` = 1, then RMW [4] = 0 (digital reset pulse) |
| 6 | — | `msleep(1)` (l.539) |

`Digfi_DacInitDigital` (l.504-520):

| # | Address | Write |
|---|---|---|
| 7 | `0xF8A20110` ADAC0 | RMW [30] pd_dacr = 0, [31] pd_dacl = 0 |
| 8 | ADAC0 | RMW [28] mute_dacr = 0, [29] mute_dacl = 0 |
| 9 | ADAC0 | [6:0] dacr_vol = 0x7F, [14:8] dacl_vol = 0x7F (quietest, l.518) |
| 10 | ADAC0 | [23] dacl_path = 0, [22] dacr_path = 1 (`Digfi_DacSetPath`, l.152-160) |

`Digfi_DacPoweup` (l.258-348), pop-free analog bring-up:

| # | Address | Write |
|---|---|---|
| 11 | ADAC2 | [20:16] Td_sel = 0 |
| 12 | `0xF8A20114` ADAC1 | [2:1] pop_adj_res = 1, [5:4] pop_adj_clk = 1 |
| 13 | ADAC2 | [5] pd_dacr = 1, [6] pd_dacl = 1 |
| 14 | ADAC2 | [14] mute_dacr = 1, [15] mute_dacl = 1 |
| 15 | ADAC1 | [0] pop_direct_r = 0, [3] pop_direct_l = 0 |
| 16 | ADAC2 | [7] pd_ctcm = 0, [3] Pd_ctcm_ibias = 0, [4] pd_ibias = 0 |
| 17 | ADAC2 | [22] popfreer = 1, [23] popfreel = 1, [21] fs = 0 (fast power-up off without MUTECTL) |
| 18 | ADAC2 | [2] pd_vref = 0 |
| 19 | ADAC1 | [0] pop_direct_r = 1, [3] pop_direct_l = 1 |
| 20 | — | **`msleep(500)`** (only without MUTECTL, l.321-323) |
| 21 | ADAC2 | [5] pd_dacr = 0, [6] pd_dacl = 0 |
| 22 | ADAC2 | [14] mute_dacr = 0, [15] mute_dacl = 0 |

`Digfi_DacInit` tail (l.440-446):

| # | Address | Write |
|---|---|---|
| 23 | ADAC1 | [23:22] data_bits = 3 (`Digfi_DacSetDataBits`, l.86-93) |
| 24 | ADAC1 | [21:19] clksel = **2** for 32/44.1/48 kHz (l.214-256; 0 = 8-12k, 1 = 16-24k, 3 = 88-96k, 4 = 176-192k) |
| 25 | ADAC0 | dacr_vol = dacl_vol = **0x06** ("0dB", l.445) |

Resulting words if unwritten fields reset to 0 [inferred]: ADAC0 `0x00400606`,
ADAC1 `0x00D0001B`, ADAC2 `0x01C00000` (popfree stays 1; the vendor never clears it after
power-up). CRG69 `0x00000001`.

ADAC volume runs the other way from AIAO volume: 0x06 = 0 dB, 0x7F = quietest; the power-down
path ramps 0x06→0x7F in steps of 10 (l.367-371) [read]. Step size in dB: **[unknown]**.

Helpers present but **never called** for v600 (grep of `V/`): `Digfi_DacSetDeemph`,
`Digfi_DacSetAdj`, `Digfi_DacSetChopper`, `Digfi_DacSetPopAdj`, `Digfi_DacSetPd` [read].
De-emphasis therefore stays at reset.

### A.6 Start — `PortStart` → `AIAO_HW_SetStart`, `hal_aiao_func.c:209-222`, `hal_aiao_priv.c:913-920,2315-2324` [read]

| # | Address | Write |
|---|---|---|
| 1 | `0xF8CD2288` TX_BUFF_WPTR | prime: write ≥ 1 period of data, then WPTR = bytes written |
| 2 | `0xF8CD2204` TX_DSP_CTRL | RMW [28] `tx_enable` = 1 → word ≈ `0x10347902` |

Priming before enable is [inferred]: the vendor starts with WPTR = RPTR = 0 and lets AOE fill
(the `empty` interrupt is not enabled, so an empty start is legal but plays silence/underruns).

## 5. Tianlai ADAC register layouts (two sources disagree on ADAC1)

ADAC0 `0xF8A20110` — both sources agree [read `hal_tianlai_adac_v600.h:61-85`, `hi_reg_peri.h:435-460`]:
[6:0] dacr_vol, [14:8] dacl_vol, [19:18] deemphasis_fs (0=48k, 1=44.1k, 2=32k), [20] dacr_deemph,
[21] dacl_deemph, [22] dacr_path, [23] dacl_path, [28] mute_dacr, [29] mute_dacl,
[30] pd_dacr, [31] pd_dacl.

ADAC1 `0xF8A20114`:
- HAL (`hal_tianlai_adac_v600.h:118-139`, the type the shipped code writes through):
  [0] pop_direct_r, [2:1] pop_adj_res, [3] pop_direct_l, [5:4] pop_adj_clk, [7] verf_extmod,
  [21:19] clksel, [23:22] data_bits.
- `hi_reg_peri.h:462-479`: [2:0] adac_pop_adj_r, [5:3] adac_pop_adj_l, [21:19] adac_clk_sel_sam,
  [23:22] adac_data_bits.
- They agree on [23:19]. The low 6 bits differ; follow the HAL (it is what ran) [inferred].

ADAC2 `0xF8A20160` — agree [read `hal_tianlai_adac_v600.h:141-174`, `hi_reg_peri.h:649-...`]:
[0] ctrl_dffr, [1] ctrl_dffl, [2] pd_vref, [3] pd_ctcm_ibias, [4] pd_ibias, [5] pd_dacr,
[6] pd_dacl, [7] pd_ctcm, [9:8] adj_refbf, [11:10] adj_dac, [12] adj_ctcm, [13] RST
(`stb_dac_ana_rst`), [14] mute_dacr, [15] mute_dacl, [20:16] Td_sel, [21] fs, [22] popfreer,
[23] popfreel, [24] clkdgesel, [25] clksel, [27:26] Chop_dacvref_sel, [29:28] Chop_ctcm_sel,
[30] Chop_bps_dacvref, [31] Chop_bps_ctcm.

How TX2's I2S lines reach the DAC: internally; the ADAC registers have no source select, and
the vendor routes DAC0 to TX2 only by choosing the port [inferred]. No pin-mux is involved for
the analog RCA path [inferred: analog pads].

## 6. Recipe (B): S/PDIF on SPDIF TX1

A.1 (global power-up) first. Then:

### B.1 Ring buffer — same as A.2 at the SPDIF-TX port base `0xF8CD3100` [read `hal_aiao_priv.c:1171-1185,2416-2524`]

`0xF8CD3180` SADDR, `0xF8CD3184` SIZE, `0xF8CD3188` WPTR = 0, `0xF8CD318C` RPTR = 0,
`0xF8CD3190` ALEMPTY_TH = period, `0xF8CD3194` TRANS_SIZE = period. Same alignment rules.

### B.2 Interface / clock — `AIAO_HW_SetIfAttr` (SPDIF branch) [read]

| # | Address | Write | Evidence |
|---|---|---|---|
| 1 | `0xF8CD0020` SPDIF_TX_MUX | RMW [11] `spdif_tx_1_port_en` = 1 | `hal_aiao_priv.c:1522,1559-1569`. The vendor **never** writes `spdif_tx_1_port_sel` [10:8] on cv200 (only on 3751 for ARC, l.1523-1530). I recommend writing it to 1 (= engine TX1) explicitly → bits [11:8] = `0x9` [inferred] |
| 2 | `0xF8CD3100` SPDIFTX_IF_ATTRI | [5:4] `tx_ch_num` = 1 (2 ch) | l.2349-2361 |
| 3 | SPDIFTX_IF_ATTRI | [3:2] `tx_i2s_precision` = 1 (16-bit) | l.2328-2341 |
| 4 | `0xF8CD5030` SPDIF_CH_STATUS5 | RMW: [0] L bit_max = 0, [3:1] L bit_width = 1, [8] R bit_max = 0, [11:9] R bit_width = 1 | `AIAO_SPDIF_HAL_SetBitWidth` l.2788-2821 (16-bit: width 1, max 0; 24-bit: width 5, max 1) |
| 5 | `0xF8CD0188` SPDIF_CRG[1].CFG0 | [26:0] `aiao_mclk_div_spdif` = **0x001AF286** | `AIAO_LOW_SetSPDIFMasterClk` l.2009-2019 |
| 6 | `0xF8CD018C` SPDIF_CRG[1].CFG1 | [3:0] bclk_div = **2**, [6:4] fsclk_div = **4**, [8] `aiao_cken_spdif` = 1 | same |
| 7 | `0xF8CD502C` SPDIF_CH_STATUS4 | `(v & 0xF0F0) | 0x0202` (L/R fs = 2 = 48 kHz) | `AIAO_SPDIF_HAL_SetSamplerate` l.2823-2870 (44.1k = 0, 32k = 3, 96k = 0xA, 192k = 0xE) |
| 8 | SPDIF_CH_STATUS5 | `(v & 0x0F0F) | 0xD0D0` (orig fs = 0xD for 48 kHz) | l.2872-2876 |

Packed: `SPDIFTX_IF_ATTRI = 0x00000014`, `SPDIF_CRG[1].CFG1 = 0x00000142`,
`SPDIF_CH_STATUS4 = 0x0202`, `SPDIF_CH_STATUS5 = 0xD2D2` [inferred, arithmetic].

`aiao_srst_req_spdif` [9]: the only writer, `AIAO_LOW_SetSPDIFMasterClkEn` (l.2022-2034), is
reached only from `AIAO_HW_SetMasterClkEn` (l.1381-1403), and **nothing calls that** (grep of
`V/`) [read]. So the vendor leaves [9] at reset. Its polarity is also odd in that function
(it sets 1 when *enabling*, commented "reset hold"). Write it explicitly 0 [inferred]; see
open questions.

### B.3 Channel status, category, mode (PCM)

| # | Address | Write | Evidence |
|---|---|---|---|
| 1 | `0xF8CD5004` SPDIF_CONFIG | `0x00000000` | linear PCM (`AIAO_SPDIF_HAL_SetMode`, l.2610-2628) |
| 2 | `0xF8CD5020` SPDIF_CH_STATUS1 | [1] l_use_b = 0, [9] r_use_b = 0 | "audio sample word is linear PCM" (l.2625-2626) |
| 3 | `0xF8CD5024` SPDIF_CH_STATUS2 | `&= ~0x7F7F` then `|= 0x0000` | category GENERAL (`SetSpidfCategoryCode`, l.2631-2689) |
| 4 | CH_STATUS1/2 | SCMS. Vendor default for SPDIF0 is "copy prohibited" + GENERAL (`drv_ao_op.c:974-975`): CH_STATUS2 `&= 0xFFFF7F7F` (L-bit 0), CH_STATUS1 [2] l_use_c = 0, [10] r_use_c = 0. For "copy allowed": CH_STATUS1 [2] = [10] = 1 | `AIAO_HW_SetSPDIF_Category_SCMS`, l.2721-2767 |
| 5 | `0xF8CD5028` SPDIF_CH_STATUS3 | `0x00002010` (L channel number 1, R channel number 2, source 0) | `AIAO_SPDIF_HAL_SetUnknow`, l.2778-2784; written at every start/stop (l.923) |

A minimal PCM, copy-allowed, 48 kHz, 16-bit consumer frame: CH_STATUS1 `0x0404`,
CH_STATUS2 `0x0000`, CH_STATUS3 `0x2010`, CH_STATUS4 `0x0202`, CH_STATUS5 `0xD2D2` [inferred].
These match IEC 60958-3 byte 3 (fs) and byte 4 (word length, original fs) codes with bit 0 of
each field as the LSB [inferred].

### B.4 Interrupt and DSP defaults

`0xF8CD31A0` SPDIFTX_INT_ENA = `0x00000001`; `0xF8CD3104` SPDIFTX_DSP_CTRL defaults as A.4
(volume 0x79, fade in 4, fade out 3, mute_fade_en 1, bypass 0). SPDIF defaults:
`hal_aiao.c:1569-1594` [read]. Track mode goes to SPDIFTX_IF_ATTRI [18:16] (l.2344-2347).

### B.5 Start — `AIAO_HW_SetStart` SPDIF branch, `hal_aiao_priv.c:921-925` [read]

| # | Address | Write |
|---|---|---|
| 1 | `0xF8CD3104` SPDIFTX_DSP_CTRL | RMW [28] `tx_enable` = 1 |
| 2 | `0xF8CD5028` SPDIF_CH_STATUS3 | `0x2010` |
| 3 | `0xF8CD5000` SPDIF_CTRL | [0] `spdif_en` = 1 |

## 7. DMA ring semantics

- **Address width.** `TX_BUFF_SADDR` is a full 32-bit register and the vendor passes a 32-bit
  physical address from its MMZ allocator (`hal_aiao_func.c:147,161`, `HI_PHYS_ADDR_T`)
  [read]. No IOMMU is used for AIAO (MMZ `remap_mmb(phyaddr, 0)`,
  `drivers/common/drv/mmz/drv_mmz_ext_k.c:22-40`) [read]. Size and pointers are 24-bit, so one
  ring is ≤ 16 MiB − 128 B (`hal_aiao_common.h:145`). Set `dma_set_mask_and_coherent(32)`.
  Any window or remap limit below 4 GiB: **[unknown]**, none seen.
- **Units.** WPTR and RPTR are **byte offsets from SADDR**, not addresses: the circular-buffer
  code stores them straight into the registers (`circ_buf.h:45-57`, `CIRC_BUF_Write` l.448-517
  writes `*(pu32Write) = u32WritePos`) with wrap at `u32Lenght` [read].
- **Who moves what.** Hardware advances RPTR as it fetches; software (or the AOE DSP, which is
  handed the physical address of the WPTR register, `hal_aiao_priv.c:1231-1255`,
  `drv_ao_op.c:508-512`) advances WPTR [read]. The AOE mixer is **not required**: the
  verification path opens a port, starts it and feeds it by CPU (`drv_aiao_veri.c:302,336,472`
  → `HAL_AIAO_P_WriteData` → `CIRC_BUF_Write`) [read].
- **Empty vs full.** RPTR == WPTR means empty. The writer never fills the ring: free space is
  reduced by `SIMPLE_CB_GAP` = 32 bytes and 1 more (`circ_buf.h:35,114-136`) [read]. A
  mainline driver must therefore keep `wptr` at least 32 bytes behind `rptr` when the ring is
  "full" from ALSA's view [inferred].
- **Granularity.** The engine moves 32-byte units (`AIAO_FIFO_UNITBYTES = 256/8`,
  `AIAO_MIN_DATA_FORDMA_INBYTES 32`, `hal_aiao_common.h:140,163`) [read]. Keep WPTR updates
  32-byte aligned (8 stereo S16 frames) [inferred]; periods and the buffer 128-byte aligned
  (`hal_aiao_func.c:72-85`) [read].
- **Sample layout.** 16-bit = 2 bytes per channel, 24-bit uses 4-byte containers
  (`AIAOFrameSize`, `hal_aiao_common.h` ~l.740-760) [read]; interleaved L,R little-endian
  [inferred: LE SoC, L/R track modes].
- **Cache coherency.** The vendor maps the ring **uncached** (`remap_mmb(…, 0)`) and does no
  cache maintenance in the write path [read]. Use `dma_alloc_coherent` / ALSA
  `SNDRV_DMA_TYPE_DEV` (non-cacheable on this non-coherent ARM) [inferred]. Bus QoS
  (`PERI_QOS_CFG0` aiao_arqos/awqos) is never written by the AIAO driver [read].
- **Period interrupt.** `TX_TRANS_SIZE` = period bytes and `TX_INT_ENA` bit 0 (`trans`) is the
  only interrupt the vendor enables (`hal_aiao_func.c:544`) [read]. That it fires each time
  TRANS_SIZE bytes are consumed is **[inferred]** from names. `alempty` (bit 2) fires below
  `ALEMPTY_TH` [inferred]; use it as an underrun early warning, or ignore.

### ALSA mapping [inferred]

- `.pointer` = `bytes_to_frames(readl(RPTR))`.
- Advance WPTR from `runtime->control->appl_ptr` in `.ack` (set `SNDRV_PCM_INFO_…` so `.ack`
  is called) or in the period IRQ: `wptr = (appl_ptr_bytes % buf)`, clamped so that
  `(rptr - wptr) mod buf ≥ 32` when the ring is full.
- Constraints: buffer and period bytes multiple of 128; periods ≥ 2
  (`AIAO_BUFFER_PERIODNUM_MIN`, `hal_aiao_common.h:152`), ≤ 128.

## 8. Interrupt line

One line: **GIC SPI 84**, level-high. [read] `hal_aiao_common.h:36` (`84 + 32`), vendor DT
`docs/vendor-arm32/hi3798cv200.dts:796,828` (`<0 84 4>`, "aiao"). All ports share it;
the vendor requests it `IRQF_SHARED` (`hal_aiao.c:339`).

ISR shape [read `hal_aiao.c:200-244`]:
1. read `AIAO_INT_STATUS` (`0xF8CD0004`);
2. for each set bit *Id*: port = TX ch (Id−16) or SPDIF ch (Id−24); read that port's
   `TX_INT_RAW` (+0xA4); handle; write the **same raw value** to `TX_INT_CLR` (+0xAC).
3. The top status is not written back; it clears when the port bits clear [inferred].

TX2 = top bit 18; SPDIF TX1 = top bit 25 [read `PORT2ID`, `hal_aiao_common.h` ~l.800-820].

## 9. Stop — `AIAO_HW_SetStart(…, 0)`, `hal_aiao_priv.c:913-996` [read]

1. DSP_CTRL [28] `tx_enable` = 0 (SPDIF also: CH_STATUS3 = 0x2010, SPDIF_CTRL [0] = 0).
2. `HW_CHN_PTR_BUG` workaround (defined `hal_aiao_priv.h:34`): TRANS_SIZE = 1, RPTR = 0,
   `udelay(500)` (l.935-950).
3. Poll DSP_CTRL [29] `tx_disable_done` == 1, 100 × `udelay(10)`; time-out is an error
   (l.969-978).
4. Before the next start, rewrite the buffer registers (A.2) — the vendor resets RPTR/WPTR to 0
   via `PortBufFlush` (`hal_aiao_func.c:93-106`).
5. Close: TX_INT_CLR = 0xFF (`hal_aiao_func.c:657`).

ADAC power-down (`hal_tianlai_adac_v600.c:361-438,544-550`): ramp ADAC0 volume 0x06→0x7F,
pop-free sequence, `msleep(2000)`, pd_vref, then ADAC0 mute/pd, ADAC2 RST = 1, CRG69 srst = 1,
cken = 0.

## 10. Pin-mux (IOCONFIG `0xF8A21000`)

No AIAO or ADAC code writes IOCONFIG on cv200 (grep of `V/` for `ioshare`/`0xF8A21`: only the
external-codec I2C helper in `V/alsa/dsp_mix_v2/alsa_i2c.c:123-129`, not built for this path)
[read]. `CI/hi_reg_io.h` names no SPDIF/I2S pad [read]. So the SPDIF pad function is set by the
boot loader's register table or by reset default — **[unknown]**. The analog RCA path needs no
mux [inferred].

## 11. Paste-ready defines

```c
/* Hi3798CV200 AIAO / Tianlai ADAC -- from vendor SDK 4.4.35 aiao_v1_1 (see doc for cites) */
#define HI_CRG_BASE                 0xF8A22000
#define HI_PERI_BASE                0xF8A20000
#define AIAO_BASE                   0xF8CD0000
#define AIAO_SIZE                   0x10000

/* CRG */
#define PERI_CRG69                  0x114          /* ADAC */
#define  CRG69_ADAC_CKEN            BIT(0)
#define  CRG69_ADAC_SRST_REQ        BIT(4)
#define PERI_CRG70                  0x118          /* AIAO */
#define  CRG70_AIAO_CKEN            BIT(0)
#define  CRG70_AIAO_SRST_REQ        BIT(4)
#define  CRG70_SKIPCFG_MASK         GENMASK(16, 12)
#define  CRG70_LOADEN               BIT(17)
#define  CRG70_MCLK_SEL_MASK        GENMASK(21, 20) /* 0 = EPLL 933.888 MHz on cv200 */
#define  CRG70_CLK_SEL_50M          BIT(22)         /* 1 = 50 MHz, 0 = 100 MHz */
#define PERI_CRG_PLL12              0x030          /* EPLL ctrl0 (read-only check) */
#define PERI_CRG_PLL13              0x034          /* EPLL ctrl1 */

/* PERI: Tianlai ADAC v600 (bit names per the HAL unions) */
#define PERI_QOS_CFG0               0x044
#define PERI_TIANLA_ADAC0           0x110
#define  ADAC0_DACR_VOL_MASK        GENMASK(6, 0)   /* 0x06 = 0 dB, 0x7F = min */
#define  ADAC0_DACL_VOL_MASK        GENMASK(14, 8)
#define  ADAC0_DEEMPH_FS_MASK       GENMASK(19, 18)
#define  ADAC0_DACR_DEEMPH          BIT(20)
#define  ADAC0_DACL_DEEMPH          BIT(21)
#define  ADAC0_DACR_PATH            BIT(22)
#define  ADAC0_DACL_PATH            BIT(23)
#define  ADAC0_MUTE_DACR            BIT(28)
#define  ADAC0_MUTE_DACL            BIT(29)
#define  ADAC0_PD_DACR              BIT(30)
#define  ADAC0_PD_DACL              BIT(31)
#define PERI_TIANLA_ADAC1           0x114
#define  ADAC1_POP_DIRECT_R         BIT(0)
#define  ADAC1_POP_ADJ_RES_MASK     GENMASK(2, 1)
#define  ADAC1_POP_DIRECT_L         BIT(3)
#define  ADAC1_POP_ADJ_CLK_MASK     GENMASK(5, 4)
#define  ADAC1_CLKSEL_MASK          GENMASK(21, 19) /* 2 = 32/44.1/48 kHz */
#define  ADAC1_DATA_BITS_MASK       GENMASK(23, 22) /* vendor writes 3 */
#define PERI_TIANLA_ADAC2           0x160
#define  ADAC2_PD_VREF              BIT(2)
#define  ADAC2_PD_CTCM_IBIAS        BIT(3)
#define  ADAC2_PD_IBIAS             BIT(4)
#define  ADAC2_PD_DACR              BIT(5)
#define  ADAC2_PD_DACL              BIT(6)
#define  ADAC2_PD_CTCM              BIT(7)
#define  ADAC2_RST                  BIT(13)
#define  ADAC2_MUTE_DACR            BIT(14)
#define  ADAC2_MUTE_DACL            BIT(15)
#define  ADAC2_TD_SEL_MASK          GENMASK(20, 16)
#define  ADAC2_FS                   BIT(21)         /* fast power-up */
#define  ADAC2_POPFREER             BIT(22)
#define  ADAC2_POPFREEL             BIT(23)
#define  ADAC2_CLKDGESEL            BIT(24)         /* 1 = falling edge */
#define  ADAC2_CLKSEL               BIT(25)

/* AIAO common */
#define AIAO_INT_ENA                0x000
#define AIAO_INT_STATUS             0x004
#define AIAO_INT_RAW                0x008
#define  AIAO_INT_TX(n)             BIT(16 + (n))
#define  AIAO_INT_SPDIFTX(n)        BIT(24 + (n))   /* n = 0..2 with timer support */
#define AIAO_HW_CAPABILITY          0x00C
#define AIAO_SPDIF_TX_MUX           0x020
#define  SPDIF_TX_MUX_SEL_SHIFT(k)  (8 * (k))       /* 3 bits */
#define  SPDIF_TX_MUX_EN(k)         BIT(8 * (k) + 3)
#define AIAO_HW_VERSION             0x024
#define AIAO_SWITCH_TX_BCLK         0x02C
#define  SWITCH_TX_BCLK_SHIFT(n)    (4 * (n))       /* value = 8 + tx_crg_id */
#define AIAO_STATUS                 0x030
#define  AIAO_STATUS_SRST_RDY       BIT(0)
#define AIAO_OUT_STANDING           0x034           /* [2:0], vendor = 2 */

#define AIAO_I2S_TX_CRG_CFG0(n)     (0x140 + 8 * (n))
#define AIAO_I2S_TX_CRG_CFG1(n)     (0x144 + 8 * (n))
#define AIAO_SPDIF_CRG_CFG0(n)      (0x180 + 8 * (n))
#define AIAO_SPDIF_CRG_CFG1(n)      (0x184 + 8 * (n))
#define  CRG_CFG0_MCLK_DIV_MASK     GENMASK(26, 0)
#define  CRG_CFG1_BCLK_DIV_MASK     GENMASK(3, 0)   /* index into {1,3,2,4,6,8,12,16,24,32,48,64} */
#define  CRG_CFG1_FS_DIV_MASK       GENMASK(6, 4)   /* index into {16,32,48,64,128,256} */
#define  CRG_CFG1_CKEN              BIT(8)
#define  CRG_CFG1_SRST_REQ          BIT(9)
#define  CRG_CFG1_BCLK_OEN          BIT(10)         /* I2S only */
#define  CRG_CFG1_BCLK_SEL          BIT(11)
#define  CRG_CFG1_BCLKIN_PCTRL      BIT(12)
#define  CRG_CFG1_BCLKOUT_PCTRL     BIT(13)
#define AIAO_MCLK_DIV_256FS_48K     0x001AF286      /* EPLL 933.888 MHz */
#define AIAO_MCLK_DIV_256FS_44K1    0x0018C205

/* Port banks */
#define AIAO_TX_BASE(n)             (0x2000 + 0x100 * (n))   /* TX2 -> DAC */
#define AIAO_SPDIFTX_BASE(n)        (0x3000 + 0x100 * (n))   /* SPDIF TX1 -> S/PDIF */
#define AIAO_SPDIFER_BASE(n)        (0x4000 + 0x1000 * (n))
/* offsets inside a TX / SPDIF-TX bank */
#define TX_IF_ATTRI                 0x00
#define  TX_IF_MODE_MASK            GENMASK(1, 0)   /* 0 I2S, 1 PCM (I2S TX only) */
#define  TX_IF_PRECISION_MASK       GENMASK(3, 2)   /* 0 8b, 1 16b, 2 24b */
#define  TX_IF_CH_NUM_MASK          GENMASK(5, 4)   /* 0 1ch, 1 2ch, 3 8ch */
#define  TX_IF_SD_OFFSET_MASK       GENMASK(15, 8)
#define  TX_IF_TRACKMODE_MASK       GENMASK(18, 16)
#define  TX_IF_SPD_I2S_SEL          BIT(19)
#define  TX_IF_SD_SOURCE_MASK       GENMASK(23, 20)
#define  TX_IF_SD_SEL_SHIFT(k)      (24 + 2 * (k))
#define TX_DSP_CTRL                 0x04
#define  TX_DSP_MUTE_EN             BIT(0)
#define  TX_DSP_MUTE_FADE_EN        BIT(1)
#define  TX_DSP_VOLUME_MASK         GENMASK(14, 8)  /* 0x79 = 0 dB, 0x7F = +6, 0x28 = -inf */
#define  TX_DSP_FADE_IN_MASK        GENMASK(19, 16)
#define  TX_DSP_FADE_OUT_MASK       GENMASK(23, 20)
#define  TX_DSP_BYPASS_EN           BIT(27)
#define  TX_DSP_TX_ENABLE           BIT(28)
#define  TX_DSP_DISABLE_DONE        BIT(29)
#define TX_DSP_STATUS               0x08
#define TX_WS_CNT                   0x20
#define TX_BCLK_CNT                 0x24
#define TX_BUFF_SADDR               0x80
#define TX_BUFF_SIZE                0x84            /* [23:0] bytes */
#define TX_BUFF_WPTR                0x88            /* [23:0] byte offset, SW */
#define TX_BUFF_RPTR                0x8C            /* [23:0] byte offset, HW */
#define TX_BUFF_ALEMPTY_TH          0x90
#define TX_TRANS_SIZE               0x94
#define TX_RPTR_TMP                 0x98
#define TX_INT_ENA                  0xA0
#define TX_INT_RAW                  0xA4
#define TX_INT_STATUS               0xA8
#define TX_INT_CLR                  0xAC
#define  TX_INT_TRANS               BIT(0)          /* period done */
#define  TX_INT_EMPTY               BIT(1)
#define  TX_INT_ALEMPTY             BIT(2)
#define  TX_INT_BFIFO_EMPTY         BIT(3)
#define  TX_INT_IFIFO_EMPTY         BIT(4)
#define  TX_INT_STOP                BIT(5)
#define  TX_INT_MFADE               BIT(6)
#define  TX_INT_DAT_BREAK           BIT(7)
#define  TX_INT_ALL                 0xFF
#define AIAO_BUF_ALIGN              128
#define AIAO_BUF_SIZE_MAX           ((1u << 24) - 128)
#define AIAO_FIFO_UNIT              32
#define AIAO_CB_GAP                 32

/* SPDIF encoder bank */
#define SPDIF_CTRL                  0x00            /* [0] spdif_en */
#define SPDIF_CONFIG                0x04            /* 0 = PCM, 1 = compressed */
#define SPDIF_INTRUPT               0x08
#define SPDIF_INTR_MASK             0x0C
#define SPDIF_INTR_STATE            0x10
#define SPDIF_CH_STATUS1            0x20
#define SPDIF_CH_STATUS2            0x24
#define SPDIF_CH_STATUS3            0x28            /* vendor: 0x2010 */
#define SPDIF_CH_STATUS4            0x2C            /* 48k: 0x0202 */
#define SPDIF_CH_STATUS5            0x30            /* 48k/16b: 0xD2D2 */
#define SPDIF_USER_DATA(n)          (0x40 + 4 * ((n) - 1))
#define SPDIF_EDITION               0xF0

#define AIAO_GIC_SPI                84              /* level-high, shared by all ports */
```

## 12. Suggested DT node [inferred]

```dts
aiao: audio-controller@f8cd0000 {
    compatible = "hisilicon,hi3798cv200-aiao";   /* new binding */
    reg = <0xf8cd0000 0x10000>;
    interrupts = <GIC_SPI 84 IRQ_TYPE_LEVEL_HIGH>;
    hisilicon,crg = <&crg>;     /* PERI_CRG69/70, or clocks/resets once crg-hi3798cv200.c grows them */
    hisilicon,peri = <&peri>;   /* syscon 0xf8a20000 for TIANLA_ADAC0/1/2 */
    #sound-dai-cells = <1>;     /* 0 = I2S TX2 (ADAC), 1 = SPDIF TX1 */
};
```

## 13. Open questions

1. **EPLL frequency.** Nothing in the AIAO driver programs it. Read `0xF8A22030/34` on the box
   (stock and mainline) and confirm 933.888 MHz, or recompute `mclk_div`.
2. **`spdif_tx_1_port_sel` reset value** and the meaning of `port_sel` (engine → pad, or the
   reverse). The vendor never writes it on cv200. Read `0xF8CD0020` under stock Android.
3. **`aiao_srst_req_spdif` / I2S `aiao_srst_req` reset values and polarity.** The vendor
   never writes either on this path; the dead helper sets the SPDIF one to 1 "on enable".
4. **SPDIF pad pin-mux** at IOCONFIG `0xF8A21000`: which pad and function carry SPDIF TX1;
   whether optical and coax share it. Dump IOCONFIG under stock Android.
5. **ADAC1 low bits:** the HAL union and `hi_reg_peri.h` disagree on [5:0]. The HAL ran on the
   box; confirm by reading ADAC1 under stock Android after audio starts (expect `0x00D0001B`
   if HAL layout and zero reset).
6. **`trans` interrupt semantics:** "fires every TRANS_SIZE bytes" is inferred from names, not
   read from documentation. Verify with `TX_WS_CNT` and a scope/printk count.
7. **ADAC volume step size** (dB per code) and the `data_bits = 3` meaning (likely 32-bit
   slot, matching FCLK_DIV 64): not documented in source.
8. **`HI_SND_MUTECTL_SUPPORT`** on the Q10 board config: if set, the 500 ms sleep is skipped and
   `fs` (fast power-up) is used; also implies a mute GPIO. Unknown for this box.
9. Whether the stock boot leaves AIAO/ADAC powered at kexec/handoff (affects whether A.1's
   reset is needed for a clean start) — not checked here.
10. `HW_CAPABILITY` live value: the vendor hard-codes `0x030D0001` for cv200 instead of
    reading it, which suggests the live register may be wrong or zero on this chip.

## Corrections to `261011-himedia-ir-keymap-audio-research.md`

- It says `HI_SND_HDMI_I2S_SPDIF_MUX` is "set for this chip in the aiao Makefile". It is set
  only for hi3798mv200 / hi3798mv200_a / hi3796mv200 (`V/Makefile:63-64`). On cv200, HDMI uses
  TX3 (I2S) or SPDIF TX0 independently.
- "SPDIF TX ports 0..3": with `HI_AIAO_TIMER_SUPPORT` (set for cv200) there are 3 (TX0..TX2);
  interrupt bits 27/28 belong to the AIAO timers (`hal_aiao_common.h` l.343-352).
