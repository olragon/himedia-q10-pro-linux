# Q10 Pro firmware catalogue — what we hold, and what an OTA actually does

**Date:** 2026-10-10 · Sourced through a logged-in browser.

## Provenance matters: this is a Vietnamese unit

The box reports build `2020-08-18.140128`, which is **newer than the newest global official**
(2.1.4, 2019-05-31). Tim confirmed the unit is a Vietnamese one, so its lineage runs through
the VN distributors (`himediatech.vn`, `hieuhien.vn`, `itvplus.net`) rather than futeko.

Build fingerprints follow `HiSTBAndroidV6/Hi3798CV200/Hi3798CV200:7.0/HMD-<ver>/<date>:eng/release-keys`.
Note **`eng`** — which is why `adb root` works on this unit at all.

## What we now hold, verified

| Package | Build | Size | Verified |
|---|---|---:|---|
| Global official **2.1.4** | 2019-05-31 | 644 MB (.rar) | sha256 `637bd0e4…` |
| VN **2.1.1 Google TV** | `HMD-2.1.1/2018-12-24.145100` | 806 MiB | sha256 `03dfdba8…`, 2298 entries |
| VN **2.0.4** (from Android 7) | `HMD-2.0.4/2017-07-05.094159` | 704 MiB | sha256 `20f39259…`, 2179 entries |

Both VN packages are genuine complete OTAs — `META-INF/com/google/android/support_Hi3798CV200`
names the SoC, and they are the `update.zip` directly rather than a wrapped archive.
⚠️ **Not trusted on byte count**: each was opened and its entry list and updater-script read.

### Three links from the 2019 listing are gone

- `2.1.1-stock` → **deleted** ("Page Not Found" in a logged-in session)
- `downgrade-a7-to-a5.1`, `1.1.0-stock` (legacy `0B1gM…` ids) → **Access Denied**

⚠️ These are **not** quota blocks, which matters: a quota wall clears in ~24 h and a
copy-to-own-Drive can route around it, whereas a deleted file is gone and an access-denied
file cannot even be viewed, so it cannot be copied either. The distinction is only visible in
a logged-in browser — `curl` and `gdown` both reported a generic failure.

⇒ **Link rot is real here and the archive is the mitigation.** `himediatech.vn`'s own page is
stale (newest Q10 Pro entry is `HMD-1.1.0`, 2017-03-16) and `futeko.com` now fails TLS
outright, so what we have locally is likely better than what remains publicly available.

## ⛔ What an OTA actually writes — this reframes the risk

From `2.1.1`'s `updater-script`:

```
package_extract_file("fastboot.img",    …/by-name/fastboot)      ← THE BOOTLOADER
package_extract_file("boot.img",        …/by-name/kernel)
package_extract_file("trustedcore.img", …/by-name/trustedcore)
package_extract_file("pq_param.img",    …/by-name/pqparam)
format("ext4", …/by-name/securestore)                            ← DEVICE-UNIQUE, WIPED
format("ext4", …/by-name/system) · format(…/cache) · delete_recursive("/cache")
```

Two consequences:

1. ⛔ **An OTA rewrites the bootloader.** That confirms the earlier caution rather than
   softening it: a full firmware flash is the operation that bricked another unit, and it is
   categorically riskier than the 64 KiB environment change we are considering.
2. ⛔ **An OTA formats `securestore`**, which is one of the six device-unique partitions. So
   a vendor restore does **not** restore this unit to its own prior state — it erases
   per-device data. **Our dump is the only copy of that.** This is now a concrete reason the
   dump had to come first, not a theoretical one.

## ⭐ A safer update path than the pinhole

`hieuhien.vn` documents the vendor's normal flow, which does not involve the RESTORE button:

1. Copy the package to the **root of a USB stick**, named exactly `update.zip` — do not
   rename it, do not unzip it.
2. On the box: **Settings → Upgrade → Local Upgrade**, then pick the `update.zip`.
3. It takes ~5 minutes and reboots itself. Do not interrupt.

⛔ The packages are **not interchangeable**: 2.1.1 requires the box to be on 2.0.4 or later
already. Respect each entry's constraint — ignoring version order is how these boxes brick.

## ⭐ The partition map is now independently confirmed

The OTA addresses partitions through `by-name` symlinks, and they exist on the box at
`/dev/block/platform/soc/f9830000.himciv200.MMC/by-name/`:

`fastboot→p1 · bootargs→p2 · deviceinfo→p4 · baseparam→p5 · fastplay→p9 · cache→p15 · backup→p17`

Every one matches the mapping the dump tool derived **by index** from `blkdevparts` — two
independent methods agreeing. ⇒ Prefer the `by-name` path in any restore command: it cannot
be thrown off by a partition appearing or disappearing, which is the failure the index
mapping had to be fixed for.

## ⭐ RESOLVED — the installed build is archived

**`2.1.7-q10pro-themed.zip`** · 550,993,205 B · sha256 `c43bc9ae5e9abbba20fdb0b6dfb5bba4c6872eb06064bb6e13976261c57868fe`

Its `META-INF/com/android/metadata` fingerprint is **byte-identical** to what the box reports:

```
HiSTBAndroidV6/Hi3798CV200/Hi3798CV200:7.0/HMD-2.1.7/2020-08-18.140128:eng/release-keys
```

So the running firmware is **HMD-2.1.7, the themed build with Kodi 18.2**
(`update_Q10Pro_(update&themed&Kodi18.2)[v1.1]`), uploaded 2020-08-25. 2266 entries.

⇒ **A vendor-path restore to this unit's exact current state is now possible**, which it was
not before. The eMMC dump remains the only copy of the device-unique partitions, since an OTA
formats `securestore`.

### How it was found, and the trap on the way

⛔ **The widely-cited page for this build links the WRONG package.** The chinagadgetsreviews
article is titled for the Q10 Pro and even prints the correct archive name, but its single
download link points at the **Q30** sibling (`update_Q30_…2020-08-17.173031`). Flashing a Q30
image to a Q10 Pro is exactly the "wrong ROM" mistake that bricks these boxes. ⇒ Map a
download link to its surrounding text before trusting it; the article body and the href
disagreed here.

⭐ The per-model links came from the vendor's own 2.1.7 changelog, kept at
`docs/reference-himedia-2.1.7-changelog.txt`:

| Model | Mediafire id |
|---|---|
| **Q10Pro** | **`1bqf7zcpejcjw96`** |
| Q5Pro | `9121zzg522pgdf1` |
| Q100 | `59n7qkdira0x52e` |
| Q30 | `zoy5vg4qukrf4qr` |

Plus Google-services patch packages (Drive folders) for Q10Pro/Q5Pro and Q100/Q30.
The Q10Pro id was independently corroborated by a German forum thread on 2.1.7.

⚠️ Mediafire needs a **tokenised, time-limited** URL scraped from the file page, so it cannot
be fetched from the id alone — that is why this one goes through the browser rather than the
plain ladder.

## 2.1.7 changelog (vendor's own words)

1. Optimised third-party app playback compatibility (Settings → Advance → Display → HDCP
   Switch; and Display → close the system navigation bar).
2. Optimised the application manager to load and start TV-version applications.
3. CEC support for switching TV or amplifier (Settings → Advance → Standby → HDMI CEC).
4. Fixed the black screen on local playback after enabling HDCP.

## Still missing

Nothing essential. `itvplus.net` was searched (via Google's `site:` operator — its own search
is useless) and tops out at **2017-era** builds (v1.0.9, v2.0.2, and a 2017 "Android TV Google
7.0" set on fshare), all older than what we hold. The Google-services patch packages for
Q10Pro/Q5Pro are available but not yet pulled, and are optional.

ref: docs/261010-himedia-q10-pro-recon-findings.md
ref: docs/261010-himedia-q10-pro-physical-runbook.md
