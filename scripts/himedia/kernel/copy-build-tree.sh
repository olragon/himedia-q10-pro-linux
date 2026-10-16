#!/bin/bash
# Copy the arm32 kernel build tree so a second agent can build without touching the first one's
# in-progress edits. Usage: copy-build-tree.sh [dest]   (default kernel-build-arm32-cpufreq)
set -eu
R=${HIMEDIA_ROOT:-${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}}
D=${1:-$R/kernel-build-arm32-cpufreq}
mkdir -p "$D"
rsync -a --exclude='/k[0-9]*' --exclude='/base*' "$R/kernel-build-arm32/" "$D/"
echo "copied to $D"
