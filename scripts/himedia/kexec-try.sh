#!/bin/bash
# kexec-try.sh <build-name> [watchdog-seconds] — boot a TEST kernel on the Q10 without touching
# the stick. Stages <name>.zImage/.dtb/-modules.tar.gz from the build dir onto the box's rootfs,
# arms the SP805, and `systemctl kexec`s into it (clean shutdown: the root is a loop image on
# the FAT stick, so an unclean kexec could corrupt it).
#
# ⭐ Why kexec: an image written to the stick by the box does not boot, and a hang there is
# before any watchdog (2026-10-11). The stick's uImage is the fallback and is NEVER written.
# Test kernel hangs -> SP805 resets the box -> U-Boot boots the stick kernel -> ssh is back,
# and the failed boot's console is in pstore (ramoops@7a800000), which this script collects.
# SP805 reset = second expiry of LOAD, so the window is ~2x <watchdog-seconds> (default 150).
set -uo pipefail
name=${1:?usage: kexec-try.sh <build-name> [watchdog-seconds]}; wds=${2:-150}
# SP805 LOAD is 32-bit at 24 MHz: >178 s wraps silently into a different window (2026-10-11).
[ "$wds" -ge 1 ] && [ "$wds" -le 178 ] || { echo "watchdog period $wds s out of range 1..178" >&2; exit 2; }
# Q10_KBUILD_ROOT: a second build tree (scripts/himedia/kernel/copy-build-tree.sh) holds other agents' kernels
B=${Q10_KBUILD_ROOT:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/kernel-build-arm32}; H=${Q10_HOST:-root@q10.local}
SSH="ssh -o BatchMode=yes -o ConnectTimeout=5"
here=$(cd "$(dirname "$0")/../.." && pwd)
for f in "$B/$name.zImage" "$B/$name.dtb" "$B/$name-modules.tar.gz"; do
  [ -s "$f" ] || { echo "⛔ missing $f"; exit 2; }; done
rel=$(tar -tzf "$B/$name-modules.tar.gz" | sed -n 's|^lib/modules/\([^/]*\)/.*|\1|p' | head -1)
base=$($SSH $H uname -r) || { echo "⛔ box not reachable over ssh"; exit 2; }
[ "$rel" != "$base" ] || { echo "⛔ test release '$rel' == running '$base' — build with --localversion"; exit 2; }
echo "[local->remote:$H] kexec-try $name  release=$rel  (running $base, watchdog ${wds}s -> reset ~$((2*wds))s)"
$SSH $H "mkdir -p /root/kexec/$name" || exit 2
scp -q -o BatchMode=yes "$B/$name.zImage" "$B/$name.dtb" $H:/root/kexec/$name/ || exit 2
$SSH $H "tar -xzf - -C /" < "$B/$name-modules.tar.gz" || exit 2
# q10_aiao.ko is out-of-tree (scripts/himedia/audio/build.sh): without a copy built for THIS
# release the test kernel boots with no sound card (k15, 2026-10-12). Build it after the kernel.
aiao=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/audio/q10_aiao-$rel.ko
if [ -s "$aiao" ]; then
  $SSH $H "mkdir -p /lib/modules/$rel/extra" && scp -q -o BatchMode=yes "$aiao" $H:/lib/modules/$rel/extra/q10_aiao.ko \
    && echo "staged q10_aiao.ko for $rel"
else echo "⚠️ no $aiao — run scripts/himedia/audio/build.sh after this kernel build, or there is no sound card"; fi
$SSH $H "depmod -a $rel" || exit 2
# The initramfs mounts the SATA root only if it finds /q10-mods/<release>/ahci_platform.ko on the
# stick; without it a test kernel silently falls back to rootfs.img, whose /lib/modules has no
# <release> -> WiFi and SATA units fail and the test runs on the wrong root (hit 2026-10-11, k15).
$SSH $H "set -e; ko=\$(find /lib/modules/$rel -name ahci_platform.ko | head -1); [ -n \"\$ko\" ] && \
  mountpoint -q /mnt/stick && mkdir -p /mnt/stick/q10-mods/$rel && cp \$ko /mnt/stick/q10-mods/$rel/ && sync && \
  echo \"staged \$ko -> stick:/q10-mods/$rel/\"" || echo "⚠️ ahci_platform.ko not staged on the stick: test kernel will use rootfs.img"
# ⛔ --image-size: kexec-tools assumes the kernel decompresses to RAM base + 0x8000 and puts the
# DTB right above its estimate (0x2c0a000). This kernel's decompressor picks base 0x200000
# (fdt_check_mem_start; cold boot runs at 0x208000), so its self-relocation (~13 MB above the
# decompressed image) lands ON the DTB: the kexec'd kernel printed "unrecognized/unsupported
# machine ID" into the RAM ring (2026-10-11). Reserving 96 MiB puts the DTB clear of all of it.
# The test kernel's command line = ITS OWN dtb bootargs + `earlyprintk` (not the running
# kernel's: a test kernel may add arguments, e.g. watchdog.handle_boot_enabled=0).
args=$(dtc -I dtb -O dts "$B/$name.dtb" 2>/dev/null | sed -n 's/^[[:space:]]*bootargs = "\(.*\)";/\1/p')
[ -n "$args" ] || { echo "⛔ no bootargs in $name.dtb"; exit 2; }
# q10.chained=1: the test kernel must not run q10-kexec-chain, which would kexec it straight back to
# the configured target (k19 test booted, then bounced to k18 — read as a failure, 2026-10-12).
echo "cmdline: $args earlyprintk q10.chained=1"
# Formerly: the running one + `earlyprintk` (feeds a --ramlog build's
# RAM ring; harmless otherwise). Its dtb has no appended copy, so this one is what it parses.
$SSH $H "q10-ramlog --clear >/dev/null 2>&1; cd /root/kexec/$name && sha256sum $name.zImage | cut -c1-16 && kexec -l $name.zImage --dtb=$name.dtb --image-size=0x6000000 --command-line=\"$args earlyprintk q10.chained=1\" && cat /sys/kernel/kexec_loaded" || { echo "⛔ kexec -l failed"; exit 3; }
$SSH $H "echo 'q10: kexec-try $name ($rel), watchdog armed ${wds}s' > /dev/kmsg; sync
  busybox devmem 0xf8a2cc00 32 0x1acce551; busybox devmem 0xf8a2c000 32 $((wds * 24000000))
  busybox devmem 0xf8a2c008 32 3; busybox devmem 0xf8a2cc00 32 1
  (sleep 1; systemctl kexec) >/dev/null 2>&1 &"
t0=$(date +%s); echo "kexec at $(date +%H:%M:%S)"
sleep 15; now=""
while [ $(( $(date +%s) - t0 )) -lt $(( 2 * wds + 180 )) ]; do
  now=$($SSH $H uname -r 2>/dev/null) && break; sleep 5; done
dt=$(( $(date +%s) - t0 ))
if [ "$now" = "$rel" ]; then
  echo "✅ test kernel $rel up after ${dt}s"; $SSH $H "uptime; systemctl is-system-running"; exit 0
elif [ -n "$now" ]; then
  echo "❌ box came back on '$now' after ${dt}s — the test kernel failed (watchdog fell back)"
  out=$here/archive/$(date +%Y%m%d-%H%M%S)-kexec-fail-$name-pstore.txt
  $SSH $H 'for f in /sys/fs/pstore/* /var/lib/systemd/pstore/* /var/lib/systemd/pstore/*/*; do [ -f "$f" ] && { echo "=== $f"; cat "$f"; }; done' > "$out" 2>&1
  $SSH $H 'q10-ramlog 2>&1' >> "$out"
  echo "pstore + ramlog -> $out ($(wc -l < "$out") lines)"; sed -n '/=== ramlog/,$p' "$out" | tail -40; exit 1
else
  echo "⛔ box did not come back within ${dt}s"; exit 4
fi
