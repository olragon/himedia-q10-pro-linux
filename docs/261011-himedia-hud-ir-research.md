# HiMedia Q10 Pro front panel (HUD) and IR - research

Confidence tags: **[read]** = read in a file/disassembly (source named); **[inferred]** = deduced, reasoning given; **[unknown]** = not established.
Work files (disassembly, extracted binaries) are in `$HIMEDIA_ROOT/hud-work/` . Tools added: `scripts/himedia/disasm-stock-kernel-range.sh`, `scripts/himedia/decode-keyled-gpio-ops.py`.

## 1. Which keyled variant, and which pins

| claim | tag | evidence |
|---|---|---|
| The vendor SDK tree `~/src/hisilicon-kernel-4.4.35` has NO tm1628/tm1629 driver. Its variants are 74HC164, PT6961, CT1642, PT6964, FD650, GPIOKEY (enum values 0-5). | read | `drivers/msp/drv/keyled/`, `hi_unf_keyled.h` |
| The shipped Android kernel (linux-3.18.y, decompressed from `_update/boot.img`, ARM, virtual base 0xc0008000) contains a `keyled_tm1628.c` driver and prints `KEYLED_DRV_ModInit default select TM1629 keyled`. | read | strings in decompressed kernel at file offsets 0x102ee85, 0x102e6c0; base proven by linux_banner literal-pool refs |
| The live box has `persist.sys.keyled = tm1629`. | read | `recon/20261010015439.-recon.md` line 352 |
| Android userspace `/system/bin/hmd_keyled_display` (started from `/system/etc/init.bigfish.sh` line 112) reads keyled type from deviceinfo @0x3000, else from `persist.sys.keyled`; result ct1642=3, tm1629=2, tm1628=1; maps tm1628 -> `HI_UNF_KEYLED_SelectType(7)`, tm1629 -> `SelectType(6)`, none found -> 6, else CT1642 type 2. Types 6/7 are vendor extensions beyond the SDK enum. | read | Thumb disassembly of the binary (main at 0x17xx) |
| deviceinfo.img offset 0x3000 is all zero (no keyled type stored there). | read | `xxd -s 0x3000` |
| So the board runs TM1629 mode (type 6). | read+inferred | property + default path agree |

### Pins (TM1629 path in stock kernel)

The tm1628 file's helpers write GPIO bank 2 directly: helper at vaddr 0xc09fe5c4 tests the bit against the DIR register at `0xf9b22400` (virt; = phys 0xF8B22400 assuming the usual +0x01000000 static map) and writes DATA at base + (4<<bit). Init at 0xc09fe614 ORs 0x01, 0x08, 0x10 into DIR (outputs).

| signal | SoC pin | gpio2 line | tag |
|---|---|---|---|
| STB | GPIO2_0 | 0 | read (c09fe784: pin 0 high, then CLK high, then pin 0 low = start; c09fe9a4: pin 0 high = end) |
| DIO | GPIO2_3 | 3 | read (c09fe720: pin 3 = `r2 & 1` data bit) |
| CLK | GPIO2_4 | 4 | read (c09fe6fc/c09fe744: pin 4 low, data, pin 4 high per bit) |

- Role assignment (STB/DIO/CLK) is **inferred from the waveform shape**, not from a label. Bank 2 from the hard-coded 0xf9b22xxx is **read**; the +0x01000000 virt-to-phys offset is **inferred** (matches mainline `gpio2: gpio@8b22000` in our dtsi, 0xf8b22000).
- Bit order on the wire: not decoded to the end. The send loop (c09fe6d8) runs 8 iterations with `lsr` - LSB-first is **inferred** (matches TM16xx convention), not confirmed.
- Delay between edges: calls into helper c09fe6d8/c09fe774; the numeric delay is **unknown** (not decoded).
- Keys: whether the panel keys are scanned by the TM1629A (key read, DIO turned to input) vs separate GPIOs: **unknown**. The TM1629 routines at 0xc09fe774 take a direction flag, consistent with a DIO read (**inferred**). The stock kernel also has other drivers using GPIO2? no: PT6964-style code uses GPIO "pins" 42/43/44/45 = **GPIO5_2..5_5** (a different bank, in the SoC always-on GPIO5 block) and CT1642 uses 44/7/40 - those are NOT the TM1629 path (read, other function groups). Do not drive them.
- hmd_keyled_display also directly sets GPIO5 DIR (0xf8004400) bit3 and DATA bit3 (0xf80043fc) - GPIO5_3 as an output (read). Its role (standby/power LED?) is **unknown**. It also ORs 0x80 into physical register 0xf8000044 before that (read); meaning **unknown** (a sysctrl/pinmux-type register, unverified).
- **Pinmux:** not established. Nothing in the TM1629 helper writes IOCONFIG (0xf8a21000). Whether GPIO2_0/3/4 need a mux change from reset state is **unknown**. Our dtsi gives gpio2 `gpio-ranges = <&pmx0 0 16 5 &pmx0 5 21 3>` (read in hi3798cv200.dtsi:419); mainline pinctrl may need those pads in GPIO function - verify on the box with the pinctrl debugfs before bit-banging (read-only check).

## 2. Digit / segment map

**[unknown] - not extracted.** The tm1628 driver has a char table and a `disp_buf_arr`/`display_mode_array` (strings at 0x102ed2c, 0x102ed70; "no find the char: %c", "TurnOn LED[%d] symbol is error") but I did not decode the table. Next step: find the table via the literal-pool refs at file offsets 0x9f5418/0x9f735c (c09fd418/c09ff35c) and dump the byte tables; or photograph/probe by writing 0xFF to each display RAM address and observing the panel (needs the box, outside this task). The display-RAM write function at c09f7840-style `0x40 | ((x>>7)&0x3e)` belongs to the 2-wire FD650-family code, not to TM1629; do not reuse it.

## 3. TM1629A protocol

**Datasheet not fetched** (alldatasheet.com and datasheet4u.com returned 403; only search snippets). Known sources to open in a browser: https://www.alldatasheet.com/datasheet-pdf/view/1137173/TITAN/TM1629A.html , https://www.alldatasheet.net/datasheet-pdf/pdf/1137173/TITAN/TM1629A.html , https://lcsc.com/product-detail/LED-Drivers_TM-Shenzhen-Titan-Micro-Elec-TM1629A_C19760.html . The search snippet states: Titan Micro, key-scan capable LED driver, 16 seg x 8 digit, 80 mA max drive, SOP-32 (inferred from search result text only).

Everything below is **[inferred] from the family convention (TM1628/TM1637/TM1638), not from the TM1629A datasheet** - verify before trusting:
- STB low frames a command; data shifts on CLK rising edge, LSB first.
- 0x40 data set (auto-increment write), 0x44 fixed-address write, 0x42 read key data; 0xC0|addr address set followed by data bytes; 0x80 display off, 0x88|brightness(0-7) display on.
- Timing limits, display-RAM layout and the key matrix: **unknown**.

Consistency check with the stock driver: the observed STB/CLK/DIO wiring and a start sequence of "STB high, CLK high, STB low" are consistent with a 3-wire TM16xx part (read in disassembly), which supports Tim's chip identification.

## 4. IR receiver

| item | result | tag |
|---|---|---|
| Vendor DT node | `ir@f8001000`, `compatible="hisilicon,hix5hd2-ir"`, `reg = <0xf8001000 0x1000>`, `interrupts = <0 0x2f 4>` (SPI 47, level high), `clocks = <&clk 0x384>`, `linux,rc-map-name = "rc-hisi"` | read (`_dtb/boot.img+0x8b5220.dts` line 423) |
| Our node | `ir: ir@8001000`, same compatible, `reg <0x8001000 0x1000>` (soc ranges strip 0xf0000000? the other nodes use the same convention), `GIC_SPI 47 LEVEL_HIGH`, `clocks = <&sysctrl HISTB_IR_CLK>`, `status = "disabled"` | read (hi3798cv200.dtsi:599) |
| Match | reg offset, interrupt (47) match. Clock: vendor index 0x384 is in the vendor's clock numbering; that `HISTB_IR_CLK` maps to the same gate is **inferred**, not verified. **Our node is `status = "disabled"` - it must be enabled in the board dts.** | read / inferred |
| Kconfig | `CONFIG_IR_HIX5HD2=y`, `RC_CORE=y`, `LIRC=y`, `RC_MAP=y`, `RC_DECODERS=y`, `IR_NEC_DECODER=y`, `INPUT_EVDEV=y` already set; RC5/RC6/Sony/etc. decoders off | read (`.config`) |
| Keymap | mainline has `rc-hisi-poplar` and `rc-hisi-tv-demo` (NEC 0xb2xx scancodes, e.g. 0xb292 = 1). Vendor name `rc-hisi` is not a mainline map name. The Q10 Pro remote's actual NEC address/codes: **unknown**. The box also loads `hid-pt71600-remote-ima.ko` (init.bigfish.sh line 108), suggesting the supplied remote may be a USB/RF HID dongle, not IR - **inferred**. | read / inferred |
| Next step | Enable node, `ir-keytable -p nec -t` on the box and press keys; the vendor `key.xml`/`keyfunction.xml` in `/system/etc` are candidates for the vendor code table (not opened). | - |

## Gaps (honest list)
1. Digit/segment map: unknown. 2. TM1629A datasheet: not fetched, protocol is family convention. 3. Key scan path and pinmux: unknown. 4. Delay values and exact bit order in the stock driver: not decoded. 5. IR remote NEC address: unknown.
