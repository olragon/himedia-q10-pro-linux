#!/bin/bash
# q10-stock-android — BOX side (installed as /usr/local/sbin/q10-stock-android): kexec the STOCK
# Android 7 kernel (3.18.24 vendor zImage + Android ramdisk) from the running mainline Linux.
#
#   q10-stock-android [--kit DIR] [--watchdog SECS | --no-watchdog] [--dry-run]
#                     [--atags zero|keep] [--atags-only]
#
#   --kit DIR        kit made by `bun run himedia:stock-boot` (default /var/lib/q10/stock-android)
#   --watchdog SECS  arm the SP805 (1..178) before kexec. DEFAULT 178 — a test run.
#   --no-watchdog    do NOT arm it (normal use). ⚠️ see below.
#   --dry-run        verify the kit, `kexec -l`, print /sys/kernel/kexec_loaded, `kexec -u`. Writes
#                    nothing to RAM or registers and never reboots.
#   --atags zero     (default) neutralise U-Boot's ATAG list at physical 0x100 before kexec
#   --atags keep     leave it (see "ATAGs" below — the stale cmdline would win)
#   --atags-only     decode and log the ATAG block, then exit (read-only; harvests U-Boot's pdm_tag)
#
# ⚠️ WATCHDOG. The stock Android kernel may never pet our SP805 (nothing in the stock image is known
# to touch 0xf8a2c000). Armed, the SP805 resets the box on its SECOND expiry (~2 x SECS) and U-Boot
# then boots the stick Linux again — that is the safety net for a test run, and it is also why
# Android "dies" after ~6 minutes at the default 178 s. With --no-watchdog Android stays up, but a
# hang in the vendor kernel then needs a power cycle (the stick kernel cannot take over by itself).
# Period > 178 s wraps the 32-bit LOAD register (24 MHz clock) into a different, shorter window.
#
# ATAGs. The vendor kernel is DT-based but takes memory, cmdline, initrd and `pdm_tag` from ATAGs
# that U-Boot leaves at PHYSICAL 0x100 — fdt_init_hisi()/deal_atags() read that address, NOT r2,
# whenever the first tag is ATAG_CORE. Anything U-Boot left there that survived our Linux would
# override our /chosen bootargs (including U-Boot's `initrd=0x4000000,0x140D59`, which points at
# memory that no longer holds the ramdisk). Zeroing the first tag header makes the DTB the only
# source: deterministic. It is done ONLY if a valid list is found there (proof Linux is not using
# that page), and it writes 16 bytes.
# The price: no `pdm_tag` => the vendor display/logo code falls back to default baseparam.
#
# --image-size=0x6000000 (96 MiB). kexec-tools sizes the kernel's footprint from a tag the stock
# zImage (3.18) does not have, so it would assume 5 x the zImage (~46 MiB). This kernel decompresses
# to a FIXED 0x8000 (`ldr r4,=zreladdr`, not AUTO_ZRELADDR), 21 MB inflated, and is loaded by kexec
# at the bottom of RAM too — so the stub relocates itself above the inflated kernel (~0x1423000) and
# its copy runs to ~0x1CB0000. 96 MiB leaves the initrd and DTB (placed above image-size) far clear
# of all of that and of the kernel's BSS. Same value as the proven mainline recipe (kexec-try.sh).
set -uo pipefail

KIT=/var/lib/q10/stock-android; WD=178; DRY=0; ATAGS=zero; ATAGS_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --kit) KIT=${2:?--kit needs a directory}; shift 2 ;;
    --watchdog) WD=${2:?--watchdog needs seconds}; shift 2 ;;
    --no-watchdog) WD=0; shift ;;
    --dry-run) DRY=1; shift ;;
    --atags) ATAGS=${2:?--atags needs zero|keep}; shift 2 ;;
    --atags-only) ATAGS_ONLY=1; shift ;;
    -h|--help) sed -n '2,/^set -uo/p' "$0" | sed 's/^# \{0,1\}//; /^set -uo/d'; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
case "$ATAGS" in zero|keep) ;; *) echo "--atags must be zero or keep" >&2; exit 2 ;; esac
[ "$WD" -ge 0 ] && [ "$WD" -le 178 ] || { echo "watchdog period $WD s out of range 0..178" >&2; exit 2; }

BB=/bin/busybox
SP805_LOCK=0xf8a2cc00; SP805_LOAD=0xf8a2c000; SP805_CTRL=0xf8a2c008
ATAG_PHYS=256          # 0x100, bytes
ATAG_DUMP_BYTES=4096
LOGDIR=/var/log/q10; mkdir -p "$LOGDIR" 2>/dev/null
STAMP=$(date +%Y%m%d-%H%M%S)
LOG=$LOGDIR/stock-android-$STAMP.log

log() { local m="q10-stock-android: $*"; echo "[$(date +%H:%M:%S)] $m" | tee -a "$LOG"; echo "$m" > /dev/kmsg 2>/dev/null; }
die() { log "REFUSED: $*"; sync; exit "${2:-1}"; }

[ "$(id -u)" = 0 ] || die "must run as root" 2
command -v kexec >/dev/null || die "kexec (kexec-tools) not installed" 2
[ -x "$BB" ] || die "busybox missing (devmem arms the watchdog)" 2
[ -c /dev/mem ] || die "/dev/mem missing (CONFIG_DEVMEM)" 2
log "start: kit=$KIT watchdog=${WD}s dry-run=$DRY atags=$ATAGS running=$(uname -r) log=$LOG"

# ---- ATAG block at physical 0x100: decode (read-only) -------------------------------------------
atag_dump() {
  local bin=$LOGDIR/stock-android-atags-$STAMP.bin
  dd if=/dev/mem of="$bin" bs=256 skip=$((ATAG_PHYS / 256)) count=$((ATAG_DUMP_BYTES / 256)) 2>/dev/null \
    || { log "cannot read /dev/mem @0x100"; return 1; }
  local -a w=($(od -An -v -t u4 "$bin")); local i=0 n=0 core=0
  while [ $i -lt ${#w[@]} ] && [ $n -lt 64 ]; do
    local sz=${w[$i]} id=${w[$((i + 1))]:-0}
    [ "$sz" -ge 2 ] 2>/dev/null && [ "$sz" -le 1024 ] || break
    printf -v hid '0x%08x' "$id"
    case $hid in
      0x54410001) core=1; log "ATAG[$n] CORE size=${sz}w" ;;
      0x54410002) log "ATAG[$n] MEM  size=${sz}w start=$(printf 0x%x "${w[$((i + 3))]}") bytes=$(printf 0x%x "${w[$((i + 2))]}")" ;;
      0x54410009) log "ATAG[$n] CMDLINE: $(dd if="$bin" bs=1 skip=$((i * 4 + 8)) count=$((sz * 4 - 8)) 2>/dev/null | tr -d '\0')" ;;
      0x54420005) log "ATAG[$n] INITRD2 start=$(printf 0x%x "${w[$((i + 2))]}") size=$(printf 0x%x "${w[$((i + 3))]}")" ;;
      0x00000000) break ;;
      *) log "ATAG[$n] id=$hid size=${sz}w (vendor/other) first-bytes: $(dd if="$bin" bs=1 skip=$((i * 4 + 8)) count=$((sz * 4 - 8 > 160 ? 160 : sz * 4 - 8)) 2>/dev/null | tr -c '[:print:]' '.')" ;;
    esac
    i=$((i + sz)); n=$((n + 1))
  done
  if [ $core = 1 ]; then log "ATAG block: VALID list of $n tags survives at 0x100 (raw: $bin)"; return 0; fi
  log "ATAG block: no ATAG_CORE at 0x100 — nothing for the vendor kernel to merge (raw: $bin)"; return 2
}

if [ $ATAGS_ONLY = 1 ]; then atag_dump; rc=$?; sync; exit $((rc == 1 ? 1 : 0)); fi

# ---- verify the kit ------------------------------------------------------------------------------
[ -d "$KIT" ] || die "kit dir $KIT missing" 2
( cd "$KIT" && sha256sum -c SHA256SUMS ) 2>&1 | tee -a "$LOG"
[ "${PIPESTATUS[0]}" = 0 ] || die "kit failed sha256 verification — refusing to boot unverified bytes" 3
for f in zImage stock-android.dtb ramdisk.gz cmdline.txt; do [ -s "$KIT/$f" ] || die "kit file $f missing" 2; done
CMDLINE=$(cat "$KIT/cmdline.txt")
case "$CMDLINE" in *initrd=*) die "cmdline.txt contains initrd= — it would override the DT initrd" 3 ;; esac
log "cmdline: $CMDLINE"

# ---- load ----------------------------------------------------------------------------------------
kexec -u 2>/dev/null
# -d prints the segment layout (kernel/initrd/dtb addresses) — the evidence for the placement above.
kexec -d -l "$KIT/zImage" --dtb="$KIT/stock-android.dtb" --initrd="$KIT/ramdisk.gz" \
  --command-line="$CMDLINE" --image-size=0x6000000 >>"$LOG" 2>&1 \
  || die "kexec -l failed (see $LOG)" 4
LOADED=$(cat /sys/kernel/kexec_loaded)
log "kexec -l ok: kexec_loaded=$LOADED"; grep -E "address=0x" "$LOG" | tail -6
[ "$LOADED" = 1 ] || die "kexec_loaded=$LOADED after kexec -l" 4

atag_dump; ATAG_RC=$?

if [ $DRY = 1 ]; then
  kexec -u; log "dry-run: unloaded, kexec_loaded=$(cat /sys/kernel/kexec_loaded). Nothing written to RAM, no register touched."
  sync; exit 0
fi

# ---- point of no return --------------------------------------------------------------------------
# Only when a VALID list survives (ATAG_RC=0): that proves page 0 is not in use by Linux, so a
# 16-byte write there cannot corrupt live data. Zeroing the first tag header (size + ATAG_CORE id)
# is all the vendor check needs — deal_atags() bails unless word[1] == ATAG_CORE. If no list
# survives there is nothing to neutralise and we write NOTHING into RAM.
if [ "$ATAGS" = zero ] && [ $ATAG_RC -eq 0 ]; then
  dd if=/dev/zero of=/dev/mem bs=16 seek=$((ATAG_PHYS / 16)) count=1 conv=notrunc 2>/dev/null \
    || die "could not zero the ATAG header at 0x100" 5
  [ "$($BB devmem 0x104 32)" = 0x00000000 ] || die "ATAG header not zero after write — /dev/mem write did not land" 5
  log "ATAG_CORE header zeroed at 0x100; the DTB is now the only source (rest of the block kept in RAM)"
elif [ "$ATAGS" = zero ]; then
  log "no valid ATAG list at 0x100 (rc=$ATAG_RC): nothing to neutralise, RAM not written"
fi

if [ "$WD" -gt 0 ]; then
  $BB devmem $SP805_LOCK 32 0x1acce551
  $BB devmem $SP805_LOAD 32 $((WD * 24000000))
  $BB devmem $SP805_CTRL 32 3
  $BB devmem $SP805_LOCK 32 1
  [ "$($BB devmem $SP805_CTRL 32)" = 0x00000003 ] || die "watchdog did not arm (CTRL=$($BB devmem $SP805_CTRL 32)) — refusing to kexec" 5
  log "watchdog ARMED ${WD}s (reset ~$((2 * WD))s after this line if Android does not pet it)"
else
  log "watchdog NOT armed (--no-watchdog): a hung Android needs a power cycle"
fi
sync
log "systemctl kexec in 1 s"
# Backgrounded so an ssh caller gets its prompt back; systemd shuts the root (a loop image on the
# FAT stick) down cleanly first — an unclean kexec could corrupt it.
( sleep 1; systemctl kexec ) >/dev/null 2>&1 &
exit 0
