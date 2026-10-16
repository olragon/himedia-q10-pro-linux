#!/bin/bash
# Regenerate patch 0019 (HDMI CEC for the HiSTB HDMI transmitter) as a diff of a small WORK tree against
# the files patch 0016 creates.  0019 only touches files 0016 creates, so no kernel tree is needed:
#
#   base = the 4 files extracted from 0016   ($WORK/base)
#   work = the same files + histb-hdmi-cec.h  ($WORK/work, edit here)
#
# First run seeds work from base.  To revise 0019 later: delete $WORK/work, run `--seed` (applies the
# CURRENT 0019 onto base), edit, run again.   Output: scripts/himedia/kernel/arm32/0019-*.patch
# The compiled proof is the real build (build-kernel-arm32.ts applies 0016 then 0019 in a kernel tree).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
K=$(cd "$here/../kernel/arm32" && pwd)
WORK=${CEC_WORK:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}/cec-work}
OUT=$K/0019-drm-bridge-histb-hdmi-add-cec-adapter.patch
P16=$(ls "$K"/0016-*.patch)
FILES="drivers/gpu/drm/bridge/hisilicon/Kconfig drivers/gpu/drm/bridge/hisilicon/histb-hdmi.c"

extract() { # patch path : the '+' lines of a file the patch creates
  awk -v p="+++ b/$2" '$0==p{f=1;next} /^\+\+\+ /{f=0} /^--- /{f=0} f&&/^\+/{print substr($0,2)}' "$1"
}

mkdir -p "$WORK/base" "$WORK/work"
for f in $FILES; do
  mkdir -p "$WORK/base/$(dirname "$f")"
  extract "$P16" "$f" > "$WORK/base/$f"
  [ -s "$WORK/base/$f" ] || { echo "extraction of $f from 0016 failed"; exit 1; }
done

if [ "${1:-}" = "--seed" ] || [ -z "$(ls -A "$WORK/work")" ]; then
  rm -rf "$WORK/work"; mkdir -p "$WORK/work"; cp -R "$WORK/base/." "$WORK/work/"
  if [ "${1:-}" = "--seed" ] && [ -f "$OUT" ]; then
    ( cd "$WORK/work" && patch -p1 --no-backup-if-mismatch < "$OUT" )
  fi
  echo "work tree seeded at $WORK/work"; [ "${1:-}" = "--seed" ] && exit 0
fi

one() { # path
  if [ -f "$WORK/base/$1" ]; then
    diff -u --label "a/$1" --label "b/$1" "$WORK/base/$1" "$WORK/work/$1" || true
  else
    diff -u --label /dev/null --label "b/$1" /dev/null "$WORK/work/$1" || true
  fi
}
{ cat "$here/0019.header.txt"
  for f in $FILES drivers/gpu/drm/bridge/hisilicon/histb-hdmi-cec.h; do one "$f"; done
} > "$OUT"
ls -l "$OUT"
grep -c '^+++ ' "$OUT"
