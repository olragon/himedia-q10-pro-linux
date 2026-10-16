import { test, expect, describe } from "bun:test";
import { parseBlkDevParts, partitionSizeBytes, dumpVerdict, RECON, STOCK_FIRMWARE } from "./lib.ts";

describe("parseBlkDevParts", () => {
  test("parses the HiSilicon cmdline form", () => {
    const got = parseBlkDevParts(
      "console=ttyAMA0,115200 blkdevparts=mmcblk0:1M(fastboot),1M(bootargs),8M(kernel),-(system) rootwait",
    );
    expect(got).toEqual([
      { device: "mmcblk0", size: "1M", name: "fastboot" },
      { device: "mmcblk0", size: "1M", name: "bootargs" },
      { device: "mmcblk0", size: "8M", name: "kernel" },
      { device: "mmcblk0", size: "-", name: "system" },
    ]);
  });

  test("returns empty when the cmdline has no blkdevparts — never a guess", () => {
    expect(parseBlkDevParts("console=ttyAMA0,115200 rootwait")).toEqual([]);
  });

  test("handles several devices separated by ;", () => {
    const got = parseBlkDevParts("blkdevparts=mmcblk0:1M(a);sda:2M(b)");
    expect(got.map((p) => `${p.device}/${p.name}`)).toEqual(["mmcblk0/a", "sda/b"]);
  });
});

describe("partitionSizeBytes", () => {
  test("converts K/M/G", () => {
    expect(partitionSizeBytes("1M")).toBe(1048576);
    expect(partitionSizeBytes("8M")).toBe(8388608);
    expect(partitionSizeBytes("2G")).toBe(2147483648);
    expect(partitionSizeBytes("512K")).toBe(524288);
  });

  // "-" means "the rest of the device". A fabricated number here would make a truncated
  // dump look complete, so the only honest answer is null.
  test("refuses to invent a size for '-'", () => {
    expect(partitionSizeBytes("-")).toBeNull();
    expect(partitionSizeBytes("")).toBeNull();
    expect(partitionSizeBytes("8MB")).toBeNull();
  });
});

describe("dumpVerdict — size agreement is not verification", () => {
  const h = "a".repeat(64), h2 = "b".repeat(64);

  test("ok only when size AND hash agree", () => {
    expect(dumpVerdict({ bytes: 100, sha256: h }, { bytes: 100, sha256: h })).toEqual({
      ok: true, reason: "size and sha256 agree on both ends",
    });
  });

  test("same size, different hash is a FAILURE", () => {
    const v = dumpVerdict({ bytes: 100, sha256: h }, { bytes: 100, sha256: h2 });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("sha256 mismatch");
  });

  test("size mismatch is reported with both sizes", () => {
    const v = dumpVerdict({ bytes: 100, sha256: h }, { bytes: 99, sha256: h });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("100");
    expect(v.reason).toContain("99");
  });

  test("a zero-length dump is never ok, even if both ends agree", () => {
    const v = dumpVerdict({ bytes: 0, sha256: h }, { bytes: 0, sha256: h });
    expect(v.ok).toBe(false);
    expect(v.reason).toContain("zero-length");
  });
});

describe("recon safety", () => {
  // Step 1 runs against a stock box we cannot yet restore. A read must never be a write.
  test("every recon command is read-only", () => {
    const forbidden = /\b(setprop|rm|mv|dd|mkfs|reboot|su\b|mount\s|umount|echo\s+\S+\s*>|fastboot|flash)\b/;
    for (const s of RECON) expect(s.cmd).not.toMatch(forbidden);
  });

  test("every recon step says why it exists", () => {
    for (const s of RECON) expect(s.why.length).toBeGreaterThan(15);
  });

  test("covers the questions the research left open", () => {
    const all = RECON.map((s) => s.key + " " + s.why).join(" ");
    expect(all).toMatch(/crypto/i);   // decides a VPN/restic role
    expect(all).toMatch(/USB bridge/i); // native SATA vs a bridge
    expect(all).toMatch(/PCIe/i);     // Wi-Fi vs SATA lane contention
  });
});

describe("stock firmware pointer", () => {
  test("keeps the MEGA decryption fragment — the link is useless without it", () => {
    expect(STOCK_FIRMWARE.url).toContain("#");
    expect(STOCK_FIRMWARE.url.split("#")[1]!.length).toBeGreaterThan(20);
  });

  test("hash starts unknown rather than fabricated", () => {
    expect(STOCK_FIRMWARE.sha256).toBeNull();
  });
});

import { mapPartitions } from "./dump-emmc.ts";

describe("mapPartitions — a mislabelled image restores wrong bytes to the wrong place", () => {
  const CMDLINE = "x blkdevparts=mmcblk0:1M(fastboot),1M(bootargs),10M(recovery),2M(deviceinfo) y";

  test("pairs names to partition indexes", () => {
    const pp = [
      "major minor  #blocks  name", "",
      " 179        0   15267840 mmcblk0",
      " 179        1       1024 mmcblk0p1",
      " 179        2       1024 mmcblk0p2",
      " 179        3      10240 mmcblk0p3",
      " 179        4       2048 mmcblk0p4",
    ].join("\n");
    expect(mapPartitions(pp, CMDLINE).map((p) => `${p.dev}=${p.name}`)).toEqual([
      "mmcblk0p1=fastboot", "mmcblk0p2=bootargs", "mmcblk0p3=recovery", "mmcblk0p4=deviceinfo",
    ]);
  });

  // The bug this pins: with p2 absent, positional pairing would call p3 "bootargs" and
  // p4 "recovery" — so `deviceinfo.img` would hold recovery, and restoring it would write
  // the wrong bytes to a partition that cannot be recovered from any generic image.
  test("a missing partition does NOT shift later labels", () => {
    const pp = [
      "major minor  #blocks  name", "",
      " 179        1       1024 mmcblk0p1",
      " 179        3      10240 mmcblk0p3",
      " 179        4       2048 mmcblk0p4",
    ].join("\n");
    const got = mapPartitions(pp, CMDLINE);
    expect(got.map((p) => `${p.dev}=${p.name}`)).toEqual([
      "mmcblk0p1=fastboot", "mmcblk0p3=recovery", "mmcblk0p4=deviceinfo",
    ]);
    expect(got.find((p) => p.name === "bootargs")).toBeUndefined();
  });

  test("an index beyond the name list keeps its device name, never a borrowed one", () => {
    const pp = " 179        9       4096 mmcblk0p9";
    expect(mapPartitions(pp, CMDLINE)[0].name).toBe("mmcblk0p9");
  });

  test("ignores the whole-disk device and non-mmcblk0 rows", () => {
    const pp = [
      " 179        0   15267840 mmcblk0",
      " 254        0    1048576 zram0",
      " 179       24       4096 mmcblk0rpmb",
      " 179        1       1024 mmcblk0p1",
    ].join("\n");
    expect(mapPartitions(pp, CMDLINE).map((p) => p.dev)).toEqual(["mmcblk0p1"]);
  });
});

import { parseEnv, buildEnv, crc32, usbFirstBootcmd, ENV_SIZE } from "./uboot-env.ts";

describe("U-Boot environment", () => {
  function mkEnv(vars: Array<[string, string]>): Buffer {
    const m = new Map(vars);
    return buildEnv(m);
  }

  test("crc32 matches the known zlib value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xCBF43926);
  });

  test("build then parse round-trips, with a valid CRC", () => {
    const buf = mkEnv([["bootdelay", "0"], ["bootcmd", "mmc read 0 1 2 3"]]);
    expect(buf.length).toBe(ENV_SIZE);
    const p = parseEnv(buf);
    expect(p.crcOk).toBe(true);
    expect(p.vars.get("bootcmd")).toBe("mmc read 0 1 2 3");
  });

  // A corrupt env is SAFE here — U-Boot falls back to compiled-in defaults, which boot from
  // eMMC. So the parser must report the mismatch rather than paper over it.
  test("a flipped byte is reported as a CRC mismatch, not silently accepted", () => {
    const buf = mkEnv([["bootdelay", "0"]]);
    buf[100] ^= 0xff;
    expect(parseEnv(buf).crcOk).toBe(false);
  });

  test("refuses an env that would overflow the block", () => {
    expect(() => mkEnv([["big", "x".repeat(ENV_SIZE)]])).toThrow(/too large/);
  });
});

describe("usbFirstBootcmd — the fallback IS the shell's behaviour", () => {
  const ORIG = "mmc read 0 0x7E700000 0x69000 0x4000;bootm 0x7E700000;mmc read 0 0x1FFBFC0 0x4B000 0xC800; bootm 0x1FFBFC0";

  test("keeps every original command, though no longer as one contiguous tail", () => {
    // The USB attempt is now spliced BETWEEN the two stock stages, so `endsWith` no longer
    // holds — but nothing may be lost.
    const c = usbFirstBootcmd(ORIG);
    for (const part of ORIG.split(";").map((x) => x.trim()).filter(Boolean)) {
      expect(c).toContain(part);
    }
  });

  /*
   * ⛔ This test previously asserted the OPPOSITE — "tries usb before any mmc command" — and
   * that assertion was the bug: it put USB ahead of the TEE load, so a USB-booted kernel got
   * no TrustedCore and therefore no BL31 and no PSCI. Inverted deliberately; it is now the
   * regression test for that failure.
   */
  test("does NOT jump the queue ahead of the TEE load", () => {
    const c = usbFirstBootcmd(ORIG);
    expect(c.indexOf("mmc read")).toBeLessThan(c.indexOf("usb start"));
  });

  // `&&` only exists with U-Boot's hush parser. With `;` a failed fatload just continues to
  // the next command, so the fallback needs no feature we have not verified.
  test("separates with ';' and never '&&'", () => {
    expect(usbFirstBootcmd(ORIG)).not.toContain("&&");
  });

  test("loads to the address the stock bootcmd already uses", () => {
    expect(usbFirstBootcmd(ORIG)).toContain("fatload usb 0:1 0x1FFBFC0 uImage");
  });
});

import { parseDiskInfo, validateTarget } from "./make-recovery-usb.ts";

describe("USB target validation — a wrong device destroys a disk", () => {
  const STICK = `
   Device Node:               /dev/disk4
   Whole:                     Yes
   Device / Media Name:       MassStorageClass
   Removable Media:           Removable
   Internal:                  No
   Disk Size:                 31.3 GB (31281119232 Bytes) (exactly 61095936 512-Byte-Units)
`;

  test("accepts a plain removable external stick", () => {
    expect(validateTarget(parseDiskInfo(STICK))).toEqual([]);
  });

  test("refuses an internal disk", () => {
    const f = parseDiskInfo(STICK.replace("Internal:                  No", "Internal:                  Yes"));
    expect(validateTarget(f).join(" ")).toContain("internal");
  });

  test("refuses non-removable media", () => {
    const f = parseDiskInfo(STICK.replace("Removable Media:           Removable", "Removable Media:           Fixed"));
    expect(validateTarget(f).join(" ")).toContain("not removable");
  });

  test("refuses a partition rather than a whole disk", () => {
    const f = parseDiskInfo(STICK.replace("Whole:                     Yes", "Whole:                     No"));
    expect(validateTarget(f).join(" ")).toContain("not a whole disk");
  });

  // Guards against a large external drive being mistaken for a stick.
  test("refuses an implausibly large disk", () => {
    const f = parseDiskInfo(STICK.replace("(31281119232 Bytes)", "(2000398934016 Bytes)"));
    expect(validateTarget(f).join(" ")).toContain("implausibly large");
  });

  test("refuses an implausibly small one", () => {
    const f = parseDiskInfo(STICK.replace("(31281119232 Bytes)", "(1048576 Bytes)"));
    expect(validateTarget(f).join(" ")).toContain("implausibly small");
  });

  // Every condition must hold, not merely most — so failures accumulate.
  test("reports every reason, not just the first", () => {
    const f = parseDiskInfo(STICK
      .replace("Whole:                     Yes", "Whole:                     No")
      .replace("Internal:                  No", "Internal:                  Yes"));
    expect(validateTarget(f).length).toBeGreaterThanOrEqual(2);
  });
});

describe("log collection is read-only and covers the cross-reboot record", () => {
  test("no source mutates the box", async () => {
    const src = await Bun.file(`${import.meta.dir}/collect-logs.ts`).text();
    const block = src.slice(src.indexOf("SHELL_SOURCES"), src.indexOf("];", src.indexOf("SHELL_SOURCES")));
    // `rm`/`dd`/`setprop` etc. must not appear in any collected command.
    expect(block).not.toMatch(/\b(setprop|rm\s|mv\s|dd\s|mkfs|reboot|umount|>\s*\/(?!dev\/null))/);
  });

  test("collects recovery's own log — the only durable record across a reboot here", async () => {
    const src = await Bun.file(`${import.meta.dir}/collect-logs.ts`).text();
    for (const must of ["/cache/recovery/last_log", "/proc/last_kmsg", "/sys/fs/pstore"]) {
      expect(src).toContain(must);
    }
  });
});

describe("shell scripts embedded in template literals", () => {
  // A backtick inside the template literal closes the string, and bun then reports the parse
  // error at a line far from the real one. This mistake was made twice, so it gets a test.
  const FILES = ["build-kernel-arm32.ts", "build-kernel.ts", "build-rootfs.ts"];

  for (const f of FILES) {
    test(`${f} embeds no backtick inside its shell body`, async () => {
      const src = await Bun.file(`${import.meta.dir}/${f}`).text();
      // Each shell body is assigned from a template literal; check every one of them.
      const bodies = [...src.matchAll(/=\s*`\n([\s\S]*?)\n`;/g)].map((m) => m[1]);
      expect(bodies.length).toBeGreaterThan(0);
      for (const b of bodies) expect(b).not.toContain("`");
    });
  }
});

describe("usbFirstBootcmd must preserve the TEE stage", () => {
  const STOCK = "mmc read 0 0x7E700000 0x69000 0x4000;bootm 0x7E700000;mmc read 0 0x1FFBFC0 0x4B000 0xC800; bootm 0x1FFBFC0";

  // blk 0x69000 = 210 MiB = trustedcore, which carries BL31 and therefore PSCI. Putting the
  // USB attempt in front of it hung BOTH the stock kernel (no keystore) and ours (no PSCI
  // for enable-method="psci"). The TEE load must stay first.
  test("the TEE load runs before the USB attempt", () => {
    const c = usbFirstBootcmd(STOCK);
    expect(c.indexOf("0x69000")).toBeLessThan(c.indexOf("usb start"));
  });

  test("the USB attempt runs before the eMMC kernel load", () => {
    const c = usbFirstBootcmd(STOCK);
    expect(c.indexOf("usb start")).toBeLessThan(c.indexOf("0x4B000"));
  });

  test("both original stages survive verbatim", () => {
    const c = usbFirstBootcmd(STOCK);
    expect(c).toContain("mmc read 0 0x7E700000 0x69000 0x4000");
    expect(c).toContain("mmc read 0 0x1FFBFC0 0x4B000 0xC800");
    expect(c).toContain("bootm 0x7E700000");
  });

  test("still uses ';' and never '&&'", () => {
    expect(usbFirstBootcmd(STOCK)).not.toContain("&&");
  });

  test("a single-stage bootcmd is simply prefixed", () => {
    const one = "mmc read 0 0x1FFBFC0 0x4B000 0xC800; bootm 0x1FFBFC0";
    expect(usbFirstBootcmd(one).startsWith("usb start")).toBe(true);
  });
});
