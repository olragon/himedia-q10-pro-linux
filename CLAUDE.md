# himedia-q10-pro-linux — agent instructions

Mainline Linux 6.18 (AArch32) + Debian trixie armhf on the HiMedia Q10 Pro (Hi3798CV200). This is a
**public repo**: everything committed here is published. `AGENTS.md` is a symlink to this file.

## ⛔ Never commit
- LAN addresses beyond the documented defaults, real MACs, disk or board serials, filesystem UUIDs,
  home paths, host names of private machines, order numbers, photos with EXIF/GPS (strip with
  `magick in -strip out`). Use `$Q10_HOST`, `$HIMEDIA_ROOT`, `$Q10_MAC` and placeholders.
- eMMC dumps or any vendor partition image: several partitions are unique to a unit (keys).
- `archive/` (run logs) is gitignored on purpose: logs carry addresses and serials.
- DRM probing or key handling of any kind.

## ⛔ Box safety
- **Never write the eMMC** except the one documented U-Boot env change (`himedia:env --apply`), and
  only with a verified dump (`himedia:dump`) in hand.
- Kernel images are written to the boot stick from the host, never from the box itself.
- Mainline `reboot` hangs on this SoC without the SP805 restart patch (0007): arm the watchdog first.
- Never retune the SATA PHY under a mounted filesystem (see `docs/261014-himedia-sata-kernel-vs-board.md`).
- The SoC has no passive thermal trip (critical only, 110 °C): sustained-load tests need their own guard.
- A claim that triggers a physical action (flash, boot, power-cycle) is verified on the artifact first:
  size, hash, the literal confirming line. "Exit 0" is not "it worked".

## Conventions
- Host tools: TypeScript on Bun (`bun run himedia:*`, see package.json). On-box tools: POSIX sh/bash and
  Python 3 (stdlib). Long builds run in a tmux/screen window and log to `archive/`.
- `bun run test` must stay green (Bun tests + the Python unit tests of `session/` and `browser/`).
- Kernel patches: one topic per patch, `git format-patch` headers, numbered in `kernel/arm32/`.
- Research notes go to `docs/YYMMDD-<slug>.md` and state what was read, inferred, or not known.
- License: GPL-2.0-only; keep third-party patch headers intact.
