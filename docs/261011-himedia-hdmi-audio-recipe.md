# HiMedia Q10 Pro (Hi3798CV200): HDMI audio on top of the boot-programmed video link

Date: 2026-10-11. Scope: a register-level recipe to add 48 kHz / 16-bit / stereo LPCM to the
HDMI output that the stock fastboot already drives at 1080p60. The recipe re-initialises no
video: no PHY, no TMDS clock, no AVI InfoFrame and no AVMUTE.
Sources (read-only): vendor SDK kernel 4.4.35 at `~/src/hisilicon-kernel-4.4.35`,
and the community tree `HiSilicon-Development/linux-6.12.y` (`histb-hdmi.c`, fetched with
curl from `raw.githubusercontent.com/.../HEAD`, kept at `~/src/histb-6.12-hdmi/`).
This builds on `docs/261011-himedia-aiao-programming-recipe.md` (the AIAO recipe that plays
TX2 + SPDIF TX1 at a measured 48 000 frames/s).

## Decision

1. **Feed HDMI from AIAO I2S TX3, not SPDIF TX0.** The vendor routes HDMI PCM to I2S, and SPDIF
   only to compressed passthrough. `SND_AOP_TYPE_I2S` is documented as "hbr or 2.0 pcm or 7.1
   lpcm" and `SND_AOP_TYPE_SPDIF` as "lbr or hbr(ddp)" (`ao/drv_ao_op.h:75-76`). On the S40
   platform (cv200), HDMI + I2S selects `AIAO_PORT_TX3` (`ao/drv_ao_op.c:85-100`) [read].
   The HDMI side defaults to I2S too: `PERI_HDMITX_CTRL0` gets `HDMI_AUDIO_SOURCE_I2S` at
   hardware init (`hdmi_hal.c:1090`), and the driver's default `enSoundIntf` is I2S
   (`drv_hdmi_intf.c:1801`) [read]. TX3 is the same IP as TX2, so the q10_aiao code is reused
   almost unchanged.
2. **HDMI TX side: ACR in hardware-CTS mode with N = 6144.** The vendor never writes the CTS
   registers. `sAudioformatSet` writes only `N_SVAL1..3` (`si_mod_tx_hdmi.c:2194-2203`), and
   `ACR_CTRL` bit 0 (`CTS_HW_SW_SEL`) stays 0 = hardware-measured CTS (`0x0c` at init, `0x0e`
   when enabled) [read]. The expected hardware value at 148.5 MHz is **CTS = 148500**: the
   vendor table `{148500, 48000, 6144, 148500}` (`hdmi_hal.c:357`) and arithmetic both give it
   (6144 × 148.5 MHz / (128 × 48 kHz) = 148500) [read + arithmetic]. Use it as a readback check.
3. **No 8051 firmware, no DDC and no EDID.** The 8051 MCU in this IP is loaded only for HDCP 2.2
   (`c8051_hdcp22_program.bin`, `hdmi_hal.c:1970-1995` writes its PRAM) [read]. The only EDID
   use on the audio path is `DRV_HDMI_CompatAudNCtsGet`, a quirk table that overrides N/CTS for
   specific sink manufacturers (`drv_hdmi_compatibility.c:501-540`) [read]. It is optional.
   Stereo 48 kHz LPCM is the baseline that an audio-capable sink must accept [inferred, CEA-861].
4. **Audio can be enabled without touching video** [inferred, but strongly supported]:
   - Every write is in the audio input processor (AIP, page 0xA) or in TPI InfoFrame buffer 2.
     The other two writes are the audio-source bits [4:0] of `PERI_HDMITX_CTRL0` and a
     read-only check of the CRG.
   - `AIP_RST` resets "every piece of the AIP logic" and the audio FIFO only (regs header,
     `AIP_RST` field comments).
   - AVMUTE is a GCP in buffer **GEN2 = FSEL 7** (`sAvMuteSet`, `si_mod_tx_hdmi.c:3064-3180`),
     and this recipe never selects 7.
   - **One hard precondition:** the link must already be in HDMI mode, not DVI.
     `TEST_TXCTRL` bit 1 must be 1, which the AVI InfoFrame on screen implies. In DVI mode
     there are no data islands, so there is no audio without a mode change (§3.0).
5. **The 6.12 community driver has no HDMI audio.** `histb-hdmi.c` (1,944 lines) defines the AIP
   registers and copies the vendor's `sHardwareInit` audio block (l.768-780). That block leaves
   audio **muted with ACR off**. The driver never writes N, `AUD_EN` or `ACR_CTRL.CTS_REQ_EN`,
   and it has no `hdmi-codec`. It does add two things worth keeping: the audio InfoFrame
   selector (`2`, l.639-641), and the note "The CV200 transmitter expects the selector to
   remain on AVI" (l.672) [read]. Our recipe restores `TPI_INFO_FSEL` after it writes the audio
   buffer.

## 1. Addressing (the part that is easy to get wrong)

The TX is a Silicon Image core ("imagev200", `CTRL_DIR := hal/ctrl/imagev200` for
`hi3798cv200`, `drivers/msp/drv/hdmi/Makefile:180-185`) [read]. Its registers are **8-bit**,
each in its own 32-bit word:

```
phys = 0xF8CE0000 + (reg_addr - 0x3000) * 4 = 0xF8CE0000 + ((page << 8) | offset) * 4
```

- `SiiPlatformRead/Write`: `addr = ((address - BASE_ADDRESS) * 4) + virt_base`, which stores the
  byte into a `uint32_t` (`hal/ctrl/imagev200/platform/platform.c:11,24`) [read].
- `BASE_ADDRESS 0x3000` and `Page_0 = 0x3000`, `Page_6 = 0x3600`, `Page_A = 0x3A00`
  (`driver/si_drv_tx_regs.h:16,20,26,30`) [read].
- `HDMI_CTRL_BASE_ADDR 0xf8ce0000` (`product/Hi3798CV200/hdmi_platform.h:41`); the window is
  mapped as 0x4000 bytes (`driver/cra/si_drv_cra.c:51`) [read].
- Cross-checks: the vendor's own `himm` comments in `sAvMuteSet` give `0xf8ce1afc` for
  `TPI_INFO_FSEL` (0x36BF), `0xf8ce1b00` for `TPI_INFO_B0` and `0xf8ce1b7c` for `TPI_INFO_EN`.
  The 6.12 driver uses `HISTB_HDMI_REG(page, reg) = ((page << 8) | reg) << 2` (l.38) [read].
  The formula matches both.
- Access: `readl`/`writel`, using the low byte only. Read-modify-write the byte as the vendor
  does with `SiiDrvCraPutBit8/SetBit8/ClrBit8`.

Line numbers in `si_mod_tx_hdmi.c`, `si_drv_tx.c` and `si_drv_tx_regs.h` are counted **after
normalising CR/CRLF line ends**: these files mix `\r` and `\r\n`, so `grep -n` on the raw file
gives other numbers. Reproduce with `perl -0777 -pe 's/\r\n?/\n/g' FILE | sed -n 'A,Bp'`.

## 2. AIAO side: I2S TX3 (analogous to the TX2 recipe)

TX3 uses the same defaults as TX2: `g_stAiaoTxHdmiI2SSDefaultOpenAttr` = master, 2 ch, 16-bit,
48 kHz, `FCLK_DIV 64`, `BCLK_DIV 4`, I2S mode, rising edge, identity SD map
(`common/src/hal_aiao.c:1532-1567`) [read]. `HAL_AIAO_P_GetHdmiI2SDfAttr` then sets
source = `AIAO_TX3` and CRG = `AIAO_TX_CRG3` (`hal_aiao.c:1661-1666`, tables l.1595-1615)
[read]. TX3 exists on cv200: `HW_CAPABILITY` bit 19 (`0x030D0001`, AIAO recipe §1) [read].

Run A.1 (global AIAO power-up) once, shared with TX2/SPDIF. Then, per the AIAO recipe §A.2-A.6,
with these values changed:

| # | Address | Value | Evidence |
|---|---|---|---|
| 1 | `0xF8CD2380` TX3 `BUFF_SADDR` | ring DMA address (may be **the same ring** as TX2/SPDIF1; each port has its own RPTR) | AIAO recipe A.2 [read]; same-ring sharing measured for TX2+SPDIF1 |
| 2 | `0xF8CD2384/88/8C/90/94` | SIZE, WPTR = 0, RPTR = 0, ALEMPTY_TH = period, TRANS_SIZE = period | A.2 |
| 3 | `0xF8CD2300` TX3 `IF_ATTRI` | **`0xE4300014`**: identity SD map [31:24] = 0xE4, `tx_sd_source_sel` [23:20] = **3**, `tx_spd_i2s_sel` [19] = 0, trackmode 0, 2 ch, 16-bit, I2S | A.3 fields; source 3 from `g_enTxI2SSourceTab[3]` [read]; packed word [inferred, arithmetic] |
| 4 | `0xF8CD0158` `I2S_TX_CRG[3].CFG0` | **`0x001AF286`** (256 fs from EPLL 933.888 MHz) | `0x140 + 8*3` [read, layout]; value as TX2 (same FCLK/BCLK) |
| 5 | `0xF8CD015C` `I2S_TX_CRG[3].CFG1` | **`0x00000133`**: bclk idx 3 (÷4 → 64 fs), fs idx 3 (÷64), cken [8] = 1, oen/sel/pctrl 0 | as TX2 [read: same defaults] |
| 6 | `0xF8CD002C` `AIAO_SWITCH_TX_BCLK` | RMW [15:12] `inner_bclk_ws_sel_tx_03` = **11** (`AIAO_TX_CRG3` = 8 + 3) | field `hal_aiao_priv.h:319`; enum `hal_aiao_common.h:214,222` (RX_CRG0 = 0, TX_CRG0 = 8); set in master mode too (`AIAO_LOW_SetI2SDulicateClk`, `hal_aiao_priv.c:1929+`) [read] |
| 7 | `0xF8CD0000` `AIAO_INT_ENA` | bit **19** (TX ch 3) only if TX3 drives the ALSA pointer | A.1 #13 layout [read] |
| 8 | `0xF8CD23A0` TX3 `INT_ENA` | `0x01` (trans), or 0 when polling | A.4 |
| 9 | `0xF8CD2304` TX3 `DSP_CTRL` | as A.4 (volume 0x79, fade in 4 / out 3, mute_fade_en 1), then [28] `tx_enable` = 1 → ≈ `0x10347902` | A.4/A.6; the HDMI defaults equal the DAC defaults (`hal_aiao.c:1553-1564`) [read] |

- **No mux.** With `HI_SND_HDMI_I2S_SPDIF_MUX` off for cv200, the vendor writes no pad, mux or
  CRG bit to connect TX3 to the HDMI AIP. The only selector is the HDMI peripheral register
  (§3, step 2). That TX3's SD0/BCLK/WS are hard-wired to the HDMI AIP's SD0 input is
  **[inferred]**: I found no other writer.
- **No MCLK to HDMI is needed.** The HDMI ACR runs with `NO_MCLK_CTSGEN_SEL = 1` ("CTS Gen
  without MCLK (auto MCLK generation)") [read, §3].
- **Order.** Start TX3 (step 9) **before** unmuting HDMI (§3 step 6), so the AIP FIFO does not
  sit in underflow [inferred]. The vendor opens and starts the AO port and then calls
  `pfnHdmiAudioChange` (`ao/drv_ao.c:1148-1159`) [read]; the exact interleave was not traced.

## 3. HDMI TX side on a running link

Registers in table order. "RMW" = read-modify-write the named bits of the byte. Every write
copies a vendor call; the vendor order is `DRV_HDMI_AOAttrSet` (`drv_hdmi_intf.c:2429-2482`):
disable audio + InfoFrame → `HAL_HDMI_AudioPathSet` → send the audio InfoFrame → enable.

### 3.0 Read-only pre-checks (do not write)

| Address | Register | Expect | Why |
|---|---|---|---|
| `0xF8CE03DC` | `TEST_TXCTRL` (0x30F7) | bit 1 `REG_HDMI_MODE` = **1** | HDMI (not DVI) output, so data islands exist. Set by `sHardwareInit` (`si_mod_tx_hdmi.c:2990`) and per TMDS mode (l.2473-2487) [read]. **If 0: stop.** Setting it is a link-mode change, outside this recipe |
| `0xF8CE01D4` | `PKT_FILTER_0` (0x3075) | bit 1 `DROP_CTS_PKT` = 0, bit 3 `DROP_AIF_PKT` = 0 | regs header l.769-781 [read]. The vendor never sets them (the line is commented out at l.3005) [read]. If set, clear those two bits only [inferred] |
| `0xF8A2210C` | `PERI_CRG67` | [5] `hdmitx_ctrl_as_cken` = 1; [14] `asclk_sel` = 1 (from PHY) | `hi_reg_crg.h:955-979, 2795` [read]. `HalHdmiClkSet` ORs 0x3F and sets bit 14 for `HDMI_CLK_FROM_PHY` (`hdmi_hal.c:876-890`), as used at init (l.1077) [read]. Expected ≈ `0x0000403F` [inferred]. **Do not write**: bits 8/9 are resets |
| `0xF8A208B0` | `PERI_HDMITX_CTRL0` | [4:0] `hdmitx_aud_id` = 0x02 | `hi_reg_peri.h:903-925, 1083` [read] |
| `0xF8CE28BC`, `0xF8CE2804`, `0xF8CE2874`, `0xF8CE298C` | `AUDP_TXCTRL`, `ACR_CTRL`, `I2S_IN_CTRL`, `TPI_AUD_FS` | `0x80`, `0x0C`, `0x60`, `0x82` | The fingerprint of the vendor's `sHardwareInit` (l.3007-3035). That function is outside every `HDMI_BUILD_IN_BOOT` guard, so fastboot also runs it [read]. That the box's fastboot was built from this code is **[inferred]**; these four values confirm it |

### 3.1 Write sequence

| # | Address | Register (SiI addr) | Write | Vendor source |
|---|---|---|---|---|
| **Disable / mute** | | | | `HAL_HDMI_AudioEnable(false)` → `sAudioEnableSet(0)` + `sAudioMuteSet(1)` (`si_mod_tx_hdmi.c:3246-3283`) |
| 1 | `0xF8CE284C` | `AUD_EN` (0x3A13) | RMW [0] `REG_AUD_IN_EN` = 0 | l.3256 |
| 2 | `0xF8CE2804` | `ACR_CTRL` (0x3A01) | RMW [1] `REG_CTS_REQ_EN` = 0 (stop N/CTS packets) | l.3258 |
| 3 | `0xF8CE28BC` | `AUDP_TXCTRL` (0x3A2F) | RMW [7] `REG_AUD_MUTE_EN` = 1 | l.3269 |
| 4 | `0xF8CE28B0` | `AIP_RST` (0x3A2C) | RMW [1:0] = 3 (`RST4AUDIO_FIFO \| RST4AUDIO`), wait **2 ms**, RMW [1:0] = 0 | `sAudioReset`, l.2538-2549, 3270-3272 |
| 5 | `0xF8CE1AFC` | `TPI_INFO_FSEL` (0x36BF) | save the old value, then [3:0] = **2** (audio buffer) | `BIT_ENUM__TPI_INFO_FSEL__AUDIO 0x02` (`si_drv_tx_regs_enums.h:46`) |
| 6 | `0xF8CE1B7C` | `TPI_INFO_EN` (0x36DF) | RMW [6] `RPT` = 0, then [7] `EN` = 0 (disable RPT first, per the field comment) | `sApplyInfoFrame(0)`, l.1663-1667 |
| **Path / format** | | | | `HAL_HDMI_AudioPathSet` (`hdmi_hal.c:1672-1731`) |
| 7 | `0xF8A208B0` | `PERI_HDMITX_CTRL0` | RMW [4:0] = **0x02** (I2S; 0x01 SPDIF, 0x04 DSD, 0x08 HBR, 0x10 parallel) | `hdmi_hal.c:1681-1693`; bit defs `hdmi_platform.h:49-53` |
| 8 | `0xF8CE2874` | `I2S_IN_CTRL` (0x3A1D) | **0x60**: [0] 0 = Philips 1-bit shift, [1] 0 = MSB first, [2] 0 = left-justified, [3] 0 = L when WS low, [5] cbit order 1, [6] sample edge 1 | re-asserts `sHardwareInit` l.3011 (`AudioPathSet` does not touch it) |
| 9 | `0xF8CE2890` | `I2S_IN_SIZE` (0x3A24) | **0x0B** (24 valid bits). The vendor keeps this for 16-bit as well; AIAO sends 16 bits in a 32-bit slot, low bits zero [inferred] | l.3010 |
| 10 | `0xF8CE2878` | `I2S_CHST0` (0x3A1E) | **0x00**: consumer, LPCM, copy **prohibited**, no pre-emphasis. 0x04 = copy permitted | `sChannelStateSet` l.2211-2220; the struct is zero-initialised (`hdmi_hal.c:1675`) |
| 11 | `0xF8CE287C` | `I2S_CHST1` | **0x00** category general | same |
| 12 | `0xF8CE2880` | `I2S_CHST2` | **0x00** source/channel number unspecified | same |
| 13 | `0xF8CE2884` | `I2S_CHST3` (0x3A21) | **0x02** = 48 kHz (IEC 60958 byte 3), clock accuracy 0 | `s_chst3aTable[SII_AUDIO_FS__48KHZ]` (`hdmi_hal.c:1598`, used l.1708) |
| 14 | `0xF8CE2888` | `I2S_CHST4` (0x3A22) | **0x02** = word length 16 bits (max 20), original fs not indicated | `Hal_AudioSampleDepthConv` (`hdmi_hal.c:1652-1653`) |
| 15 | `0xF8CE28A0`, `0xF8CE28A4` | `I2S_CHST6/7` (0x3A28/29) | **0x00**, 0x00 | `sChannelStateSet` |
| 16 | `0xF8CE298C` | `TPI_AUD_FS` (0x3A63) | RMW [3:0] = **0x2** (48 kHz). Keep [7] `SF_OVRD` = 1 → **0x82** | `sAudioformatSet` l.2090-2092; init l.3019-3020 |
| 17 | `0xF8CE28BC` | `AUDP_TXCTRL` | RMW [1] `REG_LAYOUT` = 0 (layout 0, 2 ch) | l.2122 |
| 18 | `0xF8CE2850` | `AUD_MODE` (0x3A14) | **0x10**: [4] SD0 enable only; SPDIF/HBR/DSD off | l.2144 |
| 19 | `0xF8CE288C` | `ASRC` (0x3A23) | RMW [7:4] `HBR_SPR_MASK` = 1 (→ `0x10` if [3:0] = 0); SRC off | l.2182 (`u8_reg_asrc = 0x10` for non-HBR) |
| 20 | `0xF8CE2984` | `TPI_DOWN_SMPL_CTRL` (0x3A61) | RMW [1:0] `TPI_AUD_HNDL` = 3 (no down-sampling) | l.2192 |
| 21 | `0xF8CE280C` | `N_SVAL1` (0x3A03) | **0x00** | l.2195-2197 |
| 22 | `0xF8CE2810` | `N_SVAL2` (0x3A04) | **0x18** | l.2199-2200 |
| 23 | `0xF8CE2814` | `N_SVAL3` (0x3A05) | **0x00** → N = 0x01800 = **6144** | l.2202-2203; `HDMI_DEFAULT_N_VALUE 6144` (`hdmi_hal.c:93`), table l.357 |
| — | `0xF8CE2818..20` | `CTS_TXSVAL1..3` | **not written**: hardware CTS (`ACR_CTRL[0] = 0`). The software CTS computed in `HalHdmiAudioNCTSValueGet` is never stored to a register [read: `sAudioformatSet` writes N only] | — |
| — | `0xF8CE2808` | `FREQ_SVAL` | not written (reset "256*Fs") [read: no writer] | — |
| **Audio InfoFrame** | | | | `DRV_HDMI_AudioInfoFrameSend` (`drv_hdmi_infoframe.c:742-808`) + pack (l.283-320) + `sInfoframesSet` (l.1671-1700) |
| 24 | `0xF8CE1AFC` | `TPI_INFO_FSEL` | 2 (if not still selected) | — |
| 25 | `0xF8CE1B00 + 4*i`, i = 0..13 | `TPI_INFO_B0..B13` | **`84 01 0A 70 01 00 00 00 00 00 00 00 00 00`**. Then B14..B30 (`0xF8CE1B38..0xF8CE1B78`) = 0: both the vendor and 6.12 write all 31 bytes | type 0x84, version 1, length 10, checksum 0x70; PB1 = CT 0 (refer to stream) \| CC 1 (2 ch); PB2 = 0 (SS/SF from the stream header); PB4 CA = 0x00 (FL/FR); PB5 = 0 [read: field values l.763-806; checksum arithmetic: 0x84 + 0x01 + 0x0A + 0x70 + 0x01 = 0x100] |
| 26 | `0xF8CE1B7C` | `TPI_INFO_EN` | RMW [7:6] = **0b11** (EN + RPT, sent every frame) | `sApplyInfoFrame(1)` l.1660; [5] reads back `CEA_INFO_EN` |
| 27 | `0xF8CE1AFC` | `TPI_INFO_FSEL` | restore the value saved in step 5 (normally **0** = AVI) | 6.12 l.672 [read]; vendor leaves the last-selected buffer [read] |
| **Enable / unmute** | | | | `HAL_HDMI_AudioEnable(true)` (`hdmi_hal.c:1733-1738`) |
| 28 | `0xF8CE284C` | `AUD_EN` | RMW [0] = 1, [1] `AUD_SEL_OWRT` = 0 → **0x01** | l.3250-3251 |
| 29 | `0xF8CE2804` | `ACR_CTRL` | RMW [1] `CTS_REQ_EN` = 1 → **0x0E** ([3] no-MCLK CTS gen, [2] MCLK_EN, [1] req, [0] 0 = HW CTS) | l.3252; bit defs regs header l.11901-11914 |
| 30 | `0xF8CE28BC` | `AUDP_TXCTRL` | RMW [7] `AUD_MUTE_EN` = 0 | l.3278 |

### 3.2 Verification (read-only, no ears needed)

| Address | Register | Expect |
|---|---|---|
| `0xF8CE2824/28/2C` | `CTS_TXHVAL1..3` (0x3A09-0B, hardware CTS) | 20-bit **148500 = 0x24414** → bytes `0x14 0x44 0x02` (±1-2 jitter) [inferred, from the vendor table]. 0 = no I2S clock reaching the AIP |
| `0xF8CE2848` | `AIP_IN_AUD_ID` (0x3A12, RO) | bit 1 = I2S stream identified (regs header field comment) |
| `0xF8CE28C4` | `AUDP_TXFIFO` (0x3A31, RO) | [5:0] read/write-pointer difference: non-zero and changing |
| `0xF8CE293C` | `AIP_INTR1` (0x3A4F) | [0] FIFO underflow, [1] overflow: should stay 0 after write-1-to-clear |
| TX3 `0xF8CD2320` | `TX_WS_CNT` | advances 48 000 / s (same method as `scripts/himedia/audio/test-on-box.sh`) |

`scripts/himedia/audio/hdmi-audio.sh dump|apply|off` does §3.0, §3.1 and §3.2 over ssh +
`busybox devmem`. `dump` is read-only and is the first thing to run. `apply` refuses DVI mode.
Not run yet: this session made no ssh connections.

## 4. Mute / unmute without touching AVMUTE

- **Audio-only mute:** `AUDP_TXCTRL[7] = 1` (`0xF8CE28BC`). The vendor follows it with the
  2 ms `AIP_RST` pulse (§3.1 #3-4). Unmute = `[7] = 0`. That is the whole of
  `sAudioMuteSet` (l.3262-3283), and it is gated on HDMI1/HDMI2 TMDS mode [read].
- **Never touch:** `TPI_INFO_FSEL = 7` (GEN2) or `TPI_INFO_EN` while FSEL = 7. The vendor
  builds the GCP AVMUTE packet in that buffer (`sAvMuteSet`, l.3064-3180, `himm 0xf8ce1afc 0x7`)
  [read]. Our InfoFrame steps select 2 and restore the saved selector, so the GCP buffer is
  never addressed.
- **Do not use** `TPI_AUD_CONFIG[4]` (`0xF8CE2988`, "1 = mute, sets reg_aud_mute_en"). It is
  equivalent but the vendor writes only 0x00 there (l.3018) [read].

## 5. Paste-ready defines

```c
/* Hi3798CV200 HDMI TX (SiI "imagev200" core) -- audio subset. 8-bit regs, one per 32-bit word.
 * vendor SDK 4.4.35 drivers/msp/drv/hdmi/hdmi_2_0/hal/ctrl/imagev200 (see doc for cites) */
#define HDMITX_BASE             0xF8CE0000
#define HDMITX_SIZE             0x4000
#define HDMITX_REG(page, off)   ((((page) << 8) | (off)) << 2)      /* byte offset from base */

/* page 0 */
#define HDMI_PKT_FILTER_0       HDMITX_REG(0x0, 0x75)   /* [1] drop CTS pkt, [3] drop AIF pkt */
#define HDMI_TEST_TXCTRL        HDMITX_REG(0x0, 0xF7)   /* [1] HDMI mode (0 = DVI) */
#define  TEST_TXCTRL_HDMI_MODE  BIT(1)

/* page 6: TPI InfoFrame buffers */
#define HDMI_TPI_INFO_FSEL      HDMITX_REG(0x6, 0xBF)   /* [3:0] buffer select */
#define  TPI_FSEL_AVI           0x0
#define  TPI_FSEL_AUDIO         0x2                     /* 14-byte buffer */
#define  TPI_FSEL_GEN2_GCP      0x7                     /* AVMUTE lives here -- never touch */
#define HDMI_TPI_INFO_B(n)      (HDMITX_REG(0x6, 0xC0) + 4 * (n))   /* n = 0..30 */
#define HDMI_TPI_INFO_EN        HDMITX_REG(0x6, 0xDF)
#define  TPI_INFO_CEA_EN_RO     BIT(5)
#define  TPI_INFO_RPT           BIT(6)
#define  TPI_INFO_EN            BIT(7)

/* page A: audio input processor + ACR */
#define HDMI_ACR_CTRL           HDMITX_REG(0xA, 0x01)
#define  ACR_CTS_SW_SEL         BIT(0)                  /* 0 = hardware CTS (vendor) */
#define  ACR_CTS_REQ_EN         BIT(1)                  /* send N/CTS packets */
#define  ACR_MCLK_EN            BIT(2)
#define  ACR_NO_MCLK_CTSGEN     BIT(3)
#define  ACR_CTRL_IDLE          0x0C
#define  ACR_CTRL_RUN           0x0E
#define HDMI_FREQ_SVAL          HDMITX_REG(0xA, 0x02)   /* [2:0] MCLK = 128/256/384/512 fs, reset 256 */
#define HDMI_N_SVAL1            HDMITX_REG(0xA, 0x03)   /* N[7:0] */
#define HDMI_N_SVAL2            HDMITX_REG(0xA, 0x04)   /* N[15:8] */
#define HDMI_N_SVAL3            HDMITX_REG(0xA, 0x05)   /* N[19:16] */
#define HDMI_CTS_SVAL(n)        HDMITX_REG(0xA, 0x06 + (n))   /* n = 0..2, unused in HW mode */
#define HDMI_CTS_HVAL(n)        HDMITX_REG(0xA, 0x09 + (n))   /* n = 0..2, RO measured CTS */
#define HDMI_AIP_IN_AUD_ID      HDMITX_REG(0xA, 0x12)   /* RO [0] spdif [1] i2s [2] dsd [3] hbr */
#define HDMI_AUD_EN             HDMITX_REG(0xA, 0x13)
#define  AUD_EN_IN_EN           BIT(0)
#define  AUD_EN_SEL_OWRT        BIT(1)
#define HDMI_AUD_MODE           HDMITX_REG(0xA, 0x14)
#define  AUD_MODE_SPDIF_EN      BIT(1)
#define  AUD_MODE_HBRA_ON       BIT(2)
#define  AUD_MODE_DSD_EN        BIT(3)
#define  AUD_MODE_I2S_SD(n)     BIT(4 + (n))            /* SD0..SD3 */
#define HDMI_I2S_IN_MAP         HDMITX_REG(0xA, 0x1C)   /* reset = identity */
#define HDMI_I2S_IN_CTRL        HDMITX_REG(0xA, 0x1D)   /* vendor 0x60 */
#define HDMI_I2S_CHST(n)        HDMITX_REG(0xA, 0x1E + (n))   /* n = 0..4 -> CS bytes 0..4 */
#define HDMI_ASRC               HDMITX_REG(0xA, 0x23)   /* [7:4] HBR sample-present mask */
#define HDMI_I2S_IN_SIZE        HDMITX_REG(0xA, 0x24)   /* vendor 0x0B */
#define HDMI_I2S_CHST6          HDMITX_REG(0xA, 0x28)
#define HDMI_I2S_CHST7          HDMITX_REG(0xA, 0x29)
#define HDMI_AIP_RST            HDMITX_REG(0xA, 0x2C)
#define  AIP_RST_AUDIO          BIT(0)
#define  AIP_RST_FIFO           BIT(1)
#define  AIP_RST_ACR            BIT(2)
#define HDMI_AUDP_TXCTRL        HDMITX_REG(0xA, 0x2F)
#define  AUDP_LAYOUT1           BIT(1)
#define  AUDP_AUD_MUTE_EN       BIT(7)
#define HDMI_AUDP_TXFIFO        HDMITX_REG(0xA, 0x31)   /* RO [5:0] fifo fill */
#define HDMI_AIP_INTR1          HDMITX_REG(0xA, 0x4F)   /* [0] underflow [1] overflow, W1C */
#define HDMI_TPI_DOWN_SMPL_CTRL HDMITX_REG(0xA, 0x61)   /* [1:0] = 3: no downsampling */
#define HDMI_TPI_AUD_CONFIG     HDMITX_REG(0xA, 0x62)   /* vendor 0x00 */
#define HDMI_TPI_AUD_FS         HDMITX_REG(0xA, 0x63)   /* [3:0] fs code, [7] override */
#define  TPI_AUD_FS_48K         0x02
#define  TPI_AUD_FS_OVRD        BIT(7)

/* PERI / CRG (not in the HDMI window) */
#define PERI_HDMITX_CTRL0       0xF8A208B0              /* [4:0] hdmitx_aud_id */
#define  HDMITX_AUD_SRC_MASK    GENMASK(4, 0)
#define  HDMITX_AUD_SRC_SPDIF   BIT(0)
#define  HDMITX_AUD_SRC_I2S     BIT(1)
#define PERI_CRG67_HDMITX       0xF8A2210C              /* [5] as_cken, [14] asclk_sel -- read only */

/* 48 kHz / 16-bit / 2 ch values */
#define HDMI_N_48K              6144
#define HDMI_CTS_48K_148M5      148500                  /* expected HW CTS at 1080p60 8 bpc */
#define I2S_CHST3_48K           0x02
#define I2S_CHST4_16BIT         0x02
static const u8 hdmi_audio_if_2ch[14] = {
        0x84, 0x01, 0x0A, 0x70,         /* type, version, length, checksum */
        0x01, 0x00, 0x00, 0x00, 0x00,   /* PB1 CC=1 (2ch), PB2 refer-to-stream, PB3, PB4 CA=0 */
        0x00, 0x00, 0x00, 0x00, 0x00 };

/* AIAO I2S TX3 = the HDMI feed (extends the q10_aiao defines) */
#define PORT_TX3                0x2300
#define TX3_IF_ATTRI_VAL        0xE4300014              /* I2S, 16b, 2ch, src TX3, SD 0123 */
#define TX3_CRG_CFG1_VAL        0x00000133              /* bclk idx 3, fs idx 3, cken */
#define SWITCH_TX03_SHIFT       12                      /* value 11 = AIAO_TX_CRG3 */
#define AIAO_INT_TX3            BIT(19)
```

## 6. Integration note for `q10_aiao.c` [inferred]

- Add TX3 as a third consumer of the same ring (outputs bit 2). Use `port_ring(PORT_TX3, …)`,
  write `TX3_IF_ATTRI_VAL`, `I2S_TX_CRG_CFG0(3)` = `mclk_div`, `I2S_TX_CRG_CFG1(3)` = 0x133,
  `rmw(AIAO_SWITCH_TX_BCLK, GENMASK(15,12), 11 << 12)`. Enable and stop it alongside TX2.
- Map the HDMI window separately (`ioremap(0xF8CE0000, 0x4000)`) and run §3.1 once at
  `trigger START`, after TX3 is enabled. At STOP, run only #1-#4 (mute + AIP reset). Leave the
  InfoFrame on, since the sink tolerates a muted stream.
- Do not claim the HDMI block in DT and do not touch its clocks or resets. The console depends
  on the bootloader's video state.

## 7. Open questions

1. **Boot fingerprint.** Does the live box show `AUDP_TXCTRL = 0x80`, `ACR_CTRL = 0x0C`,
   `I2S_IN_CTRL = 0x60` and `TPI_AUD_FS = 0x82` (fastboot ran `sHardwareInit`)? Run
   `hdmi-audio.sh dump`.
2. **HDMI vs DVI mode** on the current sink (`TEST_TXCTRL[1]`). A DVI-mode link cannot carry
   audio without a mode change, which this recipe does not do.
3. **TX3 → AIP wiring.** That I2S TX3 is hard-wired to the HDMI AIP SD0 is inferred from the
   absence of any other writer. Test: `CTS_TXHVAL` ≈ 148500 and `AIP_IN_AUD_ID[1] = 1` with TX3
   running, and both 0 with TX3 stopped.
4. **Hardware CTS without MCLK** (`ACR_CTRL[3] = 1`): this is the vendor default and is
   expected to work. Fallback: software CTS = 148500 in `CTS_SVAL1..3` (`0x14, 0x44, 0x02`)
   with `ACR_CTRL[0] = 1`.
5. **Deep colour / other modes.** The numbers assume 8 bpc at 148.5 MHz. Hardware CTS follows
   the TMDS clock on its own, but the readback check value changes (CTS = N × f_TMDS / 128 / fs).
6. **`TPI_INFO_EN` semantics:** the code does not show whether [7] self-clears with [6] set
   ("once transmission is done the hardware will reset it back to 0" — field comment). Use
   `CEA_INFO_EN` [5] as the readback, the way the 6.12 driver polls it (l.615-628).
7. **SCMS:** the vendor sends copy-prohibited (CHST0 = 0). Some receivers/AVRs mute
   copy-prohibited PCM only in record paths. Set 0x04 if a sink complains.
8. **The TV's EDID** (whether it supports audio at all): not needed to transmit. Read it only if
   the sink stays silent while §3.2 passes.
9. **HKC TV note:** `sHardwareInit` says a "blurred screen in boot" on HKC-F24PA1100 needs
   `ACR_CTRL = 0x0E` (l.3008). That is the value we set when enabling, so it is not a risk here.
   It does show that ACR packets interact with some sinks' video lock.

## Sources

- `~/src/hisilicon-kernel-4.4.35/drivers/msp/drv/hdmi/Makefile`,
  `hdmi_2_0/{drv_hdmi_intf.c, drv_hdmi_infoframe.c, drv_hdmi_compatibility.c}`,
  `hdmi_2_0/product/Hi3798CV200/hdmi_platform.h`,
  `hdmi_2_0/hal/ctrl/imagev200/{hdmi_hal.c, platform/platform.c, driver/si_drv_tx_regs.h,
  driver/si_drv_tx_regs_enums.h, driver/cra/si_drv_cra.c, driver/tx/si_drv_tx.c,
  driver/tx/tx_hdmi/si_mod_tx_hdmi.c}`
- `.../drivers/msp/drv/aiao/aiao_v1_1/{ao/drv_ao_op.c, ao/drv_ao_op.h, ao/drv_ao.c,
  common/src/hal_aiao.c, common/src/hal_aiao_priv.c, common/include/hal_aiao_common.h,
  common/include/hal_aiao_priv.h}`
- `.../drivers/common/include/hi3798cv200/{hi_reg_crg.h, hi_reg_peri.h}`
- https://github.com/HiSilicon-Development/linux-6.12.y `drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c`
  (local copy `~/src/histb-6.12-hdmi/histb-hdmi.c`, 62,425 bytes)
- `docs/261011-himedia-aiao-programming-recipe.md`, `scripts/himedia/audio/q10_aiao.c`
