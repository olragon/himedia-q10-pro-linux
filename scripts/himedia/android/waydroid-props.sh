#!/bin/bash
# waydroid-props.sh <profile> — ON THE BOX: set the Waydroid graphics profile, regenerate
# waydroid_base.prop. Takes effect at the next `waydroid session start`.
#   gpu-gles  Mesa panfrost + SurfaceFlinger's legacy GLES RenderEngine (SkiaGL crashes in
#             libgallium on the T720, 2026-10-12)
#   gpu-skia  Mesa panfrost + the default SkiaGL RenderEngine (crashes today; kept to re-test)
#   soft      ANGLE on lavapipe (software Vulkan) + memfd gralloc — no GPU at all
set -euo pipefail
p=${1:?usage: waydroid-props.sh gpu-gles|gpu-skia|soft}
python3 - "$p" <<'PY'
import configparser, sys
prof = sys.argv[1]; path = "/var/lib/waydroid/waydroid.cfg"
c = configparser.ConfigParser(); c.optionxform = str; c.read(path)
if not c.has_section("properties"): c.add_section("properties")
P = c["properties"]
for k in ["debug.renderengine.backend", "ro.hardware.egl", "ro.hardware.gralloc", "ro.hardware.vulkan",
          "debug.mesa_gles_version_override", "debug.mesa.gles_version_override",
          "service.sf.prime_shader_cache"]:
    P.pop(k, None)
# SurfaceFlinger pre-compiles its shaders at start (primeCache); on the T720 that SIGSEGVs in
# libgallium_dri 6-7 times per boot, and the restarts break first-boot user-data setup.
if prof.startswith("gpu"):
    P["service.sf.prime_shader_cache"] = "0"
if prof == "gpu-gles":
    P["debug.renderengine.backend"] = "threaded"
elif prof == "gpu-skia":
    pass
elif prof == "soft":
    P["ro.hardware.egl"] = "angle"; P["ro.hardware.vulkan"] = "lvp"; P["ro.hardware.gralloc"] = "default"
else:
    sys.exit("unknown profile " + prof)
P["q10.graphics.profile"] = prof
c.write(open(path, "w"))
PY
waydroid upgrade -o >/dev/null 2>&1 || true
grep -E "renderengine|hardware.egl|hardware.gralloc|hardware.vulkan|q10.graphics" /var/lib/waydroid/waydroid_base.prop
