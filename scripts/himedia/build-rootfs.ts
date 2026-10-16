#!/usr/bin/env bun
/**
 * Build a minimal Debian rootfs for the Q10 Pro, as an ext4 IMAGE FILE.
 *
 * ⭐ armhf by default: the box runs an AArch32 mainline kernel (docs/261011-himedia-ssh-rootfs.md).
 * The image lives as a plain file on the FAT32 boot stick — the stick must stay FAT32 because
 * the stock U-Boot loads uImage from it — and init.sh loop-mounts it and switch_roots.
 *
 * Runs debootstrap in a native arm64 container. ⚠️ Apple silicon has no AArch32, so the armhf
 * second stage runs through the Docker VM's qemu binfmt handler — slow but unattended.
 * ⛔ Never `--platform linux/arm/v7 debian:trixie`: it re-tags the local debian:trixie as armv7
 * and every later arm64 build silently runs emulated (2026-10-10).
 *
 * ⛔ Output goes to $HIMEDIA_ROOT, never the repo.
 *
 * Deliberately small: this box has 1.85 GiB of usable RAM and four A53 cores, so it is a
 * quiet file/sync/DNS server, not a desktop. No X, no snapd, no desktop metapackages.
 *
 * ⚠️ Key-only SSH. No root password is set, so the only way in is the authorized key
 * baked in at build time — a box with a known default password on a LAN is a liability,
 * and one with no password and no key is a brick you cannot log into. If no key is found
 * the build REFUSES rather than quietly producing an inaccessible rootfs.
 *
 * Usage:
 *   bun run himedia:rootfs                        # Debian trixie armhf, hostname q10
 *   bun run himedia:rootfs --arch arm64
 *   bun run himedia:rootfs --hostname q10 --key ~/.ssh/id_rsa.pub
 */
import { WORK_ROOT, DEVICE } from "./lib.ts";
import { mkdirSync, existsSync, readFileSync, writeFileSync, statSync } from "node:fs";

const ROOT = `${WORK_ROOT}/rootfs`;
const IMAGE = "debian:trixie";

/** What a headless always-on server on this box actually needs. */
const PACKAGES = [
  "systemd-sysv", "systemd-timesyncd", "udev", "kmod",
  "openssh-server", "ca-certificates", "iproute2", "iputils-ping", "isc-dhcp-client",
  "e2fsprogs", "parted", "gdisk", "util-linux", "mount",
  // busybox for `devmem`: the unit that disarms the SP805 safety net once sshd is up
  "busybox",
  "nano", "less", "curl", "htop", "tmux", "rsync",
  "locales", "tzdata",
  // ⛔ minbase has no D-Bus: timedatectl/resolvectl/hostnamectl all fail with "Failed to
  // connect to system scope bus" (first box boot, 2026-10-11).
  "dbus",
].join(",");

async function sh(cmd: string[], timeoutMs = 2_400_000) {
  const p = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit" });
  const t = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
  const code = await p.exited;
  clearTimeout(t);
  return code;
}

function findKey(explicit?: string): string | null {
  const candidates = explicit ? [explicit.replace(/^~/, process.env.HOME!)] :
    ["id_ed25519.pub", "id_rsa.pub", "id_rsa_erpfit.pub"].map((f) => `${process.env.HOME}/.ssh/${f}`);
  for (const c of candidates) {
    if (existsSync(c)) {
      const k = readFileSync(c, "utf8").trim();
      if (/^(ssh-|ecdsa-)/.test(k)) return k;
    }
  }
  return null;
}

async function main() {
  const argv = process.argv.slice(2);
  const arg = (f: string, d?: string) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };
  const suite = arg("--suite", "trixie")!;
  const arch = arg("--arch", "armhf")!;
  if (!["armhf", "arm64"].includes(arch)) { console.error(`⛔ --arch armhf|arm64, not ${arch}`); process.exit(2); }
  const host = arg("--hostname", "q10")!;
  const key = findKey(arg("--key"));

  if (!key) {
    console.error("⛔ No SSH public key found (~/.ssh/id_ed25519.pub, id_rsa.pub, id_rsa_erpfit.pub).");
    console.error("   Refusing to build: with no password set and no key installed, the rootfs");
    console.error("   would boot into something you cannot log into. Pass --key <path>.");
    process.exit(1);
  }

  mkdirSync(ROOT, { recursive: true });
  writeFileSync(`${ROOT}/authorized_keys`, key + "\n");
  writeFileSync(`${ROOT}/q10-modprobe-guarded.sh`, readFileSync(new URL("./tools/q10-modprobe-guarded.sh", import.meta.url)));
  writeFileSync(`${ROOT}/q10-sata.service`, readFileSync(new URL("./rootfs-units/q10-sata.service", import.meta.url)));
  writeFileSync(`${ROOT}/q10-sata-phy-tune.sh`, readFileSync(new URL("./tools/q10-sata-phy-init.sh", import.meta.url)));
  writeFileSync(`${ROOT}/q10-sata-phy-tune.service`, readFileSync(new URL("./rootfs-units/q10-sata-phy-tune.service", import.meta.url)));
  writeFileSync(`${ROOT}/q10-hud.service`, readFileSync(new URL("./rootfs-units/q10-hud.service", import.meta.url)));
  writeFileSync(`${ROOT}/q10-keymap.service`, readFileSync(new URL("./rootfs-units/q10-keymap.service", import.meta.url)));
  writeFileSync(`${ROOT}/q10-wifi.service`, readFileSync(new URL("./rootfs-units/q10-wifi.service", import.meta.url)));
  writeFileSync(`${ROOT}/q10-untested.conf`, readFileSync(new URL("./rootfs-units/q10-untested.conf", import.meta.url)));
  writeFileSync(`${ROOT}/q10-watchdog.conf`, readFileSync(new URL("./rootfs-units/q10-watchdog.conf", import.meta.url)));
  writeFileSync(`${ROOT}/q10-wifi-up.sh`, readFileSync(new URL("./rootfs-units/q10-wifi-up.sh", import.meta.url)));
  writeFileSync(`${ROOT}/himedia_q10.toml`, readFileSync(new URL("./rootfs-units/himedia_q10.toml", import.meta.url)));
  writeFileSync(`${ROOT}/q10-reset-on-reboot.sh`, readFileSync(new URL("./rootfs-units/q10-reset-on-reboot.sh", import.meta.url)));
  writeFileSync(`${ROOT}/fstab-mybook.txt`, readFileSync(new URL("./rootfs-units/fstab-mybook.txt", import.meta.url)));

  /*
   * Fleet conventions this box must follow once adopted:
   *  - FQDN under localdomain, with the SHORT hostname left alone
   *  - 127.0.0.1 keeps localhost; the real name goes on the real address, not 127.0.1.1
   */
  writeFileSync(`${ROOT}/hosts`, [
    "127.0.0.1\tlocalhost",
    "::1\t\tlocalhost ip6-localhost ip6-loopback",
    `# The FQDN deliberately leads; \`hostname -f\` returns the FIRST name on the line.`,
    `# ⚠️ .local is reserved for mDNS (RFC 6762), so this is a label, not a resolvable name.`,
    `127.0.1.1\t${host}.localdomain ${host}`,
    "",
  ].join("\n"));

  const OUT = `${host}-${suite}-${arch}-rootfs.img`;
  const STATIC_IP = process.env.Q10_STATIC_IP ?? "192.168.1.56";  // = BRINGUP_IP in build-kernel-arm32.ts
  const stage = `
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
  debootstrap arch-test e2fsprogs ca-certificates >/dev/null

# ⛔ Build on CONTAINER-LOCAL storage, not on the bind-mounted host volume. debootstrap
# bind-mounts /dev/null inside the target and the host mount refuses it ("Cannot install
# into target mounted with noexec"); an external host filesystem would also mangle unix
# permissions and symlinks. Only the finished tarball crosses back to /ws.
TARGET=/tmp/${host}-${suite}-${arch}
rm -rf "\$TARGET"; mkdir -p "\$TARGET"

# Native arm64 container; an armhf target's second stage runs via the VM's qemu binfmt.
arch-test ${arch}
debootstrap --arch=${arch} --variant=minbase \
  --include=${PACKAGES} \
  ${suite} "\$TARGET" http://deb.debian.org/debian

# --- identity ---
echo '${host}' > "\$TARGET/etc/hostname"
cp /ws/hosts "\$TARGET/etc/hosts"

# --- ssh: key only, no passwords at all ---
install -d -m 700 "\$TARGET/root/.ssh"
cp /ws/authorized_keys "\$TARGET/root/.ssh/authorized_keys"
chmod 600 "\$TARGET/root/.ssh/authorized_keys"
cat > "\$TARGET/etc/ssh/sshd_config.d/10-q10.conf" <<'EOF'
PermitRootLogin prohibit-password
PasswordAuthentication no
KbdInteractiveAuthentication no
EOF
# Root is locked (no password hash), so console login is impossible by design — the
# serial console still gives a bootloader and kernel log, which is what rescue needs.
sed -i 's|^root:[^:]*:|root:*:|' "\$TARGET/etc/shadow"

# --- networking: the same static address the kernel's ip= already gave eth0 -------------
# ⭐ Static, not DHCP: the box must come up where the bring-up tooling (and ssh) look for it,
# and a lease would move it. .56 is outside the router's pool and verified free.
cat > "\$TARGET/etc/systemd/network/10-eth.network" <<'EOF'
[Match]
Name=eth0

[Network]
Address=${STATIC_IP}/24
Gateway=192.168.1.1
DNS=192.168.1.1
DNS=1.1.1.1
KeepConfiguration=yes
EOF
ln -sf /lib/systemd/system/systemd-networkd.service \
  "\$TARGET/etc/systemd/system/multi-user.target.wants/systemd-networkd.service"
ln -sf /lib/systemd/system/systemd-resolved.service \
  "\$TARGET/etc/systemd/system/multi-user.target.wants/systemd-resolved.service" 2>/dev/null || true

# --- the boot log reaches the RAM console ------------------------------------------------
# ⭐ ramoops records printk only. Forwarding the journal to kmsg is what lets a hung or
# crashed userspace still be read back through Android (bun run himedia:ramoops).
install -d "\$TARGET/etc/systemd/journald.conf.d"
cat > "\$TARGET/etc/systemd/journald.conf.d/10-q10-kmsg.conf" <<'EOF'
[Journal]
ForwardToKMsg=yes
MaxLevelKMsg=info
EOF

# --- the watchdog safety net: disarmed only once sshd is up --------------------------------
# init.sh arms the SP805 just before switch_root. If userspace never reaches sshd, the box
# resets into Android and the RAM log says why; if it does, this unit stands the dog down.
cat > "\$TARGET/etc/systemd/system/q10-watchdog-off.service" <<'EOF'
[Unit]
Description=Q10: disarm the boot safety-net watchdog once sshd is up
After=ssh.service
Requires=ssh.service

[Service]
Type=oneshot
ExecStart=/bin/busybox devmem 0xf8a2cc00 32 0x1acce551
ExecStart=/bin/busybox devmem 0xf8a2c008 32 0
ExecStart=/bin/busybox devmem 0xf8a2cc00 32 1
ExecStart=/bin/sh -c 'echo "q10: watchdog disarmed by rootfs, ctrl=$(/bin/busybox devmem 0xf8a2c008 32)" > /dev/kmsg'

[Install]
WantedBy=multi-user.target
EOF
ln -sf /etc/systemd/system/q10-watchdog-off.service \
  "\$TARGET/etc/systemd/system/multi-user.target.wants/q10-watchdog-off.service"
install -d "\$TARGET/mnt/stick"

# --- SATA: never auto-loaded (a built-in probe hung the box, 2026-10-11) ---
# Loaded by hand with the watchdog armed: q10-modprobe-guarded <module>. Same files as
# deploy-modules.sh installs on a live box.
install -d "\$TARGET/etc/modprobe.d" "\$TARGET/usr/local/sbin"
printf 'blacklist phy_histb_combphy\nblacklist ahci_platform\n' > "\$TARGET/etc/modprobe.d/q10-sata.conf"
install -m 644 /ws/q10-untested.conf "\$TARGET/etc/modprobe.d/q10-untested.conf"
install -m 755 /ws/q10-modprobe-guarded.sh "\$TARGET/usr/local/sbin/q10-modprobe-guarded"
# vendor PHY tuning after every ahci_platform load (mainline's nano[1]=0x8 leaves SATA marginal)
install -m 755 /ws/q10-sata-phy-tune.sh "\$TARGET/usr/local/sbin/q10-sata-phy-tune"
install -m 644 /ws/q10-sata-phy-tune.service "\$TARGET/etc/systemd/system/q10-sata-phy-tune.service"
install -d "\$TARGET/etc/systemd/system/sysinit.target.wants"
ln -sf /etc/systemd/system/q10-sata-phy-tune.service \
  "\$TARGET/etc/systemd/system/sysinit.target.wants/q10-sata-phy-tune.service"
install -m 644 /ws/q10-sata.service "\$TARGET/etc/systemd/system/q10-sata.service"
ln -sf /etc/systemd/system/q10-sata.service \
  "\$TARGET/etc/systemd/system/multi-user.target.wants/q10-sata.service"
install -d "\$TARGET/mnt/mybook"
# ⛔ reboot must end in a watchdog reset: mainline has no restart handler for this SoC.
install -m 644 /ws/q10-hud.service "\$TARGET/etc/systemd/system/q10-hud.service"
install -m 644 /ws/q10-keymap.service "\$TARGET/etc/systemd/system/q10-keymap.service"
install -m 644 /ws/q10-wifi.service "\$TARGET/etc/systemd/system/q10-wifi.service"
install -d "\$TARGET/etc/systemd/system.conf.d"
install -m 644 /ws/q10-watchdog.conf "\$TARGET/etc/systemd/system.conf.d/q10-watchdog.conf"
ln -sf /etc/systemd/system/q10-wifi.service "\$TARGET/etc/systemd/system/multi-user.target.wants/q10-wifi.service"
install -m 755 /ws/q10-wifi-up.sh "\$TARGET/usr/local/sbin/q10-wifi-up"
ln -sf /etc/systemd/system/q10-keymap.service "\$TARGET/etc/systemd/system/multi-user.target.wants/q10-keymap.service"
install -d "\$TARGET/etc/rc_keymaps"
install -m 644 /ws/himedia_q10.toml "\$TARGET/etc/rc_keymaps/himedia_q10.toml"
install -d "\$TARGET/usr/lib/systemd/system-shutdown"
install -m 755 /ws/q10-reset-on-reboot.sh "\$TARGET/usr/lib/systemd/system-shutdown/q10-reset-on-reboot"

# --- serial console on ttyAMA0: confirmed from the stock cmdline ---
ln -sf /lib/systemd/system/serial-getty@.service \
  "\$TARGET/etc/systemd/system/getty.target.wants/serial-getty@ttyAMA0.service"

# --- fstab: root by UUID is filled in at deploy time, never by drive letter ---
cat > "\$TARGET/etc/fstab" <<'EOF'
# Root is mounted by the initramfs (rootfs.img on the FAT32 stick, via loop) — nothing here.
# The stick stays mounted at /mnt/stick: it backs the root filesystem, never unmount it.
# ⛔ When root moves to the SATA disk, address it by UUID, never by device letter.
EOF
cat /ws/fstab-mybook.txt >> "\$TARGET/etc/fstab"

echo 'LANG=C.UTF-8' > "\$TARGET/etc/default/locale"
# The Mac's ssh sends LC_ALL=en_US.UTF-8; without it every login prints a setlocale warning.
sed -i 's/^# *en_US.UTF-8/en_US.UTF-8/' "\$TARGET/etc/locale.gen"
chroot "\$TARGET" locale-gen

# ⛔ debootstrap inside Docker leaves Docker's resolv.conf ("nameserver 0.250.250.200"), which
# does not exist on the LAN: no DNS, so timesyncd never syncs and the clock sat at the image
# build date (first box boot, 2026-10-11). Write the LAN's resolvers explicitly.
rm -f "\$TARGET/etc/resolv.conf"
printf 'nameserver 192.168.1.1\nnameserver 1.1.1.1\n' > "\$TARGET/etc/resolv.conf"

# ⛔ Pin NTP servers: the Debian pool handed out 103.184.124.254, ~7.5 MIN fast (measured
# against time.apple.com and pool.ntp.org from the Mac, 2026-10-11), and timesyncd trusts one.
install -d "\$TARGET/etc/systemd/timesyncd.conf.d"
printf '[Time]\nNTP=time.cloudflare.com time.apple.com\nFallbackNTP=time.google.com\n' > "\$TARGET/etc/systemd/timesyncd.conf.d/10-q10.conf"

du -sh "\$TARGET"
# ⭐ ext4 image, populated straight from the tree (mkfs -d keeps owners, modes and symlinks).
# Sized to the content plus 768 MiB of headroom; FAT32 caps a file at 4 GiB.
SIZE_MB=\$(( \$(du -sm "\$TARGET" | cut -f1) + 768 ))
rm -f /ws/${OUT}
mkfs.ext4 -q -F -L q10root -d "\$TARGET" /ws/${OUT} \${SIZE_MB}M
e2fsck -fn /ws/${OUT}
ls -l /ws/${OUT}
`;

  console.log(`[local] ${DEVICE.model} rootfs: Debian ${suite} ${arch}, hostname ${host}`);
  console.log(`[local] ssh key: ${key.split(/\s+/)[0]} …${key.slice(-24)}`);
  console.log(`[local] -> ${ROOT}\n`);

  // debootstrap bind-mounts /proc and /dev inside its target, which needs SYS_ADMIN.
  const code = await sh(["docker", "run", "--rm", "--platform", "linux/arm64", "--cap-add", "SYS_ADMIN", "--security-opt", "apparmor=unconfined",
    "-v", `${ROOT}:/ws`, "-w", "/ws", IMAGE, "bash", "-eux", "-c", stage]);
  if (code !== 0) { console.error(`\n⛔ rootfs build failed (exit ${code})`); process.exit(1); }

  const img = `${ROOT}/${OUT}`;
  if (!existsSync(img)) { console.error(`⛔ expected ${img}`); process.exit(1); }
  console.log(`\n✅ ${img}  (${(statSync(img).size / 1048576).toFixed(0)} MiB)`);
  console.log(`
Deploy: copy it to the boot stick's FAT32 root as rootfs.img, next to uImage.
init.sh finds it, loop-mounts it and switch_roots; with no image it stays in the initramfs.`);
}

if (import.meta.main) await main();
