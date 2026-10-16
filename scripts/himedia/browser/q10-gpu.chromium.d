# /etc/chromium.d/q10-gpu — Chromium on the Q10's Mali-T720 (Mesa panfrost).
# Chromium 150 refuses a GLES2 context ("GLES3 is unsupported and ES version fallback is
# disabled") and then renders everything on the CPU with no WebGL. panfrost exposes only GLES 2.0
# on Midgard T720; MESA_GLES_VERSION_OVERRIDE=3.0 makes it report 3.0 and Chromium keeps its GPU
# process. Measured 2026-10-11 (k15, VDP + glamor desktop): test page 11.7 -> 38 fps at the same
# CPU, WebGL on, 0 panfrost job faults (docs/261012-himedia-chromium-kodi-hw.md).
# ⚠️ The override is a claim the hardware is not certified for. Scope: exported here, so it applies
# to Chromium's process tree only — never put it in /etc/environment.
# Remove this file to return to software rendering.
export MESA_GLES_VERSION_OVERRIDE=3.0
