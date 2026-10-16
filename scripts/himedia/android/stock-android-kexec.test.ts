import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The box script cannot run here (it needs /dev/mem, kexec and the SP805), but its ATAG decoder is
 * pure shell over a dump file: extract just that function, point `dd if=/dev/mem` at a fixture and
 * check what it reports. The decoder is the evidence path for "did U-Boot's tags survive?".
 */
const SCRIPT = readFileSync(join(import.meta.dir, "stock-android-kexec.sh"), "utf8");
const fn = /^atag_dump\(\) \{[\s\S]*?^\}/m.exec(SCRIPT)?.[0] ?? "";

function words(...w: number[]) { const b = Buffer.alloc(w.length * 4); w.forEach((x, i) => b.writeUInt32LE(x >>> 0, i * 4)); return b; }
function tag(id: number, payload: Buffer) {
  const pad = Buffer.concat([payload, Buffer.alloc((4 - (payload.length % 4)) % 4)]);
  return Buffer.concat([words(2 + pad.length / 4, id), pad]);
}
function block(...tags: Buffer[]) { return Buffer.concat([...tags, words(0, 0), Buffer.alloc(4096)]).subarray(0, 4096); }

function run(fixture: Buffer) {
  const dir = mkdtempSync(join(tmpdir(), "atag-"));
  // the fixture is PHYSICAL memory: the block starts at 0x100, like U-Boot leaves it
  writeFileSync(join(dir, "fixture.bin"), Buffer.concat([Buffer.alloc(0x100), fixture]));
  const prelude = `
    LOGDIR=${dir}; STAMP=t; LOG=${dir}/log; ATAG_PHYS=256; ATAG_DUMP_BYTES=4096
    log() { echo "$*" | tee -a "$LOG" >/dev/null; }
    dd() { if [ "$1" = "if=/dev/mem" ]; then command dd if=${dir}/fixture.bin "\${@:2}"; else command dd "$@"; fi; }
    ${fn}
    atag_dump; echo "rc=$?" >> "$LOG"`;
  Bun.spawnSync(["bash", "-c", prelude]);
  return readFileSync(join(dir, "log"), "utf8");
}

describe("atag_dump (box script)", () => {
  test("the function was found", () => expect(fn).toContain("atag_dump()"));
  test("decodes a surviving list: CORE, MEM, CMDLINE, a vendor tag", () => {
    const out = run(block(
      tag(0x54410001, Buffer.alloc(12)),
      tag(0x54410002, words(0x7c900000, 0)),
      tag(0x54410009, Buffer.from("console=ttyAMA0,115200 initrd=0x4000000,0x140D59\0")),
      tag(0x48530001, Buffer.from("pdm_tag=baseparam,0x1000,0x2000\0")),
    ));
    expect(out).toContain("ATAG[0] CORE");
    expect(out).toContain("ATAG[1] MEM  size=4w start=0x0 bytes=0x7c900000");
    expect(out).toContain("CMDLINE: console=ttyAMA0,115200 initrd=0x4000000,0x140D59");
    expect(out).toContain("ATAG[3] id=0x48530001");
    expect(out).toContain("pdm_tag=baseparam");
    expect(out).toContain("VALID list of 4 tags");
    expect(out).toContain("rc=0");
  });
  test("an all-zero page is reported as no ATAG_CORE (rc=2), never as a list", () => {
    const out = run(Buffer.alloc(4096));
    expect(out).toContain("no ATAG_CORE");
    expect(out).toContain("rc=2");
    expect(out).not.toContain("VALID");
  });
  test("garbage (a non-ATAG size word) stops the walk instead of looping", () => {
    const out = run(Buffer.alloc(4096, 0xff));
    expect(out).toContain("no ATAG_CORE");
  });
  test("a DTB magic at 0x100 is not mistaken for an ATAG list", () => {
    const b = Buffer.alloc(4096); b.writeUInt32LE(0xedfe0dd0, 0);
    expect(run(b)).toContain("no ATAG_CORE");
  });
});
