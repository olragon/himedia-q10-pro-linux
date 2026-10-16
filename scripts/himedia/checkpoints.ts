#!/usr/bin/env bun
/**
 * Turn the watchdog into a one-bit-per-checkpoint telemetry channel for early kernel boot.
 *
 * ⭐ Measured 2026-10-10: the 44-byte stub reboot-looped at ~8 s, which proved bootm jumps to
 * 0x2000000 and our code runs — AND calibrated the channel. 8 s = U-Boot (~6 s) + two watchdog
 * load periods (2 x 1 s). So the reboot PERIOD is a readable number, and the watchdog's reload
 * value encodes which checkpoint the kernel last reached. One flash, several checkpoints,
 * no console and no serial.
 *
 * Later checkpoints use SHORTER timeouts, so a shorter observed period means the kernel got
 * further. Each checkpoint re-arms, so the last one reached is the one that fires.
 *
 * ⛔ Both checkpoints are PRE-MMU on purpose. 0xf8a2c000 is a physical address; after
 * __enable_mmu it is not mapped and a write there would fault, producing a "hang" that is
 * entirely our own doing and would be misread as the bug under test.
 *
 * ⚠️ Registers: at both anchors r0-r2 carry the boot convention (r0=0, r1=machine nr,
 * r2=atags/dtb) and must not be touched. r3/r4 are free at both points. A clobbered boot
 * register would itself hang the kernel and we would attribute it to the wrong cause.
 *
 * ⚠️ `movw`/`movt`, never `ldr rX, =const`: a literal pool must sit within 4095 bytes of the
 * instruction, and head.S sections are long enough that the assembler can fail to place one.
 * movw/movt builds the constant inline and cannot fail that way. ARMv7 is guaranteed here.
 */

/** 24 MHz APB clock — the same figure the vendor DTB gives the timer as clock-frequency. */
export const APB_HZ = 24_000_000;
const WDT = 0xf8a2c000;
const UNLOCK = 0x1acce551;

export type Checkpoint = {
  id: string;
  /** Seconds per watchdog period. The box resets after TWO of them. */
  seconds: number;
  file: string;
  /** The line the insert goes AFTER. Must match exactly once. */
  anchor: string;
  indent: string;
  why: string;
  /**
   * ⭐ Branch the timeout on a CP15 register bit, turning the reboot period into a READING of
   * the hardware state rather than just a position in the boot. Currently only "sctlr-c":
   * SCTLR bit 2, the data-cache enable.
   *
   * Why it matters here: "decompress_kernel never returned in 60 s" has two very different
   * causes — a genuine hang, or inflating 30.5 MB against UNCACHED DRAM, which is 50-100x
   * slower. Those need opposite fixes, and the period can tell them apart directly.
   */
  probe?: "sctlr-c";
  /** Timeout when the probed bit is SET (caches on). */
  secondsIfSet?: number;
  /**
   * ⭐ Wrap the sequence in push/pop so register liveness does not have to be reasoned about.
   * Only valid where a stack exists — i.e. after the decompressor sets one up (it does so
   * before its first `bl`). ⛔ Checkpoint A is BEFORE that and must stay register-based: a
   * push there would write through an undefined sp and hang the decompressor itself, which we
   * would then read as "the decompressor never ran".
   */
  stackSafe?: boolean;
  /**
   * ⛔ The two scratch registers, as [base, value]. Defaults to r3/r4 because those are free at
   * every anchor in the DECOMPRESSOR — but they are not free everywhere in the kernel proper.
   * `__create_page_tables` returns the translation-table base in **r4**, and `__enable_mmu`
   * writes it to TTBR0; clobbering it would corrupt the page tables and produce a hang we
   * would then attribute to the MMU rather than to this instrument.
   */
  regs?: [number, number];
  /**
   * ⛔ This checkpoint runs AFTER __enable_mmu, where 0xf8a2c000 has no mapping and a write
   * would fault — producing a "hang" that is entirely our own doing. It is only reachable
   * because CONFIG_DEBUG_LL makes __create_page_tables add a flat section mapping for the
   * debug UART, and we point that mapping at the 1 MB section the SP805 lives in. The build
   * asserts those config symbols whenever a post-MMU checkpoint is applied.
   */
  postMmu?: boolean;
  /**
   * ⭐ "c" emits a C statement block instead of assembly, which is what makes start_kernel
   * reachable: by then the kernel is ordinary C and there is no head.S to patch. It works for
   * the same reason checkpoint J does — the DEBUG_LL section mapping is flat (PHYS == VIRT),
   * so the SP805 is addressable at the identical constant before and after the MMU.
   *
   * ⛔ Placement must avoid the inside of setup_arch: paging_init tears the early mappings
   * down and only devicemaps_init -> debug_ll_io_init puts the debug section back, so there is
   * a window in there where this write would fault. Every C checkpoint sits either before
   * setup_arch or after it returns.
   */
  lang?: "c";
};

/**
 * ⚠️ Keep the periods far apart. The reader is a human with a phone timer watching a logo
 * redraw, so 22 s vs 10 s is usable and 16 s vs 18 s is not.
 */
/**
 * ⛔ A checkpoint's timeout must EXCEED the time the next stage legitimately needs, or the
 * watchdog fires mid-progress and the reading UNDERSTATES how far the kernel got.
 *
 * This bit us: D armed a 6 s period (reset at 12 s) and the box reported D — but the stage
 * after D is `decompress_kernel` inflating **30.5 MB of gzip**, which can easily exceed 12 s,
 * especially if caches are not yet on. So "died at D" and "was still decompressing at D"
 * produce the IDENTICAL reading, and only a longer budget can separate them.
 *
 * `--patient` keeps the same order but gives the decompression stage a 60 s budget.
 */
/**
 * ⭐ The CACHE profile answers the question the patient run raised: decompression did not
 * finish in 60 s. Checkpoint D reads SCTLR.C and picks its timeout from it, so the reboot
 * period distinguishes three outcomes that otherwise look identical:
 *
 *   ~ 12 s  decompress_kernel RETURNED        -> it was merely slow; 60 s was too small
 *   ~ 20 s  caches were OFF at D              -> root cause, and the fix is different
 *   ~126 s  caches ON, still stuck after 120 s -> a genuine hang inside inflate
 */
export const CACHE_PROBE: Record<string, number> = {
  "A-decompressor": 40,     // ~86 s
  "C-dtb-done": 35,         // ~76 s
  "D-wont-overwrite": 7,    // ~20 s when the cache is OFF
  "E-decompressed": 3,      // ~12 s
  "B-kernel-proper": 1,     // ~8 s
};
/** Paired with CACHE_PROBE: D's timeout when SCTLR.C is SET. */
export const CACHE_PROBE_IF_SET: Record<string, number> = {
  "D-wont-overwrite": 60,   // ~126 s cycle, i.e. 120 s for decompression
};

/**
 * ⭐ The LATE profile exists because the cache-probe reading was AMBIGUOUS, and the reason is
 * worth keeping: cycle = overhead + 2 x load, and `overhead` was calibrated at ~6 s with the
 * 44-byte stub. Our image is 12.3 MB, so its USB read is not the stub's, and the real overhead
 * is unmeasured. A ~16 s observed cycle therefore fits D-cache-off (7), E (3) AND B (1)
 * depending on an overhead nobody measured — three incompatible conclusions.
 *
 * ⛔ So do not read a 4 s difference off a phone timer. These periods are spread so wide that
 * an overhead error of ±10 s still cannot move the answer:
 *
 *   ~96 s  A-decompressor
 *   ~76 s  C-dtb-done
 *   ~60 s  D-wont-overwrite   the overwrite check passed, decompression began
 *   ~44 s  E-decompressed     decompress_kernel RETURNED
 *   ~14 s  B-kernel-proper    the kernel proper was ENTERED in SVC
 *
 * E and B are 30 s apart, which is the only pair that actually matters here: it separates
 * "the jump to the kernel proper fails" from "the kernel proper is running and the remaining
 * work is the device tree".
 *
 * ⚠️ No SCTLR probe: later checkpoints overwrite earlier ones, so once E or B fires D's
 * cache reading is gone anyway. If the answer comes back D (~66 s), re-run --cache-probe.
 */
/** ⛔ SUPERSEDED by STEXT — it predates F/G/H/I and does not give them periods, so applying it
 * now leaves four checkpoints at defaults that COLLIDE with its own. `assertReadable` refuses
 * it for that reason; it is kept only as the record of what was flashed on 2026-10-10. */
export const LATE: Record<string, number> = {
  "A-decompressor": 45,     // ~96 s
  "C-dtb-done": 35,         // ~76 s
  "D-wont-overwrite": 27,   // ~60 s — a 54 s decompression budget
  "E-decompressed": 19,     // ~44 s
  "B-kernel-proper": 4,     // ~14 s
};

export const PATIENT: Record<string, number> = {
  "A-decompressor": 40,     // ~86 s cycle
  "C-dtb-done": 35,         // ~76 s
  "D-wont-overwrite": 30,   // ~66 s  => decompression gets 60 s before any reset
  "E-decompressed": 3,      // ~12 s
  "B-kernel-proper": 1,     // ~ 8 s
};

/**
 * ⭐ STEXT bisects the post-stext, pre-MMU path. Spread so a +-10 s overhead cannot move the
 * answer (overhead measured ~11 s on 2026-10-10, not the 6 s the 44-byte stub implied).
 *
 *   ~131 s  I  page tables BUILT   -> pre-MMU complete; box then lives 120 s, so run watch-boot
 *   ~101 s  A  decompressor        -> a regression
 *   ~ 89 s  C  dtb scan done
 *   ~ 77 s  D  overwrite check
 *   ~ 65 s  E  decompressed
 *   ~ 53 s  B  stext only          -> dies in __lookup_processor_type
 *   ~ 41 s  F  CPU recognised      -> dies in __vet_atags
 *   ~ 29 s  G  atags ok            -> dies in __fixup_smp / __fixup_pv_table
 *   ~ 17 s  H  pv patched          -> dies in __create_page_tables
 */
/** ⛔ SUPERSEDED by MMU — it predates J, so applying it would leave J at a colliding default.
 * Kept as the record of the image flashed on 2026-10-10 that identified checkpoint I. */
export const STEXT: Record<string, number> = {
  "A-decompressor": 45,     // ~101 s
  "C-dtb-done": 39,         // ~ 89 s
  "D-wont-overwrite": 33,   // ~ 77 s
  "E-decompressed": 27,     // ~ 65 s
  "B-kernel-proper": 21,    // ~ 53 s
  "F-cpu-known": 15,        // ~ 41 s
  "G-atags-ok": 9,          // ~ 29 s
  "H-pv-patched": 3,        // ~ 17 s
  "I-page-tables": 60,      // ~131 s — longest on purpose; see the checkpoint's own note
};

/**
 * ⭐ MMU adds the first post-MMU checkpoint. Readings:
 *
 *   ~194 s  J  the MMU is ON   -> and the box then lives 180 s, so run watch-boot
 *   ~134 s  I  page tables built, MMU enable or __v7_setup FAILED
 *   ~104 s  A  a regression
 *   ... B/C/D/E/F/G/H as before
 *
 * ⛔ J is deliberately LONGER than I, inverting "shorter = further", because the watchdog
 * fires from nothing re-arming it and mainline pets no SP805 — so a healthy kernel resets
 * exactly like a dead one. A long period at the furthest point stops the instrument being the
 * thing that kills the boot.
 */
export const MMU: Record<string, number> = {
  "A-decompressor": 45,     // ~104 s
  "C-dtb-done": 39,         // ~ 92 s
  "D-wont-overwrite": 33,   // ~ 80 s
  "E-decompressed": 27,     // ~ 68 s
  "B-kernel-proper": 21,    // ~ 56 s
  "F-cpu-known": 15,        // ~ 44 s
  "G-atags-ok": 9,          // ~ 32 s
  "H-pv-patched": 3,        // ~ 20 s
  "I-page-tables": 60,      // ~134 s
  "J-mmu-on": 90,           // ~194 s — longest on purpose
};

/**
 * ⭐ KERNEL bisects start_kernel. Execution order and the period each arms:
 *
 *   A 81 ~168s  C 75 ~156s  D 69 ~144s  E 63 ~132s   (decompressor — all proven reached)
 *   B 57 ~120s  F 51 ~108s  G 45 ~ 96s  H 39 ~ 84s   (stext — all proven reached)
 *   I 33 ~ 72s  J 27 ~ 60s                            (page tables, MMU on — proven)
 *   K 21 ~ 48s  L 15 ~ 36s  M  9 ~ 24s  N  3 ~ 12s   (start_kernel — the open question)
 *   O 150 ~306s                                       (deepest; leaves the box alive ~300s)
 *
 * ⚠️ Observed cycles run ~8 s longer than these, consistently: the table assumes a 6 s
 * pre-kernel overhead from the 44-byte stub, and the real figure with a 12.3 MB USB read is
 * ~14 s. Measured twice (126 -> 134, 186 -> 194), so add 8 when reading.
 *
 * The informative readings: ~32 s means time_init never returned (no working timer — a panic
 * with no console looks exactly like a hang); ~20 s means it did and console_init did not;
 * ~314 s means the console is up and the box is alive long enough for watch-boot.
 */
/** ⛔ SUPERSEDED by USERSPACE — predates P/Q. Kept as the record of the image that identified
 * checkpoint O (console_init reached) on 2026-10-10. */
export const KERNEL: Record<string, number> = {
  "A-decompressor": 81, "C-dtb-done": 75, "D-wont-overwrite": 69, "E-decompressed": 63,
  "B-kernel-proper": 57, "F-cpu-known": 51, "G-atags-ok": 45, "H-pv-patched": 39,
  "I-page-tables": 33, "J-mmu-on": 27,
  "K-start-kernel": 21, "L-setup-arch": 15, "M-mm-up": 9, "N-time-init": 3,
  "O-console": 150,
};

/**
 * ⭐ USERSPACE is the first profile where "further" means LONGER all the way down.
 *
 * Earlier profiles used "shorter = further" and bolted a long tail onto the deepest
 * checkpoint so the box would survive long enough for watch-boot. With 18 checkpoints that no
 * longer fits: the shallow end would need sub-second periods. Inverting the whole ladder is
 * simpler, keeps a uniform 12 s gap, and gives the DEEPEST point the longest life for free —
 * which is exactly the one we want the box to survive at.
 *
 *   obs =  14 + 2*load  (the +14 overhead is measured, not the stub's 6 s)
 *
 *   ~20 A  ~32 C  ~44 D  ~56 E       decompressor
 *   ~68 B  ~80 F  ~92 G ~104 H       stext
 *  ~116 I ~128 J                     page tables, MMU on
 *  ~140 K ~152 L ~164 M ~176 N ~188 O   start_kernel
 *  ~200 P ~212 Q                     initcalls, pre-exec
 *  ~224 R                            PID 1 ran  -> box lives ~210 s, run watch-boot
 */
export const USERSPACE: Record<string, number> = {
  "A-decompressor": 3, "C-dtb-done": 9, "D-wont-overwrite": 15, "E-decompressed": 21,
  "B-kernel-proper": 27, "F-cpu-known": 33, "G-atags-ok": 39, "H-pv-patched": 45,
  "I-page-tables": 51, "J-mmu-on": 57,
  "K-start-kernel": 63, "L-setup-arch": 69, "M-mm-up": 75, "N-time-init": 81,
  "O-console": 87, "P-initcalls": 93, "Q-pre-exec": 99,
  "R-userspace": 105,
};

/** R lives in our own initramfs PID 1, not in a kernel source file, so the build cannot patch
 * it the way it patches head.S. `initramfs.test.ts` asserts init.c carries this same number. */
export const USERSPACE_PID1_SECONDS = 80;

/**
 * ⭐ The NIC verdict PID 1 arms after R, from sysfs. Mirrors the NIC_* #defines in init.c (a
 * test keeps them equal). R at 3:47 proved userspace runs; these say where the network stops.
 */
export const NIC_VERDICT = {
  NIC_NO_DT_NODE: 5,           // ~0:30  ethernet@9841000 absent from the live device tree
  NIC_NO_PLATFORM_DEVS: 14,    // ~0:51  DT population failed wholesale
  NIC_NO_GMAC_BUT_EHCI: 24,    // ~1:11  gmac-specific
  NIC_NO_GMAC_NO_EHCI: 34,     // ~1:31  neither gmac nor ehci, others exist
  NIC_UNBOUND: 45,             // ~1:50  device, no driver / no netdev
  NIC_DOWN: 55,                // ~2:10  netdev not UP: ndo_open failed
  NIC_NO_CARRIER: 60,          // ~2:35  UP, no link after 15 s (the wait adds to pre-time)
  NIC_CARRIER: 300,            // ~10 min: link up — keep the box alive for watch-boot
} as const;

/**
 * ⭐ FAST — the ladder collapsed to one "regressed somewhere" period, so the verdicts can use the
 * short end. Tim, 2026-10-10: readings had grown to 7-9 minutes. The kernel reliably reaches
 * PID 1 now (R at 3:47), so the deep checkpoints only guard against regressions and do not need
 * to say WHERE; re-run USERSPACE if one appears.
 */
export const FAST_LADDER_SECONDS = 100;

/**
 * Predicted reboot cycle for every outcome under FAST, with each branch's own pre-checkpoint time
 * (measured: ~17 s to R; the verdict adds ~3 s when the gmac is missing and ~15 s waiting for a
 * carrier). A test asserts every pair is >= 18 s apart — the property that makes it readable.
 */
export function fastReadings(): Record<string, number> {
  const V = NIC_VERDICT;
  return {
    NO_DT_NODE: 20 + 2 * V.NIC_NO_DT_NODE,
    NO_PLATFORM_DEVS: 23 + 2 * V.NIC_NO_PLATFORM_DEVS,
    NO_GMAC_BUT_EHCI: 23 + 2 * V.NIC_NO_GMAC_BUT_EHCI,
    NO_GMAC_NO_EHCI: 23 + 2 * V.NIC_NO_GMAC_NO_EHCI,
    UNBOUND: 20 + 2 * V.NIC_UNBOUND,
    DOWN: 20 + 2 * V.NIC_DOWN,
    NO_CARRIER: 35 + 2 * V.NIC_NO_CARRIER,
    PID1_CRASHED: 17 + 2 * USERSPACE_PID1_SECONDS,
    KERNEL_REGRESSED_EARLIEST: 11 + 2 * FAST_LADDER_SECONDS,
    KERNEL_REGRESSED_LATEST: 17 + 2 * FAST_LADDER_SECONDS,
    CARRIER: 25 + 2 * V.NIC_CARRIER,
  };
}

export const CHECKPOINTS: Checkpoint[] = [
  {
    id: "A-decompressor",
    seconds: 12,                      // => ~30 s cycle
    file: "arch/arm/boot/compressed/head.S",
    anchor: "\t\tmov\tr8, r2\t\t\t@ save atags pointer",
    indent: "\t\t",
    why: "the decompressor is running, just after it saved the atags/dtb pointer",
  },
  {
    id: "C-dtb-done",
    seconds: 9,                       // => ~24 s cycle
    file: "arch/arm/boot/compressed/head.S",
    anchor: "dtb_check_done:",
    indent: "\t\t",
    stackSafe: true,
    why: "the appended-DTB scan finished and the pointers past it were relocated",
  },
  {
    id: "D-wont-overwrite",
    seconds: 6,                       // => ~18 s cycle
    file: "arch/arm/boot/compressed/head.S",
    anchor: "wont_overwrite:",
    indent: "\t\t",
    stackSafe: true,
    why: "the overwrite check passed, so the decompressor is clear to unpack in place",
  },
  {
    id: "E-decompressed",
    seconds: 3,                       // => ~12 s cycle
    file: "arch/arm/boot/compressed/head.S",
    anchor: "\t\tbl\tdecompress_kernel",
    indent: "\t\t",
    stackSafe: true,
    why: "decompress_kernel RETURNED, so the kernel image is unpacked in memory",
  },
  /*
   * ⭐ F/G/H/I bisect the stretch AFTER stext, measured 2026-10-10: a 19 s cycle proved B was
   * reached (every other checkpoint needed >=44 s), so the decompressor is fully exonerated and
   * the kernel proper runs. These four are the whole remaining PRE-MMU path, in order:
   *
   *   F  the CPU was recognised           (__lookup_processor_type returned non-zero)
   *   G  the atags/DTB passed validation  (__vet_atags)
   *   H  the phys/virt patching ran       (__fixup_pv_table — CONFIG_ARM_PATCH_PHYS_VIRT=y)
   *   I  the page tables were built       (__create_page_tables)
   *
   * ⛔ After I there is nothing more this channel can see: __enable_mmu turns the MMU on, and
   * 0xf8a2c000 is a PHYSICAL address with no mapping afterwards, so a write there would fault.
   * Reaching I therefore means "pre-MMU is complete" and the next question needs a different
   * instrument, not a shorter timeout.
   */
  {
    id: "F-cpu-known",
    seconds: 15,
    file: "arch/arm/kernel/head.S",
    /*
     * ⚠️ `beq __error_p` and its comment BOTH match twice (stext and secondary_startup) — the
     * same trap that made checkpoint B need a comment-line anchor. This line is unique and
     * sits immediately after that branch, so reaching it means r5 != 0, i.e. the CPU was
     * recognised. ⛔ Do not touch r8: it is being computed across this very line.
     */
    anchor: "\tadr_l\tr8, _text\t\t\t@ __pa(_text)",
    indent: "\t",
    why: "__lookup_processor_type recognised the CPU, so it did not branch to __error_p",
  },
  {
    id: "G-atags-ok",
    seconds: 9,
    file: "arch/arm/kernel/head.S",
    anchor: "\tbl\t__vet_atags",
    indent: "\t",
    why: "the atags/DTB pointer in r2 passed validation",
  },
  {
    id: "H-pv-patched",
    seconds: 3,
    file: "arch/arm/kernel/head.S",
    anchor: "\tbl\t__fixup_pv_table",
    indent: "\t",
    why: "the phys-to-virt patching completed (ARM_PATCH_PHYS_VIRT=y)",
  },
  {
    id: "I-page-tables",
    seconds: 60,
    file: "arch/arm/kernel/head.S",
    anchor: "\tbl\t__create_page_tables",
    indent: "\t",
    /*
     * ⛔ r4 holds the translation-table base from here to __enable_mmu, so this checkpoint —
     * and ONLY this one — uses r0/r3. r0 is dead after __create_page_tables returns (the proc
     * init call takes r1, r2, r4, r8, r9, r10, r13) and r3 is scratch.
     *
     * ⭐ Its period is deliberately the LONGEST, not the shortest, which inverts the usual
     * "shorter = further" reading. Reason: the watchdog fires because NOTHING RE-ARMS IT, and
     * mainline binds no SP805 driver — so a kernel that boots perfectly resets exactly like one
     * that died. A 60 s period gives the kernel 120 s of life once pre-MMU is complete, which
     * is enough for the initramfs to raise eth0 and answer on the network. The instrument stops
     * being the thing that kills the boot.
     */
    regs: [0, 3],
    why: "__create_page_tables finished; pre-MMU setup is complete and the MMU is next",
  },
  /*
   * ⭐ J is the FIRST post-MMU checkpoint, and it answers the question I left open: checkpoint
   * I (page tables built) fired on 2026-10-10 with a 134 s cycle, the box then stayed alive
   * 120 s per cycle for seven minutes, and the kernel never raised eth0 — so it is not reaching
   * userspace, and the death is somewhere in __v7_setup / __enable_mmu / __mmap_switched /
   * start_kernel. J splits that in two: reaching it proves the MMU is on and the kernel is
   * executing from virtual addresses.
   */
  {
    id: "J-mmu-on",
    seconds: 90,
    file: "arch/arm/kernel/head-common.S",
    /*
     * ⚠️ Unique (`__mmap_switched_data:` does not contain `__mmap_switched:`). r0/r1/r2 still
     * carry the boot values and are saved to r10/r7/r8 three lines below, so they must not be
     * touched; r3 is free and r4 is overwritten by the `adr` that follows. No stack yet — sp
     * is loaded further down — so this must stay register-only.
     */
    anchor: "__mmap_switched:",
    indent: "\t",
    postMmu: true,
    why: "the MMU is ON and the kernel is running from virtual addresses",
  },
  /*
   * ⭐ K..O bisect start_kernel, which became reachable once checkpoint J proved the post-MMU
   * channel works (measured 2026-10-10: a 194 s cycle, exactly J). Order of execution is
   * K -> L -> M -> N -> O, and watch-boot found no network across 400 s even with 180 s of
   * life per cycle, so the kernel dies somewhere in here.
   *
   * ⛔ None of these may sit INSIDE setup_arch — see the `lang` note on the type.
   */
  {
    id: "K-start-kernel",
    seconds: 21,
    file: "init/main.c",
    anchor: "\tset_task_stack_end_magic(&init_task);",
    indent: "\t",
    lang: "c",
    postMmu: true,
    why: "start_kernel was entered, so __mmap_switched handed over to C",
  },
  {
    id: "L-setup-arch",
    seconds: 15,
    file: "init/main.c",
    anchor: "\tsetup_arch(&command_line);",
    indent: "\t",
    lang: "c",
    postMmu: true,
    why: "setup_arch RETURNED: the DT was parsed and paging_init completed",
  },
  {
    id: "M-mm-up",
    seconds: 9,
    file: "init/main.c",
    anchor: "\tmm_core_init();",
    indent: "\t",
    lang: "c",
    postMmu: true,
    why: "memory management is up",
  },
  {
    id: "N-time-init",
    seconds: 3,
    file: "init/main.c",
    anchor: "\ttime_init();",
    indent: "\t",
    lang: "c",
    postMmu: true,
    why: "time_init RETURNED, so a working timer was found and the clocks probed",
  },
  {
    id: "O-console",
    seconds: 150,
    file: "init/main.c",
    anchor: "\tconsole_init();",
    indent: "\t",
    lang: "c",
    postMmu: true,
    /*
     * ⭐ Deepest, so it gets the LONG period deliberately: reaching it leaves the box alive
     * ~300 s, which is the window watch-boot needs to see the initramfs raise eth0. Everything
     * after console_init is rest_init -> kernel_init -> driver probe -> GbE.
     */
    why: "console_init returned; next is rest_init and driver probe",
  },
  /*
   * ⭐ P/Q/R follow the 2026-10-10 result that checkpoint O fired (>4 min cycle): the kernel
   * reached console_init, so it is into rest_init -> initcalls -> exec. watch-boot still saw
   * nothing, so these three split the only stretch left:
   *
   *   P  every initcall ran, which includes the GbE driver's probe
   *   Q  kernel_init_freeable returned, so the kernel is about to exec /init
   *   R  PID 1 ACTUALLY RAN — written from userspace through /dev/mem
   *
   * ⛔ R is the one that resolves the ambiguity Q leaves. If Q fires and nothing appears on
   * the network, "exec failed" and "init ran but the NIC never came up" are indistinguishable
   * — and they need completely different work. R separates them in one boot.
   */
  {
    id: "P-initcalls",
    seconds: 93,
    file: "init/main.c",
    anchor: "\tdo_basic_setup();",
    indent: "\t",
    lang: "c",
    postMmu: true,
    why: "every initcall ran, so the GbE driver's probe has been attempted",
  },
  {
    id: "Q-pre-exec",
    seconds: 99,
    file: "init/main.c",
    anchor: "\tkernel_init_freeable();",
    indent: "\t",
    lang: "c",
    postMmu: true,
    why: "kernel_init_freeable returned; the kernel is about to exec /init",
  },
  {
    id: "B-kernel-proper",
    seconds: 1,                       // => ~8 s cycle
    file: "arch/arm/kernel/head.S",
    /*
     * ⚠️ `safe_svcmode_maskall r9` alone matches TWICE — once in stext and once in
     * secondary_startup. Arming on a secondary-CPU bring-up path would fire at a completely
     * different time and be read as a different checkpoint. The instruction that follows is
     * identical in both, and so is the blank line between them — the ONLY distinguishing
     * text is the comment on the preceding line, which stext alone carries.
     */
    anchor: "\t@ ensure svc mode and all interrupts masked\n\tsafe_svcmode_maskall r9",
    indent: "\t",
    why: "the kernel proper was entered in SVC with interrupts masked",
  },
];

const hex = (n: number) => `0x${(n >>> 0).toString(16)}`;

/**
 * The C form of the same five register writes. `volatile` is what stops the compiler eliding
 * stores to an address it cannot see a reader for; the whole block is one statement so it can
 * be inserted after any line without regard to braces.
 */
function cFor(cp: Checkpoint, indent: string): string {
  const load = cp.seconds * APB_HZ;
  const L = (x: string) => `${indent}${x}`;
  return [
    L(`/* --- himedia checkpoint ${cp.id}: ${cp.why} --- */`),
    L(`{ volatile unsigned int *__cp = (volatile unsigned int *)${hex(WDT)}UL;`),
    L(`  __cp[0xc00/4] = ${hex(UNLOCK)}u;\t/* WdogLock <- unlock */`),
    L(`  __cp[0] = ${load}u;\t\t/* WdogLoad = ${cp.seconds}s => reset in ${cp.seconds * 2}s */`),
    L(`  __cp[2] = 3u;\t\t\t/* WdogControl = INTEN|RESEN */`),
    L(`  __cp[0xc00/4] = 3u; }\t\t/* WdogLock <- re-lock (3 != magic) */`),
    L(`/* --- end checkpoint ${cp.id} --- */`),
  ].join("\n");
}

/** Emit the pre-MMU arming sequence, using only r3 and r4. */
export function asmFor(cp: Checkpoint, indent: string): string {
  const L = (x: string) => `${indent}${x}`;
  const lo = (v: number) => hex(v & 0xffff);
  const hi = (v: number) => hex((v >>> 16) & 0xffff);
  if (cp.lang === "c") return cFor(cp, indent);
  const [rb, rv] = cp.regs ?? [3, 4];
  const B = `r${rb}`, V = `r${rv}`;
  const save = cp.stackSafe ? [L(`push\t{${B}, ${V}}`)] : [];
  const restore = cp.stackSafe ? [L(`pop\t{${B}, ${V}}`)] : [];

  const head = [
    L(`@ --- himedia checkpoint ${cp.id}: ${cp.why} ---`),
  ];

  // Common prologue: r3 = SP805 base, then unlock.
  const unlock = [
    L(`movw\t${B}, #${lo(WDT)}`),
    L(`movt\t${B}, #${hi(WDT)}`),
    L(`movw\t${V}, #${lo(UNLOCK)}`),
    L(`movt\t${V}, #${hi(UNLOCK)}`),
    L(`str\t${V}, [${B}, #0xc00]\t\t@ WdogLock <- unlock`),
  ];
  /*
   * ⛔ Re-LOCK after arming. The SP805 ignores every register write while WdogLock holds
   * anything other than 0x1ACCE551, so locking makes each checkpoint self-contained and —
   * once CONFIG_DEBUG_LL points the debug-UART mapping at this same section — stops a stray
   * printascii byte from rewriting the reload value. ${V} already holds 3 from the line above,
   * which is conveniently not the magic.
   */
  const arm = [
    L(`mov\t${V}, #3`),
    L(`str\t${V}, [${B}, #8]\t\t\t@ WdogControl = INTEN|RESEN`),
    L(`str\t${V}, [${B}, #0xc00]\t\t@ WdogLock <- re-lock (3 != magic)`),
  ];
  /*
   * ⛔ The end marker must be the LAST line of the block. The strip regex in revertFrom()
   * ends at this marker, so anything emitted after it SURVIVES a revert. `pop {r3, r4}` used
   * to sit here, which meant every revert orphaned a pop and every re-apply added another:
   * the tree reached 15 pops against 3 pushes, and the image flashed on 2026-10-10 carried 6
   * orphans. Each one advances sp by 8 bytes, and in the decompressor sp sits directly below
   * inflate's 64 KB malloc workspace — so it corrupts the very thing decompression needs,
   * and the resulting hang looks exactly like the bug under investigation.
   */
  const tail = [L(`@ --- end checkpoint ${cp.id} ---`)];

  if (cp.probe === "sctlr-c") {
    const onLoad = (cp.secondsIfSet ?? cp.seconds) * APB_HZ;
    const offLoad = cp.seconds * APB_HZ;
    return [
      ...head,
      L(`@ reads SCTLR.C (data cache enable) and picks the timeout from it:`),
      L(`@   cache ON  -> ${cp.secondsIfSet}s period, reset in ${(cp.secondsIfSet ?? 0) * 2}s`),
      L(`@   cache OFF -> ${cp.seconds}s period, reset in ${cp.seconds * 2}s`),
      L(`@ ⚠️ tst sets the flags; movw/movt/str/push/pop do NOT, so they survive to the`),
      L(`@ conditional movs below.`),
      ...save,
      L(`mrc\tp15, 0, ${V}, c1, c0, 0\t@ read SCTLR`),
      L(`tst\t${V}, #(1 << 2)\t\t@ C bit: data cache enabled?`),
      ...unlock,
      L(`movwne\t${V}, #${lo(onLoad)}\t\t@ cache ON`),
      L(`movtne\t${V}, #${hi(onLoad)}`),
      L(`movweq\t${V}, #${lo(offLoad)}\t\t@ cache OFF`),
      L(`movteq\t${V}, #${hi(offLoad)}`),
      L(`str\t${V}, [${B}, #0]\t\t\t@ WdogLoad`),
      ...arm, ...restore, ...tail,
    ].join("\n");
  }

  const load = cp.seconds * APB_HZ;
  return [
    ...head,
    L(`@ arms the SP805 watchdog with a ${cp.seconds}s period => reset in ${cp.seconds * 2}s.`),
    ...save, ...unlock,
    L(`movw\t${V}, #${lo(load)}`),
    L(`movt\t${V}, #${hi(load)}`),
    L(`str\t${V}, [${B}, #0]\t\t\t@ WdogLoad = ${load}`),
    ...arm, ...restore, ...tail,
  ].join("\n");
}

/**
 * Strip a previously inserted block, so timings can be CHANGED.
 *
 * ⛔ Needed because applyTo is idempotent: once a checkpoint is present it is skipped, so a
 * new timeout would be silently ignored and the box would report the OLD period. The reading
 * would look valid and mean something else entirely.
 */
export function revertFrom(src: string): string {
  // Both comment styles: `@ ---` in assembly, `/* ---` in C.
  return src.replace(
    /^[ \t]*(?:@|\/\*) --- himedia checkpoint [\s\S]*?--- end checkpoint [A-Za-z0-9-]+ ---(?: \*\/)?\n/gm, "");
}

/**
 * Insert after the anchor. Refuses unless the anchor appears EXACTLY once — a silent
 * zero-or-many match would ship a kernel with no telemetry, and a frozen logo would then be
 * read as "the kernel never ran" when in truth nothing was ever armed.
 */
export function applyTo(src: string, cp: Checkpoint): string {
  if (src.includes(`checkpoint ${cp.id}`)) return src;      // idempotent
  const n = src.split(cp.anchor).length - 1;
  if (n !== 1) throw new Error(`anchor for ${cp.id} matched ${n} times in ${cp.file}, need exactly 1`);
  return src.replace(cp.anchor, `${cp.anchor}\n${asmFor(cp, cp.indent)}`);
}

/** The table a human reads the result off. */
export function periodTable(uBootSeconds = 6): string {
  const rows = CHECKPOINTS.map((c) => {
    const cycle = uBootSeconds + c.seconds * 2;
    return `  ~${String(cycle).padStart(2)}s  => reached ${c.id.padEnd(16)} (${c.why.slice(0, 54)})`;
  });
  return [
    `  calibration: the 44-byte stub measured ~8s with a 1s load, so U-Boot ≈ ${uBootSeconds}s`,
    `               and cycle = U-Boot + 2 x load. Shorter cycle = got further.`,
    "",
    ...rows,
    `  frozen (no reset at all) => not even ${CHECKPOINTS[0].id} was reached`,
  ].join("\n");
}

if (import.meta.main) {
  // Applied before anything reads CHECKPOINTS.
  if (process.argv.includes("--patient")) {
    for (const c of CHECKPOINTS) c.seconds = PATIENT[c.id] ?? c.seconds;
  }
  if (process.argv.includes("--fast")) {
    for (const c of CHECKPOINTS) c.seconds = FAST_LADDER_SECONDS;
  }
  if (process.argv.includes("--userspace")) {
    for (const c of CHECKPOINTS) c.seconds = USERSPACE[c.id] ?? c.seconds;
  }
  if (process.argv.includes("--kernel-cp")) {
    for (const c of CHECKPOINTS) c.seconds = KERNEL[c.id] ?? c.seconds;
  }
  if (process.argv.includes("--mmu")) {
    for (const c of CHECKPOINTS) c.seconds = MMU[c.id] ?? c.seconds;
  }
  if (process.argv.includes("--stext")) {
    for (const c of CHECKPOINTS) c.seconds = STEXT[c.id] ?? c.seconds;
  }
  if (process.argv.includes("--late")) {
    for (const c of CHECKPOINTS) c.seconds = LATE[c.id] ?? c.seconds;
  }
  if (process.argv.includes("--cache-probe")) {
    for (const c of CHECKPOINTS) {
      c.seconds = CACHE_PROBE[c.id] ?? c.seconds;
      if (CACHE_PROBE_IF_SET[c.id] !== undefined) {
        c.probe = "sctlr-c";
        c.secondsIfSet = CACHE_PROBE_IF_SET[c.id];
      }
    }
  }
  const root = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const revert = process.argv.includes("--revert");
  if (!root) {
    console.log("usage: himedia:checkpoints <kernel-source-root>\n");
    console.log(periodTable());
    process.exit(0);
  }
  const { readFileSync, writeFileSync } = await import("node:fs");
  if (revert) {
    for (const f of [...new Set(CHECKPOINTS.map((c) => c.file))]) {
      const p = `${root}/${f}`;
      const before = readFileSync(p, "utf8");
      const after = revertFrom(before);
      writeFileSync(p, after);
      console.log(`  stripped ${before.length - after.length} B from ${f}`);
    }
    process.exit(0);
  }
  for (const cp of CHECKPOINTS) {
    const p = `${root}/${cp.file}`;
    const before = readFileSync(p, "utf8");
    const after = applyTo(before, cp);
    writeFileSync(p, after);
    const added = after.length - before.length;
    console.log(`  ${added > 0 ? "ok " : "·  "} ${cp.id.padEnd(16)} ${cp.file}` +
      `${added > 0 ? ` (+${added} B)` : " (already present)"}`);
  }
  console.log(`\n${periodTable()}`);
}

/**
 * ⛔ Refuse a profile that cannot be read off a phone timer. Two ways that happens, and both
 * have already cost a boot cycle:
 *   1. INCOMPLETE — a profile that predates a checkpoint leaves it at its default, which
 *      silently collides with the profile's own periods (LATE vs F/G/H/I).
 *   2. TOO TIGHT — the cache-probe profile put E and B 4 s apart while the overhead error was
 *      larger than that, so one reading fitted three different conclusions.
 */
export function assertReadable(name: string, profile: Record<string, number>, minGapS = 10): void {
  const missing = CHECKPOINTS.filter((c) => profile[c.id] === undefined).map((c) => c.id);
  if (missing.length) {
    throw new Error(`profile ${name} has no period for ${missing.join(", ")} — they would keep ` +
      `their defaults and collide. Give every checkpoint a period, or use a profile that does.`);
  }
  const rows = CHECKPOINTS.map((c) => ({ id: c.id, cycle: 6 + profile[c.id] * 2 }))
    .sort((a, b) => a.cycle - b.cycle);
  for (let i = 1; i < rows.length; i++) {
    const gap = rows[i].cycle - rows[i - 1].cycle;
    if (gap <= minGapS) {
      throw new Error(`profile ${name}: ${rows[i - 1].id} (~${rows[i - 1].cycle}s) and ` +
        `${rows[i].id} (~${rows[i].cycle}s) are only ${gap}s apart — a hand-timed reading ` +
        `cannot separate them. Spread them beyond ${minGapS}s.`);
    }
  }
}
