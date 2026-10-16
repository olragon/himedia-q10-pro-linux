# HiMedia Q10 Pro: IR remote keymap and audio output research (2026-10-11)

Scope: read-only research. Nothing was flashed, no ssh, nothing written under $HIMEDIA_ROOT, nothing committed.
Tags: **[read: file]** = seen in a file this session. **[inferred]** = reasoned from files, not observed on the box. **[unknown]** = not found.
Source caveat: the box ran a 3.18 build (`vermagic=3.18.24_hi3798cv2x`), the source tree is 4.4.35 of the same SDK, so every "source says" claim about the running kernel is **[inferred]**.

## Q1. IR remote

### Verdict
- The bundled remote is **IR, NEC protocol, address 0x10**. **[read: system.img /etc/key.xml, section `<himedia-key>`; every entry ends in `ef10`, and `ef` = ~`10`]**
- It needs a keymap. `hid-pt71600-remote-ima.ko` is **not** this remote (see below).
- Mainline `ir-hix5hd2` + NEC decoder will report **scancode = 0x10CC** (address<<8 | command). **[inferred]** from the two byte-order reads below; not yet observed with `ir-keytable -t` on hardware.

### How the vendor value maps to a mainline scancode
- Vendor value layout, e.g. KEY_UP = `0xba45ef10`. **[read: drivers/msp/drv/ir/ir_s2/drv_ir_nec.c ~l.538: `key.lower |= 1ULL << i`, i = bit arrival order]** so the first NEC byte lands in the lowest byte: byte0 = addr 0x10, byte1 = ~addr 0xef, byte2 = cmd 0x45, byte3 = ~cmd 0xba. **[inferred]** that NEC bits arrive LSB-first as in the standard.
- Mainline NEC decoder: first received byte is `address`, third is `command`; plain NEC when both complements check out, scancode `addr<<8|cmd`; NEC-extended `addr<<16|addr2<<8|cmd`. **[read: linux-6.18.55/drivers/media/rc/ir-nec-decoder.c l.142-156 and ir_nec_scancode_to_raw l.176-197]**
- Cross-check: both complement pairs hold for all 72 `himedia-key` values (the converter rejects any that fail; none were rejected). **[read: scripts/himedia/ir-keymap-to-toml.py run]**
- Timing table in the vendor driver lists "NEC with simple repeat code: uPD6121G" etc. **[read: ir_std/drv_ir_codedef.c]**. `android_ir_user` strings name protocol variants "nec full 2headers", "nec simple uPD6121G like", and so on **[read: strings of /system/bin/android_ir_user]**. Which variant the Q10 remote uses is **[unknown]**; mainline's NEC decoder accepts the simple-repeat form, which is the common case.

### Where the table lives
- `/system/bin/android_ir_user` reads `/etc/key.xml` **[read: strings: "/etc/key.xml", "key_xml", "%s, linux_keycode=0x%04x, ir_keycode=0x%.08llx"]**, resolves each `KEY_*` name through its own 407-entry name->Linux-code table **[read: scripts/himedia/android-ir-keytable-dump.py]**, and feeds `/dev/hi_ir` events into Android. The `.kl` files in `/system/usr/keylayout/` are the *second* stage (Linux code -> Android key); `Vendor_0001_Product_0001.kl` adds the HiMedia extras (248 VFD, 249 GAME, 250 MUSIC, 251 VIDEOSEARCH, 252 ONLINE, 253 IMAGEMODEL, 254 CYCLE, 255 POWERON, 195 3D, 196 HDR). **[read: diff of Generic.kl vs Vendor_0001_Product_0001.kl]**
- Vendor DT node: `ir@f8001000`, `hisilicon,hix5hd2-ir`, irq SPI 0x2f, `linux,rc-map-name = "rc-hisi"`. **[read: boot.img+0x8b5220.dts l.423-429]** No `rc-hisi` map exists in mainline (only `rc-hisi-poplar` and `rc-hisi-tv-demo`, other remotes). **[read: linux-6.18.55/drivers/media/rc/keymaps]**

### Other remotes in the same file
`<other-key>` holds two "Egreat" remotes (`94ca` = NEC-extended address 0xca/0x94, and `4040` = 0x40/0x40) and one "PNI" power key (`bd02` = address 0x02). **[read: key.xml]** They are not the Q10's remote. As mainline scancodes they would be NECX `0xca94CC`, `0x4040CC` and NEC `0x02CC`. **[inferred]** Not included in the TOML.

### Is `hid-pt71600-remote-ima.ko` the remote?
No. **[read: the .ko strings]** It is an HID driver with an ALSA sound card ("PT71600 Remote %i audio", `snd_pt71600_pcm_*`), matching `hid:b0005g*v00002B54p00001600`. Bus 0005 is Bluetooth in the kernel's `BUS_*` numbering, so this is an **optional Bluetooth voice remote** with a microphone, not the IR remote. **[inferred]** from the alias; no such remote is in hand. `build.prop` has `persist.guide.bt.remote=no`, so the BT remote is not the default. **[read: build.prop]** If such a remote is paired, mainline `hid-generic` should give keys; the voice/audio part would need a port of this driver. **[inferred]**

### Caveats on the keymap below
- Names: vendor-only keys (VFD, GAME, MUSIC, VIDEOSEARCH, ONLINE, IMAGEMODEL, CYCLE, POWERON, HDR, RATIO, TIMER, 3D, VIDEO) were mapped to mainline names by **our choice**, not from any file (table `VENDOR_TO_MAINLINE` in the script). Vendor codes 248-255 collide with mainline (248 = KEY_MICMUTE), which is why they were remapped.
- `KEY_RATIO` and `KEY_TIMER` are in key.xml but **not** in android_ir_user's name table **[read]**, so the stock firmware ignores these two buttons. We map them to ASPECT_RATIO / TIME as a guess.
- Duplicate scancodes: `0xa55aef10` is listed as KEY_FN_S then KEY_F5; first entry kept (stock behaviour on duplicates is **[unknown]**). Several buttons have two alternate codes (POWER x2, PLAYPAUSE x2, FN_S x3); both kept.
- Physical button labels are **[unknown]** (no photo of the remote was read), so names follow the vendor key names only.
- Regenerate with: `python3 -I scripts/himedia/ir-keymap-to-toml.py <key.xml> <input-event-codes.h>`. The stock key.xml can be extracted with `7z x system.img etc/key.xml` (7-Zip reads ext4; no docker was needed because `system-img-debugfs.sh` printed nothing in this session, cause **[unknown]**).

### Ready-to-use keymap (`/etc/rc_keymaps/himedia_q10.toml`)
Untested on hardware. Test with `ir-keytable -c -w /etc/rc_keymaps/himedia_q10.toml` then `ir-keytable -t`, and compare the printed scancodes with the table.

```toml
[[protocols]]
name = "himedia_q10"
protocol = "nec"
variant = "nec"
[protocols.scancodes]
0x1045 = "KEY_UP"  # vendor KEY_UP raw 0xba45ef10
0x1055 = "KEY_DOWN"  # vendor KEY_DOWN raw 0xaa55ef10
0x1007 = "KEY_LEFT"  # vendor KEY_LEFT raw 0xf807ef10
0x1001 = "KEY_RIGHT"  # vendor KEY_RIGHT raw 0xfe01ef10
0x1041 = "KEY_ENTER"  # vendor KEY_ENTER raw 0xbe41ef10
0x1000 = "KEY_BACK"  # vendor KEY_BACK raw 0xff00ef10
0x1005 = "KEY_MENU"  # vendor KEY_MENU raw 0xfa05ef10
0x105d = "KEY_POWER"  # vendor KEY_POWER raw 0xa25def10
0x107b = "KEY_POWER"  # vendor KEY_POWER raw 0x847bef10
0x1046 = "KEY_HOME"  # vendor KEY_HOME raw 0xb946ef10
0x1017 = "KEY_VOLUMEUP"  # vendor KEY_VOLUMEUP raw 0xe817ef10
0x1013 = "KEY_VOLUMEDOWN"  # vendor KEY_VOLUMEDOWN raw 0xec13ef10
0x1057 = "KEY_MUTE"  # vendor KEY_MUTE raw 0xa857ef10
0x1050 = "KEY_1"  # vendor KEY_1 raw 0xaf50ef10
0x1052 = "KEY_2"  # vendor KEY_2 raw 0xad52ef10
0x1010 = "KEY_3"  # vendor KEY_3 raw 0xef10ef10
0x104c = "KEY_4"  # vendor KEY_4 raw 0xb34cef10
0x104a = "KEY_5"  # vendor KEY_5 raw 0xb54aef10
0x1011 = "KEY_6"  # vendor KEY_6 raw 0xee11ef10
0x100f = "KEY_7"  # vendor KEY_7 raw 0xf00fef10
0x104e = "KEY_8"  # vendor KEY_8 raw 0xb14eef10
0x100d = "KEY_9"  # vendor KEY_9 raw 0xf20def10
0x104f = "KEY_0"  # vendor KEY_0 raw 0xb04fef10
0x101a = "KEY_RED"  # vendor KEY_RED raw 0xe51aef10
0x1058 = "KEY_GREEN"  # vendor KEY_GREEN raw 0xa758ef10
0x105c = "KEY_YELLOW"  # vendor KEY_YELLOW raw 0xa35cef10
0x101d = "KEY_BLUE"  # vendor KEY_BLUE raw 0xe21def10
0x1042 = "KEY_SEARCH"  # vendor KEY_SEARCH raw 0xbd42ef10
0x1040 = "KEY_REWIND"  # vendor KEY_REWIND raw 0xbf40ef10
0x101c = "KEY_FORWARD"  # vendor KEY_FORWARD raw 0xe31cef10
0x105b = "KEY_STOP"  # vendor KEY_STOP raw 0xa45bef10
0x1008 = "KEY_SETUP"  # vendor KEY_SETUP raw 0xf708ef10
0x1044 = "KEY_INFO"  # vendor KEY_INFO raw 0xbb44ef10
0x1004 = "KEY_9"  # vendor KEY_9 raw 0xfb04ef10
0x1054 = "KEY_7"  # vendor KEY_7 raw 0xab54ef10
0x1059 = "KEY_PLAYPAUSE"  # vendor KEY_PLAYPAUSE raw 0xa659ef10
0x101b = "KEY_PLAYPAUSE"  # vendor KEY_PLAYPAUSE raw 0xe41bef10
0x1015 = "KEY_PAGEDOWN"  # vendor KEY_PAGEDOWN raw 0xea15ef10
0x1014 = "KEY_PAGEUP"  # vendor KEY_PAGEUP raw 0xeb14ef10
0x105f = "KEY_FN_2"  # vendor KEY_FN_2 raw 0xa05fef10
0x1002 = "KEY_REDO"  # vendor KEY_REDO raw 0xfd02ef10
0x101e = "KEY_EJECTCLOSECD"  # vendor KEY_EJECTCLOSECD raw 0xe11eef10
0x100c = "KEY_ZOOMIN"  # vendor KEY_ZOOMIN raw 0xf30cef10
0x1064 = "KEY_FN_S"  # vendor KEY_FN_S raw 0x9b64ef10
0x104b = "KEY_FN_S"  # vendor KEY_FN_S raw 0xb44bef10
0x105a = "KEY_FN_S"  # vendor KEY_FN_S raw 0xa55aef10
0x105e = "KEY_BACKSPACE"  # vendor KEY_BACKSPACE raw 0xa15eef10
# duplicate 0x105a: KEY_F5 ignored, first = KEY_FN_S
0x1060 = "KEY_TV"  # vendor KEY_TV raw 0x9f60ef10
0x1061 = "KEY_F4"  # vendor KEY_F4 raw 0x9e61ef10
0x1062 = "KEY_SOUND"  # vendor KEY_SOUND raw 0x9d62ef10
0x1063 = "KEY_CAMERA"  # vendor KEY_CAMERA raw 0x9c63ef10
0x1048 = "KEY_NUMERIC_STAR"  # vendor KEY_NUMERIC_STAR raw 0xb748ef10
0x1009 = "KEY_ASPECT_RATIO"  # vendor KEY_RATIO raw 0xf609ef10
0x1049 = "KEY_EPG"  # vendor KEY_EPG raw 0xb649ef10
0x1067 = "KEY_WWW"  # vendor KEY_ONLINE raw 0x9867ef10
0x1016 = "KEY_RECORD"  # vendor KEY_RECORD raw 0xe916ef10
0x1066 = "KEY_TIME"  # vendor KEY_TIMER raw 0x9966ef10
0x1051 = "KEY_3D_MODE"  # vendor KEY_3D raw 0xae51ef10
0x1070 = "KEY_RECORD"  # vendor KEY_RECORD raw 0x8f70ef10
0x1071 = "KEY_GAMES"  # vendor KEY_GAME raw 0x8e71ef10
0x1072 = "KEY_AUDIO"  # vendor KEY_MUSIC raw 0x8d72ef10
0x1073 = "KEY_SEARCH"  # vendor KEY_VIDEOSEARCH raw 0x8c73ef10
0x1074 = "KEY_WWW"  # vendor KEY_ONLINE raw 0x8b74ef10
0x1075 = "KEY_VOD"  # vendor KEY_VIDEO raw 0x8a75ef10
0x1076 = "KEY_CYCLEWINDOWS"  # vendor KEY_CYCLE raw 0x8976ef10
0x1077 = "KEY_DISPLAYTOGGLE"  # vendor KEY_VFD raw 0x8877ef10
0x1078 = "KEY_CLEAR"  # vendor KEY_CLEAR raw 0x8778ef10
0x1079 = "KEY_MODE"  # vendor KEY_IMAGEMODEL raw 0x8679ef10
0x107a = "KEY_WAKEUP"  # vendor KEY_POWERON raw 0x857aef10
0x1080 = "KEY_PROG1"  # vendor KEY_HDR raw 0x7f80ef10
```

## Q2. Audio outputs

### Summary
There is no vendor DT node for audio: the 3.18 DT has none. **[read: grep of the vendor dts for aiao/adac/audio/spdif/i2s/hdmi/codec found nothing]** Addresses below come from SDK headers, so they apply to the SoC family and are **[inferred]** for this box. Nothing in mainline 6.18 drives this block. **[read: sound/soc/hisilicon holds only hi6210-i2s; drivers/clk has no AIAO/ADAC clock in crg-hi3798cv200.c]** (clock grep returned nothing; a full audit of the CRG driver was not done, so "no clock" is **[inferred]**).

### IP blocks and registers
| Block | Facts | Tag |
|---|---|---|
| AIAO common block (I2S RX x8, I2S TX x8, SPDIF TX x4, SPDIF receiver) | register base `0xF8CD0000`, size 0x10000; sub-blocks: COM +0x0, CRG +0x100, RX +0x1000, TX +0x2000, TX-SPDIF +0x3000, SPDIF-RX +0x4000 | read: aiao_v1_1/common/include/hal_aiao_common.h l.84-96 |
| AIAO interrupt | `AIAO_IRQ_NUM = 84 + 32` (Linux IRQ number, so GIC SPI 84; requested shared, "aiao") | read: hal_aiao_common.h l.36, hal_aiao.c l.339; SPI conversion is inferred |
| AOE (audio output engine / mixer in front of AIAO) | separate register window `AOE_COM_REG_BASE`; its definition was **not found** | unknown |
| Internal audio DAC "Tianlai ADAC v600" (RCA analog) | selected for hi3798cv200 in Makefile. Control registers sit in the **PERI block** (`0xF8A20000`): PERI_TIANLA_ADAC0, ADAC1, ADAC2 (headers list offsets 0x110/0x114/0x160 for these in hi_reg_peri.h; I did not verify which line belongs to which register name beyond the header comments). Reset/clock gate in CRG `0xF8A22000`: PERI_CRG69 @0x114 (bit0 adac_cken, bit4 adac_srst_req) | read: Makefile l.101-102, hal_tianlai_adac_v600.c, hi_reg_common.h l.17-19, hi_reg_crg.h |
| AIAO clock/reset | PERI_CRG70 @0x118 (bit0 aiao_cken, bit4 aiao_srst_req, bits 21:20 mclk_sel, bit 22 clk_sel, bits 16:12 skipcfg) | read: hi_reg_crg.h, hal_aiao_priv.c AIAO_HW_PowerOn |
| AIAO audio PLL | `AIAO_PLL_933MHZ` for 98cv200 (EPLL 933.888 MHz) | read: hal_aiao_common.h l.69 |
| HDMI audio | HDMI sink gets audio from an AIAO I2S/SPDIF TX port; with `HI_SND_HDMI_I2S_SPDIF_MUX` (set for this chip in the aiao Makefile l.64) the HDMI TX can take either; code pairs `AIAO_PORT_SPDIF_TX0` with `AIAO_PORT_TX2` for HDMI. HDMI TX controller itself is a separate vendor driver (`drivers/msp/drv/hdmi/hdmi_1_4`, `hdmi_2_0`) | read: hal_aiao_func.c, drv_aiao_veri.c l.199-202; port-to-connector mapping beyond that is **inferred** |
| S/PDIF out (optical + coaxial) | SPDIF TX ports 0..3 (`AIAO_PORT_SPDIF_TX0..3`); one SPDIF engine drives the pin. Whether optical and coax share one engine on this board: unknown | read: hal_aiao_common.h l.186-189 |

Port-to-connector wiring on the Q10 board (which pin is TX0 vs SPDIF) and any external codec on I2S: **[unknown]**. The vendor tree also holds `adac/tlv320aic31` as an optional external codec; no sign it is fitted. **[read: dir listing; fitment unknown]**

### Mainline fit
- No existing mainline driver covers AIAO. `sound/soc/hisilicon/` has only the hi6210 I2S, a different IP. **[read]** A generic fit (`snd-soc-spdif-tx` codec + a new CPU DAI) is plausible for S/PDIF and HDMI: the new part is the CPU-side DMA engine, since AIAO has its own ring-buffer registers rather than the SoC DMA controller (buffer address/size/wptr/rptr per port, 128-byte alignment, up to 2^24 bytes). **[read: hal_aiao_common.h buffer macros]** That "own ring buffer" reading is **[inferred]** from names; register semantics were not read in detail.
- The DAC: a small register set in PERI plus clock/reset; maps to a simple ASoC codec driver. **[inferred]**
- DesignWare I2S: no evidence AIAO is a DesignWare IP. **[unknown, probably not]**

### Effort estimates (all **[inferred]**, assume the box boots mainline and AIAO registers can be poked)
| Goal | Work | Estimate |
|---|---|---|
| (a) S/PDIF only | CRG gate/reset + PLL select for AIAO (clock driver additions or DT `clocks` plus a small CRG patch), AIAO CPU-DAI with one SPDIF TX port, `snd-soc-spdif-tx`, `simple-audio-card`, DT node + IRQ | smallest: roughly 1 to 2 focused days of work if the TX-SPDIF register layout is clean in the headers, longer if undocumented bits matter |
| (b) analog RCA | everything in (a) for an I2S TX port, plus the ADAC power-up sequence (PERI ADAC0/1/2, CRG69, the deemphasis/volume/path bits), plus mclk/bclk routing to the DAC | about 1.5 to 2x (a); analog bring-up needs hardware listening and a scope or just ears |
| (c) HDMI audio | (a) plus the HDMI TX controller. If the board's HDMI video comes from a bare framebuffer, no mainline driver exists for the Hi3798CV200 HDMI TX, so audio infoframes and the audio clock regeneration (N/CTS) must be programmed too | largest, and gated on HDMI TX work that is a project of its own |

### Route that avoids writing a driver
Honest answer: **no known clean route; one hack is plausible**.
- Stock Android configures AIAO from its drivers at boot, then the mainline kernel replaces it via kexec/boot, so I assume the block is **not** left running. **[inferred]; the boot chain details were not rechecked here]** The Android-side register dump in `android-probe/regs-android-*.txt` holds only four CRG lines (USB3, USB2, ETH) and no AIAO/ADAC words. **[read]**
- Hack: a userspace program using `/dev/mem` could do the CRG/AIAO/ADAC setup and push samples into a ring buffer, but it needs a physically contiguous DMA buffer the hardware can reach, the correct register sequence (which I have only partially read), and a mainline kernel that allows `/dev/mem` for those ranges. No real-time pacing, no ALSA. **[inferred]** I consider this a one-off lab probe, not a solution, and it is worth doing only to learn the register sequence before writing the driver.
- A USB audio device works with no driver work, but the task says it is out of scope.

### Recommended order
1. Prove the register sequence with a `/dev/mem` poke for S/PDIF or the DAC on the box (still no ssh from this task, so this needs a session that has box access).
2. Write the CRG/PLL pieces and an AIAO CPU DAI for SPDIF; then add the DAC.
3. HDMI audio only after HDMI TX has a driver.

### Not read / open
AOE register base and whether the AOE is mandatory for plain TX playback; per-port wiring on this board; HDMI TX register map; whether AIAO state survives into the mainline boot; PERI ADAC register names versus offsets.
