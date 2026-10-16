/**
 * Guards on the offline boot simulator.
 *
 * ⛔ The uImage CRC check REPLACES one U-Boot has switched off (`verify = n`), so it is the only
 * thing standing between a corrupt flash and a box that executes garbage. A check that cannot
 * fail is not a check — so each one is tested by breaking the thing it checks.
 */
import { test, expect } from "bun:test";
import { readFileSync, existsSync } from "node:fs";
import { parseBlkdevparts, parseEnv, parseBootcmd, readUImage, crc32 } from "./simulate-boot.ts";
import { WORK_ROOT } from "./lib";

const SPEC =
  "androidboot.selinux=disabled console=ttyAMA0,115200 blkdevparts=mmcblk0:" +
  "1M(fastboot),1M(bootargs),10M(recovery),2M(deviceinfo),8M(baseparam),8M(pqparam)," +
  "20M(logo),20M(logobak),40M(fastplay),40M(fastplaybak),40M(kernel),20M(misc)," +
  "40M(trustedcore),1024M(system),1024M(cache),50M(private),800M(backup),8M(securestore),-(userdata)";

test("crc32 matches the known CRC-32 of 'The quick brown fox jumps over the lazy dog'", () => {
  // A published vector, so the table is not merely self-consistent.
  expect(crc32(new TextEncoder().encode("The quick brown fox jumps over the lazy dog")))
    .toBe(0x414fa339);
});

test("blkdevparts resolves the two sectors the stock bootcmd hardcodes", () => {
  const parts = parseBlkdevparts(SPEC);
  expect(parts.length).toBe(19);
  // These are the magic numbers in bootcmd; the whole point is that they are not magic.
  expect(parts.find((p) => p.name === "trustedcore")!.startSector).toBe(0x69000);
  expect(parts.find((p) => p.name === "kernel")!.startSector).toBe(0x4b000);
  expect(parts.find((p) => p.name === "fastboot")!.startSector).toBe(0);
});

test("a trailing '-' partition takes the rest and ends the list", () => {
  const parts = parseBlkdevparts(SPEC);
  const last = parts[parts.length - 1];
  expect(last.name).toBe("userdata");
  expect(last.sizeBytes).toBe(-1);
});

test("bootcmd stages resolve to partition names, and an off-by-one sector resolves to none", () => {
  const parts = parseBlkdevparts(SPEC);
  const ok = parseBootcmd("mmc read 0 0x7E700000 0x69000 0x4000;bootm 0x7E700000", parts);
  expect(ok[0]).toMatchObject({ kind: "mmc-read", part: "trustedcore", count: 0x4000 });
  expect(ok[1]).toMatchObject({ kind: "bootm" });

  // ⛔ A sector that is one off names no partition — the check must notice, not round.
  const bad = parseBootcmd("mmc read 0 0x7E700000 0x69001 0x4000", parts);
  expect(bad[0]).toMatchObject({ kind: "mmc-read", part: undefined });
});

test("the USB stage is recognised and ordered after TrustedCore", () => {
  const parts = parseBlkdevparts(SPEC);
  const s = parseBootcmd(
    "mmc read 0 0x7E700000 0x69000 0x4000;bootm 0x7E700000; usb start;" +
    " fatload usb 0:1 0x1FFBFC0 uImage; bootm 0x1FFBFC0", parts);
  const tee = s.findIndex((x) => x.kind === "mmc-read" && x.part === "trustedcore");
  const usb = s.findIndex((x) => x.kind === "fatload");
  expect(tee).toBeGreaterThanOrEqual(0);
  expect(usb).toBeGreaterThan(tee);
  expect(s[usb]).toMatchObject({ file: "uImage" });
});

test("env CRC validates the real stock block, and one flipped bit breaks it", () => {
  const p = `${WORK_ROOT}/emmc-dump/bootargs.img`;
  if (!existsSync(p)) return;                       // the dump is not in git
  const buf = readFileSync(p);
  expect(parseEnv(buf).crcOk).toBe(true);
  expect(parseEnv(buf).env.bootcmd).toContain("mmc read");

  const bad = Uint8Array.from(buf);
  bad[0x100] ^= 0x01;
  expect(parseEnv(bad).crcOk).toBe(false);
});

test("uImage verification accepts the real image and REJECTS a single corrupt byte", () => {
  const p = `${WORK_ROOT}/kernel-build-arm32/uImage`;
  if (!existsSync(p)) return;
  const buf = readFileSync(p);
  const good = readUImage(buf);
  expect(good.magicOk).toBe(true);
  expect(good.hcrcOk).toBe(true);
  expect(good.dcrcOk).toBe(true);
  expect(good.arch).toBe(2);                        // the loader is 32-bit

  // ⛔ This is the mutation: corrupt one payload byte, exactly as a bad flash would.
  const corrupt = Uint8Array.from(buf);
  corrupt[64 + 4096] ^= 0xff;
  const bad = readUImage(corrupt);
  expect(bad.magicOk).toBe(true);                   // still looks like a uImage
  expect(bad.hcrcOk).toBe(true);                    // header is untouched
  expect(bad.dcrcOk).toBe(false);                   // only the data CRC catches it

  // And a truncated image must fail too, not report a short read as success.
  expect(readUImage(buf.subarray(0, buf.length - 1024)).dcrcOk).toBe(false);
});

test("an arch-mismatched header is detected", () => {
  const p = `${WORK_ROOT}/kernel-build-arm32/uImage`;
  if (!existsSync(p)) return;
  const b = Uint8Array.from(readFileSync(p));
  b[29] = 22;                                       // ARM64
  expect(readUImage(b).arch).toBe(22);
  expect(readUImage(b).hcrcOk).toBe(false);         // and the header CRC notices
});
