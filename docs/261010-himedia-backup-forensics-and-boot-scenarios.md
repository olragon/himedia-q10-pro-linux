# Q10 Pro: what the backup proves, and every boot scenario simulated offline

**Date:** 2026-10-10
**Status:** Complete (analysis) — the timer hypothesis is now evidence-backed, not a guess

Deep read of the eMMC backup and the firmware packages already on disk, plus an offline
simulation of the box's boot decision tree. Everything here was measured from bytes we already
hold. No hardware was touched.

## 1. ⭐ The timer hypothesis is now proven as far as it can be without the box

The question that decides whether our AArch32 device tree needs `clock-frequency` on the timer
node: **does anything in the stock boot chain program `CNTFRQ`?** Under AArch64 the firmware does
it at EL3, which is exactly why upstream Poplar omits the property. We enter from a 32-bit U-Boot.

`bun run himedia:cp15 <binary>` decodes every CP15 (system coprocessor) access in an ARM image:

| image | plaintext? | CP15 encodings | **CNTFRQ writes** |
|---|---|---:|---:|
| `fastboot.img` (U-Boot, 1 MiB) | yes — entropy 5.08, 47% zeros, strings `bootm 0x%x` | many | **0** |
| `trustedcore.img` (TEE/BL31, 40 MiB) | yes — `map_secure_page_table`, `SRE_SecureTimerEnable` | 4,336 | **0** |
| `recovery.img` | **no** — entropy 8.00, ADVCA-encrypted | n/a | unscannable |
| our `vmlinux` (positive control) | yes | many | **4** |

⇒ **Neither the stock loader nor the TEE can set the generic timer frequency.** A kernel entered
from them sees whatever reset left in `CNTFRQ`. So the frequency must come from the device tree —
and the vendor's own tree does exactly that.

⚠️ **Three measurement guards, because an absence is the whole argument:**
- **Entropy first.** A pattern scan over encrypted bytes proves nothing. `recovery.img` at
  entropy 8.00 is exactly that case and is reported as unscannable rather than as "clean".
- **A positive control.** A scanner that finds nothing may be broken. Ours finds 4 writes in our
  own kernel, so the zero in the boot chain is a real absence.
- **The decoder is tested against hand-computed encodings** (`0xEE0E0F10` = `MCR p15,0,r0,c14,c0,0`),
  not against itself — `scan-cp15.test.ts`, 8 tests.

⚠️ And the limit, stated plainly: this is a **pattern scan, not a disassembler**. It cannot prove
an instruction is reachable. That is why *absence* is strong here and a *presence* would not be.

### ⛔ A provenance trap that nearly inverted this

`kernel-tree/q10.dtb` looks like the vendor's device tree and is **ours** — `compatible =
"himedia,q10-pro"`, which we wrote. It says `arm,armv8-timer` with no `clock-frequency`, i.e. the
opposite of the finding. The real vendor trees are inside the firmware package:

```
_dtb/boot.img+0x8b5220.dtb      sha 207f65eb…   model = "Hisilicon"
_dtb/recovery.img+0x64b0d0.dtb  sha 207f65eb…   (byte-identical — a free cross-check)
    arm-timer { compatible = "arm,armv7-timer";
                interrupts = <1 13 0xf04  1 14 0xf04>;
                clock-frequency = <0x16e3600>; }     = 24,000,000 exactly
```

⇒ **Check what a file IS before diffing against it.** Two identical vendor copies agreeing is
evidence; one file of unknown origin is not.

## 2. ⛔ `verify = n` — a corrupt flash does NOT fail safe

The stock environment, read straight out of `bootargs.img`:

```
bootcmd   = mmc read 0 0x7E700000 0x69000 0x4000;bootm 0x7E700000;
            mmc read 0 0x1FFBFC0 0x4B000 0xC800; bootm 0x1FFBFC0
bootdelay = 0
verify    = n          ← bootm does NOT check the uImage header or data CRC
bootargs_2G = mem=1993M mmz=ddr,0,0,56M vmalloc=600M
phy_addr  = 2,1        phy_intf = mii,rgmii
```

**`verify = n` is the most consequential line in the backup.** `bootm` will not validate the
image, so a truncated or corrupt `uImage` on the stick is **jumped into, not rejected**. It then
hangs at the vendor logo — which is byte-for-byte the same observation as a kernel that booted and
died. Nothing on the box can separate those two.

⇒ So the CRC check has to happen here, before the stick is carried to the box. `bun run
himedia:simulate` does it, and the test suite corrupts one payload byte to prove the check fails
when it should:

```
ok  magic 0x27051956
ok  header CRC
ok  data CRC over 12998406 bytes (file carries 12998406)
ok  arch = 2 ARM (32-bit) — the loader is 32-bit and checks this
ok  comp = 0 (none), load 0x2000000, entry 0x2000000
```

⚠️ `bootdelay = 0` means there is **no window to interrupt U-Boot**, so the environment cannot be
corrected interactively without a console.

### The magic numbers are not magic

`blkdevparts` gives the real layout, and both hardcoded sectors land exactly on a partition start:

| partition | start | sector | | partition | start | sector |
|---|---:|---|---|---|---:|---|
| fastboot | 0 M | `0x000000` | | **kernel** | 150 M | **`0x04b000`** |
| bootargs | 1 M | `0x000800` | | misc | 190 M | `0x05f000` |
| recovery | 2 M | `0x001000` | | **trustedcore** | 210 M | **`0x069000`** |
| deviceinfo | 12 M | `0x006000` | | system | 250 M | `0x07d000` |
| baseparam | 14 M | `0x007000` | | cache | 1274 M | `0x27d000` |
| pqparam | 22 M | `0x00b000` | | private | 2298 M | `0x47d000` |
| logo / logobak | 30/50 M | `0x00f000`/`0x019000` | | backup | 2348 M | `0x496000` |
| fastplay / bak | 70/110 M | `0x023000`/`0x037000` | | securestore | 3148 M | `0x626000` |

⇒ `0x69000` **is** `trustedcore` and `0x4B000` **is** `kernel`. Our patched `bootcmd` preserves
both, and the env CRC is **valid over the 64 KiB block**, so U-Boot will accept it rather than
falling back to compiled-in defaults.

## 3. Every scenario, simulated

`bun run himedia:simulate` models the chain; the outcomes below follow from it plus the env.
**The column that matters is the last one: can we tell this apart from the others?**

| # | scenario | box behaviour | what we see | distinguishable? |
|---|---|---|---|---|
| 1 | no stick / wrong USB port | stage 4 `fatload` fails, stage 6 boots eMMC kernel | **`.200` answers** (Android) | ✅ yes |
| 2 | our kernel works | stages 1-5 | `.56` → `.57` → `.58`, `:80` serves | ✅ yes |
| 3 | our kernel hangs early | logo frozen | **nothing** answers | ⚠️ not from #6 |
| 4 | our kernel panics | `panic=5` reboots | address **flaps** | ✅ yes (8-ping sample) |
| 5 | `uImage` arch ≠ 2 | `bootm` refuses, falls to stage 6 | `.200` answers | ✅ yes |
| 6 | **`uImage` corrupt** | **`verify=n` ⇒ executed anyway** | **nothing** answers | ⛔ **no — identical to #3** |
| 7 | env CRC bad | U-Boot uses compiled-in defaults | `.200` answers | ⚠️ looks like #1 |
| 8 | USB stage before TrustedCore | stock AND our kernel break | hang | ⛔ happened once already |
| 9 | `mmc read` sector wrong | loads garbage, `verify=n` executes it | hang | ⛔ no |

⇒ **#6, #7, #8 and #9 are all pre-flight checks, not debugging.** Each one is silent on the box
and cheap to refuse beforehand, which is why `himedia:simulate` exits non-zero on all four. Rows
3 and 6 are the reason: once the stick is in, a corrupt image and a kernel bug are the same
observation, and we would debug the wrong one.

## 4. The backup: what is in it, and what must never be cross-flashed

19 partitions, **all `verified: true`** (both-ends hash match). `cache` and `userdata` were
deliberately skipped — scratch data.

**Device-unique — restoring these from a different box is destructive:**

| partition | size | content (measured) |
|---|---:|---|
| `deviceinfo` | 2 M | MAC + serial + HDCP keys — see below |
| `baseparam` | 8 M | display tables (`BASE_TABLE_DISP0`, `BASE_KEY_UNF_VERSION`), 5,797 B used |
| `pqparam` | 8 M | picture-quality tables, 182 KB used |
| `trustedcore` | 40 M | the TEE, plaintext, exports `hisi_psci_*` |
| `private` | 50 M | filesystem with SELinux labels (`u:object_r:private_file:s0`) |
| `securestore` | 8 M | **entropy 7.99 across all 8 MiB** — encrypted key material |

### ⭐ The MAC: question closed

Our device tree carried a comment guessing the real address was "probably in `deviceinfo` or
`baseparam`". It is **`deviceinfo`, as ASCII text at offset 0**:

```
00000000  "02:00:00:00:10:01\0"   ← the MAC, as a string
00000012  "HMDB501805000639\0"    ← the serial
00000023  MAGICNUM=deviceinfo  LENGTH=00000056  DRMAddr=0x4000
...       HDCP key blob at 0x4000 (per DRMAddr)
...       "00:00:00:00:00:00#disable=wifiBackupMac" / "…eth0BackupMac"
...       "POWER-STANDBY"  "KEYLED-ON"  "UART-OFF"
```

⇒ That is **why mainline never finds it**: a plain-text vendor blob at a fixed offset in a
proprietary partition is not an nvmem cell any upstream driver knows how to read. Pinning
`local-mac-address` in the device tree is the correct and only fix, and the value is now sourced
rather than copied from a running system.

⚠️ **`UART-OFF` is a LEAD, not a finding.** It is a string in a vendor config blob; what reads it
and what it gates are both unknown. Against it: `bootargs` already carries
`console=ttyAMA0,115200` and U-Boot's `stdout = serial`, so the loader clearly does emit on UART.
It may gate a standby MCU, CEC, or a debug path instead. Worth knowing if a future UART attempt
produces nothing — do not present it as "UART is disabled".

### ⛔ What a vendor OTA would cost us

An OTA rewrites `fastboot` and **formats `securestore`** — 8 MiB of encrypted key material, which
no amount of re-running the updater regenerates. We hold a verified copy; without one it is gone.
It would also drop our patched `bootcmd`, reverting the box to stock boot. That is *safe* (Android
returns) but silently removes USB boot, and `recovery.img` is ADVCA-encrypted so the update path
itself cannot be inspected or modified.

## 5. A correction to my own plan

`vmalloc=600M` was queued as a candidate because the vendor sets it. **Do not add it.** On ARM32
with `VMSPLIT_3G` (`PAGE_OFFSET=0xC0000000`) the kernel has 1 GB of virtual space, and vmalloc is
carved out of it — the mainline default is `240 * SZ_1M` (`arch/arm/mm/mmu.c`). Raising it to
600 M would cut lowmem from roughly 784 MB to roughly 424 MB. The vendor needs that space for
HiSilicon's `mmz` media allocator, which mainline does not have. `mem=1993M` is already safe
because `CONFIG_HIGHMEM=y` and `CONFIG_HIGHPTE=y` are both set.

⇒ **A setting copied from a vendor bootargs is a setting for the vendor's drivers.**

## 6. Ethernet, cross-checked

| | vendor `ethernet@f9840000` | vendor `ethernet@f9841000` | ours |
|---|---|---|---|
| phy-mode | `mii` | **`rgmii`** | **`rgmii`** |
| phy reg | `0x02` | **`0x03`** | **`phy1` @ 3** |
| interrupt | `0x47` | **`0x48`** | — |
| status | okay | okay | `gmac1` enabled |

Recon measured the stock kernel binding `f9841000`, and our tree targets `gmac1` with matching
mode and PHY address. ⇒ **"wrong ethernet port" is largely eliminated** as a cause of the silent
boot. ⚠️ Note U-Boot's own `phy_addr = 2,1` disagrees with the DTB's `0x03` for port 1; U-Boot's
net stack is only used for TFTP, and the kernel's DTB is authoritative, so this is a curiosity
rather than a conflict.

## Reusable lessons

- **An absence is only as good as its positive control.** "No CNTFRQ write" means nothing until
  the same scanner finds one somewhere it should. Check the tool on known-good input first.
- **Measure entropy before pattern-matching.** A scan over encrypted or compressed bytes returns
  a confident, meaningless answer — the same trap as the Vietmap `zn.cnk` "cracked" claim.
- **Check what a file IS before diffing against it.** A stale copy of your own output,
  sitting where the reference should be, inverts the conclusion and looks authoritative.
- **A disabled verify shifts the burden, it does not remove it.** `verify = n` means the CRC check
  moves to us; the only wrong move is to assume nobody is checking.
- **Two failure modes that look identical on the device must be separated off the device.** Rows 3
  and 6 of the scenario table are the whole argument for pre-flight validation.
- **A vendor setting is tuned for vendor drivers.** Copying `vmalloc=600M` would have cost 360 MB
  of lowmem to support an allocator we do not build.

ref: `scripts/himedia/scan-cp15.ts` (8 tests) · `scripts/himedia/simulate-boot.ts` (8 tests)
ref: `docs/261010-himedia-qemu-harness-and-devnull-bug.md` · `docs/261010-himedia-q10-pro-vendor-dtb.md`
