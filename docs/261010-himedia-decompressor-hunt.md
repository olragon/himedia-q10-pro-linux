# Q10 Pro: hunting the decompressor hang offline

**Date:** 2026-10-10
**Status:** In Progress

## Goal

The zImage decompressor runs and the kernel proper (`stext`) is never reached. Find the cause
without the box, and have candidate images built and verified before the next desk session.

## What is already established (measured, not assumed)

- `bootm` **does** jump to `0x2000000` and our code executes — proven by a 44-byte bare-metal
  stub that armed the SP805 watchdog and produced a ~8 s reboot loop.
- The reboot period is a **calibrated telemetry channel**: `cycle = U-Boot (~6 s) + 2 x load`.
- Checkpoint A (decompressor entry, right after it saves the atags/dtb pointer) fires: ~22 s.
- Checkpoint B (`stext`, kernel proper) does **not** fire.
- ⇒ The hang is inside `arch/arm/boot/compressed/head.S`, i.e. **before any device tree or
  timer code can matter.** The `clock-frequency` fix has therefore never been under test. It
  may still be needed; it is not what is biting.

## Approach

1. **Model the decompressor's placement arithmetic offline.** Its overwrite/relocation
   decision is pure computation from the image and the memory layout, so it can be computed
   here from the real numbers rather than guessed at. Deliverable:
   `scripts/himedia/decompressor-model.ts` + tests.
2. **Diff our decompressor against the VENDOR's, which demonstrably works on this hardware.**
   The vendor zImage exposes a magic table (`_magic_sig`/`_magic_start`/`_magic_end`) and its
   own `zreladdr` behaviour. That is a working reference for the same SoC.
3. **Extend the QEMU harness** to cover what it honestly can, and say plainly what it cannot.
4. **Build several single-variable candidate images ahead**, each verified (CRCs, arch,
   appended DTB, checkpoint load values), so a desk session is flash-and-read rather than
   build-and-wait.
5. **Hunt official sources**: HiSilicon Hi3798CV200 documentation, Huawei's HiSTBLinux SDK
   releases, and the 96Boards **Poplar** board documentation — Poplar is the same SoC, so its
   published memory map and U-Boot configuration are directly applicable.

## Files to Change

- `scripts/himedia/decompressor-model.ts` (new) + `.test.ts`
- `scripts/himedia/vendor-zimage.ts` (new) — read the vendor zImage's magic table
- `scripts/himedia/qemu-smoke.ts` — extend
- `scripts/himedia/candidates.ts` (new) — build + verify a set of images
- `docs/261010-himedia-decompressor-hunt.md` (this doc)

## Validation

- `bun test scripts/himedia/` green.
- The model reproduces the vendor image's known-good placement, not only ours — a model that
  cannot explain the working case explains nothing.
- Every candidate image passes: uImage magic, header CRC, data CRC, `arch == 2`, appended DTB
  at the tail with a matching `totalsize`, and its expected checkpoint load values present.

## Notes — findings

### ⭐ 1. Placement is CORRECT, confirmed against the vendor's own 32-bit kernel

`leandrotsampa/hisilicon-kernel` (v4.4.35, vendor-derived, **32-bit ARM**, targets Hi3798Cv200)
is cloned to `~/src/hisilicon-kernel-4.4.35`. Its
`arch/arm/mach-hi3798cv2x/Makefile.boot`:

```
zreladdr-y    := 0x00008000
params_phys-y := 0x00000100
initrd_phys-y := 0x00800000
LOADADDR      := 0x02000000
```

Our `AUTO_ZRELADDR` computes `0x8000` and we load at `0x2000000` — **identical to the vendor**.
Its `arch/arm/boot/dts/hi3798cv200.dts` also carries `arm,armv7-timer` with
`clock-frequency = <24000000>`, which independently confirms the timer fix. Copies of the DT,
the `hi3798cv200_linux_defconfig` and that `Makefile.boot` are in `docs/vendor-arm32/`.

⚠️ **We had been converting the arm64 dtsi by hand while a native arm32 DT for this exact SoC
existed.** Worth diffing against properly rather than continuing to convert.

### ⚠️ 2. The thin decompression margin is a RISK, not the cause

`bun run himedia:decomp` models the decompressor's placement arithmetic:

| | inflated | kernel ends | margin to the running zImage |
|---|---:|---|---:|
| ours | 30.5 MiB | `0x1e7e598` | **1.5 MiB** |
| vendor 3.18 (works) | ~10 MiB | `0xa08000` | 22 MiB |

Check 2 (`r4 + r9 <= &wont_overwrite`) **passes**, so it decompresses in place with no
relocation — and checkpoint D firing on the box confirms exactly that path. The margin only
matters *during* decompression and it is positive, so this is worth removing but is not the
bug. A model that could not explain the working vendor case would not be worth trusting; this
one puts the vendor on the same path with 22 MiB spare.

### ⛔ 3. EFI_STUB is the one unjustified config difference

| option | ours | vendor arm32 (works on this SoC) |
|---|---|---|
| `KERNEL_GZIP` | y | y |
| `ARM_APPENDED_DTB` | y | y |
| `ARM_ATAG_DTB_COMPAT` | y | y |
| `AUTO_ZRELADDR` | y | n (fixed 0x8000 — same result) |
| **`EFI_STUB` / `EFI`** | **y** | **absent** |

`EFI_STUB` replaces the decompressor's 8 leading nops with a PE/COFF `MZ` header: ours begins
`0xe2255a4d`, the vendor's with 8 real `0xe1a00000`. Those nops exist for loaders that jump 32
bytes into the image, and this is a vendor U-Boot of unknown tolerance. Removing it costs
nothing and shrinks the image by 69 KB.

### ⛔ 4. The instrument understated progress — D's budget was too short

The box reported checkpoint **D** (~18-20 s). The stage after D is `decompress_kernel`
inflating **30.5 MB of gzip**, and D armed only a 6 s period (reset at 12 s). So "hung at D"
and "still decompressing at D" produce the IDENTICAL reading.

⇒ `--patient` gives the decompression stage a 60 s budget (A 86 s / C 76 s / D 66 s / E 12 s /
B 8 s cycles). If E then fires, the earlier reading was the instrument, not the bug.

⇒ And the container-side patch step now **strips existing blocks before inserting**, because
`applyTo` is idempotent: without that, a changed timeout is silently ignored and the box
reports the OLD period — a reading that looks valid and means something else.

### 5. Official sources

- Upstream support for hi3798cv200 is **arm64 only** (96Boards Poplar). Poplar's flow is
  `bootrom → l-loader → ATF BL31 → U-Boot`, and **l-loader switches to AArch64** — our box's
  `fastboot` is a 32-bit U-Boot that never makes that switch, which is why AArch32 is forced.
- `ARM: hisi: Support Hi3798 SoC` exists for 32-bit ARM but targets the older Cortex-A9/A7
  Hi3798 parts, not CV200. So **mainline AArch32 on CV200 has no upstream precedent** — though
  vendor AArch32 clearly works, since that is what the box ships.
- Poplar docs note *"U-Boot needs to be aware of the BL31 runtime location to avoid writing
  over it."* That reframes `mem=1993M`: the 55 MiB above it is exactly where `bootcmd` puts
  TrustedCore (`0x7E700000` = 2023 MiB). It is a **secure-world reservation**, not a media
  zone. We already pass it, and our kernel ends at 30.5 MiB, nowhere near.

### Candidate images built ahead

`bun run himedia:candidates --list`. Each is one variable, each verified (magic, both CRCs,
arch, and the checkpoint load values).

ref: `docs/vendor-arm32/` · `~/src/hisilicon-kernel-4.4.35`
