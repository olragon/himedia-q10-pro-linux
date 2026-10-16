#!/bin/sh
# Run ON the box (detached: the link drops while each setting renegotiates, taking telnet
# with it). For every RGMII delay setting: renegotiate, then ping the router — a reply needs
# BOTH directions, so this measures TX, which a receive counter cannot. Results go to
# /dev/kmsg; the straps are restored at the end whatever happens.
M=/run/q10-mii
log() { echo "q10: phytest: $*" > /dev/kmsg; }
for mode in "straps:0" "bit11:0x2800" "bit12:0x3000" "both:0x3800" "off:0x2000"; do
  name=${mode%%:*}; bits=${mode#*:}
  $M set $bits >/dev/null
  i=0; while [ $i -lt 80 ]; do [ "$(cat /sys/class/net/eth0/carrier 2>/dev/null)" = 1 ] && break; usleep 100000; i=$((i+1)); done
  sleep 2
  ok=$(ping -c 10 -W 1 -i 0.3 192.168.1.1 2>/dev/null | sed -n 's/.* \([0-9]*\) packets received.*/\1/p')
  log "$name reg=$($M get) carrier=$(cat /sys/class/net/eth0/carrier) gateway-replies=${ok:-0}/10"
done
$M set 0 >/dev/null
log "done, straps restored reg=$($M get)"
