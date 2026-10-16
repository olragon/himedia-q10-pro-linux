# HiMedia Q10 Pro: display mode setting, HDR infoframe and non-PCM audio wiring - what was ported, how to test it

Date 2026-10-12. Kernel **6.18.55-k21** (artifact set `k21`), patches **0015-0017**. Built and compile-tested
(W=1, zero warnings); **nothing here has run on hardware**. Nothing is committed (owner's instruction).
Predecessor: `docs/261012-himedia-display-modes-research.md` (the plan this executes).

Tags as before: **[read]** = taken from a named file:line, **[inferred]** = reasoned, **[unknown]** = only the
box can answer. CM = community tree `~/src/histb-linux-6.12.y`; K618 = our 6.18.55;
VT = vendor SDK `~/src/hisilicon-kernel-4.4.35`.

## 0. Read this first

1. **Loading the modules still does exactly what it does today.** `modprobe histb_vdp` pulls in `histb_hdmi`
   (softdep); both adopt U-Boot's running 1080p link. No reset, no PLL write, no PHY write, no TMDS off. The
   first atomic commit - the console client's - is for the *boot mode*, and a commit for the boot mode is a
   no-op at the hardware in both drivers. The code path is checkable: `link_owned 0` in
   `/sys/kernel/debug/histb-hdmi/state` and `owned 0` in `histb_vdp_regs` until you ask for another mode.
2. **The first commit for any other mode takes the whole chain over, once**: new PLL plan, VDP soft reset, the
   community's RGB colour path, HDMI TX reset + vendor init, then the new timing. That is deliberate and is the
   biggest single uncertainty (sec. 9, risk 1): the community TX setup assumes the community's VDP RGB chain, and the
   bootloader runs a different one. They have to be switched together.
3. **The research doc was wrong in three places that mattered** (sec. 3): the 6.12 -> 6.18 bridge API drift is
   more than `color_format_property`; there are 26 PLL presets, not 25; and "adopt the VDP, run the community
   TX" does not work because the colour chains differ.
4. Order of what to run is in sec. 6. **Step 0 (a read-only `snap` before the first load) is worth doing first**:
   it records what the bootloader left in the display block, which nobody has captured.

## 1. What was ported

All three patches are in `scripts/himedia/kernel/arm32/`; `scripts/himedia/display/make-patches.sh` regenerates
them from the working tree as a diff against *pristine + the whole stack below 0015* (so 0013/0014 from the
cpufreq work are underneath, not baked in), and `verify-patches.sh` re-applies the shipped files to a fresh tree
and compares every touched file byte for byte with the compiled one (last run: `VERIFY OK`).

### 0015 - `clk-hisilicon-hi3798cv200-hdmi-pixel-clock.patch` (clock)

| Piece | New file / hunk | Provenance |
| --- | --- | --- |
| `clk_hdmi_pixel` clk_hw: HPLL + VO_HD divider + pixel gate | `drivers/clk/hisilicon/clk-hi3798cv200-hdmi.c` | CM `crg-hi3798cv200.c:987-1500` (`hi3798cv200_hdmi_pixel_*`) |
| 26 PLL presets (word for word rows of the vendor format table) | same, `presets[]` l.114 | CM `:1012-1041`; the rows are the ones `scripts/himedia/display/stock-fmt-table.py` decodes out of the stock image; arithmetic checked by `hpll-plan.test.ts` |
| generic solver for any other rate | same, `pixel_find_rate` l.152 | CM `:1052-1135` |
| `set_rate` with rollback | same, `pixel_clk_set_rate` l.341 | CM `:1323-1450` (changed, see below) |
| 8 HDMI gates (CRG 0x10c bits 0-5, 0x278 bits 0/1) | `crg-hi3798cv200.c` gate table | CM `:1739-1752` |
| ids 110-118 | `histb-clock.h` | CM numbers them 78-86, which collide with our inner window 64-89 (97 is the cpufreq patch's) |
| `hisi_clk_lock` made global | `clk.c`, `clk.h` | so the pixel clock's read-modify-writes of CRG 0xd8/0x278 are serialised with the gates that share those words |

Changed against the community code, all so that **registering the clock changes no register**:
`.prepare` is empty (CM's re-programs the PLL when the live words differ from the preset - and the boot words
`14e6ae6a/00001062` are an *equivalent* 148.352 MHz plan that is not a preset row, so CM's code would have
rewritten the PLL at boot); `CLK_IGNORE_UNUSED` on the pixel clock and all 8 gates (not CRITICAL, which would
force-enable them at registration); `set_rate` writes the two HPLL words and the VO_HD divider field only (the
source selects are *checked* and a mismatch is logged, never written); the lock wait starts 100 us after the write
because the lock bit shows the old lock for a moment (CM polls at once and can pass on a stale bit) and allows
10 ms; on timeout every register is put back and the old PLL given time to relock. One `dev_info` at boot prints
HPLL, lock and CRG54/67/158/211 as the bootloader left them.

### 0016 - `drm-bridge-add-histb-hdmi-transmitter.patch` (bridge)

`drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c` (2,314 lines) + Kconfig/Makefile + `include/drm/bridge/histb_hdmi.h`.
From CM `histb-hdmi.c` (1,944 lines): PHY table `:264`, video path `:478`, vendor reset `:810`, hw init `:830`,
configure `:865`, EDID `:954`, SCDC `:1060/:1383`, `pre_enable :1488`, `enable :1591`.

| Added / changed for 6.18 and for adoption | Where (new file) |
| --- | --- |
| 6.18 API: `atomic_*` take `struct drm_atomic_state *`, `.detect(bridge, connector)`, no `color_format_property` | the `drm_bridge_funcs` table |
| probe is read-only: aux clocks enabled, no reset, no init, no TMDS change | `histb_hdmi_probe` l.2163 |
| boot-link logic: nothing touches the hardware while `link_owned` is false and the mode is the boot mode | `keep_boot_link` l.1594, every `atomic_*` hook |
| takeover = community sequence, plus the PHY reset the community *probe* does | `atomic_pre_enable` l.1839 |
| same-link fast path: HDR / colorimetry change rewrites infoframes only | `same_link` l.1625, `atomic_check` forces the pass |
| CRTC sets the PLL, bridge only verifies it (0.5 %) and gates it; on mismatch it gives up and re-enables the previous output | `atomic_pre_enable` / `atomic_enable` |
| HDMI audio set by `q10_aiao` survives the TX reset | `audio_save` l.1682 / `audio_restore` l.1704 |
| EDID: first failure -> set the 2 DDC speed registers and retry once; `force_connected=1`, `max_output_bpc=8`, `allow_poke` | module params |
| debugfs `histb-hdmi/{state,regs}` (+ `poke`) | end of file |
| exported `histb_hdmi_set_boot_mode()` | l.1765 |

Infoframes (AVI, SPD, vendor, **DRM = HDR**) go through the generic `DRM_BRIDGE_OP_HDMI` helpers exactly as in CM
(selector 9 for DRM, `histb_hdmi_infoframe_select`), so `HDR_OUTPUT_METADATA`, `Colorspace` and `max bpc` appear
as connector properties by themselves. Registered with `max_bpc = 12` (that is what creates the HDR property) but
`max_output_bpc` clamps every commit to 8 until you raise it.

### 0017 - `drm-hisilicon-histb-vdp-mode-setting-through-the-hdmi-bridge.patch` (VDP, on top of 0011 - 0011 is untouched)

| Piece | Where | Provenance |
| --- | --- | --- |
| `histb_vdp_hw_set_mode`: PLL first, once the reset + chain, every time the timing | `histb_vdp_mode.c:257` | CM `histb-vdp.c:773` (`resources_enable`), `:556` (`program_axi`), `:590` (`rgb_identity_path`), `:652` (`program_timing`), `:838` (`pipe_enable`) |
| `pipe_reset` (VERSION1/2 poll, never leaves the block in reset) | `:102` | CM `:763-835` |
| `retime` writes HSYNC1/2 VSYNC PWR, GP0 sizes | `:214` | CM `:652-730`; the encoding was checked against the measured boot values (`HSYNC1 0x00BF077F`, `HSYNC2 0x57`, `VSYNC 0x00C28437`, `PWR 0x0004002B`) |
| connector from the bridge chain (EDID modes, HDR, infoframes); boot mode first and the only PREFERRED one | `histb_vdp_bind_bridge`, `histb_vdp_bconn_get_modes` | CM `:1244` (`drm_bridge_connector_init`) |
| `crtc_enable`: skip the hardware if the mode equals the running one; replay the planes afterwards | `histb_vdp_crtc_enable` | the commit helpers run plane updates *before* `crtc_enable`, so a reset would wipe them |
| boot mode's clock taken from the running PLL (148.352 MHz = 59.94 Hz, not "60") | `probe` | the registers hold no refresh rate; the sink's 59.94 mode is then recognised as the running one |
| DT: `ports` vdp -> hdmi, `pixel` clock, `vdp` reset | `hi3798cv200-himedia-q10-pro.dts` | CM `hi3798cv200.dtsi:808-905` |
| `modeset=0` / no `ports` / no `pixel` clock = the original fixed-mode connector | `probe` | the fallback |
| `allow_scale` | unchanged | |

## 2. The safety requirements, and where each is enforced

| Requirement | Mechanism |
| --- | --- |
| Default behaviour at load is exactly today's | clock registration writes nothing (sec. 1); bridge probe is read-only; VDP probe unchanged in hardware terms; the boot mode is the connector's only PREFERRED mode, so the console's first commit is for it; both `crtc_enable` and every bridge hook return before touching hardware for that mode |
| No reset, no PHY touch until userspace asks | VDP reset and all three HDMI resets are *acquired* at probe, pulsed only inside the first commit whose mode differs |
| Disabling an adopted link never blanks it | `keep_boot_link()` returns true when the encoder turns off |
| Failed PLL lock: roll back the previous words and fail the commit | the clock driver restores `HPLL ctrl0/ctrl1`, the VO divider and the gate and relocks the old plan; `histb_vdp_hw_set_mode` returns the error *before writing anything else*; the bridge sees the unchanged rate, logs it, and turns the output the commit switched off back on. A DRM commit cannot return an error from the enable stage (the core allows none there); "fail" therefore means: the old mode keeps running, `dmesg` says so, and the next commit for that mode retries |
| `allow_scale` unchanged | untouched |
| Everything a module | `DRM_HISI_HISTB_HDMI=m` (asserted by the build), `histb_vdp` already `=m`; a bad module fails only on a guarded `modprobe`; `histb_hdmi` is blacklisted from udev, pulled in by the VDP's softdep |

## 3. Corrections to the research doc

1. "The only API drift is `bridge.color_format_property`": false. The 6.18 bridge ops take
   `struct drm_atomic_state *` instead of `struct drm_bridge_state *`, and `.detect` takes the connector. Found by
   compiling, not by reading.
2. "25 presets": there are **26** (the table ends 593.407 / 594.000 MHz after `296.703 / 297.000`).
3. "Adopt the VDP, run the community TX": the bootloader's DHD0 has `hdmi_mode = 0` (`DHD0_CTRL 0x80008010`; the
   vendor's `DHD_YUV_TO_HDMI = 0`, VT `vdp_software_selfdefine.c:16`), i.e. YUV into the TX with DHD0's colour
   conversion on; the community TX maps its input as RGB `G,B,R` and expects `hdmi_mode = 1`, every CSC off, the
   CVM2 Q14 identity. Mixing the two permutes or mis-scales the colour channels. So the first mode change
   switches the *pair*, using the community's full VDP programming (including its soft reset).
4. "The DDC master works on fastboot's init": untested; the bridge reads the EDID before any reset and falls back to
   setting the two DDC speed registers (all the vendor init adds for DDC).

## 4. What the first mode change does, in order

`modetest -s` (or Kodi, a compositor) asks for a mode other than the boot mode:

1. **bridge `atomic_disable`**: adopted link -> `tmds off` only (infoframes and registers kept, so it can be put back).
2. plane updates run (G0/V0 for the new size - a reset will wipe these).
3. **VDP `crtc_enable`** -> `histb_vdp_hw_set_mode`: `clk_set_rate(pixel)` (pixel gate off, new HPLL words, VO_HD
   divider, relock, gate on); then, first time only: VDP soft reset, AXI/low-power, `DHD0` staged off, identity
   path + route + GP0; always: DHD0 timing, GP0 size, DHD0 on with the vendor's staged `regup`s; vblank threshold
   re-armed. Planes replayed.
4. **bridge `atomic_pre_enable`**: verify pixel rate; enable the pixel gate; save the audio block; (first time)
   pulse all three resets; vendor reset + init; `configure_mode` (PHY bucket for the TMDS rate, video path,
   scrambling off until SCDC accepts, TX in HDMI mode).
5. **bridge `atomic_enable`**: SCDC if > 340 MHz; TMDS on; link validation log; infoframes; audio restored.

Blank time is the sum of 1-5, expected well under a second; your TV's re-sync dominates.

## 5. Build result

`Q10_KBUILD_ROOT=$HIMEDIA_ROOT/kernel-build-arm32-display bun scripts/himedia/build-kernel-arm32.ts --out k21 --localversion k21 --ramlog`
((run log); exit 0; the log's config assertions include `DRM_HISI_HISTB_HDMI =m`):

| Artifact (in `.../kernel-build-arm32-display/`) | |
| --- | --- |
| `k21.zImage` 14,045,696 B, `k21.dtb` 18,296 B, `k21` (uImage, arch=2, DTB appended) 14,064,056 B | release `6.18.55-k21` |
| `k21-modules.tar.gz` 11,038,596 B | contains `histb-hdmi.ko`, `histb-vdp.ko` (vermagic `6.18.55-k21`; vdp `softdep: pre: histb_hdmi`) |
| `$HIMEDIA_ROOT/audio/q10_aiao-6.18.55-k21.ko` | built with `Q10_KBUILD_ROOT=... scripts/himedia/audio/build.sh` |

Checked in the built artifacts: `strings vmlinux` has the pixel-clock log line; the DTB decodes `display-controller@8cc0000`
(clocks + `pixel`, `resets = <crg 0xd8 30>`, `ports`) and `hdmi@8ce0000`; module parameters present as listed in sec. 7.
The tree reports "Clock skew detected" warnings from `make` (file mtimes written by the host); the strings/modinfo
checks are the evidence the objects are current. `bun test scripts/himedia/display/hpll-plan.test.ts`: 8 pass.

## 6. Test plan (you run it)

Everything on the box runs through `scripts/himedia/display/mode-test.sh` (copy it over; it re-execs itself under
`q10-wd-run`; hold 15 s, dead-man 20 s; `selftest` runs the mode picker with no hardware).

**Step 0 - before the first load, on the stick kernel or k21, `histb_vdp` NOT loaded**
```
scp scripts/himedia/display/mode-test.sh root@q10.local:/root/
ssh root@q10.local 'echo "blacklist histb_hdmi" >> /etc/modprobe.d/q10-untested.conf; /root/mode-test.sh snap' | tee archive/$(date +%Y%m%d-%H%M%S)-display-snap-before.txt
```
That records HPLL (`0x28/0x2c/0x150`), CRG `0xd8 0x10c 0x110 0x278 0x34c`, DHD0 incl. `CSC_IDC 0xc040`, GP0, and the
mixer - **what the bootloader left**. Keep it.

**Step 1 - boot k21 and load**
```
Q10_KBUILD_ROOT=$HIMEDIA_ROOT/kernel-build-arm32-display scripts/himedia/kexec-try.sh k21
# on the box, after it is back:
dmesg | grep "HDMI pixel clock"              # HPLL/CRG as the boot left them (should match step 0)
q10-modprobe-guarded histb_vdp 60 5
dmesg | grep -E "histb|hdmi|adopt|pixel clock"
```
Expected: `boot link adopted: "1920x1080": 60 148352 ...` (the refresh field rounds 59.94 to 60; the clock 148352 kHz is the 59.94 plan), `adopting bootloader mode`, `pixel clock runs 148351xxx Hz`,
`HDMI bridge registered (TX id ...)`, **no** `taking over`, no `mode change`. The TV must not flicker (a one-frame
simpledrm handoff is as before). `/sys/kernel/debug/histb-hdmi/state`: `link_owned 0`. `modetest -M histb-vdp -c`:
the EDID mode list, `#0` marked preferred = the boot mode. **Gate: if the picture or the console is gone here, stop -
`rmmod`/reboot and tell me `dmesg`; the cause is in this sec.'s no-op claim, not in mode switching.**
Read the TX's idea of the link: `mode-test.sh snap` again, and `edid-decode /sys/class/drm/card*-HDMI-A-1/edid`.

**Step 2 - stage 1, 1080p** (`mode-test.sh stage1`, or `try 1920x1080@59.94 15` one at a time): 60.00, 59.94, 50, 30, 25, 24, 23.976.
Per mode, expected in the dmesg excerpt: `mode change ... (taking the pipe over)` once, `taking over the bootloader's link`
once, then no `HPLL did not lock`, no `HDMI TX clock is not stable`, no `FDET has no active DE`. `state`: `link_owned 1`,
`tmds_on 1`, `pixel_clk_hz` = 148500000 (60, 50), 1483516xx (59.94), 74250000 (30/25/24), 7417xxxx (23.976), `fdet pixels/lines`
= the mode's htotal/vtotal [inferred that FDET counts totals]. 60 vs 59.94 differ by 0.06 Hz in the PLL only
(timing identical) - the PLL words in `snap` prove it, your TV's info OSD shows it.

**Step 3 - stage 2, 720p** (`stage2`): 60, 59.94, 50 (74.25 / 74.176 MHz; PHY bucket 74.25 edge flips `tx_reg_zone`).

**Step 4 - stage 3, 2160p** (`stage3`): 30.00 (297 MHz, no scrambling), 29.97, then 60.00 (594 MHz: SCDC + scrambling; the
helper picks RGB 8 bpc if the sink lists >= 600 MHz TMDS, else 4:2:0). `SCDC` lines in dmesg. Stop at the first failure:
a failed 4K60 on a good 4K30 is cable/sink first, driver second.

**Step 5 - HDR infoframe** (needs a client that sets properties; Kodi with HDR content, or `modetest`/`drm_info`): the connector must
list `HDR_OUTPUT_METADATA`, `Colorspace`, `max bpc`. With the property set,
`/sys/kernel/debug/dri/*/HDMI-A-1/infoframes/hdr_drm` shows the infoframe and the TV's OSD flips to HDR; it goes out
at 8 bit. `echo 10 > /sys/module/histb_hdmi/parameters/max_output_bpc` to let a commit pick 10 bpc (TX deep-colour
packing from an 8-bit pipe, **[unknown]** result).

**Step 6 - non-PCM passthrough** (AC3/DTS core only; reload `q10_aiao` k21 first, `insmod /lib/modules/6.18.55-k21/extra/q10_aiao.ko`):
```
amixer -c Q10 cset iface=PCM,name='IEC958 Playback Default' 06,82,00,02   # AES0 bit1 = non-audio
ffmpeg -i x.ac3 -c copy -f spdif out.iec61937
aplay -D hw:Q10,0 -f S16_LE -r 48000 -c 2 out.iec61937                    # AVR volume LOW
```
(or Kodi with "AC3/DTS passthrough" enabled and the device `hdmi:CARD=Q10,DEV=0` - alsa-lib's `hdmi:` plugin writes that same
control from its AES arguments). dmesg: `non-audio (IEC 61937) stream: DAC muted, HDMI/S-PDIF in bypass`. The AVR should light
"Dolby Digital". Kodi cannot read the sink's capabilities (no ELD: `q10_aiao` is not an ASoC/hdmi-codec driver) - enable
passthrough by hand.

**Capture for every failure**: `dmesg`, `mode-test.sh snap`, `cat /sys/kernel/debug/histb-hdmi/regs`, and `pstore` if it reset.

## 7. What I need you (Tim) to look at on the TV

1. **After the first mode change: colour.** Red, green, blue in the right place (a permuted channel order is the
   signature of the chain mismatch, sec. 9 risk 1); skin/grey neutral; **black is black and white is white** (full vs
   limited range: grey crushed -> range wrong, washed out -> range wrong the other way).
2. Picture present and **stable** for the whole hold, no sparkle/noise (PHY bucket), correct edges, no shifted/cropped
   image or black border that was not there at the boot mode.
3. The TV's own info OSD for every mode: resolution, **Hz** (59.94 vs 60, 23.976 vs 24), RGB/YCbCr, bit depth, HDR.
4. 24 / 23.976 Hz: a slow pan - judder is expected for 24 on a 60 Hz TV but the TV should say 24.
5. After each `try` ends: did the picture **come back by itself** (fbdev restoring the boot mode)? That is the revert path.
6. HDMI audio (any PCM stream) **before and after** a mode change - it must still play.
7. 4K: whether the TV shows 4K at all, and at 60 whether it stays up or drops out (cable).

## 8. Fallback

- **Nothing to undo in hardware**: the mode is never persisted. A hung display kernel is reset by the SP805 into the
  stick kernel; every boot re-runs U-Boot's own setup.
- A mode that leaves the TV dark: wait out the hold (the fbdev revert) - or `rmmod histb_vdp histb_hdmi` and reboot.
- Disable mode setting without a rebuild: `modprobe histb_vdp modeset=0` -> the original fixed-mode connector, the
  bridge unused (`histb_hdmi` still loads: softdep; it is read-only).
- `histb_hdmi force_connected=0` to trust the HPD bits, `max_output_bpc`, `allow_poke=1` for live TX/VDP register pokes
  (`echo "e 60 1" > /sys/kernel/debug/histb-hdmi/poke` = the TX's test pattern, which separates VDP from TX faults).
- Previous kernels: `k20`/`k19` zImages are untouched in their own dirs.

## 9. Open risks, ranked

1. **The chain switch at the first mode change [unknown].** Colour order/range after the VDP reset + community RGB
   path, and whether the community TX mapping `G,B,R` really matches the VDP identity output on *this* board (the
   community ran it on cold boot with their own DHD0 init; so do we, but after a bootloader pipe). Symptom: swapped or
   washed colours, or no picture. Tools: step 0 snapshot, `poke`, the TX test pattern.
2. **HPLL re-lock semantics [unknown]**: the 100 us settle + 10 ms window is a guess about the lock bit. A false failure
   rolls back and logs; a missed unlock passes on a stale bit and shows as a TV sync fail.
3. **EDID over the TX's DDC master on fastboot's init [unknown]**; fallback sets the speed registers once.
4. **Deep colour / HDR at 10 bit**: the pipe is 8 bit. HDR is signalled, not carried at 10 bit (research sec. 4.1);
   `max_output_bpc=8` default keeps compositors from asking for more.
5. **4K UI**: GP0's scaler is off (the community leaves it off), so a 1080p UI cannot be scaled up to 4K by the display
   block; the compositor must render at 3840x2160 (33 MB per XRGB buffer from the 128 MB CMA shared with the decoder).
   2160p60 RGB is also ~2 GB/s of scanout on a DDR the decoder shares.
6. **Audio restore** reads the TX audio infoframe buffer back; if the TX does not allow it, the stereo 48 kHz frame
   `q10_aiao` sends is substituted (so multichannel info would be lost, not stereo).
7. **Atomic commits cannot fail at the enable stage**: a refused PLL leaves the old mode running while DRM state says
   the new one; userspace sees no error, `dmesg` does.
8. `rmmod histb_vdp` after a mode change leaves the planes off (the bootloader's buffer and chain are gone) - black
   until reload or reboot.
9. Dolby Vision, HDR10+, HLG tone mapping, CEC: not attempted.

## 10. Not done

- HBR audio (E-AC3 192 kHz, TrueHD, DTS-HD MA): needs the 8-channel HBR path; only AC3 and DTS-core ride the existing 48 kHz/2ch ring.
- ASoC / `hdmi-codec` for `q10_aiao` (needed for ELD so Kodi can read the sink's audio capabilities).
- A 10-bit plane (P010) and 10-bit DHD0 output.
- Persisting a mode across reboot (deliberately never).

## 11. Files

New/changed under `scripts/himedia/`: `kernel/arm32/{0015,0016,0017}-*.patch`, `kernel/arm32/hi3798cv200-himedia-q10-pro.dts`
(vdp node extended, hdmi node added), `build-kernel-arm32.ts` (patches, `DRM_HISI_HISTB_HDMI=m`, a fix so a file created by
0011 and edited by 0017 is not restored from the tarball), `audio/q10_aiao.c` (IEC958 control, bypass, DAC mute),
`rootfs-units/q10-untested.conf` (`blacklist histb_hdmi`), `display/{compile.sh,lib.sh,make-patches.sh,verify-patches.sh,mode-test.sh,hpll-plan.ts,hpll-plan.test.ts,0015-0017.header.txt}`.

## 12. Findings from the first box runs (2026-10-12, k21)

- `try 1920x1080@60` while the boot mode was 59.94 (148352 kHz) did nothing: `DRM_MODE_MATCH_TIMINGS` does not compare the
  clock, so 60.00 Hz (148500) looked like "the running mode" in the VDP `crtc_enable`, the bridge boot-link test and the
  connector's PREFERRED marking. Fixed in 0016/0017 (`DRM_MODE_MATCH_CLOCK` added; compared in picoseconds, so 148352 and 148500 differ),
  built as **k21c**. Retest: 60.00 -> HPLL `0x12000000/0x00002063`, then 59.94 from there -> `0x12e6a7ef/0x00002062`.
- 6.18 bridges are refcounted: the bridge must come from `devm_drm_bridge_alloc()` (fixed, no WARNs in k21).
- **Test TV limits (RTK 6432): max TMDS 300 MHz, no 2160p VICs, no HDR static metadata block.** Stage 3 (2160p) and step 5 (HDR
  infoframe on a sink that advertises HDR) cannot be tested on it; `mode_valid` will not even offer >300 MHz. The 2160p presets,
  SCDC/scrambling and the DRM infoframe path stay compile-tested only until a 4K/HDR sink is available. Measured OK so far: 1080p50, 720p60, 720p50, release restoring 1080p.
