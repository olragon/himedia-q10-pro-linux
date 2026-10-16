# HiMedia Q10 Pro bring-up lessons

Lessons from the bring-up, one entry per finding, each with the evidence it rests on.

- **⭐ An ABSENCE in a binary is only as good as its positive control — and only valid where the
  bytes are plaintext.** Deciding whether the Q10 Pro's AArch32 device tree needs
  `clock-frequency` came down to "does the stock boot chain program `CNTFRQ`?", which is answerable
  from a partition dump with no hardware. It does not: **zero** CNTFRQ writes in the 1 MiB U-Boot
  and **zero across 4,336 CP15 encodings** in the 40 MiB TEE. Three guards make that worth
  believing, and skipping any one of them turns it into a confident guess:
  ⇒ **Entropy first.** A pattern scan over encrypted or compressed bytes returns a clean answer
  that means nothing — `recovery.img` measures **8.00** (ADVCA) and is reported *unscannable*,
  never *clean*, while U-Boot at **5.08** with 47% zeros and real strings is genuinely code.
  Same trap as the Vietmap `zn.cnk` "cracked" claim.
  ⇒ **A positive control.** A scanner that finds nothing may simply be broken. Ours finds 4
  CNTFRQ writes in our own `vmlinux`, so the zero is a real absence.
  ⇒ **Test the decoder against hand-computed encodings, not against itself** — `0xEE0E0F10` is
  `MCR p15,0,r0,c14,c0,0`, derived from the field layout. ARM and Thumb-2 share the 32-bit
  encoding but Thumb stores it as two LE halfwords, so **scan both byte orders** or a hit in one
  instruction set reads as an absence.
  ⚠️ And state the limit: a pattern scan is **not a disassembler** and cannot prove reachability,
  which is why an *absence* is strong evidence here and a *presence* would not be.
  `bun run himedia:cp15 <binary> [--reg CNTFRQ]` (8 tests)
  ⛔ **Check what a file IS before diffing against it.** `kernel-tree/q10.dtb` sat exactly where a
  vendor reference belonged and was **our own output** (`compatible = "himedia,q10-pro"`), carrying
  the opposite timer configuration — one read of it would have inverted the conclusion while
  looking authoritative. The real vendor trees were inside the firmware package, and *two
  byte-identical copies* (boot + recovery, same sha) agreeing is what evidence looks like.
  ⛔ **A disabled `verify` shifts the burden; it does not remove it.** The stock U-Boot env sets
  **`verify = n`**, so `bootm` checks neither the uImage header nor its data CRC: a truncated or
  corrupt image is **executed, not rejected**, and hangs at the vendor logo — byte-for-byte the
  same observation as a kernel that booted and died. Two failure modes that are identical *on* the
  device have to be separated *off* it, which is the whole case for pre-flight validation.
  `bun run himedia:simulate` verifies both CRCs and the arch field, resolves every `mmc read`
  sector against `blkdevparts` (so the "magic" numbers are checked, not trusted), and asserts the
  chain's ordering invariant. ⚠️ `bootdelay = 0` means there is no window to interrupt the loader
  and fix an environment interactively.
  ⚠️ **A vendor bootargs setting is tuned for vendor drivers.** Copying `vmalloc=600M` off the
  stock env would have cut ARM32 lowmem from ~784 MB to ~424 MB (`VMSPLIT_3G`, mainline default
  `240 * SZ_1M`) to serve HiSilicon's `mmz` media allocator, which mainline does not build.
  ref: `docs/261010-himedia-backup-forensics-and-boot-scenarios.md`

- **⭐ A watchdog is a console-less telemetry channel — and five rules make its readings true.**
  The Q10 Pro ladder (SP805 at `0xf8a2c000`, 18 checkpoints) walked a "dead" kernel from the
  decompressor to the exec of `/init` in one evening. What it took: (1) **periods spread wider
  than the overhead uncertainty** — the overhead is not the stub's 6 s but 11-14 s and GROWS
  with depth, so 4 s gaps gave one reading three meanings; `assertReadable()` refuses a profile
  with a gap <= 10 s or a checkpoint left at a colliding default and caught that four times.
  (2) **Solve for the pre-checkpoint time**, not the nearest period — 216 s fits Q with 18 s of
  work and R with an impossible 6 s. (3) **The last checkpoint hides everything after it**:
  nothing pets the dog, so a kernel that boots to userspace resets exactly like one that died —
  give the deepest point the LONGEST period. (4) Post-MMU writes need a mapping: aim the
  `CONFIG_DEBUG_LL` section at the device (`DEBUG_UART_PHYS == VIRT`, `EARLY_PRINTK` off,
  re-lock after every arm); never inside `setup_arch`, where `paging_init` drops it.
  (5) ⛔ **A probe that cannot fire is not a probe**: R opened `/dev/mem`, the initramfs had no
  such node, and "PID 1 ran" became indistinguishable from "exec failed". PID 1 now `mknod`s it.
  ref: `docs/261010-himedia-boot-ladder-results.md` · `scripts/himedia/checkpoints.ts`

- **⛔ Verifying a constant in a binary needs the full encoding matrix — two false negatives in
  one session.** `{ARM, Thumb-2} x {rotated/expanded immediate, movw+movt, literal pool}`.
  GCC built `504000000` as `mov r3,#0xc6e` (0x6e ror 24) + `movt`, not `movw` — five present
  checkpoints read as MISSING. Then the initramfs PID 1 turned out to be **Thumb-2 while the
  kernel in the same image is ARM** (`f24e 5551` = `movw r5,#0xe551`; `f44f 5118` = `mov.w`
  via ThumbExpandImm). A near-miss here invites rebuilding a correct image or flashing one
  believed instrumented when it is not. `scripts/himedia/arm-const.ts` (13 tests pin the exact
  bytes); when in doubt, `llvm-objdump --triple=armv7-none-linux-gnueabihf` settles it.

- **⛔ `=m` passes a `=[ym]` gate and never loads in a modules-less initramfs.**
  `CONFIG_RESET_TI_SYSCON=m` is the provider of the Q10 Pro gmac1 `"phy"` reset; the driver
  tolerated the missing reset (no defer) and simply never pulsed the PHY. Boot-critical
  symbols must be asserted `=y`, and a DT compatible -> Kconfig check is the gate that finds
  the next one. ⚠️ And `hix5hd2_gmac` registers its MDIO bus on the gmac node and scans
  **direct children only** — a `mdio {}` wrapper loses the PHY silently; Poplar and the vendor
  tree both put `phy@3` straight under the gmac. Fixing the reset ALONE breaks probe: the
  driver then requires `hisilicon,phy-reset-delays-us`. Land both together.

- **⛔ Q10 Pro: mainline `reboot` HANGS — the SoC has no restart handler, so arm the SP805
  before any reboot.** The vendor kernel restarts by arming the watchdog with a tiny load and
  spinning (`mach-hi3798cv2x/core.c` `hi3798cv2x_restart`); mainline has no `syscon-reboot` /
  watchdog node for this SoC, so the kernel stops at "Restarting system" — and our boot unit has
  already DISARMED the watchdog, so nothing ever resets the box. Silent box, never falls to
  Android. Cost a dead box for an afternoon (2026-10-11 16:17, Tim away). Fix: a
  systemd-shutdown hook arms the SP805 on `reboot` (`scripts/himedia/rootfs-units/`).
  ⛔ **This RETRACTS "box-written uImages do not boot"**: both "never came back" events
  (10:25, 13:46) began with a plain `systemctl reboot`, and the Mac-written retest ALSO came
  with a power cycle — two variables changed at once. Which one mattered is UNKNOWN; until a
  clean test, still write images from the Mac AND never reboot without the watchdog armed.
  ref: (an unpublished note)

- **⛔ Q10 Pro SATA errors were the KERNEL, not the board: mainline `phy-histb-combphy` writes the Poplar
  PCIe value `nano[0x1] = 0x8` in every mode; SATA needs the vendor's `0x4`.** A new cable changed nothing.
  Fixed in **k26** (patch 0020: SATA mode writes 0x4 before the first link training); the box runs from the
  SATA root, 3 soak boots with 0 exceptions (2026-10-14).
  ⛔ **Never retune a SATA PHY from userspace under a mounted filesystem.** The nano write blips the link
  (PHYRdyChg); with root I/O in flight libata's recovery failed (IDENTIFY timeouts → device disabled →
  ext4 journal aborted). Safe on an idle unmounted disk, unsafe on a root — a fix that has to run
  *after* the driver trained the link belongs in the kernel. Also: a tuner that lives on the disk it
  disturbs blocks on its own I/O (38 s stall) — run such tools from `/run`.
  ⛔ **k14's initramfs is frozen in the stick uImage**: only the chained kernel may mount a SATA root
  (`/q10-root-sata-chained`; `/q10-root-sata` stays `.off`). And **state shared by two roots lives on
  the stick** — the kexec attempt counter on each root made every second boot stay on k14.
  ⭐ **Measure a SATA link with zero media I/O:** clear PxSERR (AHCI+0x130) every second on an IDLE link
  (`tools/q10-sata-phy-probe.sh`). **A write test can be non-destructive:** read, write the same bytes
  back, re-read, compare (`tools/q10-sata-write-check.sh`). Soak: `tools/q10-sata-root-soak.sh N`.
  ⭐ **The root disk is the WD5000AAVS (`<disk-serial>`) since 2026-10-15**: 3.0 Gb/s, idle 36 °C against the
  Seagate's 47 °C (7200 rpm — the lid makes ~1 °C of difference). Both disks have carried LABEL=q10root and
  init.sh mounts by LABEL: turn `/mnt/stick/q10-root-sata-chained` `.off` before any disk swap.
  Tools: `q10-root-backup.sh`, `q10-sata-root-restore.sh`, `q10-sata-ro-mount.sh`, `q10-sata-detach.sh`
  (docs/261014-himedia-switch-to-wd-disk.md).
  ref: `docs/261014-himedia-sata-kernel-vs-board.md`

- **HiMedia Q10 Pro front panel ("HUD"): the VFD driver chip is a Titan Micro TM1629A** (Tim, read
  off the board 2026-10-11) — a 3-wire STB/CLK/DIO LED/VFD driver; mainline 6.18 has no TM16xx
  driver, so it starts as a userspace GPIO bit-bang. Whether it also scans the touch keys is not
  established (the panel's left sub-board has its own chip). Side ports: 1× USB3, 2× USB2, SD reader.
  ref: `docs/261011-himedia-peripherals-plan.md` · photos `docs/photos/`

- **⚠️ Q10 Pro SoC thermal: one trip point only — `critical` at 110 C, no passive trip, so nothing
  throttles the CPU before shutdown** (read 2026-10-15, kernel 6.18.55-k26, `soc-thermal`; cpufreq
  396-1596 MHz, governor schedutil, read 1596 MHz at idle — not read under load). Measured: idle with music ~55 C; 4 busy
  cores 56 → 80 C in ~3.5 min; 1 busy core + gigabit ssh transfer (~100 MB/s) → 79 C over 5 min. The WD
  disk stayed 41-42 C through all of it (no disk I/O). A passive trip (e.g. 85 C) in the DT would be the
  fix if sustained load ever matters. Also: the NIC's `rx_bytes` is 32-bit and wraps every 4 GiB.
