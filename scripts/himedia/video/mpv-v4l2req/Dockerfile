# Cross-build environment for mpv (Debian trixie host arch -> armhf). Used by ../build-mpv-v4l2req.sh.
# Dev libs mirror what the FFmpeg image carries (mpv links Kwiboo's libav*, which NEED them) plus mpv's own.
FROM debian:trixie
ENV DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture armhf && apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      build-essential crossbuild-essential-armhf pkgconf make git ca-certificates xz-utils file qemu-user-static \
      python3 meson ninja-build libc6:armhf \
      libdrm-dev:armhf libudev-dev:armhf zlib1g-dev:armhf libbz2-dev:armhf liblzma-dev:armhf \
      libgnutls28-dev:armhf libass-dev:armhf libfreetype-dev:armhf libfontconfig-dev:armhf \
      libfribidi-dev:armhf libharfbuzz-dev:armhf libdav1d-dev:armhf libvpx-dev:armhf \
      libopus-dev:armhf libvorbis-dev:armhf libmp3lame-dev:armhf libwebp-dev:armhf \
      libxml2-dev:armhf libopenjp2-7-dev:armhf libtheora-dev:armhf libspeex-dev:armhf \
      libsoxr-dev:armhf libzimg-dev:armhf libaom-dev:armhf \
      libplacebo-dev:armhf libgbm-dev:armhf libegl-dev:armhf libgles-dev:armhf libdisplay-info-dev:armhf \
      liblua5.2-dev:armhf libjpeg-dev:armhf libuchardet-dev:armhf libarchive-dev:armhf \
      libasound2-dev:armhf libpulse-dev:armhf \
      libx11-dev:armhf libxext-dev:armhf libxpresent-dev:armhf libxrandr-dev:armhf libxss-dev:armhf \
      libxkbcommon-dev:armhf libxinerama-dev:armhf libxv-dev:armhf libxcb1-dev:armhf \
    && rm -rf /var/lib/apt/lists/*
