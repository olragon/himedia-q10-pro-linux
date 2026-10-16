# Cross-build environment: Debian trixie (host arch = whatever docker runs) -> armhf.
# Used by ../build-ffmpeg-v4l2req.sh. Keep dev libs close to Debian ffmpeg's Build-Depends.
FROM debian:trixie
ENV DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture armhf && apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      build-essential crossbuild-essential-armhf pkgconf make git ca-certificates xz-utils file qemu-user-static \
      libc6:armhf \
      libdrm-dev:armhf libudev-dev:armhf zlib1g-dev:armhf libbz2-dev:armhf liblzma-dev:armhf \
      libgnutls28-dev:armhf libass-dev:armhf libfreetype-dev:armhf libfontconfig-dev:armhf \
      libfribidi-dev:armhf libharfbuzz-dev:armhf libdav1d-dev:armhf libvpx-dev:armhf \
      libopus-dev:armhf libvorbis-dev:armhf libmp3lame-dev:armhf libwebp-dev:armhf \
      libxml2-dev:armhf libopenjp2-7-dev:armhf libtheora-dev:armhf libspeex-dev:armhf \
      libsoxr-dev:armhf libzimg-dev:armhf libaom-dev:armhf \
    && rm -rf /var/lib/apt/lists/*
