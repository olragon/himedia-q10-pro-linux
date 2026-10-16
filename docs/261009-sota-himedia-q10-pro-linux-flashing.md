# HiMedia Q10 Pro - flashing / access / reversibility (SOTA angle: flashing)

Date 2026-10-09. Research only; nothing here is authorized work.

## Verdict

**Not proven reversible yet - but the odds are decent, and the first three steps are free.**

- A stock-restore path EXISTS and is the vendor's own: a USB stick with `update.zip` plus a pinhole RESTORE button next to the power socket. Stock packages also ship `fastboot.bin`, `recovery.img`, `bootargs.bin` (snippet-only, unfetched: androidpctv search result), so the bootloader itself is a replaceable file in the vendor set.
- BUT the one documented brick (XDA, 2017) shows that this recovery path dies with the bootloader/recovery state: box hung on the logo, LCD "boot"/"0000", USB ports ignored, **no confirmed recovery**; the only proposed fix was opening the case and using the serial console (no pins given).
- The Poplar reference board has a BootROM USB recovery (`fastboot.bin` on FAT USB, hold S3). **Nobody I could fetch shows the Q10 Pro exposing an equivalent trigger.** Hi3798CV200 is the same SoC, so the BootROM probably has the path, but retail secure-boot fusing and the trigger pad are UNKNOWN. Do not plan on it.
- Therefore: treat the box as **recoverable only if (a) a full eMMC dump exists, and (b) UART access is confirmed before any write.** Without those, flashing is potentially one-way.

## What I can state with evidence

| Claim | Evidence |
|---|---|
| Update = `update.zip` at USB root, hold RESTORE (pinhole beside power jack) while powering on, droid logo, 3-5 min | fetched: androidpctv v2.1.4 page (instructions), fetched: w2compcom (pinhole next to power socket; Q5/Q10/H8 generic, 2015 era) |
| Versions are sequence-gated on older firmware (1.0.5 -> 1.0.6 -> 1.0.8 -> 1.0.9) | fetched: w2compcom comment, Q5 II only; may not apply to Q10 Pro 2.x |
| Downloads: Mega links on androidpctv (v2.1.4, v2.1.1), chinagadgetsreviews v2.1.6/2.1.7, geekbuying, peakhdplayer | snippet-only, unfetched (search results); androidpctv page itself fetched and confirmed a Mega link |
| 1.0.8 (Android 5.1) -> 2.0.1 (Android 7) upgrade bricked a unit | fetched: XDA thread |
| Poplar: bootROM -> l-loader -> TF-A -> U-Boot; `fastboot.bin` on FAT USB in USB 2.0 port, hold S3 | fetched: TF-A Poplar doc, openSUSE HCL |
| Poplar serial: Ctrl+C at boot gives U-Boot prompt; eMMC write via `mmc write` | fetched: openSUSE HCL (Poplar only) |
| Board marking `HI3798CV200_V1.2_20160222`, AP6335 wifi, RTL8211E | search snippet only (aminhacasadigital); page fetch returned an empty shell |
| HiMedia engineers said Android 7 can't be rooted; a user says adb runs as root on Lollipop and Nougat | snippet-only, unfetched (futeko forum had expired cert; kodi/avsforum not fetched). Contradictory - treat root as UNKNOWN |

## Per-question answers

1. **Stock firmware.** Format: `update.zip` (do not unzip), plus loose `fastboot.bin`/`recovery.img`/`bootargs.bin` in the package. Updater: recovery-mode USB update via RESTORE pinhole. Downloads exist for 2.0.x to 2.1.7 (2020). Full-restore guarantee: **not established.** It restores a box whose recovery and bootloader still run; it did not rescue the XDA brick.
2. **UART.** Existence implied (XDA: "open box, RS232, PuTTY"). **Pad locations, pinout, baud: NOT FOUND.** Expect 3.3 V TTL, 115200 8N1 by HiSilicon convention - that is a prior, not a measurement. Verify GND, then probe TX with a multimeter/scope for boot-time activity before connecting anything; never connect a 5 V adapter. Could not confirm a U-Boot interrupt on retail units (Poplar: Ctrl+C works).
3. **BootROM USB path.** Trigger on Q10 Pro: **unknown.** The RESTORE pinhole is the Android recovery trigger, handled by the loaded bootloader, not demonstrably the BootROM. I found no evidence for the AV-jack toothpick trick on this model. Not confirmed, not refuted.
4. **HiTool/HiBurn.** Exists (Poplar guidance: select Hi3798CV200, "Burn EMMC"); the SDK repo `JasonFreeLab/HiSTBLinuxV100R005C00SPC050` is public (snippet-only). Transport for Q10 Pro (USB device port vs serial vs network) not established. HiBurn normally drives the board over serial/network from a Windows host - from memory, unverified.
5. **Locked/signed.** UNKNOWN. No eFuse reports found. The vendor ships a plain `fastboot.bin`, which weakly suggests a non-secure-boot retail config, but it is only an inference.
6. **Backup.** No fetched source. Candidate methods in order of safety: (a) adb shell `dd` of `/dev/block/mmcblk0*` partitions if shell is root (check `adb shell id` - costs nothing); (b) U-Boot `mmc read` over UART; (c) HiTool read. Dump to external disk, hash it twice.
7. **SATA boot.** No evidence either way. Hi3798 U-Boot on Poplar boots from eMMC/USB; SATA boot support in the vendor loader is unverified. Plausible design: kernel/initramfs from USB or eMMC `boot`-type partition, rootfs on SATA. Needs confirmation by reading `bootargs` on the UART.

## Risk table

| Step | Reversible? | Needs |
|---|---|---|
| Download stock 2.1.x zip and verify a copy is kept offline | yes | disk space; Mega access |
| `adb shell id`, read-only recon (`cat /proc/partitions`, `getprop`, `cat /proc/cmdline`) | yes | network adb enabled |
| Full eMMC dump via adb `dd` | yes (read only) | root shell, external storage |
| Open case, locate UART, probe voltages | yes if no soldering damage | multimeter, 3.3 V USB-UART, steady hands |
| Read U-Boot env, `printenv bootargs` over UART | yes | UART working |
| Re-flash same stock version via RESTORE+USB | yes in principle | USB FAT32; known to have failed once on a version jump |
| Update across major version (5.1 -> 7) | NO, ONE-WAY-RISK (the only documented brick) | dump + UART first |
| Boot a Linux kernel from USB/SATA without writing eMMC | yes, only if the loader permits it | UART, U-Boot prompt |
| Write `bootargs.bin` / `fastboot.bin` / `mmc write` to eMMC | NO until a dump and tested UART recovery exist | dump, UART, verified restore procedure |
| Try Poplar-style `fastboot.bin` on USB with a button/jack trigger | UNKNOWN; wrong image could hang the BootROM stage | need proof the trigger exists; fused-off state unknown |

## Recommended order (research suggestion, not authorization)

1. Recon over adb, read-only. 2. Dump eMMC. 3. Open case, find UART, capture a boot log. 4. Only then consider a non-eMMC boot experiment. Any write to loader partitions waits until the unbrick path (dump + UART + tested vendor restore) is proven on this exact unit.

## Gaps (named, not guessed)

- 4PDA, freaktab, kodi, avsforum, futeko threads were not fetched; a pinout or BootROM trigger may exist there (4PDA topic 734477 is the main Russian thread, snippet-only). Next probe: dev-browser on 4PDA (login-gated, Cloudflare unknown).
- aminhacasadigital teardown returned an empty shell; photos may show the UART header.
- No source on HiTool transport, secure boot, SATA boot.

## Sourcing ledger

- Fetched and read: 7 (androidpctv v2.1.4 page, XDA brick thread, w2compcom, openSUSE HCL Poplar, TF-A Poplar doc, androidtvbox v2.0.0 [title only, no body], aminhacasadigital [empty shell, no facts]). Last two contributed nothing.
- Unavailable: futeko (expired TLS cert); XDA via plain WebFetch (403, later read via proxy).
- Snippet-only, unfetched: chinagadgetsreviews, geekbuying, peakhdplayer, 4PDA, kodi, avsforum, github HiSTBLinux SDK, root claims.
- Queries returning nothing useful: UART pinout (no result), BootROM button on Q10 Pro (no result).
