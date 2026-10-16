#!/bin/bash
# setup-builder.sh — run INSIDE the build container (Ubuntu 22.04): install what a
# LineageOS / AOSP build needs, plus `repo`, ccache, and a build user. Idempotent.
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -q
apt-get install -y -q bc bison build-essential ccache curl flex g++-multilib gcc-multilib git git-lfs \
  gnupg gperf imagemagick lib32readline-dev lib32z1-dev libelf-dev liblz4-tool libsdl1.2-dev libssl-dev \
  libxml2 libxml2-utils lzop pngcrush rsync schedtool squashfs-tools xsltproc zip zlib1g-dev \
  python3 python-is-python3 openjdk-17-jdk-headless unzip lib32ncurses-dev libncurses5 libncurses5-dev \
  fontconfig e2fsprogs dosfstools tmux pv
curl -fsSL https://storage.googleapis.com/git-repo-downloads/repo -o /usr/local/bin/repo && chmod +x /usr/local/bin/repo
id build >/dev/null 2>&1 || useradd -m -s /bin/bash build
mkdir -p /src /ccache && chown build:build /src /ccache
su - build -c 'git config --global user.name "q10 builder"; git config --global user.email "q10@localhost"; git config --global color.ui false; git lfs install'
echo 'export USE_CCACHE=1 CCACHE_EXEC=/usr/bin/ccache CCACHE_DIR=/ccache' >> /home/build/.bashrc
su - build -c 'CCACHE_DIR=/ccache ccache -M 50G' 
/usr/local/bin/repo version | head -2; java -version 2>&1 | head -1; nproc; free -g | sed -n 2p; df -h /src | tail -1
