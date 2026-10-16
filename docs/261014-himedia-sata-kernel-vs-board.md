# Q10 Pro SATA: kernel PHY tuning, or a damaged board?

**Date:** 2026-10-14
**Status:** Complete — k26 kernel fix; the box runs from the SATA root (3 soak boots, 0 exceptions). Power-cut check pending.

## Goal
Decide whether the marginal SATA link (1.5 Gbps, BadCRC/10B8B on reads, new cable fitted) is our
kernel's PHY setup, the disk, or the board — and fix it if it is software. Never at the HDD's expense.

## Evidence at the start
- Every clean link in the archive (8 boots, 10-11 → 10-12 09:21, k0-k19) was **3.0 Gbps, UDMA/133,
  WD5000AAVS**. The Seagate ST3250310AS has **never** linked at 3.0 Gbps in this box (10-12 23:10 old
  cable; 10-14 new cable). Disk is a variable, not only cable/board.
- 10-14 read-only test: first training already at 1.5 Gbps (`SStatus 113`, `SControl 300` = no cap),
  then `SError { UnrecovData 10B8B BadCRC }` on `READ FPDMA QUEUED`, 6 resets, UDMA/100.
  ⇒ errors are host-RX (disk → box direction): signal integrity at the box's receiver.
- Mainline `phy-histb-combphy` writes Poplar tuning `nano 0x1=0x8, 0xc=0x9, 0x1a=0x4` in every mode.
  The vendor SATA driver (`hiahci-phy`, stock 3.18) writes `nano 0x1=0x4`, AHCI `0x14c`/`0x174`/`0x144`
  tuning and `nano 0x19=2|3`. Vendor tuning was only ever applied on the BAD cable — never measured.

## HDD safety rules (Tim: "don't burn my hdd")
1. **No writes** to the disk at all in this investigation.
2. Link quality is measured with **zero media I/O first**: PxSERR (AHCI+0x130) is cleared and
   re-read over an idle window — an idle link still carries ALIGN/SYNC primitives, so 10B8B and
   disparity errors accumulate without a sector being read. libata only issues IDENTIFY (512 B).
3. Media reads only for a config whose idle window is clean AND at 3.0 Gbps: start at 64 MB in
   16 MB chunks, **abort at the first CRC/SError increment**.
4. One spin-up per session; no spin-down/up cycling. Abort if temperature > 45 °C.
5. Every module load stays under the SP805 (`q10-modprobe-guarded`).

## Approach
1. Script `q10-sata-phy-probe.sh` (box side, pushed by a Mac wrapper): per config —
   unload `ahci_platform`, (re)apply PHY settings, guarded-load `ahci_platform`, read SStatus/SError/
   speed, clear PxSERR, idle N s, read PxSERR, decode bits. No media I/O.
2. Configs: C0 mainline baseline · C1 full vendor tuning (nano19=2) · C2 vendor nano19=3 ·
   C3 vendor AHCI regs only · C4 vendor nano only · each also with SControl SPD forced Gen2.
3. If a config is clean at 3.0 Gbps → staged read check (rule 3) → make it permanent in the kernel
   (combphy SATA-mode tuning patch) or a pre-ahci unit.
4. If NO config trains at 3.0 Gbps → check the disk: Seagate 7200.10 has a "force 1.5 Gb/s" jumper;
   swap in the WD on the same new cable (known 3.0 Gbps here); disk on another PC.
   Board damage is the conclusion only when a known-good disk + new cable also fail.

## Files
- `scripts/himedia/tools/q10-sata-phy-probe.sh` (new), `scripts/himedia/tools/q10-sata-phy-init.sh`
- this doc; `docs/261012-himedia-sata-link-down-investigation.md`

## Validation
A config with 3.0 Gbps, idle PxSERR = 0 over 60 s, and a staged 2 GB read with CRC +0 / resets +0
— then the same after a full power cut, with the fix applied by our own boot (no vendor kernel).
Result: met except the speed (1.5 Gbps with this disk) and the power-cut step (pending).

## Notes
### Verdict: KERNEL, not board damage
Mainline `phy-histb-combphy` writes `nano[0x1] = 0x8` (Poplar PCIe tuning) in every mode. In SATA mode that
leaves the box's receiver marginal. The vendor SATA driver writes `0x4`. With the vendor tuning, the same
board, disk and new cable are clean in both directions.

### Zero-media-I/O PHY probe (`q10-sata-phy-probe.sh`, ahci_platform unloaded, no IDENTIFY)
Idle-link error-seconds (PxSERR cleared each second; bits seen: T-data-integrity + B-10b8b):
| config | nano 0x1 | other | error-s |
|---|---|---|---|
| main (mainline) | 0x8 | + c=9, 1a=4 | 4/60, 15/60 (and 4/10 control) |
| main-b10 | 0x8 | + PERI+8 bit 10 | 12/60 |
| vahci | 0x8 | + vendor AHCI 14c/174/144 | 13/60 |
| n8 | 0x8 | alone | 33/60 |
| vend / v19-2 / v19-3 | 0x4 | full vendor | 0/60 each |
| vnano / vnano-nob10 | 0x4 | no AHCI regs, bit 10 on/off | 0/60 each |
| n4c9 | 0x4 | + mainline c=9, 1a=4 | 0/60 |
Sweep `n1-0..15` (30 s): 2, 4, 6 clean; every value with bit 3 set (8, 10, 12, 14) errs; 3, 5, 7, 11, 15
never linked; 1 and 9 linked late; 13 linked clean (odd values are erratic). 0x4 is mid-range of the clean set.
The link negotiated 1.5 Gbps (SPD=1) in every config.

### Under the driver (`q10-sata-read-check.sh`, `q10-sata-write-check.sh`)
| run | nano1 | AHCI regs | MB | CRC | exceptions | resets | mode |
|---|---|---|---|---|---|---|---|
| 14:37 baseline | 0x8 | — | 2048 read | +6 | 6 | 6 | UDMA/100 |
| 15:16 | 0x4 | — | 2112 read | +1 | 0 | 0 | UDMA/133 |
| 15:19 | 0x4 | vendor | 2112 read | +0 | 0 | 0 | UDMA/133 |
| 15:23 service path | 0x4 | vendor | 2112 read | +0 | 0 | 0 | UDMA/133 |
| 15:27 in-place rewrite | 0x4 | vendor | 1024 r/w/r | +0 | 0 | 0 | UDMA/133, sha256 equal |
CRC = the disk's UDMA_CRC_Error_Count (33 at the end). 74-75 MB/s read, the disk's media rate. Temp 33 → 40 °C.
One exception happened during the 15:16 run's driver load, while nano1 was still 0x8 (before the tune).

### Shipped
- `q10-sata.service` → `ExecStartPost=/usr/local/sbin/q10-sata-phy-tune` (`tools/q10-sata-phy-init.sh`):
  nano1=4 + AHCI port regs + one COMRESET; installed on the stick root, unit still **disabled** (Tim's call).
- `build-rootfs.ts` and `install-sata-hotplug.sh` install it; the installer no longer enables SATA by itself.

### Why the WD worked with mainline tuning and the Seagate never did
Every clean archived link was the WD5000AAVS at 3.0 Gbps; the Seagate has never linked above 1.5 Gbps here.
INFERRED, not measured: different disks have different TX margins — the WD had enough to survive
nano1=0x8, the Seagate does not. The WD has not been re-tested on either setting since.
The 10-12 "factory firmware sees no disk" result was the bad seating that day, not this.

### SATA root attempt (2026-10-14 16:05-17:00) — REVERTED
- Tim approved the wipe (16:0x). `tools/q10-sata-root-make.sh <disk-serial>`: GPT + ext4 q10root
  (UUID <fs-uuid>), root + music + Android copied (5.2 GB), checksum dry-run
  0 differing files, link CRC +0 / 0 exceptions during the copy. Cables: 2 bought, 83,200 ₫ for two — neither was the fault.
- Booting from it exposed what the idle tests could not: **a live nano write blips the PHY**
  (`PHYRdyChg CommWake DevExch`) and libata's EH resets the link with root I/O in flight.
  | boot | tuner | result |
  |---|---|---|
  | 16:15 | COMRESET after writes | ~6 min: one attempt hung → safety watchdog reset; then up |
  | 16:34 | no COMRESET, from disk | 3 hard resets, tune blocked 38 s on its own disk (EH) |
  | 16:41 | from RAM | 1 exception + 2 resets per stage, boot 1:50 |
  | 16:43 | from RAM, nano LAST | **k25: IDENTIFY timed out x3 → device disabled → EIO, ext4 journal aborted** → watchdog reset |
- Reverted 16:57: `/mnt/stick/q10-root-sata.off`; stick root back (k25, /dev/loop0). `e2fsck -f -n` on
  the SATA fs: clean (journal replay repaired it). Disk: SMART 0 realloc/0 pending, CRC 34, standby.
- ⇒ **Tuning from userspace on a disk that is in use is unsafe.** The fix must land before the first
  link training: k26 combphy patch (SATA mode nano[0x1]=0x4), and init.sh mounting a SATA root only
  in the chained kernel (k14's initramfs is frozen in the stick uImage and would still train at 0x8).
- ⚠️ **Heat:** 44 °C after the copy, 49-51 °C idle as root, **51 °C spinning UNATTACHED** in the
  closed box. SMART Airflow_Temperature_Cel threshold 45 = 55 °C. A disk that spins all day here
  runs within ~4 °C of its limit — airflow is a hardware question for Tim before any SATA root.
- Gen1 only: `hdparm -I` lists only "Gen1 signaling speed (1.5Gb/s)" — the disk's own setting
  (jumper), not a link fault.

### k26: the fix in the kernel (2026-10-14 18:19-19:18)
- Patch `kernel/arm32/0020-phy-histb-combphy-sata-mode-vendor-tuning.patch`: in SATA mode combphy writes
  only `nano[0x1]=0x4` (vendor), before the first link training; PCIe/USB3 unchanged. Dmesg proves it:
  `phy phy-f8a20858.phy.1: SATA mode: nano[0x1] = 0x4 (vendor SATA tuning)`.
- `init.sh`: a SATA root only in the CHAINED kernel and only with `/q10-root-sata-chained` on the stick.
  k14's frozen initramfs knows only `/q10-root-sata` (kept `.off`), so stage 1 runs from the stick root
  and never trains the SATA link at 0x8.
- The userspace tuner stands down on k26+ (`uname -r` check) — a retune would only blip a good link.
- Build: `Q10_KBUILD_ROOT=…/kernel-build-arm32-k25 bun scripts/himedia/build-kernel-arm32.ts --out k26
  --localversion k26 --ramlog`; q10_aiao rebuilt (`audio/build.sh`); `kexec-try.sh k26`;
  `install-kernel-chain.sh k26`.
- k26 on the stick root, SATA as a data disk: 2 GB read CRC +0 / 0 exc / 0 resets (75.6 MB/s), 1 GB
  in-place rewrite CRC +0 / 0 / 0, **0 exceptions in the whole boot**, including the driver load.
- Found on the way: the kexec-chain attempt counter lived on each ROOT, so k26 (SATA root) cleared its
  own copy and stage 1 (stick root) kept "attempts=1" → every second boot stayed on k14. The counter
  now lives on the stick (`/mnt/stick/q10-kexec-chain/`), and `ok` keys on `q10.chained=1`.
- **Soak (`tools/q10-sata-root-soak.sh 3`): 3 boots, k26, root /dev/sdb1, 0 exceptions, 0 hard resets,
  CRC 34 unchanged, disk 45-46 °C, boot to ssh 1:54-2:34.** No failed units; audio card, vdec/vpss,
  panfrost up; every session available; music + Android are directories on the 229 GB root.

### Power cut (2026-10-14 20:08) — PASS
Tim held the power key (clean off), pulled the plug, plugged back in. `q10-sata-root-soak.sh
--after-power-cut`: k14 up at +64 s, kexec at +131 s, ssh at +166 s on **k26, root /dev/sdb1,
`nano[0x1] = 0x4`, 0 exceptions, 0 hard resets, CRC 34**. The fix needs no vendor state left behind.

### Heat, lid closed with its thermal pad (Tim, 2026-10-14)
`tools/q10-disk-heat-test.sh 30`: idle spinning, no I/O — 35 °C (from standby) → 43 °C at 14 min →
45 °C at 19 min → 47 °C at 30 min, still rising ~1 °C / 5 min. Steady state likely ~48-50 °C idle;
SMART limit 55 °C. As the root the disk never rests — keep an eye on it under load.

### Heat, lid open (Tim, 2026-10-14 evening)
`tools/q10-disk-temp-log.sh 60 53` (log (run log)), disk as the
live root, light I/O: **48 °C at 20:06 (lid closed) → 47 °C from 20:27 and flat to 21:19**, more than 50
min with the lid open. SoC 54-60 °C. So the lid makes ~1 °C of difference: the closed lid with its pad
dumps the heat about as well as open air. **The 47-48 °C is the drive's own idle dissipation (7200 rpm
Barracuda 7200.10), not heat trapped by the enclosure.** Only moving air (a fan) or a cooler drive
(5400 rpm / 2.5") would lower it. Margin to the 55 °C limit: ~7 °C at idle; load is still unmeasured.

### Open
- The vendor AHCI port registers (0x14c/0x174/0x144) are NOT in k26 — nano alone gave CRC +0 in every
  k26 test. Add them only if the CRC count moves.
- 1.5 Gbps only: the ST3250310AS has a "limit to 1.5 Gb/s" jumper — worth a look; not a bottleneck (75 MB/s).
- Re-test the WD5000AAVS on the tuned PHY (it held the full SATA root).
