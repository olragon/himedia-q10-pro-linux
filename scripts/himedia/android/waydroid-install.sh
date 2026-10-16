#!/bin/bash
# waydroid-install.sh — Android 13 (LineageOS 20, waydroid_arm) as a container on the Q10's
# mainline kernel. Runs ON THE BOX (Debian 13 armhf), as root. Idempotent; logs to
# /var/log/q10/waydroid-install.log. docs/261012-himedia-dual-boot-android.md
#
#   waydroid-install.sh build     # armhf .debs of libglibutil, libgbinder, python3-gbinder
#   waydroid-install.sh install   # apt-install those + waydroid 1.6.2 (arch all) + cage
#   waydroid-install.sh images    # download + sha256-check LineageOS 20 system/vendor
#   waydroid-install.sh init      # waydroid init from the local images (no network fetch)
#   waydroid-install.sh setup     # TV-box Android settings (timezone, no lock screen); session running
#   waydroid-install.sh all
#   waydroid-install.sh uninstall # fallback: remove packages + /var/lib/waydroid (images kept)
#
# Why build: repo.waydro.id ships libgbinder/python3-gbinder for amd64/arm64 only, and Debian
# has none. Upstream carries debian/ packaging, so dpkg-buildpackage gives real packages that
# `apt purge` removes cleanly.
# ⛔ Nothing here touches the eMMC or the stick; everything lives on the SATA root.
set -euo pipefail
W=/var/lib/q10/waydroid-build; IMG=/var/lib/q10/waydroid-images
LOG=/var/log/q10/waydroid-install.log; mkdir -p "$W" "$IMG" /var/log/q10
exec > >(tee -a "$LOG") 2>&1
echo "=== $(date -Is) waydroid-install $*"

# Pinned sources (resolved 2026-10-12): COMMIT shas — an annotated tag's own sha never equals HEAD.
GLIBUTIL=(https://github.com/sailfishos/libglibutil 1.0.83 fa82adf84ba308626c4389c6e5b95bb4c12ce1d6)
GBINDER=(https://github.com/mer-hybris/libgbinder 1.1.54 770f4ce2a5aca0bcaf4df2ba58e21fa30e74b1bc)
GBPY=(https://github.com/waydroid/gbinder-python main 86b8feba4cacd0952b010d1c3af6a29a0c146ced)
WD_DEB=https://repo.waydro.id/dists/trixie/waydroid_1.6.2_all.deb
WD_SHA=002124e57517627d86d68b0ce136e911b4f7babc34dfaa9980d5e97c29ed5e9e
# LineageOS 20.0 (Android 13) for waydroid_arm; the OTA json "id" is the zip's sha256.
SYS_URL=https://sourceforge.net/projects/waydroid/files/images/system/lineage/waydroid_arm/lineage-20.0-20260927-VANILLA-waydroid_arm-system.zip/download
SYS_SHA=c36f1298165c572c803c0d76ed6086d37e7639dbb3d8bcec0f5e16984e494152
VEN_URL=https://sourceforge.net/projects/waydroid/files/images/vendor/waydroid_arm/lineage-20.0-20260927-MAINLINE-waydroid_arm-vendor.zip/download
VEN_SHA=335c710902148cf6f4edac5e7ab464f1af536deb460eb81facd31b9557cec1e7

deps() {  # install whatever debian/control still lists as unmet (upstream adds deps over time)
  local need; need=$(cd "$1" && dpkg-checkbuilddeps 2>&1 | sed -n 's/.*unmet build dependencies: //p' | sed 's/([^)]*)//g; s/|[^ ]*//g') || true  # exits 1 exactly when deps are missing
  [ -z "$need" ] || apt-get install -y -q $need
}

src() {  # url ref sha -> checked-out dir
  local url=$1 ref=$2 sha=$3 d=$W/$(basename "$1")
  [ -d "$d/.git" ] || git clone -q "$url" "$d"
  git -C "$d" fetch -q origin "$ref" 2>/dev/null || true
  git -C "$d" checkout -q "$sha"
  [ "$(git -C "$d" rev-parse HEAD)" = "$sha" ] || { echo "⛔ $url not at $sha"; exit 1; }
  echo "$d"
}

build() {
  apt-get install -y -q build-essential devscripts debhelper pkg-config git libglib2.0-dev \
    python3-dev python3-setuptools cython3 dh-python fakeroot flex bison
  for spec in GLIBUTIL GBINDER; do
    eval "set -- \"\${$spec[@]}\""; d=$(src "$1" "$2" "$3")
    deps "$d"; (cd "$d" && dpkg-buildpackage -b -us -uc -j4)
    # the next package build-depends on this one's -dev
    apt-get install -y -q "$W"/$(basename "$1")*_armhf.deb
  done
  d=$(src "${GBPY[@]}"); deps "$d"; (cd "$d" && dpkg-buildpackage -b -us -uc -j4)
  ls -la "$W"/*.deb
}

install_pkgs() {
  local debs; debs=$(ls "$W"/*.deb | grep -vE 'dbgsym|-tools_')
  apt-get install -y -q $debs
  curl -fsSL -o "$W/waydroid.deb" "$WD_DEB"
  echo "$WD_SHA  $W/waydroid.deb" | sha256sum -c -
  apt-get install -y -q "$W/waydroid.deb" cage
  # waydroid-net.sh hard-codes LXC_USE_NFT="false" and then prefers iptables-legacy, whose
  # x_tables tables this kernel does not build (6.18 gates them behind IP_NF_IPTABLES_LEGACY);
  # its nft path needs only nf_tables. Re-applied on every install (a package upgrade reverts it).
  sed -i 's/^LXC_USE_NFT="false"/LXC_USE_NFT="true"/' /usr/lib/waydroid/data/scripts/waydroid-net.sh
  grep -q '^LXC_USE_NFT="true"' /usr/lib/waydroid/data/scripts/waydroid-net.sh
  # The container service is started by the session, not at boot (it costs RAM).
  systemctl disable --now waydroid-container.service 2>/dev/null || true
  dpkg -l | grep -E 'gbinder|glibutil|waydroid|cage|lxc' | awk '{print $2, $3}'
}

fetch() {  # url sha out
  [ -s "$3" ] && echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null && { echo "have $3"; return; }
  curl -fL --retry 5 -C - -o "$3.part" "$1"
  echo "$2  $3.part" | sha256sum -c - && mv "$3.part" "$3"
}

images() {
  fetch "$SYS_URL" "$SYS_SHA" "$IMG/system.zip"
  fetch "$VEN_URL" "$VEN_SHA" "$IMG/vendor.zip"
  mkdir -p /etc/waydroid-extra/images
  (cd /etc/waydroid-extra/images && unzip -o -q "$IMG/system.zip" && unzip -o -q "$IMG/vendor.zip")
  ls -la /etc/waydroid-extra/images
}

init() {
  # /etc/waydroid-extra/images is waydroid's documented "preinstalled images" path: init uses it
  # instead of downloading. -f re-inits over an earlier attempt.
  waydroid init -f
  # Graphics profile: legacy GLES RenderEngine + no shader priming. SkiaGL SIGSEGVs in libgallium
  # (same pc as the primeCache crash) when a video layer goes away — every video end took
  # SurfaceFlinger, and Android, down (2026-10-12); gpu-gles plays to the end with no tombstone.
  command -v q10-waydroid-props >/dev/null && q10-waydroid-props gpu-gles
  cat /var/lib/waydroid/waydroid.cfg
}

setup() {  # first-run Android settings for a TV box; needs a RUNNING session (q10-mode switch android)
  waydroid status | grep -q 'Session:.*RUNNING' || { echo "⛔ start the android session first"; exit 1; }
  tz=$(cat /etc/timezone 2>/dev/null || timedatectl show -p Timezone --value)
  waydroid shell -- setprop persist.sys.timezone "$tz"
  # `settings`/`locksettings` refuse uid 0 ("Caller must be shell") -> run as shell (2000).
  # No lock screen on a TV box; and SystemUI's keyguard can ANR at boot on 4xA53 (2026-10-12),
  # whose dialog then sits over the launcher — hide crash/ANR dialogs.
  waydroid shell -u 2000 -- sh -c 'settings put global hide_error_dialogs 1; locksettings set-disabled true;
    settings put global stay_on_while_plugged_in 7; settings put system screen_off_timeout 2147483647'
  echo "timezone=$(waydroid shell -- getprop persist.sys.timezone) hide_error_dialogs=$(waydroid shell -u 2000 -- settings get global hide_error_dialogs)"
}

uninstall() {
  systemctl disable --now waydroid-container.service 2>/dev/null || true
  apt-get purge -y waydroid python3-gbinder libgbinder libglibutil 2>/dev/null || true
  rm -rf /var/lib/waydroid /etc/waydroid-extra
  echo "removed; downloads kept in $IMG"
}

case "${1:-}" in
  build) build ;; install) install_pkgs ;; images) images ;; init) init ;; setup) setup ;;
  all) build; install_pkgs; images; init ;;
  uninstall) uninstall ;;
  *) sed -n 2,14p "$0"; exit 2 ;;
esac
echo "=== $(date -Is) done $1"
