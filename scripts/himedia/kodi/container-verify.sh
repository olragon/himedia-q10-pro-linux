#!/usr/bin/env bash
# Runs INSIDE the himedia-kodi-xbuild container (mounted at /w) after container-build.sh: inspect the UNSTRIPPED binary,
# prune + strip the stage tree, then exercise it under qemu-arm-static. Env: PREFIX SRC
set -uo pipefail
S=/w/stage$PREFIX
tar --warning=no-unknown-keyword -C / -xzf /w/ffmpeg-v4l2req-armhf.tar.gz   # FFmpeg libs at the box path (fresh container)
UNSTRIPPED=/w/build/kodi-gbm                # cmake build-tree binary, so these checks stay repeatable after the stage is stripped
BIN=$S/lib/kodi/kodi-gbm
X=arm-linux-gnueabihf
echo "== ELF"; file "$BIN" | cut -c1-200
$X-readelf -A "$BIN" | grep -E "Tag_CPU_arch|Tag_ABI_VFP_args|Tag_FP_arch|Tag_Advanced_SIMD" || true
echo "== dynamic"; $X-readelf -d "$BIN" | grep -E "RPATH|RUNPATH"

echo "== code paths compiled in (UNSTRIPPED symbols)"
$X-nm -C "$UNSTRIPPED" 2>/dev/null | grep -E "CDVDVideoCodecDRMPRIME::(Open|Register|Create)|CRendererDRMPRIME::(Create|Register)|CRendererDRMPRIMEGLES::|CVideoLayerBridgeDRMPRIME::|CWinSystemGbm::|CDRMAtomic::" | awk '{$1="";$2="";print}' | sort -u | head -20
echo "== strings (patch #25467 + settings + EGL import)"
strings -a "$UNSTRIPPED" | grep -E "creating \{\} hwdevice context|unable to create \{\} hwdevice|videoplayer\.useprimedecoder|videoplayer\.useprimerenderer|drm_prime|CDVDVideoCodecDRMPRIME::\{\} - using decoder|EGL_EXT_image_dma_buf_import|GL_OES_EGL_image_external|--windowing|DRM_FORMAT_MOD" | sort -u | head -30

echo "== GLES shaders (version directives; ES 2.0 = #version 100)"
grep -rh "#version" $S/share/kodi/system/shaders/GLES | sort | uniq -c
echo "== context version requested by the GBM+GLES windowing"
grep -n "EGL_CONTEXT_CLIENT_VERSION" /w/src/$SRC/xbmc/windowing/gbm/WinSystemGbmGLESContext.cpp

echo "== prune + strip"
rm -rf $S/include $S/lib/kodi/cmake $S/share/kodi/cmake $S/lib/firewalld $S/bin/TexturePacker $S/bin/kodi-TexturePacker
$X-strip --strip-unneeded "$BIN"
find $S -name '*.so*' -type f -exec $X-strip --strip-unneeded {} + 2>/dev/null || true
du -sh $S; ls -l "$BIN"
find $S -type f -name '*.so*' | head

echo "== NEEDED -> armhf packages"
$X-readelf -d "$BIN" | sed -n 's/.*NEEDED.*\[\(.*\)\]/\1/p' | sort -u > /w/needed-sonames.txt
tr '\n' ' ' < /w/needed-sonames.txt; echo
: > /w/runtime-deps.txt
while read so; do p=$(dpkg -S "/usr/lib/arm-linux-gnueabihf/$so" "/lib/arm-linux-gnueabihf/$so" 2>/dev/null | head -1 | cut -d: -f1 || true); echo "${p:-UNKNOWN($so)}" >> /w/runtime-deps.txt; done < /w/needed-sonames.txt
sort -u /w/runtime-deps.txt -o /w/runtime-deps.txt; tr '\n' ' ' < /w/runtime-deps.txt; echo

echo "== loader resolution under qemu (missing libs; where do libav* come from?)"
export QEMU_LD_PREFIX=/
LD_TRACE_LOADED_OBJECTS=1 qemu-arm-static -L / "$BIN" 2>&1 | grep -E "libav|libsw|libpostproc|not found" || echo "(no libav/not-found lines)"
echo "== qemu: kodi-gbm --version"
export HOME=/tmp/kodihome; mkdir -p $HOME
timeout 120 qemu-arm-static -L / "$BIN" --version 2>&1 | head -12
echo "== qemu: kodi-gbm --help (windowing options)"
timeout 120 qemu-arm-static -L / "$BIN" --help 2>&1 | grep -iE "windowing|gl-interface|standalone|portable|debug" | head
