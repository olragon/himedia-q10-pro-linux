#!/usr/bin/env bash
# Disassemble a file-offset range of the decompressed stock Q10 Pro kernel (raw ARM Image,
# virtual base 0xc0008000 -- verified by linux_banner literal-pool references).
# usage: disasm-stock-kernel-range.sh <vmlinux.bin> <start-off-hex> <stop-off-hex> <out.s>
# Output addresses are VIRTUAL (base + file offset). Needs docker (debian:trixie + binutils-multiarch).
set -euo pipefail
BIN=$(cd "$(dirname "$1")" && pwd)/$(basename "$1"); S=$2; E=$3; OUT=$4
BASE=0xc0008000
docker run --rm -v "$(dirname "$BIN"):/w:ro" debian:trixie bash -c "
  apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq binutils-multiarch >/dev/null 2>&1
  objdump -D -b binary -marm --adjust-vma=$BASE --start-address=\$(printf '0x%x' \$(( $BASE + $S ))) --stop-address=\$(printf '0x%x' \$(( $BASE + $E ))) /w/$(basename "$BIN")" > "$OUT"
