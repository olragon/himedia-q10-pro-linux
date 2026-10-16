/**
 * Guards on the watchdog checkpoint emitter.
 *
 * ⛔ These exist because of a real, costly bug: the stack restore was emitted AFTER the
 * `end checkpoint` marker, which revertFrom() stops at — so every revert orphaned a
 * `pop {r3, r4}` and every re-apply added another. The source tree reached 15 pops against 3
 * pushes, and an image flashed to the box carried 6 orphans. Each advances sp by 8 bytes, and
 * in the decompressor sp sits immediately below inflate's 64 KB malloc workspace, so it
 * corrupts the very memory decompression needs. The resulting hang is INDISTINGUISHABLE from
 * the bug being investigated, and it invalidated one hardware test.
 */
import { test, expect } from "bun:test";
import { CHECKPOINTS, LATE, STEXT, MMU, KERNEL, USERSPACE, USERSPACE_PID1_SECONDS, assertReadable, asmFor, revertFrom, APB_HZ } from "./checkpoints.ts";

test("every emitted block balances push and pop", () => {
  for (const c of CHECKPOINTS) {
    const a = asmFor(c, "\t\t");
    const push = (a.match(/push\t\{r3, r4\}/g) ?? []).length;
    const pop = (a.match(/pop\t\{r3, r4\}/g) ?? []).length;
    expect(push).toBe(pop);
    expect(push).toBe(c.stackSafe ? 1 : 0);
  }
});

test("revertFrom strips a block COMPLETELY, leaving nothing behind", () => {
  for (const c of CHECKPOINTS) {
    const block = asmFor(c, "\t\t") + "\n";
    expect(revertFrom(block).trim()).toBe("");
    // And inside surrounding code, only the surrounding code survives.
    const wrapped = `\t\tmov\tr0, r1\n${block}\t\tmov\tr2, r3\n`;
    const after = revertFrom(wrapped);
    expect(after).toContain("mov\tr0, r1");
    expect(after).toContain("mov\tr2, r3");
    expect(after).not.toContain("r3, r4");      // ⛔ no orphaned stack op
    expect(after).not.toContain("0xf8a2");      // nor any watchdog write
  }
});

test("apply then revert is a round trip, repeatedly", () => {
  const c = CHECKPOINTS.find((x) => x.stackSafe)!;
  let src = "\t\tsome code\n";
  for (let i = 0; i < 4; i++) {
    src = src.replace("\t\tsome code", `\t\tsome code\n${asmFor(c, "\t\t")}`);
    src = revertFrom(src);
    expect(src).toBe("\t\tsome code\n");        // byte-identical every time
  }
});

test("the end marker is the LAST line of every block", () => {
  for (const c of CHECKPOINTS) {
    const lines = asmFor(c, "\t\t").trimEnd().split("\n");
    expect(lines[lines.length - 1]).toContain(`end checkpoint ${c.id}`);
  }
});

test("the SCTLR probe emits both conditional timeouts and reads the C bit", () => {
  const c = CHECKPOINTS.find((x) => x.probe === "sctlr-c");
  if (!c) return;                                // profile not active
  const a = asmFor(c, "\t\t");
  expect(a).toContain("mrc\tp15, 0, r4, c1, c0, 0");
  expect(a).toContain("tst\tr4, #(1 << 2)");
  expect(a).toMatch(/movwne\tr4, #0x[0-9a-f]+/);
  expect(a).toMatch(/movweq\tr4, #0x[0-9a-f]+/);
});

test("each checkpoint's load value is its seconds at the 24 MHz APB clock", () => {
  expect(APB_HZ).toBe(24_000_000);
  for (const c of CHECKPOINTS) {
    if (c.probe) continue;
    const body = asmFor(c, "\t");
    // The assembly form names the value in a comment; the C form writes it as a literal.
    const want = c.lang === "c" ? `${c.seconds * APB_HZ}u` : `WdogLoad = ${c.seconds * APB_HZ}`;
    expect(body.includes(want)).toBe(true);
  }
});

/*
 * ⛔ The cache-probe run on 2026-10-10 produced a ~16 s cycle that fitted D-cache-off, E AND B
 * at once, because `cycle = overhead + 2 x load` and the overhead was calibrated with the
 * 44-byte stub, not with a 12.3 MB image. A profile whose periods are closer together than the
 * overhead uncertainty cannot be read, so the separation is now an asserted property rather
 * than a hope.
 */
test("assertReadable accepts the current profile and refuses every superseded one", () => {
  assertReadable("USERSPACE", USERSPACE);
  // Each older profile predates checkpoints added after it, so it would leave them at
  // colliding defaults. This has now caught the same mistake twice; it is the guard working.
  expect(() => assertReadable("LATE", LATE)).toThrow(/no period for/);
  expect(() => assertReadable("STEXT", STEXT)).toThrow(/no period for/);
  expect(() => assertReadable("MMU", MMU)).toThrow(/no period for/);
  expect(() => assertReadable("KERNEL", KERNEL)).toThrow(/no period for/);
});

/*
 * ⛔ A post-MMU checkpoint is only reachable because CONFIG_DEBUG_LL makes
 * __create_page_tables map the debug-UART section, and we aim that at the SP805. Without
 * those symbols the write faults and the "hang" is our own instrument.
 */
test("every post-MMU checkpoint is register-only and lives outside the decompressor", () => {
  const post = CHECKPOINTS.filter((c) => c.postMmu);
  expect(post.length).toBeGreaterThan(0);
  for (const c of post) {
    expect(c.stackSafe).toBeFalsy();
    expect(c.file).not.toContain("boot/compressed");
    expect(asmFor(c, "\t")).not.toMatch(/push|pop/);
  }
});

test("every checkpoint re-locks the watchdog so a stray write cannot retime it", () => {
  for (const c of CHECKPOINTS) {
    expect(asmFor(c, "\t")).toMatch(/WdogLock <- re-lock/);
  }
});

test("assertReadable refuses a profile whose periods are too close to read", () => {
  const tight: Record<string, number> = {};
  CHECKPOINTS.forEach((c, i) => { tight[c.id] = 20 + i; });   // 2s apart in cycle terms
  expect(() => assertReadable("tight", tight)).toThrow(/cannot separate them/);
});

test("LATE puts E and B far enough apart to answer the question that matters", () => {
  // "the jump into the kernel proper failed" vs "the kernel proper is running" — the one
  // distinction worth a flash. 4 s apart (the cache-probe profile) was unreadable.
  const e = 6 + LATE["E-decompressed"] * 2;
  const b = 6 + LATE["B-kernel-proper"] * 2;
  expect(e - b).toBeGreaterThanOrEqual(25);
});

/*
 * ⛔ Every C checkpoint must sit before setup_arch or after it RETURNS. paging_init tears the
 * early mappings down and only devicemaps_init -> debug_ll_io_init restores the debug section,
 * so a write from inside setup_arch would fault — a hang caused by the instrument itself.
 */
test("no C checkpoint is anchored inside setup_arch", () => {
  const cs = CHECKPOINTS.filter((c) => c.lang === "c");
  expect(cs.length).toBeGreaterThan(0);
  for (const c of cs) {
    expect(c.file).toBe("init/main.c");
    // Anchors are whole statements in start_kernel, never anything inside arch/arm/.../setup.c
    expect(c.anchor).toMatch(/^\t[a-z_]+\(/);
  }
});

test("the C form writes the same five registers as the assembly form", () => {
  const c = CHECKPOINTS.find((x) => x.lang === "c")!;
  const body = asmFor(c, "\t");
  expect(body).toContain("volatile unsigned int");
  expect(body).toContain("0xf8a2c000");
  expect(body).toContain("0x1acce551u");       // unlock
  expect(body).toContain("__cp[0] =");          // WdogLoad
  expect(body).toContain("__cp[2] = 3u");       // WdogControl
  expect(body).toMatch(/__cp\[0xc00\/4\] = 3u/); // re-lock
});

/*
 * ⛔ __create_page_tables returns the translation-table base in r4 and __enable_mmu writes it
 * to TTBR0. A checkpoint that clobbered r4 there would corrupt the page tables, and the hang
 * would be read as an MMU problem rather than as this instrument's own doing.
 */
test("the post-page-tables checkpoint never touches r4", () => {
  const cp = CHECKPOINTS.find((c) => c.id === "I-page-tables")!;
  expect(cp.regs).toEqual([0, 3]);
  const asm = asmFor(cp, "\t");
  expect(asm).not.toMatch(/\br4\b/);
  expect(asm).toMatch(/\br0\b/);
});

test("every checkpoint in the kernel proper is register-only — there is no stack before sp is set", () => {
  for (const c of CHECKPOINTS.filter((c) => c.file === "arch/arm/kernel/head.S")) {
    expect(c.stackSafe).toBeFalsy();
    expect(asmFor(c, "\t")).not.toMatch(/push|pop/);
  }
});

/*
 * ⛔ The C block is stripped and re-applied by the same machinery whose earlier failure (a
 * restore emitted after the end marker) orphaned 6 pops into a flashed image. A comment style
 * the regex does not cover would reintroduce exactly that, so round-trip it explicitly.
 */
test("a C checkpoint strips and re-applies byte-identically", () => {
  const c = CHECKPOINTS.find((x) => x.lang === "c")!;
  const src = `\tchar *x;\n${c.anchor}\n${asmFor(c, c.indent)}\n\tnext();\n`;
  let cur = src;
  for (let i = 0; i < 4; i++) {
    cur = revertFrom(cur).replace(c.anchor, `${c.anchor}\n${asmFor(c, c.indent)}`);
  }
  expect(cur).toBe(src);
  expect(revertFrom(cur)).not.toContain("__cp");
});

test("USERSPACE is still a readable ladder on its own", () => {
  // R moved to FAST's 80 s, so the USERSPACE+R pairing no longer applies; the ladder itself
  // stays valid for locating a kernel regression if FAST reports one.
  assertReadable("USERSPACE", USERSPACE);
});

test("USERSPACE runs deeper = longer, so the deepest point survives longest", () => {
  // Inverted from every earlier profile: with 18 checkpoints a "shorter = further" ladder
  // would need sub-second periods at the shallow end.
  const depth = ["A-decompressor", "C-dtb-done", "D-wont-overwrite", "E-decompressed",
    "B-kernel-proper", "F-cpu-known", "G-atags-ok", "H-pv-patched", "I-page-tables",
    "J-mmu-on", "K-start-kernel", "L-setup-arch", "M-mm-up", "N-time-init", "O-console",
    "P-initcalls", "Q-pre-exec"];
  for (let i = 1; i < depth.length; i++) {
    expect(USERSPACE[depth[i]]!).toBeGreaterThan(USERSPACE[depth[i - 1]]!);
  }
});

// ⛔ The kernel tree persists between builds: without these, a build lacking --checkpoints
// shipped the previous build's SP805 stores and DEBUG_LL (QEMU died silently, 2026-10-11).
test("a build without --checkpoints restores pristine sources and turns DEBUG_LL off", () => {
  const b = require("node:fs").readFileSync(`${import.meta.dir}/build-kernel-arm32.ts`, "utf8");
  expect(b).toContain("${checkpoints ? checkpointStep(version) : pristineStep(version)}");
  expect(b).toMatch(/if \(!armed\) return `\.\/scripts\/config --disable DEBUG_LL`/);
  expect(b).toContain("${ramlog ? RAMLOG_CONFIG : postMmuConfig(checkpoints)}");
  // --ramlog may never ride along with --checkpoints: both claim DEBUG_LL.
  expect(b).toContain('if (ramlog && checkpoints)');
});

test("the pristine restore touches the files, or make keeps the checkpointed objects", () => {
  const b = require("node:fs").readFileSync(`${import.meta.dir}/build-kernel-arm32.ts`, "utf8");
  const fn = b.slice(b.indexOf("function pristineStep"), b.indexOf("function checkpointStep"));
  expect(fn.indexOf("touch ${files.join")).toBeGreaterThan(fn.indexOf("tar -C /ws -xf"));
});

test("patch 0004 keeps the arm32 vDSO off the virtual counter when the kernel uses the physical one", () => {
  const fs = require("node:fs");
  const p = fs.readFileSync(`${import.meta.dir}/kernel/arm32/0004-clocksource-arch_timer-no-arm32-vdso-on-physical-counter.patch`, "utf8");
  expect(p).toContain("+	if (IS_ENABLED(CONFIG_ARM) && rd != arch_counter_get_cntvct &&");
  expect(p).toContain("+		clocksource_counter.vdso_clock_mode = VDSO_CLOCKMODE_NONE;");
  const b = fs.readFileSync(`${import.meta.dir}/build-kernel-arm32.ts`, "utf8");
  expect(b).toContain("0004-vdso-counter.patch");
});
