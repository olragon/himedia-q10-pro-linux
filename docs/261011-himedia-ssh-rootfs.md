# HiMedia Q10 Pro — from initramfs telnet to SSH on a Debian armhf root

**Date:** 2026-10-11
**Status:** In Progress

## Goal
`ssh root@q10.local` lands in Debian trixie (armhf) running on mainline 6.18.55, booted
from the USB stick, with no eMMC writes.

## Approach
1. **phy-mode** — measured live (q10-mii + router pings, below): `rgmii-id`. Drop the sweep.
2. **Root on the stick without repartitioning it** — the stick must stay FAT32 because the
   stock U-Boot loads `uImage` from it. The root is an ext4 *image file* `rootfs.img` on that
   FAT32; init.sh mounts sda1, loop-mounts the image and `switch_root`s into systemd.
3. **Fallback kept** — no `rootfs.img`, or any mount step fails, and init.sh carries on exactly
   as today: initramfs shell, telnetd, diag, RAM log.
4. **Watchdog as a safety net, not a ladder** — PID 1 re-arms the SP805 with a long period just
   before `switch_root`; a systemd unit in the rootfs disarms it once sshd is up. A hung
   userspace still resets into Android, where the RAM log (journald forwards to kmsg) is read.
5. **rootfs builder** — `himedia:rootfs --arch armhf` debootstraps inside an arm/v7 container
   (Apple silicon has no AArch32, so this one is emulated) and emits `rootfs.img`.

## Files to Change
- `scripts/himedia/kernel/arm32/hi3798cv200-himedia-q10-pro.dts` — phy-mode
- `scripts/himedia/kernel/arm32/initramfs/init.c` — drop rgmii_sweep
- `scripts/himedia/kernel/arm32/initramfs/init.sh` — rootfs switch
- `scripts/himedia/build-kernel-arm32.ts` — loop/namespaces config
- `scripts/himedia/build-rootfs.ts` — armhf + ext4 image + watchdog-off unit
- `scripts/himedia/tools/{q10-mii.c,phy-tx-test.sh}` — live PHY tooling

## Validation
- `bun test scripts/himedia` green.
- Box: `ssh root@q10.local 'uname -a; cat /etc/os-release; findmnt /'` shows 6.18.55,
  Debian trixie armhf, root on `/dev/loop0`.
- Watchdog reads disabled after boot (`0xf8a2c008` = 0) and the box stays up > 10 min.

## Notes
### phy-mode, measured live 2026-10-11 (no reboot)
| setting | ext 0xa4/0x1c | router pings |
| --- | --- | --- |
| straps | 0x8575 | 10/10 |
| bit 11 only (mainline "RX") | 0xad75 | 0/10 |
| bit 12 only (mainline "TX") | 0xb575 | 0/10 |
| both (mainline `rgmii-id`) | 0xbd75 | 10/10 |
| off (mainline `rgmii`) | 0xa575 | 0/10 |

The straps already select both delays. Receive alone worked under bit 11 (the boot sweep saw
bytes arrive), but only both delays carry a round trip — a receive counter cannot see TX.

### QEMU end-to-end, 2026-10-11 — PASS
`bun run himedia:qemu --stick <rootfs.img>`: partitioned FAT32 stick image with rootfs.img,
usb-storage behind qemu-xhci. A real `ssh root@` login answered:
`Linux q10 6.18.55 armv7l` · root `/dev/loop0 ext4` · `Debian GNU/Linux 13 (trixie)` · `armhf`.
init.sh switched at 4 s, ssh.service up at 22 s (emulated).

Four harness/build bugs found on the way, each of which read as "QEMU is slow":
1. A build without `--checkpoints` left `CONFIG_DEBUG_LL` aimed at the SP805 (persistent .config).
2. ...and left the checkpoint stores in the kernel SOURCE (the tree persists between builds).
3. Restoring pristine sources with `tar` kept the tarball's OLD mtime, so make kept the
   checkpointed objects — QEMU `-d int` showed a data abort at `0xf8a2cc00` (WdogLock).
4. `virt` puts PCIe ECAM above 4 GiB; a non-LPAE kernel fails it (-75) → no xHCI, no stick.
   `-M virt,highmem=off`.
Plus PID 1 now writes the SP805 only when the DT compatible is `himedia,q10-pro`.

Box image: `uImage-noefi-root2` sha `15eecdb2fde32a9d` (checkpoints on, rgmii-id, dma 2 GiB).
