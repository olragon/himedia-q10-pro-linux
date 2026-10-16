#!/usr/bin/env bun
/**
 * Build (or rebuild) the cached kernel-builder image, `himedia-kbuild-arm32:trixie`.
 *
 * build-kernel-arm32 uses it when present and falls back to plain debian:trixie + apt when not,
 * so this is an accelerator, never a dependency. Rebuild after changing the Dockerfile or to pick
 * up toolchain updates: `bun run himedia:builder`.
 */
export const BUILDER_IMAGE = "himedia-kbuild-arm32:trixie";

if (import.meta.main) {
  const dir = `${import.meta.dir}/builder`;
  console.log(`[local] docker build -t ${BUILDER_IMAGE} ${dir}`);
  const p = Bun.spawn(["docker", "build", "--platform", "linux/arm64", "-t", BUILDER_IMAGE, dir],
    { stdout: "inherit", stderr: "inherit" });
  const code = await p.exited;
  if (code !== 0) { console.error(`⛔ docker build failed (${code})`); process.exit(code); }
  // Prove the toolchain is really in the image, not merely that docker exited 0.
  const v = Bun.spawnSync(["docker", "run", "--rm", BUILDER_IMAGE, "arm-linux-gnueabihf-gcc", "--version"]);
  const first = new TextDecoder().decode(v.stdout).split("\n")[0];
  if (v.exitCode !== 0 || !first) { console.error("⛔ image built but the cross gcc does not run"); process.exit(1); }
  // ⛔ And prove it is NATIVE: an arm/v7 image runs emulated on Apple Silicon and is the trap
  // this file was rebuilt to escape.
  const arch = new TextDecoder().decode(
    Bun.spawnSync(["docker", "run", "--rm", BUILDER_IMAGE, "uname", "-m"]).stdout).trim();
  if (arch !== "aarch64") { console.error(`⛔ image runs as ${arch}, expected aarch64`); process.exit(1); }
  // The cross toolchain must build a STATIC armhf binary, which is what PID 1 is — compile one.
  const cc = Bun.spawnSync(["docker", "run", "--rm", BUILDER_IMAGE, "sh", "-c",
    "printf '#include <stdio.h>\\nint main(void){puts(\"ok\");return 0;}\\n' > /t.c && " +
    "arm-linux-gnueabihf-gcc -static -O2 -o /t /t.c && file /t"]);
  const ccOut = new TextDecoder().decode(cc.stdout);
  if (cc.exitCode !== 0 || !/ARM, EABI5.*statically linked/.test(ccOut)) {
    console.error("⛔ the cross gcc cannot build a static armhf binary:\n" + new TextDecoder().decode(cc.stderr));
    process.exit(1);
  }
  const bb = Bun.spawnSync(["docker", "run", "--rm", BUILDER_IMAGE, "sh", "-c", "ls /opt/armhf/busybox-static_*_armhf.deb"]);
  if (bb.exitCode !== 0) { console.error("⛔ armhf busybox .deb missing from the image"); process.exit(1); }
  console.log(`✅ ${BUILDER_IMAGE}: ${first} · ${arch} · armhf busybox baked in · static armhf compile OK`);
}
