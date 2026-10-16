# HiMedia Q10 Pro: session switcher and TV boot menu

Status: **running on the box (k18, 2026-10-12)** — menu on the TV, live switches, cold-boot path measured; results in `docs/261012-himedia-dual-boot-android.md` §Results. Box fixes: menu ioctl buffer, VDP fbdev picked by name (fb0 or fb1), no `OnFailure=` (it re-opened the menu over a session it had just started), Kodi `TimeoutStopSec=8` (ignores SIGTERM >20 s as DRM master), quiet Kodi session profile, stock Android opt-in.
Code: `scripts/himedia/session/`. Run the tests: `cd scripts/himedia/session && python3 -m unittest -v test_session` (29 tests).
Menu preview: `$HIMEDIA_ROOT/session/menu.png` (confirm dialog: `menu-confirm.png`).

## What it does

Exactly one of four sessions owns the screen. All of them want DRM master, so they are exclusive.

| session | how it runs | unavailable when |
| --- | --- | --- |
| desktop | `q10-desktop.service` (exists) | the unit file is missing |
| kodi | `q10-kodi.service`, `kodi-v4l2req` (GBM), `KODI_DATA=/var/lib/q10/kodi`, preset `direct` | `/usr/local/bin/kodi-v4l2req` missing |
| android | `q10-android.service`: `cage -- q10-android-run` (waydroid session start, then `waydroid show-full-ui`) | `waydroid` or `cage` missing |
| stock-android | `/usr/local/sbin/q10-stock-android` (kexec of the vendor kernel) | the script or `/var/lib/q10/stock-android/manifest.json` missing |

Parts:

- `q10-mode` (`q10mode.py`): `list | status | get-default | set-default <s> | switch <s> | menu | boot | exited <s>`.
  **Named `q10-mode`, not `q10-session`**: `/usr/local/bin/q10-session` is the X session script that
  `q10-desktop.service` runs, and is left untouched. Exit codes: 0 ok, 1 failed, 2 unknown or unavailable, 3 cancelled.
- `q10-menu` (`q10menu.py`): draws 1920x1080 straight to `/dev/fb0` (geometry from `FBIOGET_VSCREENINFO`, stride from
  sysfs, XRGB8888 and RGB565), input from every evdev device with `EV_KEY`, never grabbed.
  `--screenshot out.png` renders without touching any device.
- `q10-hotkey` (`q10hotkey.py`): long-press watcher.
- `q10-video-stack`: loads `histb_vpss`, `histb_vdec`, `panfrost`, `histb_vdp` (decoder before VDP) through
  `q10-modprobe-guarded <mod> 60`, skipping modules already in `lsmod`.
- Units: `q10-video-stack`, `q10-session-boot`, `q10-session-menu`, `q10-kodi`, `q10-android`, `q10-hotkey`, and the drop-in
  `q10-desktop.service.d/10-q10-session.conf`.

## Design decisions

- **Exclusivity is `Conflicts=`** between the three unit sessions, plus an explicit `systemctl stop <active>` then `start <target>` in `switch`.
- **Video stack.** Every session unit `Requires=`+`After=q10-video-stack`. The menu and the boot service only `Wants=`+`After=`
  it, so the menu still appears if `histb_vdp` fails (it then draws on whatever `/dev/fb0` exists, simpledrm). `histb_vdp`
  evicts simpledrm, so `/dev/fb0` can change identity: `q10-mode` runs `systemctl start q10-video-stack` (blocks until done) *before*
  launching the menu, and the menu opens `/dev/fb0` only after that.
- **The menu stops the running session first.** The menu is drawn on fbdev; a running X or Kodi owns the CRTC and would
  hide it. So `q10-mode menu` stops the active session, shows the menu, then switches to the choice, or (BACK) restarts the previous
  session. Cost: cancelling restarts Kodi/desktop.
- **Menu on its own VT.** `q10-menu` activates tty8, sets `KD_GRAPHICS`, hides the cursor (escape code and
  `/sys/class/graphics/fbcon/cursor_blink`), and on exit restores `KD_TEXT`, the blink value, clears the console and switches back to the previous VT.
- **`boot`**: if a session is already active, do nothing. Else kernel cmdline `q10.session=<s>` (desktop, kodi, android; last
  one wins), else no display (no `/dev/fb0`, or every DRM connector not `connected`) means start the persisted default, else the menu with a
  10 s countdown on the default. Any navigation key stops the countdown. A menu failure starts the default.
- **`q10-session-boot` is `Type=simple`, not oneshot.** A oneshot would hold `multi-user.target` for the entire countdown.
  Nothing is ordered after it, so it cannot deadlock the `systemctl start` it issues.
- **stock-android can never be the default or the cmdline value.** "Reboot returns here" plus "default = stock-android" is an endless boot loop.
  `set-default` refuses it; `q10.session=stock-android` is ignored. The menu asks "Box will restart into Android 7. Reboot returns here." first (OK / BACK).
- **A session that quits by itself leaves a black screen**, so each session unit has `ExecStopPost=q10-mode exited <s>`: if the exit
  was clean and no stop job is queued for the unit (so not `systemctl stop`, not shutdown), it starts `q10-session-menu`. Failures use
  `Restart=on-failure` (limit 3 per 120 s) then `OnFailure=q10-session-menu.service`. This is why `kodi-box-test.sh`
  (`systemctl stop q10-desktop`) does not pop a menu.
- **Hotkey keys: long-press (1.5 s) of `KEY_SETUP` or `KEY_MENU`** (override: `Q10_HOTKEYS`, `Q10_HOTKEY_SECS` in `/etc/default/q10-hotkey`).
  Sessions need `KEY_HOME`/`KEY_BACK`/arrows/`KEY_ENTER` constantly. `KEY_SETUP` (remote "settings", `0x1008`) is the least used. `KEY_MENU` is also the
  only spare front-panel touch key (the panel sends the same NEC codes as the remote), so the panel gets a hotkey too.
  Both still reach the session as a normal short press (the daemon never grabs), so a long MENU press opens Kodi's context menu for
  an instant before the switch. "Not while the menu is up": the daemon starts the *unit* `q10-session-menu` (systemd ignores a start of an
  active unit) and `q10-mode menu` holds a flock on `/run/q10/menu.lock`.
- Every action is logged to `/var/log/q10/session.log`, stderr (journald under a unit) and `logger` from a shell.

## Keymap assumptions (from `scripts/himedia/rootfs-units/himedia_q10.toml`)

Read there: `KEY_UP`, `KEY_DOWN`, `KEY_LEFT`, `KEY_RIGHT`, `KEY_ENTER` (the OK button), `KEY_BACK`, `KEY_MENU`, `KEY_HOME`, `KEY_SETUP`.
Numeric codes used (from `input-event-codes.h`, **not** read off the box): ESC 1, ENTER 28, SPACE 57, KPENTER 96, HOME 102, UP 103, LEFT 105,
RIGHT 106, DOWN 108, MENU 139, SETUP 141, BACK 158, OK 352. The menu also accepts `KEY_OK`, `KEY_KPENTER`, `KEY_SPACE`, `KEY_ESC`, so a USB keyboard works.
**Assumed, not measured:** that the remote really emits `KEY_SETUP` for the settings button after `q10-keymap.service`, and that rc-core
sends value-2 repeats for a held key (the daemon also fires from a timer, so it does not depend on repeats).

## Install / uninstall (on the box, as root)

```
scp -r scripts/himedia/session root@<box>:/root/q10-session && ssh root@<box> /root/q10-session/install-session.sh
```

`install-session.sh` (idempotent):

1. `apt-get install python3-evdev python3-pil fonts-dejavu-core` (skip: `--no-apt`).
2. Records, once, the prior `systemctl is-enabled q10-desktop` and default target in `/var/lib/q10/session/backup/state.env`.
3. Copies code to `/usr/local/lib/q10-session/`, symlinks `q10-mode`, `q10-menu`, `q10-hotkey` into `/usr/local/sbin`.
4. Installs the six units and the desktop drop-in; backs up any differing file it replaces into `backup/`.
5. `systemctl disable q10-desktop.service` (no more autostart through `graphical.target`); `systemctl enable q10-session-boot.service q10-hotkey.service`.
6. Sets the default to `desktop` if none. **Starts and stops nothing**: the new flow runs at the next boot. To try it now: `systemctl start q10-hotkey q10-session-menu`.

**Fallback / uninstall:** `install-session.sh --uninstall` disables and removes everything, restores the backed-up files, and puts
`q10-desktop.service` back to its recorded enable-state. Manual fallback with no scripts at all:
`systemctl disable q10-session-boot q10-hotkey; systemctl enable q10-desktop; rm /etc/systemd/system/q10-desktop.service.d/10-q10-session.conf; systemctl daemon-reload`.
Stuck at a bad boot: the sshd path never depends on any of this (nothing is ordered before ssh).

## Unverified (it has not run on the box)

- Everything on hardware: fbdev writes are visible on the VDP output after a session stops (DRM `lastclose` restoring the fbdev mode); the tty8 / `KD_GRAPHICS` dance;
  `histb_vdp` really leaving `/dev/fb0` usable; stride and `red/green/blue` offsets of the real fb (XRGB8888 and RGB565 are only tested against synthetic byte layouts).
- `cage` on the histb-vdp DRM driver (needs atomic KMS + GBM), `LIBSEAT_BACKEND=builtin` as root, and whether `waydroid status` prints `Session: RUNNING` as `q10-android-run` expects.
- Kodi under systemd (no TTY, libinput as root), and whether Kodi's own "Exit" returns 0 so the `exited` hook shows the menu.
- Render time of the 1080p frame on the box CPU (the menu redraws only when the selection or the countdown second changes).
- That `systemctl list-jobs` shows `<unit> stop` during `ExecStopPost` of a manual stop (the `exited` hook relies on it; worst case: the menu pops up after a manual stop).
- The install script's restore path maps backup file names back with `tr _ /`, fine for today's paths (none contain `_`), wrong for any future one that does.
- `q10-modprobe-guarded` argument contract was taken from the task description, not read.
- The `q10-stock-android` interface (no args, exit 0 only if it did not kexec away) is assumed.
