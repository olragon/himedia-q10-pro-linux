# Q10 Pro — RESTORE pinhole probe: result

**Date:** 2026-10-10 · Probe: a deliberately invalid 196-byte `update.zip` on a FAT32 stick,
RESTORE pinhole held at power-on. Baseline and after logs captured and diffed.

## Observed

Boot → Android loading (**abnormal boot path**) → HiMedia logo → **stuck**. Removing the stick
and restarting returned the box to its normal Kodi UI.

## Verdict: partial, and not the clean answer we wanted

| | |
|---|---|
| The pinhole triggers an alternate boot path | ✅ **proven** — the boot was visibly abnormal |
| Nothing was written | ✅ **proven** — `ro.build.fingerprint` unchanged (`HMD-2.1.7/2020-08-18.140128`) |
| The box survives a failed attempt | ✅ **proven** — recovered on stick removal |
| Recovery reads the USB and finds a package | ❌ **NOT established** |
| A valid package would be accepted | ❌ **NOT established** |

⛔ **Android's recovery never ran.** `/cache/recovery/last_log`, `last_install` and `last_kmsg`
are all still **0 bytes**, `/cache/recovery/` is byte-identical to the baseline, and the
bootloader control block in `misc` still reads `command="" status=""`. Android recovery always
writes `last_log`; its absence is conclusive.

⇒ **The RESTORE pinhole goes to the BOOTLOADER's updater, not Android recovery.** That fits what
the dumped loader contains (`usb start`, `fatload`, `usb part`) and explains the hang: a
bootloader with `stdout=serial` and nothing to print to has no way to report an invalid package.

⇒ **Without a UART we cannot see what that path did.** This is the first concrete argument that
the UART has real *diagnostic* value even though it is not needed for rescue — the probe was
designed to avoid needing it and ran into exactly the blind spot it was avoiding.

⚠️ "Stuck on the HiMedia logo" is the **same symptom** as the documented brick on this model. The
difference is ours recovered the moment the stick was removed. That is reassuring about this
attempt and says nothing about a flash interrupted mid-write.

## ⛔ One recovery path is now known to be UNAVAILABLE

`Settings → Upgrade → Local Upgrade` — the gentler route — **cannot be used on this unit**,
because the vendor Settings app crashes:

```
java.lang.NumberFormatException: For input string: "32A NTT"
  at java.lang.Integer.parseInt(Integer.java:521)
  at com.hitv.tv.settings.data.ItemDataManager.getWifiList(ItemDataManager.java:460)
  at com.hitv.tv.settings.fragment.WifiListFragment.updateRecyclerView(WifiListFragment.java:206)
```

⭐ **Root cause: a neighbouring SSID is named `"32A NTT"`, and `getWifiList()` runs
`Integer.parseInt()` over a scan field.** Any non-numeric SSID in range crashes the Wi-Fi list,
which takes the whole Settings app down (`com.hitv.tv.settings` killed twice, plus a second
`NullPointerException` on the same activity, plus a `tombstone_00`). This is a pre-existing
vendor defect triggered by a neighbour's network name — not caused by anything we did.

⇒ Consequences: **Wi-Fi cannot be configured from the UI** while that SSID is in range (hence the
box is on Ethernet at `192.168.1.200`, `eth0` MAC `02:00:00:00:10:01`), and the Local Upgrade
recovery route is gone. ⭐ Ethernet is the better interface anyway — it is the one mainline
supports; Wi-Fi is SDIO and works only under the vendor stack.

## Recovery paths, re-ranked honestly

| Path | Status | Needs |
|---|---|---|
| **adb + `dd` from our verified dump** | ⭐ **proven, used repeatedly today** | Android to boot, and adb |
| Pinhole + a **valid** package | ⚠️ **unproven** — hung on an invalid one | nothing, in principle |
| Settings → Local Upgrade | ⛔ **unavailable** — Settings crashes | — |
| UART | not fitted | opening the case |

⛔ **So our only PROVEN recovery path requires Android to boot.** That is the real finding of this
probe, and it is less comfortable than the plan assumed. The env change's own fallbacks do not
depend on the pinhole — a corrupt env falls back to the loader's compiled-in defaults, and a
failed USB load falls through to the stock eMMC boot — so the narrow scenario that would need the
pinhole is a loader-level failure. But "narrow" is not "covered".

## Next, as a choice rather than a plan

1. **Proceed with the env change**, relying on its three fallbacks and accepting that a
   loader-level failure has no proven route back; or
2. **Fit the UART first** after all — the probe showed it is the only way to observe the
   bootloader path, and a bricked box would need it anyway; or
3. **Re-probe with a VALID package** (we now hold the fingerprint-exact 2.1.7). A same-build
   reflash is no longer a downgrade, so it would genuinely test the path — at the cost of
   rewriting the bootloader and formatting `securestore`, which only our dump preserves.

ref: docs/261010-himedia-q10-pro-firmware-catalogue.md
ref: docs/261010-himedia-q10-pro-physical-runbook.md
