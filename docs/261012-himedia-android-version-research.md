# Which Android to build for Waydroid on the Q10 Pro (AArch32) — research 2026-10-12

Scope: web + git only, no box access. Raw artifacts: were at `$HIMEDIA_ROOT/scrape-lab/sota/android-waydroid-arm32/` — deleted 2026-10-12 with the A16 cleanup.
Tags: **[F]** fetched and read this session · **[I]** inferred · **[U]** unverified.

## Decision

1. **Build LineageOS 23.2 (Android 16 QPR2) from upstream `waydroid/*` `dev/lineage-23.2`, product `lineage_waydroid_tv_arm` or `lineage_waydroid_arm`.**
   Upstream Waydroid has a live A16 branch with explicit 32-bit-only products; no other newer branch exists upstream. [F]
2. **Fallback: Android 13 / LineageOS 20 from source** (official branch, same product names, known to work with our 32-bit boot). Upstream has NO A14 or A15 branch. [F]
3. **Do not pick A14/A15.** Only the community `WayDroid-ATV` org carries `lineage-21` / `lineage-22.2` branches with `waydroid_arm`; they are not upstream and their builds ship x86_64 only. [F]
4. Use **phone/tablet UI + a TV launcher** for the first boot of a new version; try ATV (`waydroid_tv_arm`) second. Reason in section 5.
5. Expect A16 on arm32 to be **unproven**: no one has published an arm32 A16 image or a boot report (section 1). We would be first. [I]

## 1. Waydroid trees and branches [F]

| Repo | Branches (git ls-remote) |
|---|---|
| waydroid/android_vendor_waydroid | `dev/lineage-23.2`, `lineage-17.1`, `lineage-18.1`, `lineage-20` |
| waydroid/android_device_waydroid_waydroid | `dev/lineage-23.2`, `lineage-17.1`, `lineage-18.1`, `lineage-20`, `wip/drop-omx` |
| waydroid/android_hardware_waydroid | `dev/lineage-23.2`, 17.1, 18.1, 20, `clipboard`, `openfde-wip`, `wip` |
| waydroid/android_vendor_waydroid_init, android_prebuilts_vndk_v34 | `dev/lineage-23.2` only |
| LineageOS/android manifest | lineage-20.0, 21.0, 22.0-22.2, 23.0-23.2, **24.0** (A17) |

- `dev/lineage-23.2` is active: vendor commits 2026-07-12 .. 2026-09-08 (task control plane, SurfaceFlinger task streams, hostaidls.conf), device commits to 2026-09-08 (erofs images, metadata partition, "Add a 64-bit-only x86 product", "Use c2.ffmpeg on ARM images", "Enable nouveau for ARM targets"). [F]
- `manifest_scripts` ships `manifests-28/29/30/33/36`. SDK 34 and 35 (A14, A15) are **absent**: upstream went 13 -> 16. [F]
- `AndroidProducts.mk` on `dev/lineage-23.2` lists `lineage_waydroid_arm`, `lineage_waydroid_arm64(_only)`, `lineage_waydroid_tv_arm`, `..._tv_arm64(_only)`, x86 variants. `waydroid_arm/BoardConfig.mk`: `TARGET_ARCH := arm`, `armv7-a-neon`, `armeabi-v7a`; `PRODUCT_MODEL := WayDroid arm Device (32-bit only)`; mesa gallium list includes panfrost, lima, etnaviv, freedreno, v3d, vc4, nouveau, tegra. TV: `waydroid_tv_arm` sets `PRODUCT_IS_ATV := true`, model "(TV form factor)". [F]
- Caveat: the x86 32-bit dirs (`waydroid_x86`, `waydroid_tv_x86`) were dropped on `dev/lineage-23.2` (directory listing) while `waydroid_arm` stayed. [F] That an `arm` dir exists does not prove it builds or boots. [I]
- Manifest 36 pulls many third-party forks: `android-generic/external_drm_hwcomposer`, `android-generic/external_llvm-project` (release_22.x), `WayDroid-ATV/*` mesa3d (lineage-18.1 branch), libdrm, pulseaudio, TvSettings, rust crates `android16-qpr2-release`. [F]
- Upstream is not fully released: the OTA repo still serves lineage-20.0 images (arm 20260927; commits 2026-09-27 all x86). [F] Issue waydroid/waydroid#2229 (2026-02-17, open): "Update image OS to Android 16 / Lineage 23". PR #2393 (open) adds A13-16 vendor detection to the initializer; #2410 (open) lxc changes for an A16 guest (gralloc5, `/metadata`, host AIDL). #2433: A16 images, Zygisk unusable. #2436: 20260927 vendor image multi_windows flicker. [F]
  => The **host side** (waydroid initializer/lxc) needs patches for A16 on our box; stock waydroid host may reject or mis-detect it. [I]
- Community: `WayDroid-ATV` org (pushed 2026-10-10 on device/vendor lineage-23.2) and `supechicken/waydroid-builds` -> now `WayDroid-ATV/waydroid-builds`. Releases: 20260717 (LOS 23.2, **x86_64 only**, "ARM64 not available, see 20260302"), 20260302 (A16, arm64 present), 20260224 (A15 x86_64), 20260125 (A14 x86_64). **No arm32 release in any.** README table claims A13-16 features (VA-API, ARM translation layer) for x86. Its device repo has `waydroid_arm` / `waydroid_tv_arm` dirs on lineage-21, 22.2, 23.0, 23.2, 24.0. [F]
- Not checked: Droidian, Ubuntu Touch/Halium, ATL. Halium A15/A16 appear only in PR text above (Pixel 9 Pro). They target arm64 phones. [U]

## 2. 32-bit support in AOSP/Lineage [F unless noted]

- `LineageOS/android_build` `target/product/aosp_arm.mk` exists on lineage-20.0, 21.0, 22.2 and **23.2** (model "AOSP on ARM32"); 23.2 also adds `aosp_arm64_plus_armv7.mk`. So a 32-bit-only product is still in tree for A16.
- Android 16 CDD (source.android.com/docs/compatibility/16/android-16-cdd, via search snippet): handheld with <2 GB must support a single ABI (64-only or 32-only). [F, snippet only] Legal 32-only is therefore still allowed for low-RAM. Whole-system 32-bit-only deprecation notice: **none found**. [U]
- Lineage wiki (clone, 763 device files): 162 devices have `architecture: arm`; highest version for them: 18.1 (41), 17.1 (8), 16.0 (7), 15.1 (14), 14.1 (80), 13.0 (12). **Zero 32-bit devices on lineage 19+.** So no real armv7 device validates the Lineage 20-23 userspace; only Waydroid does. [F]
- Practical limit: Google Play and most modern apps are 64-bit; an armeabi-v7a-only image runs only apps with 32-bit libs. [F, search snippet]

## 3. Android TV [F unless noted]

- `device.mk` (`dev/lineage-23.2`): `PRODUCT_IS_ATV` inherits `device/google/atv/products/atv_base.mk` + `vendor/lineage/config/common_full_tv.mk`, packages TvSettings, TvSystemUI, Catapult, Generic_ATV.kl; `common_tv.mk` brings LeanbackIME and `device/lineage/atv`. Manifest replaces Lineage TvSettings with the WayDroid-ATV fork.
- Which launcher the ATV product ships without GMS: **not determined**. `device/google/atv` content not fetched. Open-source options (FLauncher, Projectivy) not verified for Waydroid. [U]
- ATV needs: `waydroid_tv_arm` product, the TvSettings fork, `frameworks/waydroid`, a leanback launcher, D-pad/CEC key layout; GApps TV (`gapps_tv`) is optional and off by default (commit "Do not build GApps by default"). Waydroid's window model is a single full-screen host window, which suits TV. [I]
- WayDroid-ATV maintainers publish ATV images for x86_64 only. [F]

## 4. Build cost

- AOSP official: 64-bit x86 Linux, **>= 400 GB** disk (250 sync + 150 build), Google's own reference 64 GB RAM / 72 cores = ~40 min full build. [F] source.android.com/docs/setup/start/requirements
- Waydroid-ATV BUILDING.md: "~300 GB", "up to ~5 hours". Lunch targets `lineage_waydroid_<arch>-ap2a|bp1a-userdebug`; commands `make systemimage` + `make vendorimage`. [F]
- Waydroid docs: `apply-waydroid-patches` after sync; build `make systemimage` and `make vendorimage` only; since lineage-20.0 output is raw (no simg2img). [F]
- So **yes**, only system+vendor images are built. Boot/recovery are not needed. [F]
- 16 threads / 24-32 GB: 32 GB is below Google's recommendation; Lineage wiki advice (16 GB min) not fetched [U]. Expect ~5-10 h clean on i7-10700K, swap/zram needed at link; Mesa + llvm release_22.x from source adds time. [I]
- A16 sync is larger than A13 (clone-depth 1 only on Waydroid projects; the rest full). Plan 350-450 GB free. Host must be Linux x86_64 (not a Mac; a server with ~128 GB RAM). [I]

## 5. Recommendation and risks

**Target: A16 (LOS 23.2) `lineage_waydroid_tv_arm` first-boot via `lineage_waydroid_arm`** — newest, security-patch current (LineageOS manifest forks `android-security-16.0.0_r8`, 2026-09 ASB [F]), actively maintained upstream. Keep LOS 20 prebuilt as the working baseline.

Phone/tablet + TV launcher vs ATV: start with `waydroid_arm` (fewer moving parts: no TvSettings fork, no atv_base). Add ATV after the base boots. [I]

Risks:
1. No arm32 A16 Waydroid image or boot report exists; upstream arm CI evidence absent. [F/I]
2. `dev/lineage-23.2` is a dev branch; patches for host waydroid (#2393/#2410) are unmerged. [F]
3. RAM: A16 on 2 GB or less, 32-bit — framework/SystemUI heavy (Material 3 Expressive on by default). Box RAM unconfirmed. [U]
4. gralloc/GPU: 23.2 relies on gralloc5/AIDL host HAL paths for Halium; our mainline-kernel DRM path is the minigbm + mesa (lineage-18.1 fork) route; mesa on armv7 untested. [I]
5. A16 needs `/metadata` writable, erofs support in host kernel, binder/ashmem config. [F partly; kernel check U]
6. Third-party forks (WayDroid-ATV, android-generic) can move or vanish: pin SHAs when syncing. [I]
7. Build is disk-heavy and cannot run on the Mac. [I]
8. OTA signing: our own image needs our own OTA channel (`waydroid init -c/-v`, as in WayDroid-ATV releases). [F]

## Sources ledger (fetched this session)

- git ls-remote / GitHub API: waydroid/{android_vendor_waydroid, android_device_waydroid_waydroid, android_hardware_waydroid, android_vendor_waydroid_init, android_prebuilts_vndk_v34, OTA, waydroid}; org repo listing
- raw: waydroid/android_device_waydroid_waydroid `dev/lineage-23.2` {AndroidProducts.mk, device.mk, waydroid_arm/*, waydroid_tv_arm/*}; android_vendor_waydroid `dev/lineage-23.2` manifest_scripts/manifests-36/*, generate-manifest.sh
- ota: https://raw.githubusercontent.com/waydroid/OTA/master/system/lineage/waydroid_arm/VANILLA.json
- issues/PRs: github.com/waydroid/waydroid #2229, #2393, #2410 (+ titles #2433, #2436)
- WayDroid-ATV: org repo list, device/vendor branch lists, releases of waydroid-builds, BUILDING.md, README
- https://docs.waydro.id build page (raw waydroid/docs `development/compile-waydroid-lineage-os-based-images.md`)
- LineageOS/android (manifest branches), LineageOS/android_build `target/product` listings, `aosp_arm.mk`; vendor_lineage `common_full_tv.mk`; LineageOS/lineage_wiki clone
- https://source.android.com/docs/setup/start/requirements
- WebSearch snippet only (not page-fetched): Android 16 CDD, esper.io 64-bit article, barisuslucan.com AOSP ABI guide
- Not fetched: Droidian/Ubuntu Touch/ATL, device/google/atv, FLauncher/Projectivy, Lineage build wiki RAM figures.
