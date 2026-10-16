#!/usr/bin/env bash
# Runs INSIDE the himedia-kodi-xbuild container (mounted at /w). Called by ../build-kodi-v4l2req.sh.
# Env: JOBS PREFIX FFPREFIX SRC (patched Debian source dir name)
set -euo pipefail
cd /w
tar --warning=no-unknown-keyword -C / -xzf /w/ffmpeg-v4l2req-armhf.tar.gz   # FFmpeg headers/.pc/libs at the box path
cd "/w/src/$SRC"

# --- what Debian's rules do before cmake, minus Debian-only branding ------------------------------
cp -r debian/webinterface-default addons/webinterface.default
cp debian/extra/arial.ttf media/Fonts/arial.ttf                 # pre-merged font (fontforge not needed)
tar -cf tools/depends/target/libdvdnav/libdvdnav-embedded.tar.xz  libdvdnav-embedded
tar -cf tools/depends/target/libdvdread/libdvdread-embedded.tar.xz libdvdread-embedded
touch addons/skin.estuary/media/from-debian-logo.png 2>/dev/null || true

# --- native (build-arch) generators --------------------------------------------------------------
if [ ! -x /w/native-tools/bin/TexturePacker ] || [ ! -x /w/native-tools/bin/JsonSchemaBuilder ]; then
  rm -rf /w/native-tools /w/native-build; mkdir -p /w/native-build
  cmake -G"Unix Makefiles" -Stools/depends/native/JsonSchemaBuilder/src -B/w/native-build/jsb -DCMAKE_INSTALL_PREFIX=/w/native-tools > /w/native-jsb.out 2>&1
  make -C /w/native-build/jsb -j"$JOBS" install >> /w/native-jsb.out 2>&1
  cmake -G"Unix Makefiles" -Stools/depends/native/TexturePacker/src -B/w/native-build/tp -DKODI_SOURCE_DIR="$PWD" \
        -DCMAKE_CXX_FLAGS="-DTARGET_POSIX" -DCMAKE_INSTALL_PREFIX=/w/native-tools > /w/native-tp.out 2>&1
  make -C /w/native-build/tp -j"$JOBS" install >> /w/native-tp.out 2>&1
fi
ls -l /w/native-tools/bin

# --- configure (cross) ------------------------------------------------------------------------------
mkdir -p /w/stage
if [ "${REUSE_BUILD:-0}" = 1 ] && [ -f /w/build/CMakeCache.txt ]; then echo "REUSE_BUILD=1: skipping configure"; else
rm -rf /w/build; mkdir -p /w/build
cmake -G"Unix Makefiles" -S . -B /w/build \
  -DCMAKE_TOOLCHAIN_FILE=/w/toolchain-armhf.cmake \
  -DCMAKE_INSTALL_PREFIX="$PREFIX" -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_BUILD_TYPE=Release \
  -DCORE_PLATFORM_NAME=gbm -DAPP_RENDER_SYSTEM=gles -DWITH_ARCH=arm -DENABLE_NEON=ON -DNEON=True \
  -DENABLE_INTERNAL_FFMPEG=OFF \
  -DWITH_JSONSCHEMABUILDER=/w/native-tools/bin/JsonSchemaBuilder -DWITH_TEXTUREPACKER=/w/native-tools/bin/TexturePacker \
  -DENABLE_TESTING=OFF -DHOST_CAN_EXECUTE_TARGET=FALSE -DENABLE_PYTHON=ON \
  -DENABLE_ALSA=ON -DENABLE_PULSEAUDIO=ON -DENABLE_PIPEWIRE=OFF -DENABLE_SNDIO=OFF -DENABLE_DBUS=ON -DENABLE_UDEV=ON \
  -DENABLE_VAAPI=OFF -DENABLE_VDPAU=OFF -DENABLE_AVAHI=OFF -DENABLE_BLURAY=OFF -DENABLE_CEC=OFF -DENABLE_LIRCCLIENT=OFF \
  -DENABLE_MYSQLCLIENT=OFF -DENABLE_MARIADBCLIENT=OFF -DENABLE_NFS=OFF -DENABLE_SMBCLIENT=OFF -DENABLE_AIRTUNES=OFF -DENABLE_PLIST=OFF \
  -DENABLE_OPTICAL=OFF -DENABLE_DVDCSS=OFF -DENABLE_EVENTCLIENTS=OFF -DENABLE_UPNP=ON -DENABLE_MICROHTTPD=ON -DENABLE_XSLT=ON \
  -DENABLE_INTERNAL_CROSSGUID=OFF -DENABLE_INTERNAL_DATE=OFF -DENABLE_INTERNAL_KISSFFT=OFF -DENABLE_INTERNAL_RapidJSON=OFF \
  -DENABLE_INTERNAL_TZDATA=OFF -DENABLE_INTERNAL_LIBDVD=ON \
  -DLIBDVDREAD_URL=tools/depends/target/libdvdread/libdvdread-embedded.tar.xz -DLIBDVDNAV_URL=tools/depends/target/libdvdnav/libdvdnav-embedded.tar.xz \
  -DLIBDVDREAD_HASH="SHA256=$(sha256sum tools/depends/target/libdvdread/libdvdread-embedded.tar.xz | cut -d' ' -f1)" \
  -DLIBDVDNAV_HASH="SHA256=$(sha256sum tools/depends/target/libdvdnav/libdvdnav-embedded.tar.xz | cut -d' ' -f1)" \
  > /w/cmake-configure.out 2>&1 || { tail -60 /w/cmake-configure.out; exit 1; }
tail -70 /w/cmake-configure.out
fi

# --- build + install -------------------------------------------------------------------------------------
make -C /w/build -j"$JOBS" > /w/make.out 2>&1 || { tail -80 /w/make.out; exit 1; }
make -C /w/build install DESTDIR=/w/stage >> /w/make.out 2>&1 || { tail -40 /w/make.out; exit 1; }
echo "BUILD+INSTALL OK"
