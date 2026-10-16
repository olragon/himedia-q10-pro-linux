#!/bin/bash
# cec-test.sh - HDMI-CEC bring-up test for the Q10 Pro.  RUN ON THE BOX (root), kernel with patch 0019
# (histb_hdmi loaded: histb_vdp pulls it in).  docs/261012-himedia-hdmi-cec.md has the reading guide.
#
#   cec-test.sh [--secs N] [--dev /dev/cecN] [--wake] [--keys-only] [--no-keys]
#
#   --secs N      how long the human-key phase listens (default 30)
#   --wake        also send <Image View On> + <Active Source> (turns the TV on / switches to this input)
#   --keys-only   skip the TV queries, only listen for remote keys
#   --no-keys     skip the key phase (no human needed)
#
# Phases, each prints PASS / FAIL / INFO and writes its raw output to $OUT:
#   0 environment   /dev/cec*, cec-ctl, dmesg lines of histb-hdmi, debugfs cec (block id 0xcc, wire level)
#   1 configure     cec-ctl --playback --osd-name "Q10 Pro": physical address from the EDID, a logical address
#   2 topology      --show-topology
#   3 TV            poll LA 0, <Give Device Power Status>, <Get CEC Version>, <Give Device Vendor ID>, <Give OSD Name>
#   4 keys          --monitor-all (falls back to --monitor: the DRM helper adapter has no monitor-all) while a
#                   person presses TV-remote keys, AND the rc-cec input device logged in parallel
#
# Nothing here writes to the video path.  Fallback if CEC misbehaves: modprobe -r histb_vdp histb_hdmi, then load with
# `options histb_hdmi cec=0` in /etc/modprobe.d (the adapter is then never created and the registers are not touched).
set -u

SECS=30; DEV=""; WAKE=0; KEYS_ONLY=0; NO_KEYS=0
while [ $# -gt 0 ]; do
  case "$1" in
    --secs) SECS=$2; shift ;;
    --dev) DEV=$2; shift ;;
    --wake) WAKE=1 ;;
    --keys-only) KEYS_ONLY=1 ;;
    --no-keys) NO_KEYS=1 ;;
    -h|--help) sed -n 2,22p "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
  shift
done

OUT=/var/tmp/cec-test-$(date +%Y%m%d-%H%M%S)
mkdir -p "$OUT"
pass=0; fail=0
ok()   { echo "PASS  $*"; pass=$((pass+1)); }
bad()  { echo "FAIL  $*"; fail=$((fail+1)); }
info() { echo "INFO  $*"; }
hdr()  { echo; echo "== $*"; }

# ---------------------------------------------------------------- 0 environment
hdr "0 environment (raw output in $OUT)"
uname -r | sed 's/^/INFO  kernel /'
dmesg 2>/dev/null | grep -iE 'histb-hdmi|cec' > "$OUT/dmesg-cec.txt"
sed 's/^/      /' "$OUT/dmesg-cec.txt" | tail -15

if [ -z "$DEV" ]; then DEV=$(ls /dev/cec* 2>/dev/null | head -1); fi
if [ -z "$DEV" ] || [ ! -c "$DEV" ]; then
  bad "no /dev/cec* node. Is histb_hdmi loaded (modprobe histb_vdp)? Was it loaded with cec=0? Is the kernel built from patch 0019 (CONFIG_DRM_HISI_HISTB_HDMI_CEC)?"
  echo "      lsmod: $(lsmod | grep -E 'histb|cec' | tr '\n' ' ')"
  echo; echo "RESULT: $pass pass, $fail fail"; exit 1
fi
ok "adapter node $DEV"
if ! command -v cec-ctl >/dev/null 2>&1; then
  bad "cec-ctl not installed (apt install v4l-utils)"; echo "RESULT: $pass pass, $fail fail"; exit 1
fi

DBG=/sys/kernel/debug/histb-hdmi/cec
if [ -r "$DBG" ]; then
  cp "$DBG" "$OUT/debugfs-cec-before.txt"; sed 's/^/      /' "$DBG"
  grep -q '^device_id *cc' "$DBG" && ok "CPI block answers (device_id cc)" || bad "CPI block id is not cc: wrong address, clock gate closed, or the block is in reset"
  grep -q '^line high' "$DBG" && ok "CEC wire idles high (a sink pulls it up)" || bad "CEC wire LOW: no sink on the line, the pin is not wired to the connector, or something holds it"
else
  info "no $DBG (debugfs not mounted: mount -t debugfs none /sys/kernel/debug)"
fi

# Who is on the other end?  A monitor with a Realtek scaler (EDID mfg "RTK") has an HDMI vendor block, hence a
# physical address, and usually NO CEC: it neither ACKs nor talks.  Measured 2026-10-12 on the bench display.
for e in /sys/class/drm/*HDMI*/edid; do
  [ -e "$e" ] || continue
  M=$(od -An -tx1 -j8 -N2 "$e" | tr -d ' \n')
  MFG=$(python3 -c "v=int('$M',16); print(''.join(chr(64+((v>>s)&31)) for s in (10,5,0)))" 2>/dev/null)
  info "sink on $(basename "$(dirname "$e")"): EDID manufacturer ${MFG:-?}$( [ "$MFG" = RTK ] && echo ' (Realtek scaler: a plain monitor; expect NO CEC replies)')"
done

# ---------------------------------------------------------------- 1 configure
hdr "1 configure as a playback device"
cec-ctl -d "$DEV" --clear > "$OUT/clear.txt" 2>&1
cec-ctl -d "$DEV" --playback --osd-name "Q10 Pro" > "$OUT/configure.txt" 2>&1
sed 's/^/      /' "$OUT/configure.txt" | head -40
cec-ctl -d "$DEV" > "$OUT/status.txt" 2>&1
PA=$(grep -iE 'Physical Address' "$OUT/status.txt" | head -1 | grep -oE '[0-9a-f]\.[0-9a-f]\.[0-9a-f]\.[0-9a-f]')
LA=$(grep -iE 'Logical Address.*:' "$OUT/status.txt" | head -1)
info "physical address: ${PA:-none}   $LA"
case "${PA:-f.f.f.f}" in
  f.f.f.f) bad "physical address invalid: no EDID yet (is a TV on the port? has histb_vdp read the EDID?) - CEC cannot configure without it" ;;
  *) ok "physical address $PA from the EDID" ;;
esac
if grep -qiE 'Logical Addresses *: *1 |Logical Address *: *[0-9]+ \((Playback|Recording|Tuner)' "$OUT/status.txt" ||
   grep -qiE 'Playback' "$OUT/status.txt"; then ok "logical address claimed (playback)"; else
  bad "no logical address: the polls of 4/8/11 all got an ACK (suspicious), or the transmit path does not complete"; fi
if grep -qiE 'passthrough' "$OUT/status.txt"; then info "RC passthrough flag present"; else
  info "no 'passthrough' in the status: TV-remote keys only reach the input device when the adapter allows RC passthrough (cec-ctl allows it by default)"; fi

# ---------------------------------------------------------------- 2 topology
hdr "2 topology"
cec-ctl -d "$DEV" --skip-info --show-topology > "$OUT/topology.txt" 2>&1
sed 's/^/      /' "$OUT/topology.txt" | head -30
if grep -qiE 'TV|Device [0-9]+|System Information' "$OUT/topology.txt"; then ok "topology lists at least one device"; else info "topology empty (no TV answered the polls)"; fi

# ---------------------------------------------------------------- 3 TV queries
if [ $KEYS_ONLY -eq 0 ]; then
  hdr "3 talk to the TV (logical address 0)"
  cec-ctl -d "$DEV" --skip-info --to 0 --poll > "$OUT/poll.txt" 2>&1
  # ⛔ 'Not Acknowledged' contains 'Acknowledged': match the positive line only (the first version of this test passed on a NACK)
  grep -qE 'Tx, Acknowledged|Tx, OK' "$OUT/poll.txt" && ! grep -q 'Not Acknowledged' "$OUT/poll.txt" && ok "TV (LA 0) acknowledges a poll: the TX path and the wire work" || bad "poll of LA 0 not acknowledged: $(tail -1 "$OUT/poll.txt")"
  cec-ctl -d "$DEV" --skip-info --to 0 --give-device-power-status > "$OUT/power.txt" 2>&1
  PW=$(grep -iE 'pwr-state' "$OUT/power.txt" | head -1)
  [ -n "$PW" ] && ok "TV power status: $PW" || bad "no <Report Power Status> from the TV (a reply needs RX to work as well as TX)"
  cec-ctl -d "$DEV" --skip-info --to 0 --get-cec-version > "$OUT/version.txt" 2>&1
  CV=$(grep -iE 'cec-version' "$OUT/version.txt" | head -1)
  [ -n "$CV" ] && ok "TV CEC version: $CV" || bad "no <CEC Version> reply"
  cec-ctl -d "$DEV" --skip-info --to 0 --give-device-vendor-id > "$OUT/vendor.txt" 2>&1
  VI=$(grep -iE 'vendor-id' "$OUT/vendor.txt" | head -1)
  [ -n "$VI" ] && ok "TV vendor: $VI" || info "no <Device Vendor ID> reply"
  cec-ctl -d "$DEV" --skip-info --to 0 --give-osd-name > "$OUT/osdname.txt" 2>&1
  grep -iE 'osd-name' "$OUT/osdname.txt" | head -1 | sed 's/^/INFO  TV /'
  if [ $WAKE -eq 1 ]; then
    cec-ctl -d "$DEV" --skip-info --to 0 --image-view-on > "$OUT/wake.txt" 2>&1
    [ -n "$PA" ] && cec-ctl -d "$DEV" --skip-info --active-source phys-addr="$PA" >> "$OUT/wake.txt" 2>&1
    info "sent <Image View On> + <Active Source>: the TV should switch to this input (see $OUT/wake.txt)"
  fi
fi

# ---------------------------------------------------------------- 4 keys
if [ $NO_KEYS -eq 0 ]; then
  hdr "4 TV-remote keys for $SECS s - PRESS: Up Down Left Right Select(OK) Back/Return Menu/Settings, a few times each"
  # the rc-cec input device: bustype 0x001e (BUS_CEC)
  EVDEV=""
  for d in /sys/class/input/event*; do
    [ "$(cat "$d/device/id/bustype" 2>/dev/null)" = "001e" ] && EVDEV=/dev/input/$(basename "$d")
  done
  if [ -n "$EVDEV" ]; then ok "rc-cec input device $EVDEV ($(cat /sys/class/input/$(basename "$EVDEV")/device/name))"; else
    bad "no input device with bustype 0x001e: kernel without CONFIG_MEDIA_CEC_RC, or the adapter has no CEC_CAP_RC"; fi

  MON=--monitor-all
  cec-ctl -d "$DEV" --skip-info --monitor-all --monitor-time 1 > "$OUT/probe-monitor-all.txt" 2>&1 || true
  if grep -qiE 'not supported|Invalid argument|failed' "$OUT/probe-monitor-all.txt"; then
    MON=--monitor; info "--monitor-all is not available on this adapter (expected: the DRM helper adapter has no monitor-all): monitoring frames addressed to us and broadcasts only"
  fi
  timeout $((SECS+2)) cec-ctl -d "$DEV" --skip-info $MON --monitor-time "$SECS" > "$OUT/monitor.txt" 2>&1 &
  MPID=$!
  if [ -n "$EVDEV" ]; then
    EVDEV="$EVDEV" SECS="$SECS" python3 - <<'PY' > "$OUT/keys.txt" 2>&1 &
import os, sys, time
try:
    import evdev
    from evdev import ecodes
except ImportError:
    print("python3-evdev missing (apt install python3-evdev)"); sys.exit(0)
dev = evdev.InputDevice(os.environ["EVDEV"])
end = time.monotonic() + float(os.environ["SECS"])
names = {v: k for k, v in ecodes.ecodes.items() if k.startswith("KEY_") and not isinstance(v, list)}
while time.monotonic() < end:
    r = dev.read_one()
    if r is None:
        time.sleep(0.01)
        continue
    if r.type == ecodes.EV_KEY:
        print("%s %s" % (names.get(r.code, r.code), {0: "up", 1: "down", 2: "repeat"}[r.value]), flush=True)
PY
    KPID=$!
  fi
  for i in $(seq "$SECS" -1 1); do printf '\r      %2d s left ...   ' "$i"; sleep 1; done; echo
  wait "$MPID" 2>/dev/null
  [ -n "${KPID:-}" ] && wait "$KPID" 2>/dev/null

  FR=$(grep -ciE 'Received from|from TV|User Control' "$OUT/monitor.txt")
  UCP=$(grep -ciE 'User Control Pressed' "$OUT/monitor.txt")
  info "monitor: $FR frame lines, $UCP <User Control Pressed>   (raw: $OUT/monitor.txt)"
  if [ "$UCP" -gt 0 ]; then ok "the TV's remote keys arrive over CEC"; else bad "no <User Control Pressed> seen: wire not connected, TV setting 'HDMI-CEC' off, or the box is not the TV's active input"; fi
  if [ -s "$OUT/keys.txt" ]; then
    echo "      key events by name:"; grep -E 'down$' "$OUT/keys.txt" | sort | uniq -c | sed 's/^/        /'
    # what the session menu / hotkey daemon understand (q10common.KEYS): OK UP DOWN LEFT RIGHT MENU SETUP BACK EXIT ENTER ESC HOME
    UNK=$(grep -E ' down$' "$OUT/keys.txt" | awk '{print $1}' | sort -u | grep -vxE 'KEY_(OK|UP|DOWN|LEFT|RIGHT|MENU|SETUP|BACK|EXIT|ENTER|ESC|HOME)' | tr '\n' ' ')
    [ -n "$UNK" ] && info "keys the session menu ignores (fine for Kodi/desktop, which map their own): $UNK"
    grep -qE 'KEY_(UP|DOWN|LEFT|RIGHT) down' "$OUT/keys.txt" && ok "arrow keys reach the input layer as KEY_UP/DOWN/LEFT/RIGHT" || bad "no arrow key events from the rc-cec device"
    grep -qE 'KEY_OK down' "$OUT/keys.txt" && ok "Select arrives as KEY_OK (the menu treats it as ENTER)" || info "no KEY_OK seen (press Select/OK)"
    grep -qE 'KEY_EXIT down' "$OUT/keys.txt" && ok "Back/Return arrives as KEY_EXIT (the menu treats it as BACK)" || info "no KEY_EXIT seen (press Back/Return; some TVs send nothing for it)"
  else
    info "no key events logged (keys.txt empty)"
  fi
fi

[ -r "$DBG" ] && { cp "$DBG" "$OUT/debugfs-cec-after.txt"; info "debugfs after: $OUT/debugfs-cec-after.txt (the start_bit counters read 1-2 although the waveform is correct (measured): not a usable clock check)"; }
echo; echo "RESULT: $pass pass, $fail fail   (everything in $OUT; copy it back with: scp -r box:$OUT .)"
[ $fail -eq 0 ]
