# Q10 Pro: user-selectable boot — Linux desktop, Kodi, Android 13, stock Android 7

**Date:** 2026-10-12
**Status:** Complete for desktop / Kodi / Android 13 (measured on the box). Stock Android 7: experimental, opt-in. TV look + remote press need Tim.

## Goal
One box, chosen with the remote at power-on (and switchable later without a cable):
Linux desktop · Kodi · a recent Android · the stock Android — with no eMMC write and a
fallback for every step.

## Constraints (standing)
- ⛔ Never write the eMMC. ⛔ Never write the stick's `uImage` (k14 = the fallback kernel).
- Every new kernel is tried by `kexec-try.sh` under the SP805 first.
- Logs for every run in `archive/`.

## Findings that shape the design (read 2026-10-12)
- **No newer vendor Android exists.** The box runs `Hi3798CV200:7.0/HMD-2.1.7/2020-08-18`, the
  last HiMedia build (`docs/261010-himedia-q10-pro-firmware-catalogue.md`). Updating the eMMC
  Android is therefore impossible *and* forbidden — a recent Android has to run on our kernel.
- **Recent Android on our kernel = Waydroid.** `ota.waydro.id` publishes **LineageOS 20.0
  (Android 13) for `waydroid_arm` (32-bit), built 2026-09-27** — VANILLA 689 MB, GAPPS 1.1 GB,
  plus a `MAINLINE` vendor image (Mesa). It is a container on the running mainline kernel: root on
  SATA, no bootloader change, deleted with one `rm -r`.
  Waydroid's apt repo has **no armhf** `libgbinder`/`python3-gbinder` → build them for armhf.
  k15 lacks `ANDROID_BINDER_IPC`/binderfs, `VETH`, `BRIDGE`, NAT, `CGROUP_FREEZER`, `FUSE`, `PSI`
  → a k16 kernel.
- **The stock Android can be started from Linux by kexec.** The eMMC `kernel` partition (backup
  `emmc-dump/kernel.img`) is an ADVCA header + a *plaintext* Android boot image at 0x2000
  (page 16 KiB): uImage-wrapped zImage at 0x6000 with its DTB appended (0x8b5060), gzip ramdisk at
  0x8ba000, empty cmdline. The cmdline comes from the U-Boot env (`bootargs` + `bootargs_2G`).
  kexec only *reads* the backup; a hang is caught by the SP805 and lands back in Linux.
  ⚠️ Android itself writes its own `userdata`/`cache` on the eMMC while it runs — exactly as it
  does when the stick is pulled today. That is Android being used, not us flashing it.
- **A cold boot always runs the stick's k14**, which cannot change. So k14 is stage 1: it kexecs
  the chosen kernel, guarded by a failure counter so a bad kernel cannot loop.

## Approach
1. **k16** = k15b + binder/binderfs, veth, bridge, nf NAT/masquerade, freezer, fuse, psi, zram.
   `kexec-try.sh k16`; stage `q10_aiao.ko` per kernel (open TODO).
2. **Waydroid (Android 13)**: armhf libglibutil/libgbinder/python3-gbinder (agent, Docker armhf),
   `waydroid` 1.6.x (arch all), LineageOS 20 VANILLA `waydroid_arm` + MAINLINE vendor. Session =
   `cage` (wlroots kiosk, GLES2 on panfrost) + `waydroid show-full-ui`. Measure: boot time,
   RAM, GPU faults, frame rate; fall back to software GL if panfrost faults.
3. **Stock Android 7 by kexec** (agent extracts kernel/dtb/initrd + cmdline; I test under the SP805).
4. **Session switcher** `q10-session`: `desktop | kodi | android | stock-android`; systemd units
   per session; a full-screen TV menu (remote: up/down/OK, 10 s timeout → last choice) at boot and
   on a remote hot-key; `q10-session set|switch|menu` over ssh.
5. **Boot chain**: k14 (stick) → stage-1 → kexec k16 (`q10.session=` on the cmdline) with the
   failure counter → session. Stock Android is a kexec from the menu.

## Files to Change
`scripts/himedia/android/` (waydroid build + install, stock-android kexec kit),
`scripts/himedia/session/` (q10-session, menu, units), `scripts/himedia/build-kernel-arm32.ts`
(k16 options), `scripts/himedia/kexec-try.sh` (stage q10_aiao.ko), this doc, TODO.md.

## Validation
- k16 up via kexec-try, all k15 functions still load (VDP, VDEC, panfrost, audio, WiFi).
- `waydroid status` = RUNNING, Android 13 UI on the VDP (screenshot via the Linux side), 0 js faults.
- Stock Android kexec: the box answers as Android (adb on the LAN) within the watchdog window.
- `q10-session switch` moves between desktop ↔ Kodi ↔ Android 13 without a reboot.
- Every path has a stated fallback; TV look-checks listed as needing Tim.

## Notes

## Results (2026-10-12, measured on the box; screens read from the live VDP scanout)

**What the box does now.** Power on → U-Boot → stick k14 (never rewritten) → `q10-kexec-chain`
kexecs **k18** (SP805 armed, failure counter) → `q10-video-stack` loads VPSS/VDEC/panfrost/VDP under the
guard → `q10-session-boot` shows the TV menu (10 s countdown, remote ▲▼/OK) → the chosen session.
Long-press SETUP or MENU on the remote reopens the menu at any time; `q10-mode switch <s>` over ssh.

| check | result |
| --- | --- |
| cold reboot → k18 chained (`q10.chained=1`) | **80 s** (135 s before dropping `After=q10-sata`) |
| k18 → desktop on the TV (`systemd-analyze`) | 10.6 s kernel + 58.4 s userspace |
| failure counter | written before the kexec, cleared by `q10-kexec-chain-ok` at multi-user (`attempts=0` read) |
| after a watchdog reset (stock-Android test) | box came back by itself: k14 → k18 → desktop |
| menu on the TV, opened over Kodi | rendered (grab mean 0.185); picks the VDP fbdev by name |
| remote keys (uinput, same codes as the IR device) | Down+OK in the menu started Kodi; Android's InputDispatcher logged 8 KeyEvents for 4 presses |
| live switches | desktop ↔ Kodi ↔ Android 13, each screen grabbed |
| GPU faults across all of it | **0** |

**Android 13 = LineageOS 20 (`20.0-20260926-VANILLA-waydroid_arm`, security patch 2026-02-01)** in
Waydroid 1.6.2 on k18, full screen through `cage` on the VDP, GPU = Mali-T720 (Mesa 26.0.8 panfrost,
reported as ES 3.0). Launcher **100 s** after choosing it (first boot ~3.5 min); idle **0.85 s CPU / 20 s**
(≈1% of the box); **724 MB** used, 1.2 GB available; 0 SurfaceFlinger crashes, 0 GPU faults.
Screenshot: `docs/photos/261012-android13-home-on-vdp.png`.

What it took (each one a silent failure first):
1. **k16-k18 kernel options**: binder/binderfs, cgroups (memcg, cpuset, freezer, pids, bpf device),
   PSI, FUSE, overlayfs, zram, dma-heaps, veth/bridge, nf_tables NAT, `INPUT_UINPUT`, and
   ⛔ **`EXT4_FS_POSIX_ACL`** — without it vold's default ACL on `/data/media/0` fails ("Operation not
   supported"), `vold_prepare_subdirs` exits 255 and system_server loops on "error rebooting into recovery".
2. **armhf binder stack**: Waydroid's repo has no armhf `libgbinder`/`python3-gbinder`; built as real
   `.deb`s on the box (`waydroid-install.sh build`; pin COMMIT shas, an annotated tag's sha ≠ HEAD).
3. **`waydroid-net.sh` hard-codes legacy iptables**; 6.18 gates those tables behind `IP_NF_IPTABLES_LEGACY`.
   Its nft path works → the installer flips `LXC_USE_NFT=true` (re-applied on every install).
4. **The LXC config bind-mounts `$XDG_RUNTIME_DIR/pulse/native`**: no audio server → "container failed
   to start". The session starts PipeWire + pipewire-pulse first (`q10-android-run`).
5. **GLES 2.0 only on the T720** → SurfaceFlinger's SkiaGL SIGSEGVs in `libgallium_dri`. Two fixes, both needed:
   `MESA_GLES_VERSION_OVERRIDE=3.0` exported by an **init `.rc` in the vendor overlay** (Mesa reads it
   from the environment; a `debug.mesa_*` property is not consulted for it), and
   **`service.sf.prime_shader_cache=0`** — SurfaceFlinger's boot-time shader priming was what crashed
   (6-7 times per boot, which in turn broke first-boot user setup). `waydroid-props.sh gpu-skia|gpu-gles|soft`.
6. **Android's `/data` lives in `/root/.local/share/waydroid/data`**, not `/var/lib/waydroid/data` —
   wiping the latter does nothing. A first boot interrupted by crash loops leaves a half-made `/data`;
   wipe it and boot clean.
7. **TV-box settings** (`waydroid-install.sh setup`): timezone from the host, no lock screen, hide
   crash/ANR dialogs (SystemUI's keyguard can ANR at boot on 4×A53). `settings`/`locksettings` refuse
   uid 0 → `waydroid shell -u 2000`.
8. **cage must be pointed at the VDP** (`WLR_DRM_DEVICES=/dev/dri/by-path/...display-controller-card`);
   it otherwise also opens simpledrm.

**Stock Android 7 (eMMC, untouched)**: the kit kexecs the vendor kernel from a read-only backup copy.
Run 1 (from k16): Android answered on DHCP .200 after 22 s, and the TV showed **vertical-stripe noise**
(photo from Tim); the watchdog returned the box to Linux. Runs 2 (from k14) and 3 (k18 with `histb_vdp`
unloaded): no Android address seen before the watchdog reset — inconclusive, the probe reads a LAN box's
ARP table. ⇒ **opt-in only** (`touch /etc/q10/stock-android.enable`), "Experimental, returns here after
~3 min" in the menu. Details: `docs/261012-himedia-stock-android-kexec.md`.

**Not verified (needs Tim):** a real remote press in each session (uinput proves the path, not the
physical remote's keymap in Android), audio from Android, the picture quality of Android on the TV
(grabs are read back from the scanout buffer, which is exactly what the VDP sends), Play-Store apps
(VANILLA image; GAPPS is one `waydroid init` away), video playback inside Android (software codecs only).

**Fallbacks:** `install-kernel-chain.sh --off` (cold boots stay on k14), `q10-kexec-chain reset`,
`install-session.sh --uninstall` (old boot flow), `waydroid-install.sh uninstall`, and the stick's k14
is never written — pulling the stick still boots the stock Android 7 from the eMMC as before.
