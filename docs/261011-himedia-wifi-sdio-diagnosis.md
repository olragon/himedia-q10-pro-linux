# HiMedia Q10 Pro: AP6255 SDIO never answers CMD5 on mainline 6.18 (diagnosis)

Date 2026-10-11. Scope: what the vendor 3.18/4.4.35 `himciv200` stack does for the SDIO controller at
`0xf9c40000` (vendor alias `sdio`, Android `mmc2`, CRG `0x28c`) that mainline `snps,dw-mshc` does not.
Tags: **[READ]** seen in a file (path:line given) · **[INFER]** reasoned from reads · **[UNKNOWN]** no evidence on disk.
Read-only analysis. Nothing was run on the box. Nothing was committed.

## 1. Decision first

1. **Leading hypothesis (H1, ~50%): the host never releases the card reset and never gets the vendor clock state.**
   Vendor power-up writes **PWREN=1 and then RST_N(0x78)=1** and waits 100 ms, from `host_init` at probe
   and again on every `MMC_POWER_UP`. Mainline `dw_mmc` writes **only PWREN**; it writes `RST_N` only in
   `card_hw_reset`, which a non-removable SDIO card never reaches. U-Boot used eMMC and SD0 to boot, so it
   configured those hosts; **nobody ever configured SDIO2 before Linux**. If SDIO2's `RST_N` powers up as 0
   (or drives the module enable), the card is held in reset and CMD5 times out at every frequency, exactly as seen.
2. **H2 (~25%): CRG sample/drive phase and source rate differ from the vendor state.** Vendor forces
   `0x28c = 0x00032103` on every clock enable (sample 2, drive 3, 50 MHz source). You read `0x303`
   (sample 0, drive 0, 166.5 MHz). Phase is a weak cause at 100-400 kHz, but it costs one write to rule out.
3. **H3 (~15%): pad state of SDIO2 (IOCONFIG `0xf8a210b0..0xf8a210ec`, incl. the CARD_POWER_EN pad).**
   The vendor kernel never writes this window for SDIO2, so U-Boot (or nothing) set it. That is the same
   input our kernel gets, so it only matters if our boot path differs. Dump it before blaming it.
4. **H4 (~10%): module enable / 32 kHz LPO is board-side and not modelled.** The vendor driver had
   `WL_REG_ON = -1` (a no-op), so it did not control the pin either. Not testable by register writes.
5. **Ruled out (high confidence): IO voltage.** The vendor does **nothing** for SDIO2 voltage: no LDO
   (no `ldo-addr` in its DT node) and the switch hook returns before touching `UHS_REG`. There is no
   register to write. A `vqmmc` fixed 1.8 V regulator in DT changes no hardware and cannot fix CMD5.
6. **PWREN reading 0 after failure is not evidence.** The core calls `mmc_power_off` after the final
   failure and dw_mmc then clears PWREN (`dw_mmc.c:1534-1536`). Read it during an attempt, not after.

**Top live test (T1, 5 writes, all reversible, section 5): force vendor power-up state, then rebind.**

## 2. Findings per question

### (a) Module power / WL_REG_ON

| Finding | Evidence | Tag |
| --- | --- | --- |
| Android `bcmdhd` has no WL_REG_ON GPIO: "GPIO(WL_REG_ON) = -1", "PULL WL_REG_ON(-1) HIGH" | `$HIMEDIA_ROOT/logs/20261010033845-after-probe/dmesg.txt:284-289` | READ |
| So the module enable is tied high, or follows a host pad (PWREN / RST_N), or is set by the boot chain | the vendor DT (`boot.img+0x8b5220.dts`) has no gpio, regulator or rfkill consumer for the node | INFER |
| Vendor power-up: `MCI_PWREN(0x04)=1`, then `MCI_RESET_N(0x78)=1`, then `msleep(100)`. Power-down is the reverse: RESET_N=0 then PWREN=0 | `drivers/mmc/host/himciv200/himciv200.c:90-110` | READ |
| Vendor does that at probe (off, then on, forced) before any card detect | `himciv200.c:243-251` (`himciv200_host_init`) | READ |
| Vendor again does it in every `set_ios` power transition | `himciv200.c:962-968` | READ |
| Vendor reboot path also pulses `RST_N=0`, `PWREN=0`, 2 ms, `RST_N=1` on SDIO base `0xF9830000` (this is the eMMC/SDIO1 block, not ours) | `arch/arm/mach-hi3798cv2x/core.c:109-132` | READ |
| Mainline writes PWREN on `MMC_POWER_UP`, clears it on power off, and touches `RST_N` only in `dw_mci_hw_reset` | `kernel-build-arm32/linux-6.18.55/drivers/mmc/host/dw_mmc.c:1494-1497, 1534-1536, 1616-1650` | READ |
| Android lets DHD power the module first, then calls card detect. With no GPIO, "power" was a no-op, so the card was already powered when the host came up | `dmesg.txt:288-291` | READ |
| Whether `RST_N` or `PWREN` is wired to WL_REG_ON | no schematic | UNKNOWN |
| Reset default of `RST_N` on this IP | not in any file read; the vendor writes it explicitly, mainline eMMC works without because U-Boot ran it | INFER |

### (b) IO / signal voltage of the SDIO2 pads

| Finding | Evidence | Tag |
| --- | --- | --- |
| `himciv200_switch_voltage` returns 0 at once for `devid==0`, `devid==2`, or no `ldoaddr`. SDIO2 is `devid 2` (Android `mmc2`) and its DT node has no `ldo-addr` | `himciv200.c:865-876`; DT lines 491-499 | READ |
| Only SD0 has an LDO: `ldo-addr = <0xf8a2011c>`, `ldo-shift = 0` (PERI_CTRL 0xf8a2011c). Irrelevant to SDIO2 | DT lines 478-489; `himciv200.c:840-862` | READ |
| The vendor also leaves `MCI_UHS_REG(0x74) bit0 (VDD_180)` untouched for SDIO2, yet Android reports "ultra high speed SDR104" | `himciv200_def.h:143-146`; dmesg:299 | READ |
| So the module VDDIO is fixed 1.8 V by the board, and the host pads take it as is | no register involved | INFER |
| Vendor `ocr_avail = 3.2-3.4 V`, same as a plain mainline dw_mmc with no vmmc | `himciv200.c:1216` | READ |

Consequence: add no `vqmmc` regulator for the purpose of fixing enumeration. Keep `ocr_avail` as is.

### (c) Pin-mux of the SDIO2 pads (IOCONFIG `0xf8a21000` block)

| Finding | Evidence | Tag |
| --- | --- | --- |
| The vendor DT gives the node a second reg window `0xf8a210b0`, length `0x40` (16 pad registers, `0xb0..0xec`). eMMC uses `0xf8a21000`, SD0 uses `0xf8a21158` | DT lines 468, 480, 493 | READ |
| The vendor driver writes that window **only** when `dev_name == "f9830000.himciv200.MMC"` (eMMC drive strength). For SDIO2 it never writes a pad register | `drivers/mmc/host/himciv200/himci_hi3798cv2x.c:97, 138, 163, 213, 249` | READ |
| Pad register layout (vendor macros): bits[7:4] drive strength code, bit 8 slew rate. Function select is in the low bits | `himci_hi3798cv2x.c:26-34` for strength and slew; function select bits[2:0] from general HiSilicon IOCONFIG knowledge | READ / INFER |
| No SDIO2 pad values exist in the Android register dump (it holds only USB/ETH CRG and PERI_USB regs) | `android-probe/regs-android-20261010-233226.txt` (11 lines) | READ |
| The pad setup is therefore done by the boot chain. The stock `fastboot.img` is high-entropy (7.32 bits/byte) and a scan for the word `0xf8a210b0` found nothing, so its register table cannot be read from disk | python scan of `emmc-dump/fastboot.img` | READ |
| Whether our boot path leaves the same pad state as an Android boot | | UNKNOWN |

### (d) Clock phase and sample settings

| Finding | Evidence | Tag |
| --- | --- | --- |
| `CRG 0x28c` = `PERI_CRG163`: [0] bus gate, [1] ciu gate, [4] soft reset, [9:8] source select, [14:12] sample phase, [18:16] drive phase, [19] clk_mode | `drivers/common/drv/include/hi3798cv200/hi_reg_crg.h:2048-2071` | READ |
| Source table for SDIO2 is {100, 50, 150, 166.5} MHz on [9:8] | `drivers/hisilicon/clk/hi3798cv2x/clk-hi3798cv200.c:120-130, 184-196` | READ |
| `CLK(PERI_CRG163_SDIO2, mask 0x77703, value 0x32103, reset BIT(4))`. On every enable the vendor does `val = (val & ~0x77703) \| 0x32103` and unresets bit 4. That is gates on, **source 50 MHz, sample phase 2, drive phase 3** | `clk-hi3798cv200.c:68`; `clk-hisi.c:30-45, 70-80` | READ |
| The vendor SDIO driver never changes phase for SDIO2 (all `set_phase`, `set_driver`, `set_crgclk` bodies are gated on the eMMC device name). No tuning for SDIO2 | `himci_hi3798cv2x.c:136-205, 241-250` | READ |
| The vendor divider math uses `clk_get_rate` = 50 MHz, so Android ran the SDIO bus at the 50 MHz ciu even though DHD prints "sd clock rate = 100000000" | `himciv200.c:216-236`; dmesg:306 | INFER |
| Your live state `0x303`: sample 0, drive 0, source 3 (166.5 MHz) | your report | READ (by you) |
| `clk_mode` bit 19 is not in the vendor mask, so the vendor left it at the hardware default | `clk-hi3798cv200.c:68` | READ |
| Meaning of bit 19 | none on disk | UNKNOWN |

### (e) Reset sequence and 32 kHz LPO

| Finding | Evidence | Tag |
| --- | --- | --- |
| CRG bit 4 is pulsed asserted then released by the clock framework around enable (`CLKHW_RESET` flag) | `clk-hisi.c:60-80, 90-100` | READ |
| Host-side: `BMOD.SWR`, 10 ms, `CTRL = CTRL_RESET\|FIFO_RESET\|DMA_RESET` at host init | `himciv200.c:68-88` | READ |
| Mainline does an equivalent `dw_mci_reset` at probe | `dw_mmc.c:1745, 1994` | READ |
| No clock named 32k/LPO/rtc in the vendor DT; bcmdhd manages none | grep of the DTS | READ |
| Where the 32.768 kHz LPO comes from | | UNKNOWN |

## 3. What the vendor does that mainline does not (ranked)

| # | Difference | Register | Vendor value | Your value | Source |
| --- | --- | --- | --- | --- | --- |
| 1 | Release card reset | `0xf9c40078` RST_N | 1 (after PWREN=1, 100 ms) | untouched, unknown | himciv200.c:98-101 |
| 2 | Phases and source | `0xf8a2228c` | `0x00032103` | `0x00000303` | clk-hi3798cv200.c:68 |
| 3 | Power-up settle time | n/a | 100 ms after PWREN and RST_N | core default (10 ms `power_delay_ms`) | himciv200.c:103-106 |
| 4 | Pad window | `0xf8a210b0..ec` | boot chain state (unwritten by the kernel) | unknown | himci_hi3798cv2x.c:97 |
| 5 | Voltage | none | none | none | himciv200.c:875 |

## 4. Safety rules for the live session

- **Do not touch `0xf9c40000` while the BIU gate is off.** A read of a gated block can hang the bus.
  After `unbind` the driver releases the clocks. Always run `devmem 0xf8a2228c` first; if bits 0-1 are not
  both 1, write `0x00000303` before any controller access.
- CRG base is `0xf8a22000` (the Android dump shows `CRG_USB3 0xf8a220b0`), so `CRG 0x28c` is **`0xf8a2228c`**.
  IOCONFIG base is `0xf8a21000`.
- Every write below is undone by the next reboot. None writes a pad register.

## 5. Live tests (busybox `devmem`, run as root, driver unbound)

### T0. Read-only snapshot (do this first, save the output)

```sh
CRG=0xf8a2228c; B=0xf9c40000
devmem $CRG                                   # want 0x...303; if bits0-1 are 0 do: devmem $CRG 32 0x303
for o in 00 04 08 0c 10 18 48 50 6c 70 74 78 100 10c 110; do printf '%s ' $o; devmem $((B+0x$o)); done
for o in b0 b4 b8 bc c0 c4 c8 cc d0 d4 d8 dc e0 e4 e8 ec; do printf 'pad+%s ' $o; devmem $((0xf8a21000+0x$o)); done
for o in 158 15c 160 164 168 16c 170 174 178 17c 180 184 188 18c 190 194; do printf 'sd0pad+%s ' $o; devmem $((0xf8a21000+0x$o)); done
```

Read it as follows. RST_N (`+78`) = 0 confirms H1 at once. The SDIO2 pad words should look like the SD0
pad words (same function field, same pull bits). A pad word whose low bits equal the reset/GPIO function
points at H3. Run the same dump once on Android (same script through your Android probe path) and diff;
that comparison is the cheapest way to settle H3 and H1 together.

### T1. Leading test: vendor power-up state (H1 + H2 together)

```sh
devmem 0xf8a2228c 32 0x00032303    # gates on, source 3 (keep 166.5 MHz, see note), sample 2, drive 3, bit4 = 0
devmem 0xf9c40004 32 1             # PWREN = 1
devmem 0xf9c40078 32 1             # RST_N = 1 (release card reset)
sleep 0.2                          # vendor waits 100 ms
echo f9c40000.mmc > /sys/bus/platform/drivers/dw_mmc/bind
dmesg | tail -30
devmem 0xf8a2228c                  # did the clock framework rewrite the phases?
```

Note on the source rate: keep mux 3 because the clock framework caches 166.5 MHz and dw_mmc computes its
divider from that. Writing mux 1 (50 MHz, `0x00032103`) behind its back makes the real bus clock 3.3x slower
than requested (400 kHz request becomes ~120 kHz), which is still legal and is the exact vendor state, so
use it as T1b if T1 fails.

Expected result if H1 is right: `mmc1: new ... SDIO card` (or at least a CMD5 response), then
brcmfmac probes. If PWREN is cleared between attempts, RST_N stays 1 because mainline never writes it.

### T1b. Exact vendor clock state

Same as T1 with `devmem 0xf8a2228c 32 0x00032103`. Expect a slower bus than logged.

### T2. Split H1 from H2

Run T1 with the CRG line removed (RST_N and PWREN only). If it works, H1 is proven and H2 is irrelevant.
If it fails, run only the CRG line. Two single-variable runs, no combined guesses.

### T3. If T1/T1b fail: hold the module in reset and release it slowly

```sh
devmem 0xf9c40078 32 0; devmem 0xf9c40004 32 0; sleep 0.5      # vendor reboot quirk order
devmem 0xf9c40004 32 1; sleep 0.1; devmem 0xf9c40078 32 1; sleep 0.3
```

then rebind. This copies the vendor `host_power(false)` then `host_power(true)` including the 100 ms settle.

### T4. If still dead: attribute the failure to the pad or the module, not the controller

Read `RINTSTS (+0x44)` right after a failed command. `0x100` (RTO) alone with a running clock means no
card output: pad, power or LPO. Any CRC/RE bit means the card talks and the phase is wrong (back to H2).
Record `STATUS (+0x48)` bit 8 (DAT3 level) with the driver bound and idle: a floating or low DAT3 with a
card present argues for a missing pull-up in the pad word (H3).

## 6. Permanent change (only after a live test passes)

Pick the form that matches the winning test. Nothing here is built.

1. **If H1 (RST_N) wins.** Use the Hisilicon glue, not the generic compatible. Change `sdio1` to
   `compatible = "hisilicon,hi3798cv200-dw-mshc"` (as `emmc`), and add a 3-line `init` callback to
   `drivers/mmc/host/dw_mmc-hi3798cv200.c` that does `mci_writel(host, RST_N, SDMMC_RST_HWACTIVE)` for
   slot 0, then a 100 ms settle in `set_ios` on `MMC_POWER_UP`. This matches vendor order (PWREN then RST_N).
   The core already writes PWREN. [INFER, verify the glue's `init` hook exists in 6.18]
2. **If H2 (phases) wins.** The same glue takes `clocks = ciu, biu, ciu-sample, ciu-drive` and owns
   the phases. Add HISTB_SDIO1_SAMPLE/DRV clocks to the CRG patch at `0x28c` bits [14:12] and [18:16],
   and set `hisilicon,sap-dll-reg`-style defaults: sample 2, drive 3. Do not use `sd-uhs-*` yet. [INFER]
3. **If H3 (pads) wins.** Add a `pinctrl` state, or write the pad words once from board init, with the
   exact values from the Android diff. Do not guess values.
4. **If WL_REG_ON turns out to be a real GPIO or the host pin.** Add `mmc-pwrseq-simple` with
   `reset-gpios`, `post-power-on-delay-ms = <100>` and, if a 32 kHz source exists, `clocks`.
   `pwrseq` cannot drive the host's own `RST_N`, so it does not replace item 1.
5. **Do not add** a fixed 1.8 V `vqmmc` for init. It is cosmetic here (section 2b). Add it later only if you
   want `sd-uhs-sdr50/104` and tuning, which also needs the Hisilicon glue's sample-phase tuning.
6. Keep the NVRAM note from the research doc: drop `sd_oobonly=1` for brcmfmac.

## 7. Gaps and caveats

- Vendor tree used is `hisilicon-kernel-4.4.35`, the device ran 3.18. The `himciv200` code paths cited
  match the Android log behaviour, but exact line numbers could differ from the 3.18 binary. [INFER]
- The Android boot/recovery ramdisk (`init*.rc`) was not found: `emmc-dump/kernel.img` has a Hisilicon
  header, not an Android boot header, so no rc parse was possible. `system.img` has no `/etc/init` and no
  `/vendor`. Any boot-time `echo`/devmem on SDIO2 or its power therefore remains **UNKNOWN**.
- The WiFi platform glue (`bcmdhd` `dhd_custom_*`) is not in the vendor kernel tree on disk; only its log is.
- `docs/.../q10log-20261011/boot-1` dmesg is an older boot where the failing `mmc1` was the eMMC node,
  not SDIO2. It does not describe your current failure.
- Probabilities are judgement, not measurement. T0 and T2 convert them into facts in about five minutes.
