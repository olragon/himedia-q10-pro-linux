# Q10 Pro: a QEMU harness, and the /dev/null bug that made the second stage a no-op

**Date:** 2026-10-10
**Status:** Complete (the bug), In Progress (the board device tree)

## Goal

Answer two questions in one pass:

1. *"can we build emulator without physical usb flash swap?"* — how much of the bring-up can be
   tested without the box, and precisely which half cannot.
2. *"the clue always at the backup, update images on hand already, do deeply investigate"* — what
   the vendor's own images say that our converted device tree does not.

## What QEMU covers, and what it cannot

`qemu-system-arm` 11.0.2 has `virt`. It has **no** hi3798cv200 machine model — a search of
`-machine help` returns zero matches for `hisi` or `3798`. So the split is hard:

| | covered by QEMU | needs the box |
|---|---|---|
| kernel image boots at all | ✅ | |
| initramfs is populated and unpacks | ✅ | |
| `/init` is found and exec'd | ✅ | |
| `init.c` → busybox handoff | ✅ | |
| `init.sh`, `/dev`, devpts, `httpd` | ✅ | |
| `ip=` / CONFIG_IP_PNP networking | ✅ (QEMU user-net) | |
| **our board device tree** | | ✅ |
| clocks, combphy, SATA, GbE, eMMC | | ✅ |

⭐ **The real prize is not the emulation, it is the console.** The box has no serial attached, and
mainline has no display driver for this SoC, so the bootloader's logo stays frozen and a healthy
kernel looks exactly like a hung one. Our only signal has been ICMP. Under `-nographic` QEMU gives
a PL011 on stdio, so the full kernel log is readable.

⛔ **Boot the bare `zImage`, never the `uImage`.** With `CONFIG_ARM_APPENDED_DTB` the decompressor
*prefers* a device tree glued to the image over whatever the bootloader passes in `r2`. Feeding
QEMU the `uImage` would hand it our HiMedia tree and make the kernel drive hardware that is not
there. The bare `zImage` carries no appended DTB, so QEMU's own tree wins and `-append` is honoured.

`bun run himedia:qemu [--timeout N]` → `scripts/himedia/qemu-smoke.ts`. It forwards guest port 80
to host 18080 and fetches `/info.txt` — the same artifact `watch-boot` pulls off the real box, so
the end-to-end path the box is judged on is exercised here.

## ⛔ The bug: /dev shipped EMPTY, so every redirection failed

The first QEMU run settled it in 215 lines. The kernel was never the problem:

```
[    0.000000] Linux version 6.18.55 … arm-linux-gnueabihf-gcc
[    1.110472] Warning: unable to open an initial console.      ← the answer
[    1.178511] Run /init as init process
```

The initramfs staging directory lives on a Docker bind mount of APFS, which **cannot hold device
nodes**, so `mknod` there fails and `dev/` shipped empty. Then:

- PID 1 had **no stdin, stdout or stderr** — every `printf` in `init.c` went to a closed fd, which
  is why none of its diagnostics were ever seen.
- `init.sh` opened with `mount -t devtmpfs dev /dev 2>/dev/null`. **POSIX: if a redirection fails,
  the command is not executed.** `/dev/null` lives on devtmpfs, so before that mount it does not
  exist, so the redirect fails, so **the mount never ran** — and `/dev` stayed empty forever,
  taking every later `2>/dev/null` line with it.

⇒ **The entire second stage has been a silent no-op for every boot attempt.** Verified
mechanically rather than asserted:

```
$ /bin/sh -c 'echo THE-COMMAND-RAN 2>/definitely/not/here; echo script-continues'
/bin/sh: /definitely/not/here: No such file or directory
script-continues                      ← the echo never ran, the script carried on
```

This matches the observed symptom exactly: the box answers ping (the kernel configures `eth0` from
`ip=` *before* userspace) while no alias ever appears and nothing ever listens. Every round that
read that as "the daemons are broken" was reading a script that had not executed a single line.

### Fixes

- Stage the initramfs on **container-local** storage (`/irfs`), `mknod` `console`/`null`/`zero`/`tty`,
  and assert each is a character device. Also assert `dev/console` reached the cpio — the same
  shape as the existing "a 512-byte cpio is an empty one" guard.
- `init.sh`: mount `/proc`, `/sys` and `/dev` **first, with no redirections at all**.
- `scripts/himedia/initramfs.test.ts` — 7 tests that fail if a redirection reappears above the
  devtmpfs mount, or if the mounts regain one.

## ⛔ The bring-up addresses proved nothing, in two places

A second, independent instance of the same error class — *a check that cannot fail is not a check*:

- `init.sh` raised its "proof" alias as `eth0:0` at **192.168.1.56** — the address the kernel
  already configures from `ip=`, on the alias `init.c` uses. So it could never have proven
  anything, and had it run it would have **deleted** the rung below it.
- `watch-boot.ts` had `const INIT_PROOF = IP; const initRan = true;` — it probed the kernel's own
  address and then hardcoded the answer. It reported init running for several rounds in which
  `init.sh` had not executed a line.

The rungs are now distinct addresses on distinct aliases, one question each:

| rung | raised by | proves |
|---|---|---|
| `.56` | the kernel, `CONFIG_IP_PNP`, pre-userspace | the kernel booted and GbE bound |
| `.57` | `init.c` by ioctl, alias `eth0:0` | our static PID 1 ran |
| `.58` | `init.sh` by busybox ifconfig, alias `eth0:1` | the second stage ran, so `/dev` works |
| `.56:80` | busybox httpd | the whole chain |

## The backups: four core-node divergences from the vendor DTB

Diffing our converted `hi3798cv200.dtsi` against the DTB extracted from the eMMC dump:

```
vendor  arm-timer  compatible = "arm,armv7-timer"
                   interrupts = <1 13 0xf04  1 14 0xf04>
                   clock-frequency = <0x16e3600>        ← 24 MHz, SET
ours    timer      compatible = "arm,armv8-timer"
                   interrupts = GIC_PPI 13/14/11/10, IRQ_TYPE_LEVEL_LOW
                   (no clock-frequency)                 ← MISSING

vendor  GIC        "arm,cortex-a9-gic", reg = <0xf1001000 0x1000  0xf1002000 0x100>, no interrupts
ours    GIC        "arm,gic-400", 4 regions incl GICH/GICV, GIC_PPI 9 maintenance IRQ

vendor  psci mentions: 0            ours: 6
```

⭐ **Leading hypothesis: the missing `clock-frequency`.** Under AArch64 the firmware programs
`CNTFRQ` at EL3, which is why upstream Poplar omits it. We enter in **AArch32 from a 32-bit
U-Boot** that evidently does not, so the kernel has no timekeeping and dies in early init with
nothing to say. Applied, together with removing PSCI (the vendor tree has none, and our AArch32
entry has no PSCI provider either).

⚠️ **QEMU does not test this.** QEMU supplies its own timer node and sets `CNTFRQ` itself, so a
clean QEMU boot says nothing about the hypothesis. It remains live and needs the hardware.

## Measured result

The chain is green end to end in emulation, with no USB swap and no box:

```
ok  /info.txt served, 18642 bytes          ← generated by init.sh, served by busybox httpd
eth0      inet addr:10.0.2.15               ← the kernel, CONFIG_IP_PNP
eth0:0    inet addr:192.168.1.57            ← init.c  ran
eth0:1    inet addr:192.168.1.58            ← init.sh ran
tcp :::23 LISTEN   tcp :::80 LISTEN         ← telnetd (so devpts works) and httpd
```

The "unable to open an initial console" warning is gone. 64 tests pass.

⭐ **And the first run of this harness proved the alias-collision diagnosis by accident.** That
build staged `init.sh` before the ladder fix landed, and its `/info.txt` showed `eth0:0` holding
**.56** with **no .57 anywhere** — init.c's rung deleted by init.sh reusing its alias, exactly as
predicted. A nice demonstration that the harness can see failures, not just successes.

## Reusable lessons

- **A silent fd is worse than a crash.** PID 1 with no `/dev/console` runs, produces nothing, and
  looks like a hang. The kernel says so in one line — `unable to open an initial console` — and
  that line is only visible if something is reading a console.
- **A failed redirection suppresses its command and nothing else.** So one missing file at the top
  of a shell script can turn the whole script into a no-op, with no error anywhere that a reader
  of the symptom would ever see. Same family as *byte count is not a content check*.
- **A bind mount is not a filesystem.** Anything that needs real inode semantics — device nodes,
  xattrs, hard links, suid — has to be staged on container-local storage. `debootstrap` already
  had to move for the `noexec` version of this.
- **A check that cannot fail is not a check** — `initRan = true` and an alias on the address the
  kernel already owns are the same mistake twice, and both reported success for rounds.

ref: (an unpublished note) · `docs/261010-himedia-q10-pro-vendor-dtb.md`
ref: `scripts/himedia/qemu-smoke.ts` · `scripts/himedia/initramfs.test.ts`
