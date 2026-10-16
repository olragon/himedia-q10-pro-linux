#!/bin/sh
# q10-wd-run <command...> — run a risky command (GPU, new driver) under the SP805 watchdog.
# Arms 60 s and pets every 20 s from a background loop: a hung kernel stops the pets and the box
# resets into the stick kernel in ~2 min; a slow but alive command never trips it. Raises printk
# to 7 for the run so faults and panics reach console-ramoops (pstore) if it does reset.
# Always disarms (control register only — never LOAD=0, which expires at once) and restores printk.
BB=/bin/busybox
wd() { $BB devmem 0xf8a2cc00 32 0x1acce551; "$@"; $BB devmem 0xf8a2cc00 32 1; }
wd $BB devmem 0xf8a2c000 32 $((60 * 24000000)); wd $BB devmem 0xf8a2c008 32 3
[ "$($BB devmem 0xf8a2c008 32)" = "0x00000003" ] || { echo "q10-wd-run: watchdog did not arm — refusing" >&2; exit 3; }
( while sleep 20; do wd $BB devmem 0xf8a2c00c 32 1; done ) & petter=$!
old=$(cut -f1 /proc/sys/kernel/printk); echo 7 > /proc/sys/kernel/printk
echo "q10-wd-run: $*" > /dev/kmsg
cleanup() { kill $petter 2>/dev/null; wd $BB devmem 0xf8a2c008 32 0; echo "$old" > /proc/sys/kernel/printk; }
trap cleanup EXIT INT TERM
"$@"
