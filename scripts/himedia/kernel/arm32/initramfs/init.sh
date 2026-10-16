#!/bin/sh
# Second-stage bring-up for the Q10 Pro, exec'd by the static C init. Its only job is to make the kernel OBSERVABLE.
#
# ⛔ Why this exists: mainline has no display driver for this SoC, so the bootloader's logo
# stays frozen on HDMI and a perfectly healthy kernel looks identical to a hang. The kernel
# console goes to ttyAMA0, which is not wired up. So the box must report over Ethernet.
#
# The kernel has already configured eth0 from the `ip=` boot argument (CONFIG_IP_PNP), before
# userspace, so networking is live by the time this runs.

BB=/bin/busybox

# ⛔ MOUNT /dev FIRST, AND WITH NO REDIRECTION.
#
# This block used to sit below the ifconfig alias and carry `2>/dev/null` like every other
# line, and that made the ENTIRE script a no-op. POSIX: "if any of the redirections fail,
# the command shall not be executed." /dev/null lives on devtmpfs, so before this mount it
# does not exist, so `2>/dev/null` fails, so the mount never runs — and /dev stays empty
# forever, taking every later line with it. The kernel was healthy the whole time; the box
# answered ping (CONFIG_IP_PNP configures eth0 before userspace) while nothing here ran.
# The initramfs now also ships a real /dev/console and /dev/null, so this is belt and braces.
$BB mount -t proc     proc /proc
$BB mount -t sysfs    sys  /sys
$BB mount -t devtmpfs dev  /dev

# ⭐ Shell-side watchdog checkpoints, via busybox devmem — the same four SP805 writes init.c makes
# (unlock, load, INTEN|RESEN, re-lock). The USB log failed twice with nothing to say why, because
# every failure in it returns silently; these name the stage. /dev/mem comes from devtmpfs above.
# Load values are literals (seconds x 24 MHz): 150 s overflows a signed 32-bit shell integer.
# ⛔ ONE reporter per boot. CP_SHELL=1 lets init.sh's USB stages own the watchdog; 0 leaves it to
# PID 1's NIC verdict. Two reporters overwrite each other and a reading means nothing.
CP_SHELL=0
cp_arm() {
  [ "$CP_SHELL" = 1 ] || return 0
  $BB devmem 0xf8a2cc00 32 0x1acce551
  $BB devmem 0xf8a2c000 32 $1
  $BB devmem 0xf8a2c008 32 3
  $BB devmem 0xf8a2cc00 32 3
}
# ⛔ SH_STARTED must OUTLAST the time until the next stage arms: info gathering + up to 30 s
# waiting for the stick. It was 5 s, so the box reset 10 s after init.sh started (24.5 s,
# 2026-10-10) while still healthily waiting for USB — a reading produced by the instrument.
CP_SH_STARTED=1560000000    #  65 s  -> ~2:25  init.sh ran, never reached a USB verdict
CP_NO_USB_HOST=336000000    #  14 s  -> ~0:49  no USB root hub registered
# NO_STICK is split by what the HARDWARE says (three NO_STICK readings, two fixes that changed
# nothing — 2026-10-10; stop guessing, read the registers). Pre-time is ~50 s (after the wait).
# The middle of the range is taken (MOUNT_FAIL, SH, R, kernel), so all but the baseline sit past 3:50.
CP_NS_NO_CONNECT=240000000      #  10 s  -> ~1:09  ports powered, nothing electrically connected
CP_NS_DEVICE_NO_DISK=2256000000 #  94 s  -> ~3:55  a USB device enumerated, but no /dev/sd*
CP_NS_EHCI_CONNECT=2544000000   # 106 s  -> ~4:20  EHCI sees a connect, it never enumerated
CP_NS_OHCI_CONNECT=2832000000   # 118 s  -> ~4:45  only the OHCI companion sees a connect
CP_NS_UNPOWERED=3120000000      # 130 s  -> ~5:10  no EHCI port has port power
CP_MOUNT_FAIL=840000000     #  35 s  -> ~1:36-2:02  stick found, vfat mount failed
CP_WRITTEN=3600000000       # 150 s  -> ~5:30  log written
cp_arm $CP_SH_STARTED

# ⛔ devpts is REQUIRED for telnetd: it allocates a pty, and without /dev/pts it dies
# silently at startup. That is exactly what happened on the first observable boot — the box
# answered ping but no port ever listened, which reads as "the shell is broken" rather than
# "the shell never started".
$BB mkdir -p /dev/pts
$BB mount -t devpts devpts /dev/pts

# HDMI: the console draws into the boot-logo framebuffer (simple-framebuffer in the DT), whose
# layer has PER-PIXEL alpha on (G0_CBMPARA 0x11FF, measured). fbcon writes alpha 0, so its text
# would be transparent. Keep global alpha 0xFF, drop palpha_en (bit 12), latch with G0_UPD.
# The logo's own pixels are opaque, so the picture does not change.
$BB devmem 0xf8cc7030 32 0x1ff
$BB devmem 0xf8cc7004 32 1

# --- the real root: Debian on rootfs.img, an ext4 image FILE on the FAT32 boot stick ---------
# ⭐ The stick stays FAT32 because the stock U-Boot loads uImage from it, so the root is a file
# on it, loop-mounted (docs/261011-himedia-ssh-rootfs.md). Every step is checked; any failure
# falls through to the rest of this script — initramfs shell, telnetd, RAM log — unchanged.
# The SP805 is re-armed as a SAFETY NET right before switch_root: the rootfs's
# q10-watchdog-off.service disarms it once sshd is up. A userspace that never gets there
# resets the box into Android, and the journal (forwarded to kmsg) is in the RAM log.
WD_ROOTFS=3600000000        # 150 s load -> reset ~5:30 after switch_root unless disarmed
# --- root on the SATA disk (ext4, LABEL=q10root), opt-in, with a self-healing fallback ---------
# Opt in: create /q10-root-sata-chained on the stick (k26+; see try_sata_root). The SATA driver is a module (the initramfs carries
# none), so it is loaded from the stick: /q10-mods/<release>/ahci_platform.ko.
# ⛔ Anti-lockout: /q10-sata-trying is written (and synced) BEFORE the attempt and removed only once
# the SATA root is mounted and has /sbin/init. If anything hangs, the watchdog (armed by PID 1)
# resets the box; the next boot finds the stale marker, logs it, and boots rootfs.img instead —
# so a dead disk or a bad driver can never cause a boot loop. Remove the marker by hand to retry.
# ⛔ k26+: ONLY the chained kernel mounts a SATA root, and the marker is /q10-root-sata-chained.
# The stick's k14 (its initramfs is frozen inside the never-rewritten uImage) trains the SATA link
# with mainline's PCIe PHY tuning and knows only /q10-root-sata — which must stay absent. Retuning a
# live link from userspace wedged the disk under root I/O (2026-10-14); k26's combphy (0020) tunes
# before the first link training. docs/261014-himedia-sata-kernel-vs-board.md
try_sata_root() {
  $BB grep -q 'q10.chained=1' /proc/cmdline || return 1
  [ -f /stick/q10-root-sata-chained ] || return 1
  if [ -f /stick/q10-sata-trying ]; then
    echo "q10: rootfs: previous SATA-root attempt did not finish — using rootfs.img this boot" > /dev/kmsg
    return 1
  fi
  ko=/stick/q10-mods/$($BB uname -r)/ahci_platform.ko
  [ -f $ko ] || { echo "q10: rootfs: no $ko — using rootfs.img" > /dev/kmsg; return 1; }
  echo "trying $($BB date)" > /stick/q10-sata-trying; $BB sync
  $BB insmod $ko || { echo "q10: rootfs: insmod ahci_platform failed" > /dev/kmsg; $BB rm -f /stick/q10-sata-trying; $BB sync; return 1; }
  i=0; dev=""
  while [ $i -lt 30 ]; do dev=$($BB findfs LABEL=q10root 2>/dev/null) && [ -n "$dev" ] && break; $BB sleep 1; i=$((i+1)); done
  [ -n "$dev" ] || { echo "q10: rootfs: no LABEL=q10root after 30 s" > /dev/kmsg; $BB rm -f /stick/q10-sata-trying; $BB sync; return 1; }
  $BB mkdir -p /newroot
  $BB mount -t ext4 -o rw,noatime $dev /newroot || { echo "q10: rootfs: mount $dev failed" > /dev/kmsg; $BB rm -f /stick/q10-sata-trying; $BB sync; return 1; }
  [ -x /newroot/sbin/init ] || [ -L /newroot/sbin/init ] || { echo "q10: rootfs: no /sbin/init on $dev" > /dev/kmsg; $BB umount /newroot; $BB rm -f /stick/q10-sata-trying; $BB sync; return 1; }
  $BB rm -f /stick/q10-sata-trying; $BB sync
  echo "q10: rootfs: switching to SATA root $dev (LABEL=q10root), watchdog safety net armed" > /dev/kmsg
  $BB mkdir -p /newroot/mnt/stick
  $BB mount --move /stick /newroot/mnt/stick
  $BB devmem 0xf8a2cc00 32 0x1acce551
  $BB devmem 0xf8a2c000 32 $WD_ROOTFS
  $BB devmem 0xf8a2c008 32 3
  $BB devmem 0xf8a2cc00 32 1
  $BB umount /dev/pts
  $BB mount --move /dev  /newroot/dev
  $BB mount --move /proc /newroot/proc
  $BB mount --move /sys  /newroot/sys
  exec $BB switch_root /newroot /sbin/init
}
try_rootfs() {
  i=0; dev=""
  while [ $i -lt 20 ]; do [ -b /dev/sda1 ] && { dev=/dev/sda1; break; }; $BB sleep 1; i=$((i+1)); done
  [ -n "$dev" ] || { echo "q10: rootfs: no /dev/sda1 after 20 s" > /dev/kmsg; return 1; }
  $BB mkdir -p /stick /newroot
  $BB mount -t vfat -o rw,noatime $dev /stick || { echo "q10: rootfs: vfat mount of $dev failed" > /dev/kmsg; return 1; }
  try_sata_root && return 0      # returns only on failure (success never comes back)
  [ -f /stick/rootfs.img ] || { echo "q10: rootfs: no rootfs.img on the stick" > /dev/kmsg; $BB umount /stick; return 1; }
  $BB mount -t ext4 -o loop,rw,noatime /stick/rootfs.img /newroot \
    || { echo "q10: rootfs: loop mount of rootfs.img failed" > /dev/kmsg; $BB umount /stick; return 1; }
  [ -x /newroot/sbin/init ] || [ -L /newroot/sbin/init ] \
    || { echo "q10: rootfs: no /sbin/init in rootfs.img" > /dev/kmsg; $BB umount /newroot; $BB umount /stick; return 1; }
  $BB mkdir -p /newroot/mnt/stick
  $BB mount --move /stick /newroot/mnt/stick
  echo "q10: rootfs: switching to rootfs.img ($dev), watchdog safety net armed" > /dev/kmsg
  $BB devmem 0xf8a2cc00 32 0x1acce551
  $BB devmem 0xf8a2c000 32 $WD_ROOTFS
  $BB devmem 0xf8a2c008 32 3
  $BB devmem 0xf8a2cc00 32 1
  $BB umount /dev/pts
  $BB mount --move /dev  /newroot/dev
  $BB mount --move /proc /newroot/proc
  $BB mount --move /sys  /newroot/sys
  exec $BB switch_root /newroot /sbin/init
}
[ -e /noroot ] || try_rootfs

# ⭐ A THIRD IP, as a pure-ICMP proof that THIS SCRIPT ran. The addresses form a ladder,
# and each rung answers a different question — which is the whole point, because "the box
# pings" was ambiguous for several debugging rounds:
#
#   .56  the kernel booted      — CONFIG_IP_PNP configures eth0 from ip= BEFORE userspace
#   .57  init.c ran             — our static PID 1 raised it by ioctl, on alias eth0:0
#   .58  init.sh ran            — this line, on alias eth0:1
#   .56:80 serves /info.txt     — the whole chain, busybox and networking included
#
# ⛔ It must be a DISTINCT address on a DISTINCT alias. This line used to raise .56 on
# eth0:0: the address the kernel had already configured, so it could never prove anything,
# on the alias init.c uses, so running it would have DELETED the .57 rung below it.
$BB ifconfig eth0:1 192.168.1.58 netmask 255.255.255.0 up

# --- snapshot everything worth knowing, to plain files ---
# Files beat a shell here: they are captured at a known point in boot and can be fetched with
# one HTTP request, no terminal negotiation and no pty involved.
{
  echo "=== uname ==="        ; $BB uname -a
  echo "=== cmdline ==="      ; $BB cat /proc/cmdline
  echo "=== cpuinfo ==="      ; $BB cat /proc/cpuinfo
  echo "=== partitions ==="   ; $BB cat /proc/partitions
  echo "=== interrupts ==="   ; $BB cat /proc/interrupts
  echo "=== iomem ==="        ; $BB cat /proc/iomem
  echo "=== meminfo ==="      ; $BB head -5 /proc/meminfo
  echo "=== net ==="          ; $BB ifconfig -a
  echo "=== block devices ===" ; $BB ls -l /sys/class/block/ 2>/dev/null
  echo "=== drivers bound ===" ; $BB ls /sys/bus/platform/drivers/ 2>/dev/null
  echo "=== scsi/ata ==="     ; $BB ls -l /sys/class/scsi_host/ /sys/class/ata_port/ 2>/dev/null
} > /info.txt 2>&1

$BB dmesg > /dmesg.txt 2>&1

# --- the kernel log, written to the boot stick ------------------------------------------
# ⭐ The box has no console, but PID 1 runs (checkpoint R, 2026-10-10) — so the log goes to the
# same FAT32 stick the uImage came from. One directory per boot under Q10LOG/, never touching
# uImage. Written twice: early (whatever exists now) and late (after 60 s, once probing and
# the NIC have settled), each followed by sync + umount so a watchdog reset cannot leave the
# FAT half-written. Every step is bounded; nothing here may hang or kill PID 1.
# Why did no disk appear? Read the controllers themselves (EHCI 0xf9890000, OHCI 0xf9880000).
# EHCI: CAPLENGTH is byte 0 of the cap regs, HCSPARAMS[3:0] = port count, PORTSCn = op + 0x44 + 4n
# with CCS bit 0, port power bit 12. OHCI: HcRhPortStatus[n] = base + 0x54 + 4n, CCS bit 0.
usb_why() {
  # ⛔ Devices are "1-1", "3-1.2". Root hubs' INTERFACES are "1-0:1.0" and matched the old
  # '^[0-9]*-', so DEVICE_NO_DISK fired whenever any root hub existed (5:25, 2026-10-10).
  if $BB ls /sys/bus/usb/devices/ 2>/dev/null | $BB grep -qE '^[0-9]+-[0-9.]+$'; then
    cp_arm $CP_NS_DEVICE_NO_DISK; return; fi
  cap=$(( 0xf9890000 )); caplen=$(( $($BB devmem $cap 32) & 0xff )); op=$(( cap + caplen ))
  n=$(( $($BB devmem $(( cap + 4 )) 32) & 0xf )); [ $n -gt 0 ] || n=1
  i=0; conn=0; pwr=0
  while [ $i -lt $n ]; do
    ps=$($BB devmem $(( op + 0x44 + 4 * i )) 32)
    [ $(( ps & 1 )) -ne 0 ] && conn=1
    [ $(( ps & 0x1000 )) -ne 0 ] && pwr=1
    i=$((i+1))
  done
  [ $conn -eq 1 ] && { cp_arm $CP_NS_EHCI_CONNECT; return; }
  i=0
  while [ $i -lt $n ]; do
    [ $(( $($BB devmem $(( 0xf9880054 + 4 * i )) 32) & 1 )) -ne 0 ] && { cp_arm $CP_NS_OHCI_CONNECT; return; }
    i=$((i+1))
  done
  [ $pwr -eq 1 ] && cp_arm $CP_NS_NO_CONNECT || cp_arm $CP_NS_UNPOWERED
}
usb_dev() {
  for d in /dev/sda1 /dev/sdb1 /dev/sda /dev/sdb; do [ -b $d ] && { echo $d; return; }; done
}
BOOTDIR=""
usb_log() {   # $1 = tag
  $BB ls -d /sys/bus/usb/devices/usb* >/dev/null 2>&1 || { cp_arm $CP_NO_USB_HOST; return 0; }
  dev=""; i=0
  while [ $i -lt 30 ]; do dev=$(usb_dev); [ -n "$dev" ] && break; $BB sleep 1; i=$((i+1)); done
  [ -n "$dev" ] || { usb_why; return 0; }
  $BB mkdir -p /usb
  $BB mount -t vfat $dev /usb 2>/dev/null || { cp_arm $CP_MOUNT_FAIL; return 0; }
  $BB mkdir -p /usb/Q10LOG
  if [ -z "$BOOTDIR" ]; then
    n=$($BB cat /usb/Q10LOG/next 2>/dev/null); n=${n:-1}
    echo $((n+1)) > /usb/Q10LOG/next
    BOOTDIR=/usb/Q10LOG/boot-$n
  fi
  $BB mkdir -p $BOOTDIR
  $BB dmesg > $BOOTDIR/dmesg-$1.txt 2>&1
  { $BB cat /info.txt
    echo "=== /sys/class/net ==="; $BB ls -l /sys/class/net/
    for f in /sys/class/net/*/operstate /sys/class/net/*/carrier /sys/class/net/*/address; do
      echo "$f: $($BB cat $f 2>&1)"; done
    echo "=== mdio_bus ==="; $BB ls -l /sys/bus/mdio_bus/devices/ 2>&1
    echo "=== deferred ==="; $BB cat /sys/kernel/debug/devices_deferred 2>&1
    echo "=== uptime ==="; $BB cat /proc/uptime
  } > $BOOTDIR/state-$1.txt 2>&1
  $BB sync
  $BB umount /usb
  cp_arm $CP_WRITTEN
}
# ⭐ Put the OTG port into HOST mode. EHCI/OHCI port 0 is muxed by bit 28 of PERI_CTRL+0x12c
# (0xf8a2012c): set = the USB DEVICE controller owns the port, clear = the host. The vendor kernel
# runs a thread (drivers/hisilicon/usbotg/hiotg.c, DWC_OTG_SWITCH) flipping it to probe for a
# connection; mainline has no such driver, so nothing ever selects host. Measured 2026-10-10:
# root hubs registered, no /dev/sd* in 30 s (NO_STICK, 1:02). Switching at runtime is how the
# vendor does it, so EHCI simply sees a connect once the port is ours.
OTG_BEFORE=$($BB devmem 0xf8a2012c 32)
$BB devmem 0xf8a2012c 32 $(( OTG_BEFORE & ~0x10000000 ))
OTG_AFTER=$($BB devmem 0xf8a2012c 32)
echo "otg 0xf8a2012c: before=$OTG_BEFORE after=$OTG_AFTER" >> /info.txt

# ⭐ Everything below also goes into the KERNEL log via /dev/kmsg — and so into the ramoops RAM
# block that stock Android reads back with himd.l (bun run himedia:ramoops). Userspace output is
# otherwise invisible: the RAM console only records printk.
klog() { while IFS= read -r l; do echo "q10: $l" > /dev/kmsg; done; }
# ⭐ The RGMII delay sweep got frames INTO the MAC (rx +4972, straps) but every one arrived with
# length 0 (RX bytes 0, all dropped): the driver reads data_len from the RX BQ descriptor the
# MAC writes back. Dump the rings straight from DRAM (STRICT_DEVMEM is off; busybox devmem is
# O_SYNC, i.e. uncached — exactly what the MAC wrote) to split the two readings:
#   cmd len 0 AND buffer untouched  -> the MAC's DMA writes never land (blocked/mis-addressed)
#   buffer holds a frame, len 0      -> descriptor format/position, not DMA
gmac_dump() {
  g=0xf9841000
  for o in 0x40 0x44 0x64 0x214 0x5c0 0x5c4 0x5cc 0x500 0x504 0x508 0x50c 0x520 0x524 0x528 0x52c; do
    echo "gmac+$o = $($BB devmem $(( g + o )) 32 2>&1)"; done
  fq=$($BB devmem $(( g + 0x500 )) 32); bq=$($BB devmem $(( g + 0x520 )) 32)
  wr=$(( $($BB devmem $(( g + 0x528 )) 32) >> 5 ))
  for k in 1 2 3; do
    i=$(( (wr - k + 1024) % 1024 )); d=$(( bq + i * 32 )); f=$(( fq + i * 32 ))
    ba=$($BB devmem $d 32); cmd=$($BB devmem $(( d + 4 )) 32)
    echo "bq[$i] @$($BB printf 0x%x $d): buff=$ba cmd=$cmd w2=$($BB devmem $(( d + 8 )) 32) w3=$($BB devmem $(( d + 12 )) 32) len=$(( (cmd >> 16) & 0x7ff ))"
    echo "fq[$i] @$($BB printf 0x%x $f): buff=$($BB devmem $f 32) cmd=$($BB devmem $(( f + 4 )) 32)"
    [ $(( ba )) -ne 0 ] && echo "  data@$ba: $($BB devmem $ba 32) $($BB devmem $(( ba + 4 )) 32) $($BB devmem $(( ba + 8 )) 32) $($BB devmem $(( ba + 12 )) 32)"
  done
}
diag() {   # $1 = tag
  { echo "=== diag $1 uptime $($BB cat /proc/uptime)"
    echo "--- ifconfig -a"; $BB ifconfig -a 2>&1
    echo "--- eth0 up attempt"; $BB ifconfig eth0 up 2>&1; echo "rc=$?"
    for f in operstate carrier flags address speed; do echo "eth0/$f: $($BB cat /sys/class/net/eth0/$f 2>&1)"; done
    echo "--- mdio"; for d in /sys/bus/mdio_bus/devices/*; do echo "$d id=$($BB cat $d/phy_id 2>&1)"; done
    echo "--- usb"; $BB ls /sys/bus/usb/devices/ 2>&1
    for d in /sys/bus/usb/devices/[0-9]*-[0-9]*; do [ -e $d/product ] && echo "$d: $($BB cat $d/idVendor 2>/dev/null):$($BB cat $d/idProduct 2>/dev/null) $($BB cat $d/product 2>/dev/null)"; done
    echo "--- block"; $BB ls /sys/class/block/ 2>&1
    echo "--- regs (diff against the working Android values)"
    # + xHCI host1 PORTSC: op base = 0xf98b0000 + CAPLENGTH 0x20; ports at op + 0x400 + 0x10n
    for r in 0xf8a220b0 0xf8a220b8 0xf8a220bc 0xf8a220cc 0xf8a20120 0xf8a20124 0xf8a2012c 0xf9843010 0xf98b0420 0xf98b0430; do
      echo "$r = $($BB devmem $r 32 2>&1)"; done
    echo "--- gmac rings"; gmac_dump
    echo "--- xhci1 USBCMD/USBSTS + irq counts"
    echo "usbcmd=$($BB devmem 0xf98b0020 32) usbsts=$($BB devmem 0xf98b0024 32) iman=$($BB devmem $(( 0xf98b0000 + ($($BB devmem 0xf98b0018 32) & ~0x1f) + 0x20 )) 32)"
    $BB grep -E "xhci|ehci|ohci|eth|gmac" /proc/interrupts
    for d in /sys/bus/usb/devices/usb*; do echo "$d runtime=$($BB cat $d/power/runtime_status 2>&1)"; done
  } 2>&1 | klog
}
diag early
# 2026-10-11: xHCI host1 port 1 read PORTSC 0x6E1 — CCS=1, PLS=Polling, PP=1, CSC=0 — i.e. the
# onboard hub IS attached and waiting for a port reset that usbcore never issued, with no
# usb 3-1 line at all. If the root hub sat runtime-suspended (its wake needs a port-change
# IRQ), forcing it awake re-runs hub_activate, which finds the connection by reading PORTSC.
for d in /sys/bus/usb/devices/usb*; do echo on > $d/power/control; done
echo "q10: usb: root hubs forced to power/control=on" > /dev/kmsg
( $BB sleep 20; diag t20 ) &

# USB: the working Android system has CRG 0xb0 bit 17 (USB3_REF_CKEN1, host1's reference clock)
# SET; mainline has no clock for it and leaves it clear (0x007D0060 vs 0x007f007f). Turn it on
# before waiting for the stick — the onboard hub may simply appear once the port has a ref clock.
$BB devmem 0xf8a220b0 32 $(( $($BB devmem 0xf8a220b0 32) | 0x20000 ))
echo "q10: usb: CRG 0xb0 after REF_CKEN1 = $($BB devmem 0xf8a220b0 32)" > /dev/kmsg

usb_log early
( $BB sleep 60; usb_log late ) &

# --- serve them: httpd needs no pty, so it works even when telnetd cannot ---
$BB httpd -p 80 -h / 2>/dev/null

# A shell too, now that devpts exists — useful for poking at things interactively.
$BB telnetd -l /bin/sh 2>/dev/null

# Record what actually came up, so a later fetch can tell a failed daemon from a failed boot.
( $BB sleep 2; { echo "=== listening ==="; $BB netstat -ltn 2>/dev/null; } >> /info.txt ) &

# Staying alive is the signal: if the box answers ping, the kernel booted and the GbE driver
# and device tree are correct. Exiting would panic the kernel and take the network with it.
while : ; do $BB sleep 30 ; done
