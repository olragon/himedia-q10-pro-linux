#!/usr/bin/env bun
/**
 * Build a bare-metal uImage stub — a test image that is deliberately NOT a kernel.
 *
 * ⛔ Six build-and-boot rounds have assumed the stock bootm jumps into our image. Nothing has
 * ever tested that, because every probe we own runs inside Linux. A loader that refuses our
 * image and a kernel that hangs in early boot produce the SAME observation: a frozen vendor
 * logo. This separates them.
 *
 * ⚠️ RECOVERY, and it is the whole safety story: if the stub runs, the box enters a REBOOT
 * LOOP (reset -> U-Boot -> loads the stub from USB -> reset). That is intended and is the
 * signal. To stop it, UNPLUG THE STICK and power-cycle: bootcmd then falls through to the
 * eMMC kernel and Android returns. Nothing is written to eMMC at any point.
 *
 * Usage:
 *   bun run himedia:stub                 # builds wdt-reset, verifies it, prints the plan
 */
import { WORK_ROOT } from "./lib.ts";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { readUImage } from "./simulate-boot.ts";

// The same base the kernel build uses; the toolchain is installed per run.
const IMAGE = "debian:trixie";
const APT = "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq " +
  "--no-install-recommends gcc-arm-linux-gnueabihf binutils-arm-linux-gnueabihf u-boot-tools";
const LOAD = "0x2000000";          // identical to the stock uImage's load AND entry
const OUT = `${WORK_ROOT}/stub`;

async function sh(cmd: string[]) {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  return await p.exited;
}

async function main() {
  const name = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "wdt-reset";
  const src = `${import.meta.dir}/stub/${name}.S`;
  if (!existsSync(src)) { console.error(`no stub source: ${src}`); process.exit(2); }
  mkdirSync(OUT, { recursive: true });

  const body = [
    "set -eux",
    APT,
    "cd /ws",
    // Assemble, link at the load address, flatten, then wrap exactly like the stock image.
    "arm-linux-gnueabihf-as -march=armv7-a -o stub.o stub.S",
    `arm-linux-gnueabihf-ld -Ttext=${LOAD} -o stub.elf stub.o`,
    "arm-linux-gnueabihf-objcopy -O binary stub.elf stub.bin",
    "arm-linux-gnueabihf-objdump -d stub.elf | tail -20",
    "ls -l stub.bin",
    // ⛔ arch=arm (2), NOT arm64: the stock loader is 32-bit and checks this field.
    `mkimage -A arm -O linux -T kernel -C none -a ${LOAD} -e ${LOAD} -n "q10pro ${name}" -d stub.bin uImage`,
  ].join("\n");

  await Bun.write(`${OUT}/stub.S`, readFileSync(src));
  const code = await sh(["docker", "run", "--rm", "-v", `${OUT}:/ws`, "-w", "/ws",
    IMAGE, "bash", "-c", body]);
  if (code !== 0) { console.error("⛔ build failed"); process.exit(1); }

  // Verify it the way the box will NOT: the stock env sets verify=n.
  const u = readUImage(readFileSync(`${OUT}/uImage`));
  const row = (ok: boolean, s: string) => console.log(`  ${ok ? "ok " : "⛔ "} ${s}`);
  console.log(`\n--- ${OUT}/uImage ---`);
  row(u.magicOk, "magic 0x27051956");
  row(u.hcrcOk, "header CRC");
  row(u.dcrcOk, `data CRC over ${u.size} bytes`);
  row(u.arch === 2, `arch = ${u.arch} (2 = ARM 32-bit, which the loader checks)`);
  row(u.load === 0x2000000 && u.ep === 0x2000000,
    `load 0x${u.load.toString(16)} entry 0x${u.ep.toString(16)} — same as the stock image`);
  row(u.size < 4096, `${u.size} bytes — a kernel this small cannot be mistaken for one`);
  if (!u.dcrcOk || u.arch !== 2) process.exit(1);

  console.log(`
--- what this test means ---
  Flash it:  bun run himedia:usb --disk <diskN> --kernel --apply \\
               --image ${OUT}/uImage

  box REBOOTS over and over   => bootm DID jump into our image and our code ran.
                                 The USB path is sound and the fault is inside Linux
                                 early boot. Bisect from there.
  logo stays FROZEN           => our code never executed. bootm is not jumping, and
                                 every kernel round so far has been testing nothing.
  Android boots               => the loader ignored the stick entirely.

⚠️  To stop the loop: UNPLUG THE STICK, then power-cycle. Nothing touches eMMC.`);
}

if (import.meta.main) await main();
