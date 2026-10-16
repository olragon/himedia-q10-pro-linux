# Q10 Pro: switch the root disk from the Seagate back to the original WD

**Date:** 2026-10-14 · **Status:** Complete 2026-10-15 08:45 — the box runs from the WD
**Why:** Tim: "plan for me to switch to original hdd, don't like heat up disk". The Seagate ST3250310AS
(7200 rpm) idles at 47-48 °C in the box, lid open or closed (docs/261014-himedia-sata-kernel-vs-board.md
§Heat). SMART limit 55 °C.

## The two disks
| | Seagate ST3250310AS <disk-serial> (now) | WD WD5000AAVS-00G9B0 (original) |
|---|---|---|
| Spin | 7200 rpm | GreenPower, ~5400 rpm class |
| Idle power | ~8-9 W (from memory of datasheets, not measured) | ~4 W (from memory, not measured) |
| Temp in this box | 47-48 °C idle, measured | **never measured** |
| Link here | 1.5 Gb/s only (disk's own setting) | 3.0 Gb/s, every archived boot clean |
| Size | 250 GB | 500 GB |
| Content | live k26 root, 7.3 G (Android 2.2 G) | old ext4 `q10root` from 2026-10-11 (k14/k25 era root) |

## ⛔ The trap: both disks carry LABEL=q10root
init.sh (`try_sata_root`) mounts `findfs LABEL=q10root`. If the WD goes in while
`/mnt/stick/q10-root-sata-chained` exists, k26 boots the WD's **stale** root: old units (possibly the
old userspace PHY tuner, the one that aborted the ext4 journal) and maybe no k26 modules. So the
opt-in marker is switched off BEFORE the swap and back on only after the WD holds a fresh root.

## Steps
A. Me, no physical action
  1. Back up the Seagate root to `$HIMEDIA_ROOT/backups/q10-seagate-root-20261014` (~7.3 G, rsync over ssh).
  2. `/mnt/stick/q10-root-sata-chained` → `.off`; reboot; verify k26 on the stick root (`/dev/loop0`).
  3. Spin the Seagate down and detach it (`hdparm -y`, `device/delete`). Tell Tim: ready.
B. Tim: pull the plug, swap Seagate → WD (same new cable, lid pad on the WD), plug in. Keep the Seagate
   on the shelf untouched: it is the rollback.
C. Me, read-only on the WD
  1. SMART: hours, realloc, pending, CRC, temp. Gate: PASSED, 0 realloc/pending.
  2. `tools/q10-sata-phy-probe.sh` (idle PxSERR) + `tools/q10-sata-read-check.sh 2048`.
     Gate: 3.0 Gb/s, CRC +0, 0 exceptions.
  3. Mount the old fs `ro,noload` (no journal replay), list it, back it up to
     `$HIMEDIA_ROOT/backups/q10-wd-root-20261011` — the 2026-10-11 notes call it the only copy of the
     k25-era root.
D. Me: `tools/q10-disk-heat-test.sh 30`, lid closed. Gate: clearly cooler than the Seagate (≤ 44 °C at
   30 min). If it is not, stop and tell Tim — the swap buys nothing.
E. Tim approves the wipe (destructive). Me: wipe the WD, ext4 `q10root`, fill it from the step-A Seagate
   backup (today's state), not from the older stick root. Tool: `tools/q10-sata-root-restore.sh <disk-serial>
   $HIMEDIA_ROOT/backups/q10-seagate-root-20261014.tar.zst`.
F. Me: `.off` → `q10-root-sata-chained`; `tools/q10-sata-root-soak.sh 3`; temp log 1 h idle, then a
   Kodi session. Gate: 0 exceptions, 0 resets, CRC unchanged, temp below the Seagate's.

## Progress
- **A1 21:29** `tools/q10-root-backup.sh q10-seagate-root-20261014 /` →
  `$HIMEDIA_ROOT/backups/q10-seagate-root-20261014.tar.zst`, 3.7 G, 62,060 entries, 9.94 GB of files
  (Android 2.36 GB). Box tar exit 1 = files changed on the live root (expected); sockets skipped.
- **A2 21:30** marker → `/mnt/stick/q10-root-sata-chained.off`; reboot → k26 chained, root `/dev/loop0`,
  ssh at +164 s, `running`.
- **A3 21:33** `tools/q10-sata-detach.sh`: driver loaded on k26 (nano 0x4, 1.5 Gb/s, 0 exceptions/resets),
  Seagate to standby, device deleted. Safe to pull the plug.
- **B 22:05** Tim swapped the disks; cold boot to the stick root, ssh at +88 s.
- **C1 22:08** WD SMART: PASSED, serial <disk-serial>, 22,438 h, 0 realloc / 0 pending / 0 offline-unc,
  CRC 0, 6,393 start/stops, 28 °C cold. Link **3.0 Gb/s** (SStatus 123), k26 nano 0x4.
  Old fs: ext4 `q10root` UUID a54ae156…, state clean, last write 2026-10-12 19:42.
- **C2 22:08** `tools/q10-sata-read-check.sh 2048`: 3.0 Gb/s, UDMA/133, 63.3 MB/s, CRC +0, 0 exceptions,
  0 resets (the Seagate never managed 3.0 Gb/s here; its own setting is 1.5).
- **C3 22:22** `tools/q10-sata-ro-mount.sh mount` (ro,noload — no journal replay) +
  `tools/q10-root-backup.sh q10-wd-root-20261012 /mnt/sata-ro` →
  `$HIMEDIA_ROOT/backups/q10-wd-root-20261012.tar.zst`, 3.5 G, 210,143 entries, tar exit 0. Unmounted,
  standby, detached.
- Found on the cold boot, not caused by the swap: `q10-wifi` gave up 0.5 s before wlan0 appeared
  (firmware load ~10.5 s) — wait raised 10 → 30 s, deployed to the stick root; `q10-music-import`
  fails on the stick root (`/var/lib/q10/music/import.lock: Permission denied`) — filed.
- **D 22:24-22:54** `tools/q10-disk-heat-test.sh 30 50`, idle spinning, no I/O: **35 → 36 °C, flat**
  (the disk was already warm from ~15 min of backup reads). SoC 51 °C (57-60 °C with the Seagate).
  Seagate, same test: 35 → 47 °C and still rising. **The WD runs ~11 °C cooler; it also warms the SoC
  less.** 0 exceptions. Gate (≤ 44 °C) passed.
- **E 08:31-08:35 (2026-10-15, Tim approved)** `tools/q10-sata-root-restore.sh <disk-serial>
  …/q10-seagate-root-20261014.tar.zst`: new ext4 `q10root` UUID 78e61914-290e-406c-84a8-18d3d47366d1,
  restored in 3 min 20 s. Name-by-name diff, archive (GNU tar on the box: 64,146) vs disk: identical
  except `lost+found`. Link during wipe+restore: CRC +0, 0 exceptions, 0 resets. ⚠️ The first try was
  refused by the serial guard: `lsblk` SERIAL is empty after a SCSI rescan (udev db not filled) — the
  script reads the serial with `smartctl -i` now. ⚠️ The Mac's bsdtar `tar -tf` undercounts these GNU
  archives (62,060 vs 64,146); count on the box when the number matters.
- **F 08:37-08:45** marker back on; `tools/q10-sata-root-soak.sh 3`: **3/3 boots on /dev/sdb1 (WD), 3.0
  Gb/s, 0 exceptions, 0 hard resets, CRC 0, disk 35-36 °C**, ssh at 117-174 s. System `running`, no
  failed units, Android data 2.2 G, 444 G free. wifi-up fix deployed to the WD root too.
- Still open: temperature during a Kodi session (load).

## Rollback
Any step: marker `.off` (stick root always boots). To get today's system back exactly: swap the
Seagate back in and rename the marker back.

## Notes
- No reboot without the watchdog armed (shutdown hook does it). Hold-to-off on the power key does not
  work on k26 (TODO), so the plug pull in B is the power-off; the SATA disk is already detached then.
