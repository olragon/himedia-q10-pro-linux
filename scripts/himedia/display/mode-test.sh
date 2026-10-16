#!/bin/bash
# mode-test.sh — ON THE BOX: display mode-switching tests for histb_vdp + histb_hdmi, every one under the
# SP805 watchdog (q10-wd-run) with a dead-man on the process that holds the mode.
#
#   mode-test.sh snap                    read-only: link state, TX/VDP registers, the connector's mode list
#   mode-test.sh list                    the connector's modes with the index modetest uses
#   mode-test.sh try <WxH@HZ> [hold=15]  switch to that mode for <hold> s, then release (see "how it reverts")
#   mode-test.sh stage1|stage2|stage3    the plan: 1080p rates / 720p / 2160p30 + 2160p60
#   mode-test.sh selftest                the mode picker against a canned modetest listing (no hardware)
#
# ⭐ How it reverts: `modetest -s` holds the mode only while it runs.  When it exits (the hold ends, or the
#   dead-man below kills it) the DRM master is dropped and the fbdev client restores ITS configuration - the
#   boot mode - through the same driver path, i.e. one more mode switch.  A switch that leaves the TV blank
#   therefore heals itself ~<hold> s later (dead-man: modetest is SIGKILLed at <hold>+5 s, i.e. 20 s with the
#   default hold, in case it wedges).  If the kernel itself hangs, nobody pets the SP805 and the box resets
#   into the stick kernel in ~2 min (q10-wd-run).
# ⛔ Run `snap` BEFORE the first `try` and keep its output: it is the reference for "what the bootloader left".
# The session that owns the card (q10-desktop / q10-kodi) is stopped for the run and restarted after;
#   Q10_KEEP_SESSION=1 leaves it alone (then modetest cannot become master - for compositor tests only).
set -u
[ "${1:-}" = selftest ] || { [ -z "${Q10_WD:-}" ] && Q10_WD=1 exec q10-wd-run "$0" "$@"; }

DEAD=${Q10_DEADMAN:-5}         # seconds past <hold> after which modetest is killed: 15 s hold + 5 s = the 20 s dead-man
MT="modetest -M histb-vdp"

card_dir() {
  local d
  for d in /sys/kernel/debug/dri/*/name; do
    grep -q histb-vdp "$d" 2>/dev/null && { echo "${d%/name}"; return; }
  done
}

# ---- parsing (pure: reads modetest output on stdin) ---------------------------------------------
# connector id of the first connected connector
parse_conn() { awk -F'\t' '$3=="connected"{print $1; exit}'; }
# first CRTC id
parse_crtc() { awk '/^CRTCs:/{f=1;next} f&&/^[0-9]+\t/{print $1; exit}'; }
# mode index for WxH@Hz (tolerance 0.02 Hz; 23.976 and 23.98 are the same mode)
parse_mode_index() { # $1 = WxH@Hz
  local want=${1%@*} hz=${1#*@}
  awk -v w="$want" -v hz="$hz" '
    $1 ~ /^#[0-9]+$/ && $2 == w { d = $3 - hz; if (d < 0) d = -d; if (d < 0.02) { sub(/^#/, "", $1); print $1; exit } }'
}

modes_listing() { $MT -c | awk '$1 ~ /^#[0-9]+$/ { printf "%-5s %-10s %6s Hz  htot %s vtot %s  clock %s  %s %s %s\n", $1, $2, $3, $7, $11, $12, $14, $15, $16, $17 }'; }

selftest() {
  local sample idx
  sample=$(printf 'Connectors:\nid\tencoder\tstatus\t\tname\t\tsize (mm)\tmodes\tencoders\n40\t39\tconnected\tHDMI-A-1\t620x340\t4\t39\n  modes:\n\tindex name refresh (Hz) hdisp hss hse htot vdisp vss vse vtot\n  #0 1920x1080 59.94 1920 2008 2052 2200 1080 1084 1089 1125 148352 flags: phsync, pvsync; type: preferred, driver\n  #1 1920x1080 60.00 1920 2008 2052 2200 1080 1084 1089 1125 148500 flags: phsync, pvsync; type: driver\n  #2 1920x1080 23.98 1920 2558 2602 2750 1080 1084 1089 1125 74176 flags: phsync, pvsync; type: driver\n  #3 3840x2160 29.97 3840 4016 4104 4400 2160 2168 2178 2250 296703 flags: phsync, pvsync; type: driver\n\nCRTCs:\nid\tfb\tpos\tsize\n42\t0\t(0,0)\t(1920x1080)\n  #0 1920x1080 59.94\n')
  [ "$(echo "$sample" | parse_conn)" = 40 ] || { echo "FAIL conn"; return 1; }
  [ "$(echo "$sample" | parse_crtc)" = 42 ] || { echo "FAIL crtc"; return 1; }
  idx=$(echo "$sample" | parse_mode_index 1920x1080@60.00); [ "$idx" = 1 ] || { echo "FAIL 60.00 -> $idx"; return 1; }
  idx=$(echo "$sample" | parse_mode_index 1920x1080@59.94); [ "$idx" = 0 ] || { echo "FAIL 59.94 -> $idx"; return 1; }
  idx=$(echo "$sample" | parse_mode_index 1920x1080@23.976); [ "$idx" = 2 ] || { echo "FAIL 23.976 -> $idx"; return 1; }
  idx=$(echo "$sample" | parse_mode_index 3840x2160@29.97); [ "$idx" = 3 ] || { echo "FAIL 2160p30 -> $idx"; return 1; }
  [ -z "$(echo "$sample" | parse_mode_index 1280x720@50.00)" ] || { echo "FAIL absent mode"; return 1; }
  echo "selftest OK"
}

# ---- hardware-facing ---------------------------------------------------------------------------
snap() {
  local d; d=$(card_dir)
  echo "=== $(date '+%F %T')  kernel $(uname -r)"
  echo "--- modules"; lsmod | grep -E "^histb|^q10"
  echo "--- histb-hdmi state"; cat /sys/kernel/debug/histb-hdmi/state 2>&1
  echo "--- histb-vdp"; [ -n "$d" ] && cat "$d/histb_vdp_regs" || echo "(no histb-vdp card: is the module loaded?)"
  echo "--- boot-time clock line"; dmesg | grep -E "HDMI pixel clock|adopting|pixel clock runs|boot link adopted|HDMI bridge registered|mode change|taking over" | tail -12
  echo "--- modes"; modes_listing
  echo "--- TX register pages (full dump: /sys/kernel/debug/histb-hdmi/regs)"
  grep -E "^p0 r0[0-5] |^p0 rf7 |^p6 r3b |^p6 r1b |^p0 r31 |^pb r8[01] |^pb r8c |^pb r8e |^pb r8f |^p7 rb[0-9a-f] |^p7 r(e2|f8) |^p9 r(00|09|20) |^pa r13 " /sys/kernel/debug/histb-hdmi/regs 2>/dev/null
  echo "--- CRG (HPLL 0x28/0x2c/0x150, 0xd8, 0x10c, 0x110, 0x278, 0x34c)"
  for a in 0xf8a22028 0xf8a2202c 0xf8a22150 0xf8a220d8 0xf8a2210c 0xf8a22110 0xf8a22278 0xf8a2234c; do printf '%s %s\n' "$a" "$(busybox devmem $a 32)"; done
  echo "--- DHD0 (ctrl vsync hsync1 hsync2 vplus pwr vtthd sync_inv)"
  for a in 0xf8ccc000 0xf8ccc004 0xf8ccc008 0xf8ccc00c 0xf8ccc010 0xf8ccc014 0xf8ccc01c 0xf8ccc020; do printf '%s %s\n' "$a" "$(busybox devmem $a 32)"; done
  echo "--- DHD0 colour path (CSC_IDC 0xc040, CLIP 0xc090/94, DATA_SEL 0xc02c) and GP0 (ctrl, oreso, ireso)"
  for a in 0xf8ccc040 0xf8ccc090 0xf8ccc094 0xf8ccc02c 0xf8cc8000 0xf8cc8008 0xf8cc800c 0xf8ccb408; do printf '%s %s\n' "$a" "$(busybox devmem $a 32)"; done
}

session_stop() {
  STOPPED=""
  [ "${Q10_KEEP_SESSION:-0}" = 1 ] && return
  local u
  for u in q10-desktop q10-kodi; do
    if [ "$(systemctl is-active $u 2>/dev/null)" = active ]; then systemctl stop $u && STOPPED="$STOPPED $u"; fi
  done
  sleep 2
}
session_start() { local u; for u in $STOPPED; do systemctl start $u; done; }

try_mode() { # <WxH@Hz> [hold]
  local spec=$1 hold=${2:-15} listing conn crtc idx t0
  listing=$($MT 2>&1)
  conn=$(echo "$listing" | parse_conn); crtc=$(echo "$listing" | parse_crtc)
  idx=$($MT -c | parse_mode_index "$spec")
  if [ -z "$conn" ] || [ -z "$crtc" ]; then echo "FAIL $spec: no connector/CRTC (conn='$conn' crtc='$crtc'): histb-vdp not loaded or the session still owns the card"; return 3; fi
  if [ -z "$idx" ]; then echo "SKIP $spec: the sink does not list it"; return 4; fi
  echo; echo "######## $spec  (connector $conn crtc $crtc mode #$idx, hold ${hold}s, dead-man $((hold + DEAD))s)"
  echo "q10: mode-test $spec" > /dev/kmsg
  t0=$(date +%s)
  ( sleep "$hold" ) | timeout -s KILL "$((hold + DEAD))" $MT -s "$conn@$crtc:#$idx" -v > /tmp/mode-test.log 2>&1 &
  local pid=$!
  sleep 4
  echo "--- 4 s in: state"; cat /sys/kernel/debug/histb-hdmi/state 2>&1 | grep -E "link_owned|tmds_on|pixel_clk|fdet|sys_stat|hpd"
  local d; d=$(card_dir); [ -n "$d" ] && sed -n 1,2p "$d/histb_vdp_regs"
  echo "--- DHD0 now:"; for a in 0xf8ccc000 0xf8ccc004 0xf8ccc008 0xf8ccc00c 0xf8ccc014; do printf '%s %s\n' "$a" "$(busybox devmem $a 32)"; done
  echo "--- HPLL now:"; for a in 0xf8a22028 0xf8a2202c 0xf8a22150; do printf '%s %s\n' "$a" "$(busybox devmem $a 32)"; done
  wait "$pid"; local rc=$?
  echo "--- modetest rc=$rc after $(( $(date +%s) - t0 )) s;  flip rate:"; grep -i "freq" /tmp/mode-test.log | tail -3
  sleep 3
  echo "--- after release (fbdev restored the boot mode?)"; cat /sys/kernel/debug/histb-hdmi/state 2>&1 | grep -E "pixel_clk|tmds_on|fdet"
  echo "--- kernel log"; dmesg | awk -v s="q10: mode-test $spec" 'index($0,s){f=1} f' | grep -E "histb|hdmi|HDMI|vdp|drm|WARN|BUG|Oops" | tail -25
  return 0
}

run_set() { # hold modes...
  local hold=$1; shift
  session_stop
  for m in "$@"; do try_mode "$m" "$hold"; done
  session_start
}

case "${1:-}" in
  selftest) selftest ;;
  snap)  snap ;;
  list)  modes_listing ;;
  try)   shift; session_stop; try_mode "${1:?usage: try WxH@Hz [hold]}" "${2:-15}"; session_start ;;
  stage1) run_set "${2:-15}" 1920x1080@60.00 1920x1080@59.94 1920x1080@50.00 1920x1080@30.00 1920x1080@25.00 1920x1080@24.00 1920x1080@23.976 ;;
  stage2) run_set "${2:-15}" 1280x720@60.00 1280x720@59.94 1280x720@50.00 ;;
  stage3) run_set "${2:-20}" 3840x2160@30.00 3840x2160@29.97 3840x2160@60.00 ;;
  *) sed -n 2,13p "$0"; exit 2 ;;
esac
