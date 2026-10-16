#!/bin/bash
# sync-lineage.sh [branch=lineage-23.2] [waydroid-branch=dev/lineage-23.2] — run INSIDE the build
# container as user `build`: repo init LineageOS + Waydroid's local manifests, sync, apply the
# Waydroid patches, and record every project's revision (repo manifest -r) for reproducibility.
# Docs: docs.waydro.id "Building from source"; docs/261012-himedia-android-version-research.md
set -euo pipefail
B=${1:-lineage-23.2}; W=${2:-dev/lineage-23.2}; S=/src/$B
export PATH=/usr/local/bin:$PATH
mkdir -p $S && cd $S
[ -d .repo ] || repo init -u https://github.com/LineageOS/android.git -b $B --git-lfs --depth=1
# Waydroid's manifest set for SDK 36 (Android 16)
rm -rf .repo/local_manifests && mkdir -p .repo/local_manifests
tmp=$(mktemp -d); git clone -q --depth=1 -b $W https://github.com/waydroid/android_vendor_waydroid $tmp/vw
cp $tmp/vw/manifest_scripts/manifests-36/*.xml .repo/local_manifests/ 2>/dev/null || true
ls .repo/local_manifests; rm -rf $tmp
repo sync -c -j8 --no-tags --no-clone-bundle --optimized-fetch --prune --force-sync --fail-fast
. build/envsetup.sh
apply-waydroid-patches || echo "⚠️ apply-waydroid-patches reported problems"
repo manifest -r -o /src/$B-pinned-$(date +%Y%m%d).xml
du -sh $S
