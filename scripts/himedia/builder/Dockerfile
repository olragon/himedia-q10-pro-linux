# Q10 Pro kernel builder: debian:trixie with the ARM32 cross toolchain pre-installed.
#
# ⛔ Why this exists: every build used to apt-install ~150 MB of toolchain from deb.debian.org,
# and three builds in a row on 2026-10-10 hit a bad CDN node — one stalled for minutes, one
# trickled at a few KB/s so steadily that even a 15 s apt timeout never fired. The host and a
# fresh container both measured 3.5-8.5 MB/s at the same moment, so the fix is not a timeout,
# it is not downloading the toolchain on every build at all.
# ⛔ NATIVE arm64, pinned. The local `debian:trixie` tag was found to be linux/arm/v7 on
# 2026-10-10 (replaced 2026-10-05, likely by an armhf rootfs pull), so every kernel build ran as
# armv7l under emulation — Apple Silicon has no AArch32. The build script was written for arm64
# + a cross-compiler all along; pinning the platform makes the tag's history irrelevant.
FROM --platform=linux/arm64 debian:trixie

# ⛔ libc6-dev-armhf-cross is the armhf libc SYSROOT the cross gcc needs to build our static
# PID 1 (init.c). It is only a Recommends of gcc-arm-linux-gnueabihf, so --no-install-recommends
# drops it — and the old arm/v7 container never noticed, because there the "cross" gcc was really
# the native one using build-essential's armhf headers. Symptom without it:
# "bits/libc-header-start.h: No such file or directory".
# bizflycloud measured fastest from this network (8.5 MB/s vs 3.5 for deb.debian.org).
# Security updates stay on the official host.
RUN sed -i 's|http://deb.debian.org/debian |http://mirror.bizflycloud.vn/debian |; s|URIs: http://deb.debian.org/debian$|URIs: http://mirror.bizflycloud.vn/debian|' /etc/apt/sources.list.d/debian.sources \
 && printf 'Acquire::http::Timeout "15";\nAcquire::Retries "5";\nAcquire::http::Pipeline-Depth "0";\n' > /etc/apt/apt.conf.d/99-fail-fast \
 && apt-get update -qq \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      build-essential bc bison flex libssl-dev libelf-dev python3 xz-utils curl ca-certificates \
      kmod u-boot-tools gcc-arm-linux-gnueabihf file \
      libc6-dev-armhf-cross \
 && dpkg --add-architecture armhf && apt-get update -qq \
 && mkdir -p /opt/armhf && cd /opt/armhf && apt-get download busybox-static:armhf \
 && ls /opt/armhf/busybox-static_*_armhf.deb \
 && rm -rf /var/lib/apt/lists/*
