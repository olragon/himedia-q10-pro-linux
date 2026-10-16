#!/bin/bash
# Path B benchmark: Panfrost (Mali-T720) rendering to simpledrm via kmscube.
# kmscube quits on any stdin byte or EOF, so stdin is held open by a sleeper.
# usage (on the box): kmscube-bench.sh "" "-M rgba" "-M nv12-2img"
for m in "$@"; do
  s=$(date +%s%N)
  timeout 60 kmscube -D /dev/dri/card0 -c 300 $m < <(sleep 70) > /tmp/kc.log 2>&1; rc=$?
  e=$(date +%s%N); ms=$(( (e-s)/1000000 ))
  echo "mode='$m' rc=$rc wall_ms=$ms fps=$(awk -v ms=$ms 'BEGIN{printf "%.1f", 300000/ms}')"
  grep -iE "fps|frames|error|fail|interrupt" /tmp/kc.log | head -3
done
