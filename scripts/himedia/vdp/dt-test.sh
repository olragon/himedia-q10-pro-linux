#!/bin/bash
# Compile-test vdp-dt-snippet.dtsi against OUR dtsi + board dts (+ the vdec/gpu nodes already in the dts).
# Needs the vdp-port tree with 0011+0012 applied (the node uses HISTB_VDP_* clock ids).
set -euo pipefail
PORT=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/vdp-port
K=$(cd "$(dirname "$0")/../../.." && pwd)/scripts/himedia/kernel/arm32
mkdir -p "$PORT/dt"
cp "$K/hi3798cv200.dtsi" "$PORT/dt/"
cp "$K/hi3798cv200-himedia-q10-pro.dts" "$PORT/dt/test.dts"
# the snippet's PART A/B, appended exactly as a user would paste it
cat "$K/vdp-dt-snippet.dtsi" >> "$PORT/dt/test.dts"
docker run --rm -v "$PORT":/ws -w /ws/linux-6.18.55 himedia-kbuild-arm32:trixie bash -c '
set -e
[ -x scripts/dtc/dtc ] || make ARCH=arm scripts_dtc >/dev/null 2>&1
cpp -nostdinc -I include -I arch/arm/boot/dts -I /ws/dt -undef -D__DTS__ -x assembler-with-cpp /ws/dt/test.dts > /ws/dt/test.pp.dts
scripts/dtc/dtc -I dts -O dtb -@ -W no-unit_address_vs_reg -o /ws/dt/test.dtb /ws/dt/test.pp.dts 2>&1 | head -30
echo "dtc exit: ${PIPESTATUS[0]}"
scripts/dtc/dtc -I dtb -O dts /ws/dt/test.dtb 2>/dev/null | grep -n "display-controller" -A22 | head -40
'
