# HiMedia Q10 Pro front-panel touch keys: how the stock kernel reads them (2026-10-11)

Scope: read-only research on the stock 3.18 kernel (`$HIMEDIA_ROOT/hud-work/vmlinux.bin`),
the stock `system` partition (v2.1.4 extract) and the vendor 4.4.35 SDK source. No ssh, nothing flashed,
nothing committed.

Tags: **[read: disasm @addr]** seen in the stock kernel disassembly; **[read: file]** seen in a file;
**[inferred]** reasoned, not observed; **[unknown]** not found.

## Decision

**Stop looking for a key-scan protocol on the TM1629A or on a GPIO. The stock kernel has none.**
Both front-panel keyled drivers in the stock kernel (TM1629 and TM1628) stub every key operation, and no
kernel driver or boot-time userspace daemon reads GPIO, GPIO-I2C or I2C for keys. The only key input
that is live in stock Android is the **IR receiver** (`/dev/hi_ir`, block at `0xf8001000`), read by
`android_ir_user` through `/etc/key.xml`. So the leading hypothesis is: **the TCH68 touch board emits
IR-protocol frames (most likely NEC) onto the IR receiver line**, and the touch keys reach Android as
"remote" key presses. **[inferred]** from the absence of every other path; not yet observed.

Next step, one command on the box, no kernel rebuild: `q10-keyprobe ir 30`, press the touch keys, and
read whether IR symbols appear (test below). If they do, the touch keys need nothing beyond what the IR
remote already needs: `CONFIG_IR_HIX5HD2` + the NEC decoder + a keymap entry per key.

## Stock evidence

The symbol names below come from the kernel's own symbol table, recovered with the new
`scripts/himedia/stock-kallsyms.py` (85,156 symbols; table at file offset 0xd76e90). Earlier docs
called the GPIO2 helper "the tm1628 file"; with names, there are two drivers, and both are mute.

### 1. No key-read routine for this panel

| Claim | Tag |
|---|---|
| The TM1629 driver (the one this board selects: `persist.sys.keyled = tm1629`, `hmd_keyled_display` -> `SelectType(6)`) has **no rx/read function at all**. Its symbols are `keyled_tm1629_gpio_dirset / tx_byte / write_burst / write / display_addr_inc`, plus display code. | **[read: kallsyms c09fd334-c09fe4b8]** |
| `hi_tm1629_keyled_scan` is an empty function (`mov ip,sp; push; bl mcount; ldm` = return). | **[read: disasm @c09fd334]** |
| All eight `KEYLED_KEY_*_TM1629` ops (Open, Close, Reset, GetValue, SetBlockTime, SetRepTime, IsRepKey, IsKeyUp) are 0x1c-byte stubs that only `mov r0,#0` and return. `GetValue` never writes a key. | **[read: disasm @c09fda10-c09fdaec]** |
| The TM1628 driver is the same: `keyled_tm1628_rx_byte` and `keyled_tm1628_read` return 0, `keyled_tm1628_get_keycode` and `handle_keycode` return -1, `hi_tm1628_keyled_scan` is empty, all `KEYLED_KEY_*_TM1628` return -1. | **[read: disasm @c09fe844, c09fe860, c09feb90, c09febac, c09fe4d4, c09fee54-c09fef18]** |
| The only `0x42` (TM16xx read-key) command bytes in the whole keyled region belong to the PT6961 (`@c09f9010`) and PT6964 (`@c09fa6bc`) drivers, not to TM1628/1629. | **[read: disasm]** |
| `hmd_keyled_display` (the boot-time panel daemon) calls `HI_UNF_KEY_Close` and never `HI_UNF_KEY_Open`/`GetValue`. | **[read: its dynamic symbol strings]** |
| Only `sample_keyled` and `sample_dvbplay_ir` call `HI_UNF_KEY_GetValue`; neither is started at boot. | **[read: grep of system/bin; init.bigfish.sh]** |

### 2. No other key path in the kernel

| Claim | Tag |
|---|---|
| No `gpio-keys`, touch-key, ADC-key or keypad driver symbol exists; the vendor DT has no key node. | **[read: kallsyms grep; boot.img+0x8b5220.dts]** |
| `HI_DRV_GPIOI2C_CreateGpioI2c` is called only from `MCE_ADP_TunerConnect` and the `/dev` ioctl handler; `HI_DRV_GPIO_ReadBit` only from `hi_gpio_ioctl` (userspace) and the GPIO export table. No built-in driver polls a GPIO or a GPIO-I2C device for keys. | **[read: `stock-xrefs.py`, BL callers c09381ac, c07b9364, c065934c]** |
| The "DRV_GPIOI2C_Config OK(I2cNum=..)" string you saw is printed by that generic create path (tuner or a userspace tool), not by a key driver. | **[inferred]** from the caller list |
| Userspace: the only binaries that read GPIO are `hmd_set_gpio` (a manual CLI, not started by `init.bigfish.sh`), `sample_gpio` and `libhardwaretest_jni.so` (factory test). No vendor `.ko` handles keys. | **[read: grep of system; lib/modules list]** |
| `android_ir_user` (service `ir_user`, running on the box) is the only key source wired at boot. It loads every section of `/etc/key.xml` (`hisi-key`, `himedia-key`, `creative-key`, `other-key`). | **[read: recon `init.svc.ir_user=running`; key.xml]** |

### 3. Which IR codes the touch keys would send: unknown

- If the touch board emits the bundled remote's codes (NEC address 0x10), Android needs no extra table,
  which matches the firmware: there is no separate front-panel section in `key.xml`. **[inferred]**
- `himedia-key` has **two** `KEY_POWER` codes for address 0x10 (`0x5d` and `0x7b`) and other doubled
  keys (PLAYPAUSE 0x59/0x1b, KEY_9 0x0d/0x04, KEY_7 0x0f/0x54). One of the POWER pair could be the
  touch power key. This is **[inferred]**; nothing names the doubles.
- `creative-key` (NECX 0x83/0x22) has UP/DOWN/LEFT/RIGHT/ENTER/MENU/BACK but **no POWER**, so it is
  probably another remote, not the 8-key panel. **[inferred]**
- Mapping for the eight keys, if they use address 0x10 (mainline scancode = `0x10<<8 | cmd`):

  | panel key | stock key.xml name | NEC cmd | mainline scancode | Linux keycode |
  |---|---|---|---|---|
  | left | KEY_LEFT | 0x07 | 0x1007 | 105 |
  | up | KEY_UP | 0x45 | 0x1045 | 103 |
  | right | KEY_RIGHT | 0x01 | 0x1001 | 106 |
  | down | KEY_DOWN | 0x55 | 0x1055 | 108 |
  | OK | KEY_ENTER | 0x41 | 0x1041 | 28 |
  | back | KEY_BACK | 0x00 | 0x1000 | 158 |
  | menu | KEY_MENU | 0x05 | 0x1005 | 139 |
  | power | KEY_POWER | 0x5d or 0x7b | 0x105d / 0x107b | 116 |

  The codes are **[read: key.xml]**; that the touch keys send them is **[unknown]** until the test runs.
  All eight are already in `himedia_q10.toml` (docs/261011-himedia-ir-keymap-audio-research.md), so a
  match needs no keymap change.

### 4. TM1629A protocol: stock vs ours

There is **no stock key read to compare with** (section 1). For the write path, the stock waveform
matches `q10-panel.c`:

| Item | Stock | Tag |
|---|---|---|
| Pins | STB = GPIO2_0, DIO = GPIO2_3, CLK = GPIO2_4 (`hi_gpio_write_bit(2, pin, v)`, DIR via `0xf9b22400` virt) | **[read: disasm @c09fd56c-c09fd5c0, c09fd518]** |
| Bit order | LSB first (`asr r2, r6, r4`, r4 = 0..7) | **[read: disasm @c09fd58c]** |
| Per bit | CLK low; delay A; DIO = bit; delay B; CLK high; delay A | **[read: disasm @c09fd56c-c09fd5d0]** |
| Delays | `__const_udelay(0x10624d)` and `(0x20c49a)` = udelay(1) and udelay(2) if `CONFIG_HZ=500` (exact integer fit of `2147*HZ + 483648*HZ/1e6`); ~5 and ~10 us if HZ=100 (off-by-one fit). Microsecond scale either way. | **[read: constants]**, HZ **[inferred]** |
| Frame | STB high, CLK high, STB low, delay A, bytes, STB high | **[read: disasm @c09fd5fc-c09fd670]** |

Our read (`0x42`, 4 bytes LSB-first, sample after CLK rises, DIO released) is the textbook TM16xx read;
the stock code gives no reason to change it. Returning `00 00 00 00` while pressing is what you get if
no key matrix is wired to the TM1629A's K1/K2 inputs, which fits the keys having their own 6-pin cable
to the mainboard and not to the VFD board. **[inferred]**
Caveat: TM16xx DIO is open-drain on read. With no pull-up on the line, every read is 0x00 whether or not
the chip answers, so `00 00 00 00` does not prove the chip is answering. **[inferred]** from the
TM16xx family convention; the TM1629A datasheet is still not fetched.

### 5. What stock boot sets up that mainline may not

| Item | Stock | Tag |
|---|---|---|
| Panel pad mux | `KEYLED_Init_TM1628.part.2` / `hi_gpio_Multiset_bit` save, then clear bit 0 of IOCONFIG `0xf8a21040`, `0xf8a2104c`, `0xf8a21050` (virt `0xf9a21xxx`); `KEYLED_DeInit_*.part.3` restores the saved values. | **[read: disasm @c09feab4-c09feaf0, c09fd470-c09fd4a8, c09fd34c]** |
| Which pads | 0x40/0x4c/0x50 = GPIO2_0/2_3/2_4 (0x40 + 4 x bit). Already right under mainline, because the display works. | **[inferred]** |
| IR clock | vendor `ir_set_clk()`: sysctrl `0xf8000048` bit4 = clock on, bit5 = reset (cleared). Mainline `clk_ir` is the same gate (`0x48`, bit 4). | **[read: vendor drv_ir_intf.c; crg-hi3798cv200.c:290]**; that the 3.18 binary does the same at `ir_set_clk @c065b57c` is **[inferred]**, not disassembled |
| IR block mode | symbol mode, interrupt driven, 10 us units: `DATAH` = symbol count, `DATAL` = `[15:0]` low width, `[31:16]` high width | **[read: vendor drv_ir_intf.c ISR ~l.548]** |
| IR pad mux | not set anywhere in the keyled or IR code that was read; the IR input is probably a dedicated pad. | **[unknown]** |
| `hmd_keyled_display` | ORs 0x80 into `0xf8000044` and drives GPIO5_3 as an output. Meaning unknown; not key related. | **[read]** (prior doc), meaning **[unknown]** |
| Key timing | `KEYLED_Init_TM1628.part.2` stores 8, 500, 300 into the keyled state (buffer length, block time ms, repeat time ms by SDK convention) and re-arms a display timer at `msecs_to_jiffies(100)`. The key fields are never used, because the key ops are stubs. | **[read: disasm @c09fea68-c09feb3c]**, meaning **[inferred]** |

## Test on the box

Build: `gcc -O2 -o /usr/local/sbin/q10-keyprobe scripts/himedia/tools/q10-keyprobe.c` (copy the file over
first). It needs root and `/dev/mem`, like `q10-panel`.

**A. IR path (decisive, about 1 minute).** First check that no kernel IR driver is bound:
`ls /sys/class/rc` must be empty. Then:

```
q10-keyprobe ir 30
```

Press each touch key once, slowly, then **one remote key as a control**. The tool switches on the IR
clock (`0xf8000048` bit4, bit5 cleared), puts the block in symbol mode
(`IR_CFG = 0x3e800000 | 1<<8 | 1<<7 | 23`, 24 MHz), polls the FIFO every 2 ms, prints every symbol and
an NEC decode.

| Result | Meaning | Next |
|---|---|---|
| Remote key prints a `NEC raw ... addr 0x10` line, touch keys print lines too | **Hypothesis confirmed.** Write down the `cmd` per key. | Build `CONFIG_RC_CORE`, `CONFIG_IR_NEC_DECODER`, `CONFIG_IR_HIX5HD2`, enable `&ir` in the board dts, load `himedia_q10.toml`, add any touch-only codes. No new driver. |
| Touch keys print symbols with no NEC decode | Same path, other protocol | Paste the symbol widths; pick the mainline decoder (RC5/RC6/Sony/JVC) from the timings. |
| Remote prints, touch keys print nothing | IR is not the touch path | Run test B. |
| Remote also prints nothing | The probe is wrong, not the theory (IR pad mux, clock, or register setup) | Do not conclude anything; enable the kernel IR driver and use `ir-keytable -t` instead. |

The remote control is the positive control: a probe that cannot see the remote proves nothing about
the touch keys.

**B. Fast GPIO edge capture (if A shows nothing from the touch keys).**

```
q10-keyprobe gpio 20
```

It samples all 13 PL061 `DATA` registers in a tight loop (it prints the measured microseconds per
sweep at the end) and logs every bit change with a timestamp. It catches pulse trains and short
interrupt pulses that `gpio-watch.sh` (one `devmem` process per read, ~1 Hz) misses. If one bit
toggles only while a key is held, that pin is the touch IC's output. If nothing moves, the touch IC is
host-clocked (I2C-like) on pads that are not muxed as GPIO, or it is read by the standby MCU, and the
next step is a multimeter/logic probe on the 6-pin cable: find GND and VCC, then watch the other four
lines while touching a key.

### Optional `q10-panel.c` patch (not applied)

Only worth running if A and B both come back empty, to rule out a missed TM1629A key bit by polling
instead of one-shot reads:

```diff
@@ int main(int argc, char **argv)
 	if (!strcmp(op, "keys")) {
+		int loop = argc > 2 ? atoi(argv[2]) : 0;	/* q10-panel keys 30 = poll 30 s */
+		uint8_t prev[4] = {0xaa, 0xaa, 0xaa, 0xaa};
+		time_t end = time(NULL) + loop;
+		do {
 		pin(STB, 0); dly(); tx(0x42); dir_out(DIO, 0); dly(); dly();
 		uint8_t k[4];
 		for (int i = 0; i < 4; i++) k[i] = rx();
 		pin(STB, 1); dir_out(DIO, 1);
-		printf("keys: %02x %02x %02x %02x\n", k[0], k[1], k[2], k[3]);
+		if (memcmp(k, prev, 4)) {
+			printf("keys: %02x %02x %02x %02x\n", k[0], k[1], k[2], k[3]);
+			memcpy(prev, k, 4);
+		}
+		struct timespec t = {0, 50000000}; nanosleep(&t, NULL);	/* 20 Hz, like TM16xx scan */
+		} while (time(NULL) < end);
 		return 0;
 	}
```

## Tools added

- `scripts/himedia/stock-kallsyms.py <vmlinux.bin> [--grep RE] [--at ADDR]`: recovers the stock
  kernel's symbol table (absolute kallsyms; finds `token_table` by matching it to `token_index`).
- `scripts/himedia/stock-xrefs.py <vmlinux.bin> ADDR...`: ARM `BL` callers and literal-pool
  references of an address, each named by symbol. ARM only; it does not decode Thumb-2.
- `scripts/himedia/tools/q10-keyprobe.c`: the box-side `ir` / `gpio` probes above. The syntax was
  checked on the Mac (`cc -Wall -Wextra -fsyntax-only`); it has **not** been run on the box.

## Unknowns

1. Whether the touch board drives the IR line (the test above answers this).
2. The touch keys' IR codes, if any.
3. The TCH68 part and its output format (no datasheet).
4. The 6-pin cable pinout and where it lands on the mainboard.
5. Whether the TM1629A DIO line has a pull-up (this decides whether a `00` key read means anything).
6. Stock `CONFIG_HZ`, which sets the exact microsecond delays.

## Power key: hold and OFF (measured 2026-10-13)

- **The front power touch key sends a real hold.** `q10-key-capture` ((run log)):
  scancode `0x105d` every ~109 ms while touched; rc-core turns it into `KEY_POWER` 1, then 2 (repeat)
  every ~140 ms, then 0 at release, over 6.9 s. The "touch key sends one frame" guess was wrong.
  An earlier "3 s hold does nothing" report fits the old code: the daemon fired, and the result looked like nothing.
- **logind did not take part.** With `HandlePowerKey=ignore` it only logs "Power key pressed short" per event;
  q10-power fired at 3.0 s and ran `systemctl poweroff`.
- **A real poweroff is wrong on this box**, for two reasons:
  1. mainline has no power-off handler, so the CPU halts and **no key can wake it**: only unplugging works;
  2. simpledrm ignores fb blank, so **HDMI keeps showing the console text** of the shutdown.
- **New behaviour.** Hold 3 s = soft **OFF**: sessions stop, the TV gets the black VT12 frame and CEC standby,
  disks are synced and spun down, and the panel shows ` OFF` (dimmed). Any press from OFF = `systemctl reboot`,
  which `q10-reset-on-reboot` turns into an SP805 reset, i.e. a fresh boot. States on / standby / off sit in one
  table (`STEPS` in q10power.py). Verified from the shell: state `off`, HDMI frame mean 0 / max 0.
- **Touch from OFF verified** (Tim, 09:33): the panel showed BOOT, the box rebooted, and Music was back on tty11.
- **Side finding: the stick root was 100 % full.** q10-swap made its 2 GB SATA swap file on the 3.5 GB stick;
  fallocate failed partway and left a 1.25 GB unusable file. Removed; q10-swap now needs 3 GB free
  and deletes a partial file.
