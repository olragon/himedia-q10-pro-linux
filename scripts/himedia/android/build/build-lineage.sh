#!/bin/bash
# build-lineage.sh [product=lineage_waydroid_arm] [jobs=8] — run INSIDE the build container as `build`,
# after sync-lineage.sh: apply the Waydroid patches (once), pick the tree's release config, build only
# the system + vendor images (Waydroid's documented path). RAM is capped at 22 GB, so -j8.
# Output: /src/lineage-23.2/out/target/product/waydroid_arm/{system,vendor}.img
set -eo pipefail
P=${1:-lineage_waydroid_arm}; J=${2:-8}; S=/src/lineage-23.2
cd $S
export USE_CCACHE=1 CCACHE_EXEC=/usr/bin/ccache CCACHE_DIR=/ccache
set +u; source build/envsetup.sh   # envsetup is not `set -u` safe (TOP: unbound variable)
if [ ! -f .q10-waydroid-patched ]; then apply-waydroid-patches && touch .q10-waydroid-patched; fi
# ── Q10 fix-ups to the dev/lineage-23.2 manifest set (idempotent, each one logged) ──────────────
# 1. external/pulseaudio (WayDroid-ATV lineage-20) links "libsndfile12", which no project defines;
#    the pinned external/libsndfile (same org, lineage-20) provides "libsndfile_linux" (2026-10-12).
if grep -q '"libsndfile12"' external/pulseaudio/src/Android.bp; then
  sed -i 's/"libsndfile12"/"libsndfile_linux"/' external/pulseaudio/src/Android.bp
  echo "q10 fix-up: pulseaudio libsndfile12 -> libsndfile_linux"
fi
REL=$(ls build/release/release_configs/ 2>/dev/null | sed -n 's/\.textproto$//p' | grep -E "^[ab]p[0-9]a$" | sort | tail -1)  # newest QPR, e.g. bp4a
echo "release config: ${REL:-<none, using lunch default>}"
lunch ${P}-${REL:+$REL-}userdebug
m -j$J systemimage vendorimage
ls -la out/target/product/waydroid_arm/*.img
