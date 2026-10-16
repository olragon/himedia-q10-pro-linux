#!/bin/sh
# tx3-mirror-test.sh [seconds] [sine|pink] — RUNS ON THE BOX. Feasibility test for HDMI audio before the driver
# grows a TX3 port: start AIAO I2S TX3 (the HDMI audio source, docs/261011-himedia-hdmi-audio-recipe.md
# §2) on the SAME ring q10_aiao is playing through TX2, and mirror TX2's write pointer into TX3 in
# a loop. Plays a 440 Hz tone meanwhile. The SP805 guards the whole run.
secs=${1:-90}
type=${2:-sine}
BB=/bin/busybox; rd() { $BB devmem $1 32; }; wr() { $BB devmem $1 32 $2; }
wr 0xf8a2cc00 0x1acce551; wr 0xf8a2c000 3600000000; wr 0xf8a2c008 3; wr 0xf8a2cc00 1
speaker-test -D hw:Q10,0 -c 2 -r 48000 -F S16_LE -t $type -f 440 -l 0 >/tmp/st-hdmi.log 2>&1 &
st=$!; sleep 1
T2=0xf8cd2200; T3=0xf8cd2300
wr $((T3+0x04)) $(( $(rd $((T3+0x04))) & ~0x10000000 ))            # stopped
wr $((T3+0x00)) 0xe4300014                                          # I2S 16b 2ch, src TX3
wr 0xf8cd0158 0x001af286; wr 0xf8cd015c 0x133                       # CRG3: 12.288 MHz, 64fs, cken
s=$(rd 0xf8cd002c); wr 0xf8cd002c $(( (s & ~0xf000) | (11 << 12) ))  # bclk/ws from CRG3
wr $((T3+0xa0)) 0
wr $((T3+0x80)) $(rd $((T2+0x80))); wr $((T3+0x84)) $(rd $((T2+0x84)))
wr $((T3+0x90)) $(rd $((T2+0x90))); wr $((T3+0x94)) $(rd $((T2+0x94)))
wr $((T3+0x88)) $(rd $((T2+0x88))); wr $((T3+0x8c)) 0
d=$(rd $((T3+0x04))); wr $((T3+0x04)) $(( (d & ~0x0fffffff) | (4<<16) | (3<<20) | (0x79<<8) | 2 | 0x10000000 ))
echo "TX3 started: saddr $(rd $((T3+0x80))) size $(rd $((T3+0x84))) dsp $(rd $((T3+0x04)))"
end=$(( $(date +%s) + secs ))
while [ $(date +%s) -lt $end ]; do wr $((T3+0x88)) $(rd $((T2+0x88))); done
w1=$(( $(rd $((T3+0x20))) & 0xffffff )); sleep 1; w2=$(( $(rd $((T3+0x20))) & 0xffffff ))
echo "TX3 frames/s ~ $(( (w2 - w1 + 0x1000000) % 0x1000000 ))"
kill $st; wr $((T3+0x04)) $(( $(rd $((T3+0x04))) & ~0x10000000 ))
wr 0xf8a2cc00 0x1acce551; wr 0xf8a2c008 0; wr 0xf8a2cc00 1; echo "done, watchdog disarmed"
