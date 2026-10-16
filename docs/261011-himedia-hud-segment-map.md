# HiMedia Q10 Pro front panel - segment map from the stock kernel

Tags: **[disasm]** = read from disassembly (address given); **[inferred]** = deduced, reasoning given; **[unknown]** = not established.
Source: decompressed stock kernel `$HIMEDIA_ROOT/hud-work/vmlinux.bin` (ARM, vaddr = 0xc0008000 + file offset), disassembly `tm.s` there. Parent doc: `docs/261011-himedia-hud-ir-research.md`.
Nothing here was tested on the panel. Encoder: `scripts/himedia/hud-segment-encode.ts` (`--verify <vmlinux.bin>` re-checks the font against the image).

## 1. Font table

| claim | tag | evidence |
|---|---|---|
| 64-byte glyph table at vaddr **0xc0d6351c** (file 0xd5b51c); lookup string "0123456789-ABC...Zabc...z " (64 chars) at **0xc0d63560**. Glyph = string index. | disasm | DispString `c09ff284`: `ldrb [r2,#1]!` walks the string from 0xc0d63560 (r2 literal at c09ff354), r3 = index (`cmp r3,#64`), then `ldrb r1,[r8+r3+88]` with r8=0xc0d634c4 -> 0xc0d6351c+index (c09ff300-c09ff308). '0' is short-circuited to index 0 (c09ff2cc/c09ff338). Unknown char -> prints "no find the char: %c" (c09ff340) and stores nothing for it. |
| Bit order is standard: bit0=a, bit1=b, bit2=c, bit3=d, bit4=e, bit5=f, bit6=g, bit7=dp. | inferred | `0x3f` is '0' (a-f), `0x40` is '-' (g only), `0x06`='1' (b,c). Matches the common 7-seg convention; segment letters are names, the physical wiring is separate (section 2). |
| A second, word-wide table of the digits 0-9 at **0xc0d634c4** (values 0x3f 06 5b 4f 66 6d 7d 07 7f 6f, 32-bit each) is used by the clock routine. | disasm | `c09ff234 = 0xc0d634c4`, `ldr r5,[ip,r6,lsl#2]` (c09ff1d0..c09ff200). Same glyphs as the byte table. |

Glyphs (index: char = byte): 0:`0`=3f 1:`1`=06 2:`2`=5b 3:`3`=4f 4:`4`=66 5:`5`=6d 6:`6`=7d 7:`7`=07 8:`8`=7f 9:`9`=6f 10:`-`=40
A=77 B=7c C=39 D=5e E=79 F=71 G=6f H=76 I=06 J=0e K=00 L=38 M=00 N=37 O=3f P=73 Q=67 R=31 S=6d T=78 U=3e V=00 W=00 X=00 Y=6e Z=5b
a=77 b=7c c=58 d=5e e=79 f=71 g=6f h=74 i=06 j=0e k=00 l=38 m=00 n=54 o=5c p=73 q=67 r=31 s=6d t=78 u=1c v=62 w=00 x=00 y=6e z=5b, space=00. (disasm: raw bytes at 0xd5b51c-0xd5b55b.) `00` entries are glyphs the stock driver cannot draw.

## 2. Placement into the 16 RAM bytes - THE PANEL IS TRANSPOSED

| claim | tag | evidence |
|---|---|---|
| The string routine copies up to 4 glyph bytes (`min(strlen,4)`, c09ff2ac-c09ff2b4) into a 5-byte source buffer at 0xc16f43ec (= base 0xc16f4334 + 0xb8) and calls the writer `c09fe87c(r0=0, r1=buf, r2=7, r3=0x8a)`. | disasm | c09ff308-c09ff32c |
| The writer **transposes**: for source byte n (0..4) and bit ci (0..7), `dest[ci] |= bit ci of src[n] << n` (outer loop r2<5 at c09fe970, inner 8 iterations c09fe94c-c09fe968). | disasm | c09fe938-c09fe978 |
| It then sends `r2=7` pairs: `dest[k]` followed by `0x00`, for k=0..6 (c09fe98c-c09fe9a0). So **RAM byte 2k = dest[k]; RAM byte 2k+1 = 0; k=0..6** (bytes 14,15 not written by a string write). | disasm | c09fe97c-c09fe9a0 |
| Therefore: segment a..g of the glyph (font bit 0..6) lives on **RAM byte 0,2,4,...,12 (GRID1..GRID7)**; **digit n (0 = first char) is bit n (SEG1..SEG4)** of those bytes; **bit 4 (SEG5) is the 5th "digit" = icon/colon column**. | disasm + inferred | direct consequence of the loop. Which physical digit is position 0 (leftmost?) is **inferred**: the clock routine puts hour-tens in src[0] (below). |
| The decimal point (font bit 7 -> dest[7] -> RAM byte 14) is **never sent** by the string/clock path. | disasm | only 7 pairs sent. A dp may exist on the glass but the stock path cannot drive it (physical existence **unknown**). |
| Odd-numbered RAM bytes are always written 0 by the stock driver. | disasm | `mov r0,#0; bl send` after every dest byte (c09fe994). SEG9-16 (high byte of each GRID pair) are therefore unused by text. |

Clock routine (c09ff168): fields {hour, minute, flag} -> src[0]=glyph(h/10), src[1]=glyph(h%10), src[2]=glyph(m/10), src[3]=glyph(m%10) (divide by 10 via umull 0xcccccccd, c09ff1ac-c09ff1f0), then writer called the same way (r2=7, r3=0x8a). [disasm] The hour/minute field meaning is **inferred** from the h:m digit grouping; the fields are loaded from a struct at 0xc16f43e0 (base+0xac) whose producer was not traced.

## 3. Icons

| item | tag | evidence |
|---|---|---|
| **Colon**: src[4] = 0x10 when the flag word &1 is set, else 0 (c09ff1c4-c09ff218: `ands lr,lr,#1`, `strbeq 0`, `movne r3,#16; strbne [fp,#-38]`). Through the transpose, src[4]=0x10 means font-bit 4 of "digit 4" -> dest[4] bit 4 -> **RAM byte 8 (GRID5), bit 4 (0x10)**. | disasm (flag/value); inferred (that this lights the colon: the routine is the clock, and 0x10 is set exactly when its flag is on) |
| Other icons (network, play, ...): other bits of src[4] (SEG5 column) would be dest[ci] bit 4 for ci=0..6, i.e. bit 4 of RAM bytes 0,2,...,12. What each lights is **unknown**. | unknown |
| A "TurnOn LED[%d] symbol is error" string exists (0x102edd0) but its caller and symbol table were not decoded. `c09fec80` stores the 4 bytes of a 32-bit value at buf[0],[2],[4],[6] of a 14-byte buffer then calls the writer with r2=14; that stride-2 layout does not match the 5-byte consecutive source the writer's transpose reads, so it is either a different mode or unused. | unknown |
| `c09ff120` ("blank"): sets src[0..3]=0x40 (dashes) and src[4]=0, then the same writer call. | disasm | c09ff124-c09ff150. So "----" is the stock idle/blank pattern. |

## 4. Init / write sequence (TM1629 mode)

TM1629 mode is selected when the type argument is 6: `c09ff238` stores flag byte 0xc13f4780 = 1 for type 6, 0 for type 7 (c09ff24c-c09ff27c). [disasm]

Writer `c09fe87c` sequence, each command framed by STB (command send helper `c09fe774`: STB=1, CLK=1, STB=0, delay, bytes, STB=1) [disasm]:

1. command **0x00** (c09fe8a4-c09fe8d8; purpose unknown, probably a display-mode command)
2. command **0x40** (data set, write + auto-increment) (c09fe8e0-c09fe8ec)
3. STB=1, CLK=1, STB=0 (c09fe8f4-c09fe918), then byte **0xC0** (= `r0 - 0x40` with r0=0, c09fe920), then the 14 data bytes (k=0..6 pairs), then STB=1 (c09fe9a4)
4. command **0x03** (c09fe9b8-c09fe9c4; purpose unknown)
5. when flag!=0 (TM1629): command **r3** passed by the caller (c09fea10-c09fea18). Values seen: **0x8a** = display on, brightness 2 (string, clock, blank); **0x80** = display off (driver init `c09fea30`, c09feb0c-c09feb18, which first writes 14 zero pairs to clear RAM). Dim/undim helper c09fec18: 0x80 or 0x8a chosen by a variable (c09fec68-c09fec6c). When flag==0 the writer sends 0x80 instead.

Bits are sent **LSB first**: `c09fe6d8` per bit: CLK=0, DIO=(byte>>i)&1, delay, CLK=1, delay, 8 times. [disasm: c09fe6f8-c09fe764]. STB=GPIO2_0, DIO=GPIO2_3, CLK=GPIO2_4 (pin ids 2,{0,3,4} in c09fe5c4 calls). Delays are `__const_udelay`-style constants 0x10624d and 0x20c49a (c09fe708, c09fe730); the unit is **inferred** ~250/500 us, so stock runs the bus far slower than needed. Init also sets GPIO2 DIR bits 0,3,4 (c09fe614-c09fe658).

Difference from `q10-panel raw`: it does not send **0x00 (before)** or **0x03 (after the data)**. Whether the chip needs them to light the grids is **unknown**; if raw writes show nothing, add them.

## 5. Keys

No read of GPIO2_3 (DIO as input) exists anywhere in the TM1629 path (the only `RD` calls found are in the GPIO5-pin PT6964/CT1642 routines, see decode-keyled-gpio-ops.py output). **Key-scan byte/bit -> key map: unknown**; the stock kernel's TM1629 driver as disassembled does not read keys through the chip. Keys may come via other pins. (Hardware read of the key bytes with `q10-panel keys` stays the way to find out.)

## 6. Concrete commands

Computed by `bun scripts/himedia/hud-segment-encode.ts 1234 [--colon]`, hand-verified for "1234":
```
# "1234" (all four text digits, transposed per section 2)
q10-panel raw 06 00 0f 00 0d 00 06 00 02 00 08 00 0e 00 00 00
# "12:34": same, colon bit at RAM byte 8 bit 4 (0x02 -> 0x12)
q10-panel raw 06 00 0f 00 0d 00 06 00 12 00 08 00 0e 00 00 00
```
Both are **untested predictions** built on one [inferred] link (digit n = bit n, leftmost first). If the digits come out mirrored, reverse the text; if nothing lights, send commands 0x00 and 0x03 around the data as in section 4 and re-check the brightness byte (0x8a).
