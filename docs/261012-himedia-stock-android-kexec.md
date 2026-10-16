# HiMedia Q10 Pro: boot the STOCK Android 7 by `kexec` from mainline Linux

Status 2026-10-12: kit built and unit-tested on the Mac. **Nothing has been run against the box.**

## Decision

**Worth one test run. It will probably get through the kernel handoff and early boot; whether
Android then comes all the way up is unknown, and the unknown is hardware state, not the handoff.**

| Stage | Verdict | Basis |
| --- | --- | --- |
| zImage entry + decompress under kexec | likely works | READ: fixed `zreladdr=0x8000`, relocation path is the standard one, same recipe as the proven mainline kexec |
| DTB accepted, memory/cmdline/initrd correct | likely works | READ in the vendor kernel disassembly (below) and in kexec-tools source |
| Display config (`pdm_tag`) | **degrades to defaults** | READ: no ATAG path under kexec, kernel falls back to default baseparam |
| Secondary CPUs | may come up as 1 CPU | INFERRED from `hi3798cv2x_boot_secondary`, not run |
| Vendor drivers on hardware that mainline already initialised (eMMC, GMAC, xHCI, SATA, VDP, GPU) | **unknown, the real risk** | cannot be settled offline |

A failure costs one watchdog cycle (default 2 x 178 s): U-Boot then boots the stick Linux again.
`--no-watchdog` removes that net, so it is for a build already known to boot.

⛔ Booting Android makes it write the eMMC (userdata, cache) in the normal way. That is its stock
behaviour; the kit itself writes nothing to eMMC or to the stick.

## What is in the kit

`bun run himedia:stock-boot` -> `$HIMEDIA_ROOT/stock-android-kexec/`

| File | bytes | sha256 |
| --- | ---: | --- |
| `zImage` (uImage header and appended DTB stripped) | 9,105,440 | `858212327e181f5311acc3133e2d31ac3bdba792ba10997083e4f83ecd6726ab` |
| `stock.dtb` (byte-exact vendor DTB) | 13,027 | `207f65eb5005452b2a086faa75e76ad90a18482a35ccecdd16d62c516cbb9745` |
| `stock-android.dtb` (stock + `/memory` + `/chosen/bootargs`) | 13,524 | `9a04163cb317c309de73f413cce5b39e3666df67172ea05379387af8f021369b` |
| `ramdisk.gz` | 1,314,137 | `dbbde1726d185544690645776197770d43b3abe7eac8092ca23bfdfee7077616` |
| `cmdline.txt` | 404 | `d37c7f6a2b2f1ec5a8c1633b7d83794565b10b5824a6111319833f48840a7983` |
| `vmlinux.bin` (inflated Image, local analysis only, not shipped) | 21,084,828 | `e9139f56ca406d2502c11a4ebf40005b9810f74a7280d7dfd9b7944b2c2c5c5c` |

Source `kernel.img`: 41,943,040 B, sha256 `e30f8545...6276d0`. Both uImage CRCs verify
(`0xf85638a7` header, `0x471c1757` data). Also written: `manifest.json`, `SHA256SUMS`.

## Commands

```
bun run himedia:stock-boot                                   # build + verify the kit (Mac, read-only)
bun test scripts/himedia/android/extract-stock-boot.test.ts scripts/himedia/android/stock-android-kexec.test.ts   # 23 pass
scripts/himedia/android/stock-android-try.sh [watchdog-s]    # Mac: copy, dry-run, run, poll, collect
# on the box (installed by the runner as /usr/local/sbin/q10-stock-android):
q10-stock-android --atags-only        # READ-ONLY: do U-Boot's ATAGs survive at 0x100? logs pdm_tag
q10-stock-android --dry-run           # kexec -l, print kexec_loaded, kexec -u. No RAM write, no reboot.
q10-stock-android                     # watchdog 178 s armed (test run)
q10-stock-android --no-watchdog       # normal use
```

**Run `--atags-only` first.** It costs nothing and answers the one question this analysis cannot.

## The stock zImage

- `kernel.img` = ADVCA header (0x2000) -> `ANDROID!` (page 16 KiB; kernel_addr `0x3008000`,
  ramdisk_addr `0x4000000`, tags_addr `0x3000100`, empty cmdline) -> uImage (`Linux-3.18.24_hi3798cv2x`,
  load = entry = `0x02000000`, no compression) -> zImage + appended DTB at `_edata` (`0x8af020`).
- **Appended-DTB support is compiled in, and the appended DTB wins.** READ in the stub: literal
  `0xedfe0dd0` at 0x924; at 0x100-0x110 `ldr lr,[r6]; cmp lr,r1; ... mov r8,r6` replaces the
  bootloader's r2 with the appended blob. So the extractor **strips** it. kexec-tools makes
  `kernel_mem_size = len + 4` (`kexec-zImage-arm.c`), so the stub sees zeros after `_edata`, skips
  the append branch, and passes our `--dtb` through in r2.
- **`zreladdr` is FIXED at 0x8000**, not `AUTO_ZRELADDR`: `ldr r4,[pc,#0x878]` at 0xa0, literal
  `0x8000` at 0x920, and no `and rX,rX,#0xf8000000` anywhere. The Android header's `0x3008000` is
  not what the decompressor uses.
- No `ZIMAGE_TAG_KRNL_SIZE` extension (3.18 predates it) -> kexec-tools falls back to
  `image_size = 5 x len`. The decompressed Image is 21,084,828 B; kexec loads the zImage at
  `0x8000` too, so check 1 and check 2 of the decompressor fail and it relocates itself above the
  inflated kernel (~`0x1423a9c`); the relocated copy ends near `0x1ce0000`. `--image-size=0x6000000`
  (96 MiB) puts initrd and DTB far clear of that and of the kernel BSS. Same value as `kexec-try.sh`.

## DTB: what to pass, and why it is not the stock DTB

`stock.dtb`: root `compatible = "hi3798cv200-series"`, `#address-cells = <1>`, 4 x cortex-a53,
`arm-timer` with `clock-frequency = <24 MHz>`, **no `/memory`, no `/chosen`, no `/reserved-memory`,
no `cpus enable-method`**. U-Boot does not patch it. Memory, cmdline, initrd and PDM data reach the
stock kernel only as ATAGs.

Vendor kernel, READ in the disassembly of `vmlinux.bin` (`scripts/himedia/android/stock-dis.py`):

- `setup_machine_fdt` -> `early_init_dt_verify` -> **`fdt_init_hisi(fdt)`**. It `fdt_open_into`s the
  DTB into a **32 KiB static buffer** (so nothing is written after the DTB in RAM) and prints
  `fdt size too big` + `dump_stack` if the input is **>= 16384 B**. Ours: 13,524 B before kexec,
  about 13.7 KB after. The extractor refuses above 16384 - 512.
- It then calls **`deal_atags(0x100)`**: the ATAG list is read from **fixed physical 0x100**
  (`phys_to_virt(0x100)`), **not from r2**. It returns without merging unless word[1] is
  `ATAG_CORE (0x54410001)`. With a valid list: `ATAG_CMDLINE` -> `/chosen/bootargs`
  (then `parse_nodev_bootargs`, `parse_initmrd_bootargs`), `ATAG_MEM` -> `/memory/reg`,
  `ATAG_INITRD2` -> `linux,initrd-start/end`, any other tag -> `parse_tags_hisi` (table of
  handlers; `parse_param` stores a <= 2 KiB `key=value` buffer). At the end: `initmrd_reserve_memory`,
  `pdm_reserve_mem`, `pcie_reserve_memory`.

**Decision: pass `stock-android.dtb` = `stock.dtb` + `/memory reg=<0 0x7c900000>` + `/chosen/bootargs`.**
kexec-tools does not add a memory node (READ: `kexec-zImage-arm.c` only sets `bootargs` via
`setup_dtb_prop`, creating `/chosen` if absent, and `linux,initrd-start/end`), and without
`/memory` the vendor kernel would have nothing: stock got it from ATAGs. `--command-line` and
`--initrd` then do the `/chosen` fixups; the pre-filled bootargs are identical, so it is a no-op there.
`mem=1993M` on the cmdline overrides the DT range anyway, which keeps `mmz` and the TEE (`0x7e700000`)
outside Linux exactly as stock does.

⛔ **Stale ATAGs would override all of this.** If U-Boot's list survived at 0x100 in our Linux's
RAM, `deal_atags` would replace `/chosen/bootargs` with U-Boot's, which carries
`initrd=0x4000000,0x140D59` (the `initrd=` early param beats the DT initrd), pointing at memory
that no longer holds the ramdisk. `q10-stock-android` decodes the block, and by default zeroes the
16-byte first-tag header **only if a valid list is there** (that proves Linux is not using the
page, so the write is safe); with no list it writes nothing. `--atags keep` leaves it.

## Command line

Chosen (`cmdline.txt`, 404 B) = the stock `/proc/cmdline` captured over adb on 2026-10-10 **minus
`initrd=0x4000000,0x140D59`**:

```
androidboot.selinux=disabled console=ttyAMA0,115200 blkdevparts=mmcblk0:1M(fastboot),...,-(userdata)
hbcomp=/dev/block/mmcblk0p14 mem=1993M mmz=ddr,0,0,56M vmalloc=600M HM3=2003
```

Provenance, checked by the extractor against `bootargs.img`: the env `bootargs` and `bootargs_2G`
are both wholly present; U-Boot adds exactly two tokens at run time, `initrd=...` and `HM3=2003`.
`HM3=2003` is carried because it is unexplained, not because it is understood.
`initrd=` is dropped because kexec places the ramdisk itself; there is a way to keep it
(set `--image-size` so the initrd lands exactly on 0x4000000) and it matters only for
`--atags keep`; not implemented. No `earlyprintk`/`loglevel` added: the vendor cmdline is the
control, and the console is the UART we do not have.

Parsed from the cmdline: `androidboot.*` (Android init), `console`, `blkdevparts`, `hbcomp`, `mem`,
`mmz`, `vmalloc`, `HM3`. Parsed from tags only: **`pdm_tag`**, delivered through the HiSilicon
`param` ATAG.

## `pdm_tag`: what is lost

READ: `PDM_GetTagBuf` and `pdm_reserve_mem` call `get_param_data("pdm_tag", buf, 512)`. The value is
a list of `name=0xPHYS,0xLEN[,nosnapshot]` items; each page-aligned item gets an
`fdt_add_mem_rsv` and `HI_DRV_PDM_Init` consumes the table. With no tag: `get_param_data` returns
<= 0, `pdm_reserve_mem` returns silently and the table stays empty; the strings
`ERR: HI_DB_GetDBFromMem, use default baseparam!` show the fallback. **Expect default display
mode/logo/baseparam, not a hang.** `pdm: Invalid PDM tag, errno:%d` is `KERN_ERR` and non-fatal.

Whether the buffers U-Boot loaded (baseparam, logo, fastplay) are still intact is **unknown**:
`mem=1993M` keeps our Linux out of the top 55 MiB, but we cannot tell what lives where without the
tag's contents. `--atags-only` is how to find out; the raw block is saved to
`/var/log/q10/stock-android-atags-*.bin`.

## Risks, ranked

1. **Hardware left initialised by mainline** (eMMC/SD `himci`, GMAC, xHCI/EHCI/OHCI, SATA, VDP, Mali).
   The vendor drivers assume U-Boot's reset-like state. Unknown; the main reason this is a test.
2. **Secondary CPUs.** Vendor `hi3798cv2x_boot_secondary` writes an SCU boot address, calls
   `slave_cores_power_up`, releases a pen and sends an IPI; mainline's `cpu_die` may leave cores
   in a state that never answers. Failure mode: `CPU1: failed to come online`, single-CPU Android.
3. **The watchdog.** Nothing known pets the SP805 in stock Android. Armed, Android is reset at
   ~2 x period. Unarmed, a hung vendor kernel needs a power cycle. The runner always arms.
4. **ATAG residue** (above). Handled by `--atags zero`; `--atags-only` shows which case we are in.
5. **Unclean stop of Android** by the watchdog reset: ext4 journals recover, but it is a hard reset
   of a system writing userdata.
6. **Machine-readable proof is thin on the Mac side:** from tmux, macOS denies Local Network
   silently. The runner probes through a LAN host (`$PROBE_VIA`), counting only `REACHABLE`/`DELAY`
   neighbours with the box MAC at an address other than `.56`. A "nothing answered" verdict is not
   proof Android did not boot.
7. kexec-tools source was read from git master, not the box's Debian version. `--dtb`, `--initrd`,
   `--command-line` and `--image-size` are already used by the working recipe, so the dependency
   is not new; `--dry-run` proves this exact kit loads.

## Not known

- Contents of U-Boot's ATAG block (`pdm_tag`, `HM3`, memory tag) at the moment of boot.
- Whether page 0 of RAM survived our Linux.
- Whether stock Android pets or disables the SP805.
- Whether the vendor `pstore`/ramoops path exists (no ramoops here: a failed run leaves our Linux's
  own log only; the vendor kernel has no console we can read).

## Files

- `scripts/himedia/android/extract-stock-boot.ts` (+ `.test.ts`, 18 tests, 5 mutations caught, 1 survived and was closed with a test)
- `scripts/himedia/android/stock-android-kexec.sh` (+ `stock-android-kexec.test.ts`, the ATAG decoder, 1 mutation caught)
- `scripts/himedia/android/stock-android-try.sh`
- `scripts/himedia/android/stock-dis.py`: annotated disassembler for `vmlinux.bin` (uses `stock-kallsyms.py`)
- `package.json`: `himedia:stock-boot`
- kexec-tools files fetched to `~/src/kexec-tools-src/`

## Results on the box (2026-10-12)

| run | kexec from | Android seen | picture | back in Linux |
| --- | --- | --- | --- | --- |
| 1 | k16 (VDP driver loaded) | box MAC at **.200 after 22 s** | **vertical-stripe noise** (Tim's photo) | after 211 s (watchdog) |
| 2 | k14 (simpledrm only) | nothing before the reset | not seen | after 211 s |
| 3 | k18, `histb_vdp` unloaded | only .57 (one of OUR addresses, likely stale ARP) | not seen | after 237 s |

`--dry-run` and `--atags-only` are clean on every kernel (no ATAG list at 0x100). The reset arrives
~178 s in — the first SP805 expiry, not the second — so something in the vendor kernel changes the
watchdog's behaviour. ⇒ Menu entry is **opt-in** (`/etc/q10/stock-android.enable`). Next, with Tim at
the TV: watch run 1's conditions to the end; give the vendor kernel the boot-logo VDP state it expects
(the U-Boot register set is in (an unpublished note) §HDMI); find a log channel
(the vendor kernel's log buffer is overwritten by the next boot).
