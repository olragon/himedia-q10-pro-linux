# Q10: SATA link down since stock Android booted — investigation

**Date:** 2026-10-12
**Status:** In Progress

## Goal
SATA worked this morning (k25 booted from the SATA root). Since the stick was pulled and stock Android 7
booted once, every probe reports `ata1: SATA link down (SStatus 0)` — under stock Android, k14 and after
re-probes — with two different disks and a reseated cable. Tim: power and cable are fine; only
firmware/OS changed. Find what changed and fix it.

## Approach
1. Diff this boot against an archived good boot (dmesg lines for ata/ahci/combphy/clk).
2. What did stock Android write? U-Boot env (bootargs partition) vs our patched image; other partitions.
3. Every register in the SATA path (CRG SATA clocks/resets, PERI_CTRL, combphy, AHCI port regs) vs a good dump.
4. Fix: restore the changed state (env / register / init order), verify `SATA link up`.

## Validation
`ata1: SATA link up` + the disk visible in lsblk; the box boots from the SATA root again (k25 chain).

## Notes
### Findings (2026-10-12 22:30-23:00)
- Same driver path as good boots; only the link differs: `SStatus 0` = PHY sees nothing (no COMINIT).
- Good-boot SATA logs this week are all after a **vendor kernel ran** (stock Android 10-11; stock-kexec
  tests 08:00-08:33 today) with only **warm** resets since. The disk/cable swap needed a full power cut.
- Old disk ran hot and stock Android showed `hard resetting link` with it → likely a second, separate
  fault (failing drive). Keep it out.
- Vendor stock 3.18 has a SATA PHY driver mainline lacks: `hiahci-phy` (DT `reg = <0xf9900000 0x1000
  0xf8a20000 0x3000>`, AHCI = `generic-ahci`). Decoded (capstone, `dis-hiahci-*.s` in
  $HIMEDIA_ROOT/stock-android-kexec/):
  - clk prepare: CRG98[15:8] = 0xd00 (ours matches)
  - phy_init: mode check PERI+8[12:11]=SATA; nano[1]=4 (mainline writes 1=8, c=9, 1a=4 — Poplar PCIe
    tuning); CRG42 = 0xf (whole word); AHCI+0x148 &= ~0x100; +0x14c = (v&~0x1ff)|0x52; again 0x148;
    +0x14c = (v&~0x3fe00)|0x8000; +0x174 = 0x0e400000; +0x144 |= 0x680000; PxCMD = 0x600000 → 0x600002;
    msleep 100; if PxSSTS.IPM==0 nano[0x19]=2, then 3.
  - phy_power_on: PERI+8 |= 0x400 (**never set by mainline**: PERI+8 was 0x1063).
  - nano write helper: PERI+0x858 addr<<12 | data<<20, pulse bit 24. Read-back appears in 0x85c[11:8]
    but does not match written values — not trusted.
- Applying all of it live (after ahci probe) and in vendor order with ahci unloaded
  (`tools/q10-sata-vendor-bringup.sh`, watchdog-guarded): still DET=0. ⇒ more vendor state is involved
  (other drivers / boot firmware) — next: dump a WORKING stock-Android SATA state and diff.
- Tools: `tools/q10-sata-phy-init.sh`, `tools/q10-sata-vendor-bringup.sh`, dump windows `sata_ahci`,
  `peri_combphy`, `peri_hi` in `android-reg-dump.sh`.
### Decisive test (2026-10-12 22:54): stock Android, new disk, stick out
- Stock HMD-2.1.7 kernel log: `ata1: SATA link down (SStatus 0 SControl 300)` — the FACTORY firmware
  cannot see the disk either.
- Vendor register state read with `himd.l` (adb root): AHCI+0x144 `1f6c9f24`, +0x14c `00008052`,
  +0x174 `0e400000`, CRG42 `0xf`, CRG98 `0xd09`, PERI+8 `0x1462` (PHY power bit 10 ON), combphy CFG
  `0x00319000`, PxSSTS `0` — identical to what `q10-sata-phy-init.sh` / `q10-sata-vendor-bringup.sh`
  programmed on Linux (the replay was correct).
- ⇒ Not an OS/firmware-state problem: two disks, two OSes incl. the factory one, full factory PHY init,
  zero PHY presence. Fault is physical: box SATA connector/PHY or the data cable. Physical events that
  fit: the old disk ran hot; a disk was connected live.
- Next: test disk+cable on another machine / USB-SATA adapter. Workaround if the port is dead: disk in a
  USB 3 SATA dock on the side USB 3 port (SuperSpeed 91.7 MB/s measured on k25).
- Kept for when the port works: the vendor PHY init (incl. PERI+8 bit 10) belongs in our kernel so SATA
  survives a power cut without a vendor kernel having run first — not yet proven necessary, since k14/k15
  linked SATA in earlier boots; verify after a power cut once hardware is fixed.
### Resolution so far (2026-10-12 23:10-23:40) — PHYSICAL, marginal link; corrections
- ⛔ Correction: "physical PORT fault" (22:54) was too strong, and the earlier "vendor state needed"
  theory is refuted. After Tim re-seated the connector with the cover off and no strain on the disk,
  the link came up on k14 with every vendor tuning register at its DEFAULT (0x144 1F049F24, 0x14c 92,
  0x174 0E240000; PERI+8 bit 10 clear). Stock Android's own link-down was the same bad connection.
- But the link is MARGINAL: trained at 1.5 Gbps after a failed first reset; under mkfs load 18
  exceptions, 20 hard resets, UDMA mode dropped to UDMA/33, UDMA_CRC_Error_Count 17 → 26, ~0.2 MB/s.
  Disk itself healthy (Seagate ST3250310AS, SMART PASSED, 37-41 °C, 0 realloc/pending).
- Tim: stop using the bad link (risk to the disk); a new SATA cable is ordered; "only use the stick".
  Done: mkfs stopped (disk has a fresh GPT + sdb1 'q10new', NO filesystem — redo with the new cable),
  disk spun down and detached, q10-sata + q10-sata-hotplug disabled, stick initramfs SATA-root opt-in
  moved to /mnt/stick/q10-root-sata.off (restore by renaming back).
- With the new cable: re-test the link with `tools/q10-sata-link-test.sh` (CRC delta must be 0, 3.0 Gbps,
  UDMA/133) BEFORE mkfs; then also re-test the OLD WD disk (WD5000AAVS) — it held the only copy of the
  full SATA root (k25 chain, sessions, Kodi, Android 13) and probably failed for the same physical reason.
- The vendor PHY tuning (`tools/q10-sata-phy-init.sh`) was applied but never measured (Tim stopped the
  test, rightly): it may still improve margin — measure only on a good cable.
### New cable, 2026-10-14 14:37 — STILL MARGINAL (read-only test)
- Tim replaced the SATA data cable; k25 booted from the stick. `scripts/himedia/tools/q10-sata-read-check.sh 2048`
  (guarded driver load + 2 GB raw O_DIRECT read, nothing written): link **1.5 Gbps** (SStatus 113), first
  configured UDMA/133, then **CRC +6 (26 → 32), 6 exceptions, 6 hard resets**, libata dropped to **UDMA/100**;
  72.6 MB/s. Disk: Seagate ST3250310AS <disk-serial>, SMART PASSED, 0 realloc/pending, 33 °C, 34,209 h.
- ⇒ The cable was not the (only) fault. Left: box connector/PHY margin, the disk's own port, or PHY TX
  tuning (vendor 0x174 = 0x0e400000 vs default 0x0e240000 — still never measured on a fixed cable).
- Disk spun down (hdparm -y) and detached; q10-sata + hotplug stay disabled; SATA root stays .off.
  Log: (run log). Android stays halted (its condition was "SATA cable works").
