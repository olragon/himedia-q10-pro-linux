# Cross-build environment for Kodi 21.2 (Debian trixie source) -> armhf GBM/GLES. Used by ../build-kodi-v4l2req.sh.
# Host arch = whatever docker runs (arm64 on the Mac); target = ARMv7 hard-float NEON.
# Native (build-arch) tools: java/groovy/swig/doxygen for Kodi's code generators, flatc, and the libs for the
# natively built JsonSchemaBuilder + TexturePacker. Target (:armhf) dev libs: the GBM/GLES/ALSA/Pulse/Python set,
# plus the libs the side-by-side FFmpeg (/opt/ffmpeg-v4l2req) NEEDs, so the linker can resolve libavcodec's dependencies.
FROM debian:trixie
ENV DEBIAN_FRONTEND=noninteractive
RUN dpkg --add-architecture armhf && apt-get update -qq && apt-get install -y -qq --no-install-recommends \
      build-essential crossbuild-essential-armhf pkgconf make cmake git ca-certificates xz-utils file qemu-user-static \
      curl patch quilt dpkg-dev autoconf automake libtool python3 python3-dev python3-setuptools libc6:armhf \
      default-jre-headless groovy libcommons-lang-java swig doxygen gawk gperf zip unzip gettext \
      flatbuffers-compiler libgif-dev libjpeg-dev libpng-dev liblzo2-dev zlib1g-dev rapidjson-dev \
      libdrm-dev:armhf libudev-dev:armhf zlib1g-dev:armhf libbz2-dev:armhf liblzma-dev:armhf \
      libgnutls28-dev:armhf libass-dev:armhf libfreetype-dev:armhf libfontconfig-dev:armhf \
      libfribidi-dev:armhf libharfbuzz-dev:armhf libdav1d-dev:armhf libvpx-dev:armhf \
      libopus-dev:armhf libvorbis-dev:armhf libmp3lame-dev:armhf libwebp-dev:armhf \
      libxml2-dev:armhf libopenjp2-7-dev:armhf libtheora-dev:armhf libspeex-dev:armhf \
      libsoxr-dev:armhf libzimg-dev:armhf libaom-dev:armhf \
      libgbm-dev:armhf libegl-dev:armhf libgles-dev:armhf libdisplay-info-dev:armhf libinput-dev:armhf libxkbcommon-dev:armhf \
      libasound2-dev:armhf libpulse-dev:armhf libdbus-1-dev:armhf libmicrohttpd-dev:armhf libcurl4-gnutls-dev:armhf \
      libcrossguid-dev:armhf libflatbuffers-dev:armhf libfmt-dev:armhf libfstrcmp-dev:armhf libgcrypt20-dev:armhf \
      libgpg-error-dev:armhf libgif-dev:armhf libjpeg-dev:armhf libpng-dev:armhf liblcms2-dev:armhf liblzo2-dev:armhf \
      libpcre2-dev:armhf libpython3-dev:armhf libsqlite3-dev:armhf libspdlog-dev:armhf libtag1-dev:armhf \
      libtinyxml-dev:armhf libtinyxml2-dev:armhf libudfread-dev:armhf libxslt1-dev:armhf uuid-dev:armhf \
      libhowardhinnant-date-dev:armhf libkissfft-dev:armhf libcap-dev:armhf libcdio-dev:armhf \
    && rm -rf /var/lib/apt/lists/*
