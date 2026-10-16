#!/bin/bash
# install-stick-sessions.sh <step>... — MAC side: put Kodi, Web and Android 13 on the box's STICK root
# (the SATA root had them; the box runs from the stick until the new SATA cable). Each step is
# idempotent and needs the box on k25 (q10-kexec-chain; kexec-try.sh k25 + install-kernel-chain.sh k25).
#   kodi      ffmpeg-v4l2req + kodi-v4l2req tarballs (+ their apt runtime deps)
#   web       cage, Mesa (panfrost GLES), the drm-rdwr preload shim chromium needs
#   android   gbinder debs (android/build-gbinder-debs.sh) + waydroid + cage + PipeWire, then the
#             LineageOS 20 images onto q10-android.img (tools/stick-space.sh android-img) and init
#   check     what q10-mode thinks is available
# docs/261013-himedia-stick-full-sessions.md
set -euo pipefail
H=${Q10_HOST:-root@q10.local}; SSH="ssh -o BatchMode=yes -o ConnectTimeout=5"
here=$(cd "$(dirname "$0")" && pwd); D=${HIMEDIA_ROOT:-$HOME/himedia-q10-pro}
[ "$($SSH $H uname -r)" = 6.18.55-k25 ] || { echo "⛔ box is not on k25 — Kodi/Web/Android need its drivers"; exit 2; }

kodi() {
  $SSH $H 'mkdir -p /root/stick-install'
  scp -q "$D/ffmpeg-v4l2req/ffmpeg-v4l2req-armhf.tar.gz" "$D/ffmpeg-v4l2req/ffmpeg-v4l2req-armhf.tar.gz.sha256" \
    "$D/ffmpeg-v4l2req/install-ffmpeg-v4l2req.sh" "$D/kodi-v4l2req/kodi-v4l2req-armhf.tar.gz" \
    "$D/kodi-v4l2req/kodi-v4l2req-armhf.tar.gz.sha256" "$D/kodi-v4l2req/install-kodi-v4l2req.sh" $H:/root/stick-install/
  $SSH $H 'set -e; cd /root/stick-install; apt-get update -qq
    sh install-ffmpeg-v4l2req.sh install ffmpeg-v4l2req-armhf.tar.gz
    sh install-kodi-v4l2req.sh install kodi-v4l2req-armhf.tar.gz
    rm -f *.tar.gz; df -h / | tail -1'
}

web() {
  $SSH $H 'set -e; apt-get install -y -q --no-install-recommends cage libgl1-mesa-dri libegl-mesa0 libgles2 2>&1 | tail -2; command -v cage chromium'
  # the preload shim q10-web-run loads (Chromium HW-video frames, else EACCES): no compiler on the stick
  local so=$D/browser/drm-rdwr-preload.so
  [ -s "$so" ] || bash "$here/../browser/build-preload.sh"
  $SSH $H 'mkdir -p /usr/local/lib/q10'; scp -q "$so" $H:/usr/local/lib/q10/drm-rdwr-preload.so
  $SSH $H 'ls -la /usr/local/lib/q10/drm-rdwr-preload.so'
}

android() {
  ls "$D"/waydroid/debs/*.deb >/dev/null || { echo "⛔ no debs — run android/build-gbinder-debs.sh"; exit 2; }
  $SSH $H 'findmnt -n /var/lib/waydroid >/dev/null' || { echo "⛔ /var/lib/waydroid is not on q10-android.img — q10-stick-space android-img"; exit 2; }
  $SSH $H 'mkdir -p /var/lib/q10/waydroid-build /usr/local/lib/q10-android'
  scp -q "$D"/waydroid/debs/*.deb $H:/var/lib/q10/waydroid-build/
  scp -q "$here/../android/waydroid-install.sh" "$here/../android/waydroid-props.sh" $H:/usr/local/lib/q10-android/
  # The LineageOS images come from the MAC: SourceForge gave the box ~25 KB/s and then dropped the
  # transfer (curl 18, 2026-10-13). waydroid-install.sh's fetch() keeps a present file whose sha256
  # matches, so staging them in its download dir skips its own download.
  local wi=$here/../android/waydroid-install.sh img=$D/waydroid/images
  mkdir -p "$img"
  for kind in SYS VEN; do
    local url sha out; url=$(sed -n "s/^${kind}_URL=//p" "$wi"); sha=$(sed -n "s/^${kind}_SHA=//p" "$wi")
    out=$img/$([ $kind = SYS ] && echo system || echo vendor).zip
    if ! { [ -s "$out" ] && echo "$sha  $out" | shasum -a 256 -c --quiet - 2>/dev/null; }; then
      # Q10_FETCH_PROXY=socks5h://127.0.0.1:18089 (ssh -D to a host abroad): SourceForge's master gives Vietnam
      # 15-50 KB/s whatever use_mirror says; through a proxy abroad it was 435 KB/s (2026-10-13)
      curl -fL --retry 5 -C - ${Q10_FETCH_PROXY:+-x "$Q10_FETCH_PROXY"} -o "$out.part" "$url"
      echo "$sha  $out.part" | shasum -a 256 -c - && mv "$out.part" "$out"
    fi
  done
  scp -q "$img/system.zip" "$img/vendor.zip" $H:/var/lib/q10/waydroid-images/
  # one command per line under set -e: an `a && b && c` chain does not stop the script when b fails,
  # which reported a failed image download as success (2026-10-13)
  $SSH $H 'set -e; chmod +x /usr/local/lib/q10-android/*.sh; ln -sfn /usr/local/lib/q10-android/waydroid-props.sh /usr/local/bin/q10-waydroid-props
    apt-get install -y -q --no-install-recommends pipewire pipewire-pulse wireplumber lxc curl unzip 2>&1 | tail -1
    W=/usr/local/lib/q10-android/waydroid-install.sh
    $W install
    $W images
    $W init
    test -s /var/lib/waydroid/waydroid.cfg
    df -h / /var/lib/q10/android | tail -2'
}

check() {
  $SSH $H 'python3 -c "import sys; sys.path.insert(0, \"/usr/local/lib/q10-session\"); import q10mode; [print(k, v) for k, v in q10mode.availability().items()]"; df -h / /var/lib/q10/android | tail -2'
}

[ $# -gt 0 ] || { sed -n 2,10p "$0"; exit 2; }
for step in "$@"; do echo "=== $step"; "$step"; done
