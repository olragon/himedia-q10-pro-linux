# HiMedia Q10 Pro: HDMI-CEC (TV remote controls the box)

**Date:** 2026-10-12 · **Status:** built (k24, `6.18.55-k24`), **not booted, not tested on hardware**
**Patch:** `scripts/himedia/kernel/arm32/0019-drm-bridge-histb-hdmi-add-cec-adapter.patch` (on 0016/0017)
**Test:** `scripts/himedia/display/cec-test.sh` · **Plan item:** (an unpublished note) §3

## 1. Where the CEC engine lives

Evidence tags: **[read]** = read in source or binary this session, **[inferred]** = deduced, **[unknown]**.

| Question | Answer |
| --- | --- |
| Separate block? | **No.** It is the "CPI" block of the Silicon Image `imagev200` core, **inside the TX register window** `0xf8ce0000`, as **page 0xf** of the same 8-bit-register-per-32-bit-word file the bridge already uses. [read] `hal_cec.h:8` `CEC_BASE_ADDRESS 0x3F00`; `si_drv_tx_regs.h:16,31` `BASE_ADDRESS 0x3000`, `Page_F = BASE|0xf00`; `platform.c` `phys = base + (addr - 0x3000) * 4` |
| Address of a register | `0xf8ce0000 + ((0xf << 8 \| reg) << 2)` = `0xf8ce3c00 + 4*reg`. CPI registers are `reg 0x80..0xe4` = `0xf8ce3e00..0xf8ce3f90`. Same formula as the bridge's `HISTB_HDMI_REG(0xf, reg)`. [read] |
| Confirmed in the stock kernel? | **Yes.** `HAL_HDMI_Open+0x2e8` (`0xc06ad6dc`) does `mov r1, #0x3f00; bl SiiCecDeviceCreate` in `$HIMEDIA_ROOT/stock-android-kexec/vmlinux.bin`; the CEC symbols (`SiiDrvCecInterruptHandler`, `SiiCecAPingCallBack`, `HAL_HDMI_Cec*`, `DRV_HDMI_Cec*`) are all present (`stock-kallsyms.py --grep cec`, `disasm-stock-capstone.py`, `stock-xrefs.py`). `-DHDMI_CEC_SUPPORT` is in `drivers/msp/drv/hdmi/Makefile:93`. [read] |
| ⚠️ The "CEC 0x4800" in `docs/261012-himedia-display-modes-research.md` §1 | **Not used on this SoC.** `HDMI_TX_BASE_ADDR_CEC 0x4800` is in the product header, but the only code using it is `hal/ctrl/hisiv100/regs/hdmi_reg_cec.c`; Hi3798CV200 selects `CTRL_DIR := hal/ctrl/imagev200`, which uses page 0xf. [read] |
| Clock | The **`cec` gate**, CRG `0x10c` bit 1 (`HDMITX_CTRL_CEC_CKEN = 1<<1`, vendor `hdmi_platform.h:85`), already in our 0015 (`HISTB_HDMI_CEC_CLK`, id 111) and in the DT `clocks`; `probe()` enables it with the other aux gates. It is a **gate only** - no rate is set anywhere in the vendor code. [read] |
| Reset | **No CEC-specific CRG reset.** `SW_RST3` bit 7 is "soft reset for CEC only", but the vendor writes it as `baseAddr(0x3f00) \| REG_ADDR__SW_RST3(0x3012)` = page 0xf reg 0x12, which is not a CEC register - so the vendor "reset on disable" goes to the wrong place, and we do not replicate it. [read] The TX bus/core reset (`0x10c` bits 8/9) does reset the whole block (our takeover path), so 0019 re-applies the state afterwards. [inferred] |
| Interrupt | **SPI 147, `hdmi_cec`** (vendor DTB `docs/vendor-arm32/hi3798cv200.dts:815,847`; our DT already has `interrupts = <SPI 88 TX>, <SPI 147 cec>`). **The vendor driver does not use it**: `SiiDrvCpiCreate` starts a 100 ms timer that runs `SiiDrvCecInterruptHandler` (it reads the two `INT_STATUS` registers); a second 100 ms timer drives auto-ping. [read] |
| Pinmux | None found: the CEC pin is the HDMI connector's, not a muxed GPIO. Whether pin 13 is **soldered through to the box's HDMI connector** is [unknown] - the wire-level bit (§3) answers it in one read. |

## 2. How the vendor drives it (and what we copy)

CPI registers (names from `si_drv_tx_regs.h`; all page 0xf):

| reg | name | use |
| --- | --- | --- |
| `80` | DEVICE_ID | RO, **0xCC** - liveness probe |
| `81/83` | SPEC / HARDWARE_REV | RO |
| `84/85` | DEBUG_0/1 | RO start-bit low period / duration, documented as 250 µs units (`0x0e-0x0f` / `0x11-0x12`). **Measured on the box: 1 and 2** with a correct waveform - the units are not 250 µs; do not use as a clock check |
| `87` | DEBUG_3 | bit1 `NACK_HDR` (1 = do not ACK header blocks), bit7 `FLUSH_TX` (self-clearing) |
| `88` | TX_INIT | our (initiator) logical address for the next transmit |
| `89` | TX_DEST | destination; bit7 `SD_POLL` sends a header-only frame |
| `8e` | CONFIG_CPI | bit4 `PASSTHRU` (1 = CEC bus passed through to the I2C master; cleared in `tx_hw_init` already) |
| `8f..9e` | TX_COMMAND, TX_OPERAND_0..14 | opcode + up to 15 operands (**one** buffer entry, depth 2) |
| `9f` | TRANSMIT_DATA | bit4 `SEND`, bits 3:0 operand count |
| `a0` | RETRY_LIMIT | retries after the first try (vendor leaves the default) |
| `a2/a3` | CAPTURE_ID0/1 | 16-bit mask, bit *n* = accept and ACK frames for logical address *n*; broadcast always accepted |
| `a4/a5` | INT_ENABLE_0/1 | vendor enables `RX_FIFO_NEMPTY\|TX_FIFO_EMPTY\|TX_FF_CSTATE` and `FRME_RETX_CNT\|SHRT_PULSE\|START_ODD\|RX_FIFO_OVRUN` |
| `a6/a7` | INT_STATUS_0/1 | write-1-to-clear; status_0 bit7 is the **wire level** (1 = high) |
| `ac` | RX_CONTROL | bit0 clear current frame, bit1 clear all |
| `ad` | RX_COUNT | bit7 error, bits 5:4 frames waiting (0-3), bits 3:0 operand count |
| `ae/af/b0..be` | RX_CMD_HEADER, RX_COMMAND, RX_OPERAND_0..14 | `initiator<<4\|destination`, opcode, operands |
| `e0..e2` | AUTO_DISCOVERY, AUTODISC_MAP0/1 | hardware auto-ping of all 15 addresses; vendor-only - the CEC core does its own polling, so unused |

Vendor sequence ([read] `si_drv_cpi.c`): **enable** = clear `PASSTHRU`, clear `NACK_HDR`, `RX_CLR_ALL`, clear and enable the statuses above. **Disable** = zero the enables, set `PASSTHRU`, **set `NACK_HDR`** (a comment names Onkyo and Samsung sets that malfunctioned when a disabled CEC block kept ACKing). **Transmit** = clear the TX status bits, write `TX_INIT`, `TX_DEST`, `TX_COMMAND`, operands, then `TRANSMIT_DATA = SEND|count`; a poll writes `TX_DEST = SD_POLL|dest` only. **Failure** = `INTRP_FRME_RETX_CNT`; the handler must `FLUSH_TX` *before* clearing it or the frame is re-sent. **Receive** = while `RX_COUNT[5:4]` nonzero: read header, opcode, operands, then `RX_CLR_CUR`. The vendor stack's logical-address choice (auto-ping then pick from {3, 6, 7, 10, 15}) is replaced by the CEC core's own allocation.

## 3. What 0019 does

`histb-hdmi-cec.h` (included by `histb-hdmi.c`, one translation unit; it could not be a second object because the module name equals the main file's) + ~25 lines of hooks in `histb-hdmi.c` + a Kconfig bool. Design, in order of the constraints in `CLAUDE.md`:

* **Idiomatic 6.18 path, no hand-rolled `cec_adapter`:** the bridge sets `DRM_BRIDGE_OP_HDMI_CEC_ADAPTER`, `hdmi_cec_dev`, `hdmi_cec_adapter_name`, `hdmi_cec_available_las = 1` and implements `hdmi_cec_{init,enable,log_addr,transmit}`. `histb_vdp` already creates the connector with `drm_bridge_connector_init()`, which calls `drmm_connector_hdmi_cec_register()` - that allocates the adapter with `CEC_CAP_DEFAULTS` (LOG_ADDRS, TRANSMIT, PASSTHROUGH, **RC**) `| CONNECTOR_INFO`, **sets the physical address from the EDID** on every EDID read/invalidate, and gives us `drm_connector_hdmi_cec_received_msg()` / `_transmit_attempt_done()`. Nothing in `histb_vdp` changes.
* **Poll, do not IRQ** (as the vendor): a delayed work, 20 ms while enabled, 5 ms while a frame is on the wire. `cec_irq=1` additionally requests SPI 147 (polarity unverified - hence opt-in) and brings the poll forward; the poll stays as the net.
* **Transmit:** header-only frames are polls (`SD_POLL`). `RETRY_LIMIT = 0`; the CEC core does the retries (`cec_transmit_attempt_done`). A set `RETX` status = `CEC_TX_STATUS_NACK`. **Success is declared only when** the TX-empty/changed status latched **and** the frame could have finished (`5 ms + 25 ms/byte + 20 ms`), because the vendor's "ACKED" bit (`TX_FF_CSTATE`, "buffer full/empty change") is not proven to mean "completed" - taking it at face value could report every poll as ACKed and leave the core with no free logical address. Timeout = frame time + 300 ms → `CEC_TX_STATUS_ERROR`.
* **Locking:** the core calls `adap_enable/log_addr/transmit` with `adap->lock` held and `cec_received_msg()` / `cec_transmit_done()` take it. So the work **drops its own mutex before calling the core**, and `enable(false)` uses non-sync `cancel_delayed_work()` (a `_sync` would deadlock on a work waiting for `adap->lock`). `remove()` clears `alive` first so a late teardown never touches the unmapped window.
* **Adopted link:** `probe()` only **reads** (block id, spec, revision, wire level); nothing is written until the CEC core enables the adapter. A takeover of the link (bus/core reset) calls `histb_hdmi_cec_restore()` from `hw_init`.
* **Fallback:** `modprobe histb_hdmi cec=0` → no adapter, CEC registers never touched. Compile-time: `CONFIG_DRM_HISI_HISTB_HDMI_CEC=n`.
* **Debug:** `cec_debug=1` logs every frame and raw status; `/sys/kernel/debug/histb-hdmi/cec` shows block id, **wire level**, start-bit timers, ids and statuses.
* **Config (asserted by the builder):** `MEDIA_CEC_SUPPORT=y`, `MEDIA_CEC_RC=y` (was off), `DRM_HISI_HISTB_HDMI_CEC=y`; `CEC_CORE=y` was already on.

Not supported (and why): **`--monitor-all`** (the DRM helper's `cec_adap_ops` has no `adap_monitor_all_enable`; the hardware has a snoop bit - `DEBUG_3` bit 0, `DEBUG_2[7:4]` - but using it means owning the adapter instead of the helper); **more than one logical address**; **CEC wake from standby** (no standby on this box); the vendor's hardware auto-ping.

## 4. TV remote → keys

With `MEDIA_CEC_RC` the CEC core creates an input device (`bustype 0x001e`, name = the adapter name, `8ce0000.hdmi`) with the **`rc-cec` keymap**, fed from `<User Control Pressed/Released>` when the adapter was configured with `CEC_LOG_ADDRS_FL_ALLOW_RC_PASSTHRU` (`cec-ctl` sets it unless `--no-rc-passthrough`; the test prints whether the flag is present). Measured against what `scripts/himedia/session/` expects (`q10common.KEYS`, which `q10hotkey.py` and `q10menu.py` read from **every** input device with `EV_KEY`, so the new device needs no configuration):

| TV remote key | CEC code | `rc-cec` → | session layer |
| --- | --- | --- | --- |
| Up / Down / Left / Right | 01 02 03 04 | `KEY_UP/DOWN/LEFT/RIGHT` | **match** (menu navigation) |
| Select / OK | 00 | `KEY_OK` (352) | **match** - the menu already accepts `OK` as confirm |
| Settings / Setup menu | 0a | `KEY_SETUP` (141) | **match** - a hotkey (long-press 1.5 s opens the session menu) |
| Contents / Menu | 0b | `KEY_MENU` (139) | **match** - the other hotkey |
| **Back / Return (= CEC "Exit")** | 0d | **`KEY_EXIT` (174)** | **was a mismatch** - the menu cancelled only on `KEY_BACK`/`ESC`. Fixed: `q10common.KEYS["EXIT"]=174`, `q10menu.py` treats EXIT as BACK; `test_cec_remote_keys_reach_the_menu` (34 session tests pass) |
| Home / Root menu | 09 | `KEY_ROOT_MENU` (0x26a) | not a session-menu key; Kodi / Chromium / desktop map their own |
| Play/Pause/Stop/FF/Rew, Vol ±/Mute, 0-9, colour keys | 44-4b, 41-43, 20-29, 71-74 | `KEY_PLAYCD`, `KEY_PAUSECD`, `KEY_STOPCD`, `KEY_FASTFORWARD`, `KEY_REWIND`, `KEY_VOLUMEUP/DOWN`, `KEY_MUTE`, `KEY_NUMERIC_*`, ... | whatever each app maps; `KEY_PLAYCD` etc. are unusual for Kodi - `ir-keytable`/udev `hwdb` can remap the `rc-cec` table if Kodi ignores them |

⚠️ TV vendors differ: many send `Exit` (0d) for Back, some send nothing, and Select is sometimes `Enter`(2b → `KEY_ENTER`, which the menu also accepts). The test prints the key names it saw.

## 5. Test plan (on the box)

Prerequisites: `k24` booted (or any kernel with 0019), TV on the HDMI port with **HDMI-CEC enabled in the TV settings** (Samsung "Anynet+", LG "SIMPLINK", Sony "BRAVIA Sync"), `histb_vdp` loaded (it pulls in `histb_hdmi`; the EDID read gives the physical address), `apt install v4l-utils` (and `python3-evdev`, already used by the hotkey daemon).

```
sudo scripts/himedia/display/cec-test.sh --secs 30            # TV queries + 30 s of key presses
sudo scripts/himedia/display/cec-test.sh --wake --secs 20     # also <Image View On> + <Active Source>
dmesg | grep -i 'histb-hdmi\|cec'                              # the probe line: block id, wire level
```

Read it as a ladder, each rung needs the one before it:

1. `histb-hdmi 8ce0000.hdmi: CEC block id cc ... line high` - the block is there and the wire idles high. **id ≠ cc**: wrong window or the gate is closed. **line LOW**: nothing pulls the wire up - the CEC pin is not connected on this box's HDMI port, or the TV is off / CEC disabled (a standby TV still pulls the line up on most sets).
2. `/dev/cec0` exists; `cec-ctl --playback` gives a **physical address** (EDID) and **claims a logical address** (4, 8 or 11 - polls got NACKed). *If every poll "succeeds" and no address is claimed, the TX success rule is wrong* (§3): the debug log (`cec_debug=1`) shows the status bits and timings.
3. Poll of LA 0 acknowledged → TX path and wire proven. `--give-device-power-status` answered → **RX works too** (a reply needs both).
4. Keys: `<User Control Pressed>` in the monitor and `KEY_*` events from the `bustype 001e` device.

Everything lands in `/var/tmp/cec-test-<ts>/` (raw `cec-ctl` output, `monitor.txt`, `keys.txt`, the debugfs before/after). (`start_low_250us`/`start_bit_250us` are NOT a usable clock check: see §8, they read 1 and 2 while the transmitted waveform is exactly right.)

## 6. What is uncertain (state it, do not hope)

1. **The wire.** Whether the CEC pin reaches the connector, and whether the SoC's pad needs any pad control: [unknown]. Rung 1.
2. **The CEC clock rate.** The block's bit timing derives from a clock the vendor never programs (only the gate); the bootloader presumably left a good one. Rung "start_bit_250us".
3. **`TX_FF_CSTATE`/`TX_FIFO_EMPTY` timing** and the exact meaning of `RETRY_LIMIT = 0` ("0 extra retries" is the documented reading). The success rule is time-gated to survive either, but a NACK that the hardware reports differently would show as an `ERROR` after the timeout rather than a `NACK`.
4. **Header-only RX frames** (a poll *to* us): the vendor never explains whether they enter the RX FIFO; 0019 drops a frame with opcode 0 and no operands. If polls to us are not ACKed (capture mask misuse), other devices will think our logical address is free.
5. **Whether `RX_COUNT[7]` (error) is per frame or sticky**: handled as per frame.
6. **SPI 147 polarity/enable** - never exercised; hence `cec_irq=0`.
7. **Interaction with the display takeover**: `restore()` re-enables after a bus/core reset, but the order against a frame in flight is untested.
8. The TV's own behaviour (some sets ignore a source until `<Active Source>`/`<Report Physical Address>` is seen; `cec-ctl --playback` sends the latter).
9. **Not run**: the kernel was built and the module linked (`histb-hdmi.ko`, W=1 clean); nothing was booted.

## 7. Files and reproduction

* `scripts/himedia/kernel/arm32/0019-drm-bridge-histb-hdmi-add-cec-adapter.patch` - the change; generated, do not hand-edit.
* `scripts/himedia/cec/make-patch-0019.sh` + `0019.header.txt` - regenerate it from the work tree `$HIMEDIA_ROOT/cec-work/work` (`--seed` re-creates that tree from base + the current patch). It diffs against the files patch **0016** creates, so **regenerating 0016 (`display/make-patches.sh`) can invalidate 0019's hunks** - re-run `--seed` against the new 0016.
* `scripts/himedia/build-kernel-arm32.ts` - applies 0019 after 0017 (edit shared with the 0018 agent: one new line in the patch list, one apply block after 0017, three `REQUIRED` entries).
* `scripts/himedia/display/cec-test.sh` - the box test.
* `scripts/himedia/session/q10common.py`, `q10menu.py`, `test_session.py` - `KEY_EXIT` as Back.
* Build: `kernel-build-arm32-k24` (copied with `kernel/copy-build-tree.sh`), `bun scripts/himedia/build-kernel-arm32.ts --out k24 --localversion k24 --ramlog` → `k24`, `k24.zImage`, `k24.dtb`, `k24-modules.tar.gz`, release `6.18.55-k24`; `audio/build.sh` → `$HIMEDIA_ROOT/audio/q10_aiao-6.18.55-k24.ko`.

## 8. First box run (k24, 2026-10-12): TX proven on the wire, RX untested - the sink has no CEC

**Result: there is no RX bug to fix on this display.** The first report ("TV acknowledges a poll", then no replies) had two causes, one in our test:

1. **`cec-test.sh` passed a NACK.** It matched `Acknowledged`, which is also inside `Not Acknowledged`. Fixed (`Tx, Acknowledged` only). With the fix the poll of LA 0 correctly FAILS. ⚠️ Every "PASS" from the first run about the TV was wrong; what really held was: block id cc, wire idles high, EDID physical address, logical address 4 claimed (polls of 4 NACKed = free).
2. **The connected sink does not answer CEC at all.** EDID manufacturer **RTK** (Realtek scaler), a generic monitor (1920x1200 in its modes, no name descriptor, HDMI vendor block `67 03 0c 00 10 00` = physical address 1.0.0.0). It never ACKs and never talks. The test now prints the EDID manufacturer and warns.

**How it was proven (reusable):** status_0 bit 7 is the live CEC wire, so `scripts/himedia/display/cec-reg-probe.py tx 4 0 8f` (direct `/dev/mem`, 100 µs sampling) is a logic analyser on the CEC pin. A transmitted frame shows: start bit low 3.7 ms / period 4.5 ms; data bits low 0.6 ms (1) or 1.5 ms (0) on a 2.4 ms period; header `0x40` decoded bit by bit correctly; EOM; then the **ACK slot: our 0.6 ms low pulse, released, and the line stays high** - nobody extends it to 1.5 ms. The frame repeats every ~38.6 ms (`RETRY_LIMIT=3` ⇒ 4 tries ≈ 165 ms; the NACK is detected at the header's ACK bit). Poll and directed message are bit-identical up to there.
Therefore: the bit timer and the clock are right (so the §6 item 2 worry is closed - and the `DEBUG_0/1` counters simply do not mean what the header says), the CPI TX path, the open-drain drive and the pin all work, `RETX` really means "no ACK", and `capture_id0 = 0x10` for LA 4 is programmed as the vendor does.

**Still unproven:** RX (frame FIFO, `RX_COUNT`, header/opcode/operand registers, `RX_CLR_CUR`) - it needs a device that transmits. Next step needs a real CEC sink: the TV (CEC enabled in its menu - Anynet+/SIMPLINK/Bravia Sync) on this port, or any CEC device. `cec-reg-probe.py watch 30` while a remote key is pressed shows `rx_count` and the wire waveform even if the driver is wrong, so a failure can be located (no activity = wire/TV; activity but `rx_count` stays 0 = capture mask or FIFO use; `rx_count` set but nothing in `cec-ctl --monitor` = the driver).
The RX code was compared with the vendor's (`SiiCecCallBack`, `SiiDrvCpiRead`: count from `RX_COUNT[5:4]`, header `0xae`, opcode `0xaf`, operands `0xb0..`, `RX_CLR_CUR` per frame); one deliberate difference: the vendor reads the frame count as `(RX_COUNT & 0xf0) >> 4`, which includes the error bit; we mask it.
