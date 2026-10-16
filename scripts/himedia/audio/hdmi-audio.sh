#!/bin/bash
# hdmi-audio.sh [dump|apply|off] — add 48 kHz / 16-bit / 2-ch LPCM to the HDMI link that the stock
# fastboot already brought up, WITHOUT touching video: no PHY, no TMDS clock, no AVI, no AVMUTE
# (GCP lives in TPI buffer GEN2 = FSEL 7, which this script never selects).
# Every address and value follows docs/261011-himedia-hdmi-audio-recipe.md (vendor SDK 4.4.35,
# hdmi_2_0/hal/ctrl/imagev200, file:line cited there).
#   dump  (default) read-only: the boot state of every register the recipe touches + ACR readback
#   apply           HDMI side only (§3 of the doc). The AIAO I2S TX3 port must already be running
#                   (q10_aiao with TX3, §2) or the AIP FIFO underflows and the sink hears nothing.
#   off             mute + disable audio sample packets, ACR and the audio InfoFrame again
# Registers are 8-bit, one per 32-bit word: phys = 0xf8ce0000 + ((page << 8) | off) * 4.
# Output: archive/<ts>-q10-hdmi-audio-<mode>.log
set -uo pipefail
mode=${1:-dump}
case $mode in dump|apply|off) ;; *) echo "usage: hdmi-audio.sh [dump|apply|off]"; exit 2;; esac
H=${Q10_HOST:-root@q10.local}; SSH="ssh -o BatchMode=yes -o ConnectTimeout=5"
here=$(cd "$(dirname "$0")/../../.." && pwd)
out="$here/archive/$(date +%Y%m%d-%H%M%S)-q10-hdmi-audio-$mode.log"

remote=$(cat <<'EOF'
set -u
rd()  { printf '0x%02x' $(( $(busybox devmem $1 32) & 0xff )); }
wr()  { busybox devmem $1 32 $2; }
set1() { wr $1 $(( $(rd $1) | $2 )); }
clr1() { wr $1 $(( $(rd $1) & ~$2 & 0xff )); }
TEST_TXCTRL=0xf8ce03dc; PKT_FILTER_0=0xf8ce01d4
ACR_CTRL=0xf8ce2804; N1=0xf8ce280c; N2=0xf8ce2810; N3=0xf8ce2814
CTSH1=0xf8ce2824; CTSH2=0xf8ce2828; CTSH3=0xf8ce282c; AUD_ID=0xf8ce2848
AUD_EN=0xf8ce284c; AUD_MODE=0xf8ce2850; I2S_IN_CTRL=0xf8ce2874
CHST0=0xf8ce2878; CHST1=0xf8ce287c; CHST2=0xf8ce2880; CHST3=0xf8ce2884; CHST4=0xf8ce2888
ASRC=0xf8ce288c; I2S_IN_SIZE=0xf8ce2890; CHST6=0xf8ce28a0; CHST7=0xf8ce28a4
AIP_RST=0xf8ce28b0; AUDP_TXCTRL=0xf8ce28bc; AUDP_TXFIFO=0xf8ce28c4; AIP_INTR1=0xf8ce293c
DOWN_SMPL=0xf8ce2984; TPI_AUD_CONFIG=0xf8ce2988; TPI_AUD_FS=0xf8ce298c
FSEL=0xf8ce1afc; IF_B0=0xf8ce1b00; IF_EN=0xf8ce1b7c
PERI_HDMITX_CTRL0=0xf8a208b0; CRG67=0xf8a2210c; CRG158=0xf8a22278

dump() {
  for r in TEST_TXCTRL PKT_FILTER_0 ACR_CTRL N1 N2 N3 CTSH1 CTSH2 CTSH3 AUD_ID AUD_EN AUD_MODE \
           I2S_IN_CTRL CHST0 CHST1 CHST2 CHST3 CHST4 ASRC I2S_IN_SIZE CHST6 CHST7 AIP_RST \
           AUDP_TXCTRL AUDP_TXFIFO AIP_INTR1 DOWN_SMPL TPI_AUD_CONFIG TPI_AUD_FS FSEL; do
    eval a=\$$r; echo "$r $a $(rd $a)"; done
  for r in PERI_HDMITX_CTRL0 CRG67 CRG158; do eval a=\$$r; echo "$r $a $(busybox devmem $a 32)"; done
  f0=$(rd $FSEL)
  for s in 0 2 7; do wr $FSEL $s; echo "TPI_INFO_EN[fsel=$s] $(rd $IF_EN)  B0..B4 $(rd $IF_B0) $(rd $((IF_B0+4))) $(rd $((IF_B0+8))) $(rd $((IF_B0+12))) $(rd $((IF_B0+16)))"; done
  wr $FSEL $f0
  cts=$(( $(rd $CTSH1) | ($(rd $CTSH2) << 8) | (($(rd $CTSH3) & 0xf) << 16) ))
  n=$(( $(rd $N1) | ($(rd $N2) << 8) | (($(rd $N3) & 0xf) << 16) ))
  echo "N=$n  CTS_hw=$cts  (expect N=6144 CTS=148500 at 1080p60/48k once enabled)"
}

audio_if() {   # $1 = 1 enable, 0 disable; FSEL 2 = audio buffer, restored afterwards
  f0=$(rd $FSEL); wr $FSEL 2
  clr1 $IF_EN 0x40; clr1 $IF_EN 0x80
  if [ $1 = 1 ]; then
    i=0; for b in 0x84 0x01 0x0a 0x70 0x01 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00 0x00; do
      wr $((IF_B0 + 4*i)) $b; i=$((i+1)); done
    while [ $i -lt 31 ]; do wr $((IF_B0 + 4*i)) 0; i=$((i+1)); done
    set1 $IF_EN 0xc0
  fi
  wr $FSEL $f0
}

off() {
  clr1 $AUD_EN 0x01; clr1 $ACR_CTRL 0x02
  set1 $AUDP_TXCTRL 0x80; set1 $AIP_RST 0x03; sleep 0.002; clr1 $AIP_RST 0x03
  audio_if 0
}

apply() {
  [ $(( $(rd $TEST_TXCTRL) & 0x02 )) -ne 0 ] || { echo "REFUSED: TEST_TXCTRL bit1=0 (DVI mode) - no data islands, audio impossible without a mode change"; exit 3; }
  off
  p=$(busybox devmem $PERI_HDMITX_CTRL0 32); wr $PERI_HDMITX_CTRL0 $(( (p & ~0x1f) | 0x02 ))
  wr $I2S_IN_CTRL 0x60; wr $I2S_IN_SIZE 0x0b
  wr $CHST0 0x00; wr $CHST1 0x00; wr $CHST2 0x00; wr $CHST3 0x02; wr $CHST4 0x02; wr $CHST6 0x00; wr $CHST7 0x00
  wr $TPI_AUD_FS $(( ($(rd $TPI_AUD_FS) & 0xf0) | 0x02 ))
  clr1 $AUDP_TXCTRL 0x02
  wr $AUD_MODE 0x10
  wr $ASRC $(( ($(rd $ASRC) & 0x0f) | 0x10 ))
  wr $DOWN_SMPL $(( ($(rd $DOWN_SMPL) & 0xfc) | 0x03 ))
  wr $N1 0x00; wr $N2 0x18; wr $N3 0x00
  audio_if 1
  set1 $AUD_EN 0x01; clr1 $AUD_EN 0x02; set1 $ACR_CTRL 0x02
  clr1 $AUDP_TXCTRL 0x80
  sleep 1
}
EOF
)
{
  echo "# q10 hdmi-audio $mode — $(date)"
  case $mode in
    dump)  $SSH $H "$remote
dump" ;;
    apply) $SSH $H "$remote
echo '--- before'; dump; apply; echo '--- after'; dump" ;;
    off)   $SSH $H "$remote
off; dump" ;;
  esac
} 2>&1 | tee "$out"
echo "log: $out"
