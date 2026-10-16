#!/bin/bash
# install-lxqt.sh — ON THE BOX: a Windows-familiar, light desktop for the Q10 (LXQt 2.1 on the
# existing openbox). Bottom taskbar, start menu with search (fancymenu), quick launch, tray, clock,
# show-desktop; pcmanfm-qt file manager + desktop icons + wallpaper; dark theme, Papirus icons.
# No compositor (no GL cost, nothing for panfrost to fault on). Idempotent.
#   install-lxqt.sh            install / refresh
#   install-lxqt.sh --uninstall   back to openbox + xterm (configs restored from the backup dir)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
H=/root; BK=/var/lib/q10/desktop/backup; mkdir -p $BK
SESSION=/usr/local/bin/q10-session

if [ "${1:-}" = "--uninstall" ]; then
  [ -f $BK/q10-session ] && cp $BK/q10-session $SESSION
  rm -rf $H/.config/lxqt $H/.config/pcmanfm-qt
  echo "restored openbox session (packages kept; apt purge lxqt-* to remove them)"; exit 0
fi

apt-get install -y -q --no-install-recommends lxqt-panel lxqt-session lxqt-config lxqt-runner \
  lxqt-notificationd lxqt-qtplugin lxqt-globalkeys lxqt-themes pcmanfm-qt qterminal lximage-qt \
  featherpad papirus-icon-theme arc-theme fonts-noto-core xdg-utils >/dev/null

# ⛔ A running LXQt saves its in-memory settings over these files when it stops (theme=dark came
# back, 2026-10-12): stop the desktop first, start it again at the end.
was_active=0; systemctl is-active --quiet q10-desktop && { was_active=1; systemctl stop q10-desktop; }

install -D -m 644 "$here/q10-wallpaper.png" /usr/share/q10/wallpaper.png
for a in "$here/asound.conf" "$here/../../audio/asound.conf"; do [ -f "$a" ] && { install -m 644 "$a" /etc/asound.conf; break; }; done
# PNG, not SVG: QIcon(<file>.svg) needs Qt's SVG icon-engine plugin (absent) -> blank Start button.
install -D -m 644 "$here/q10-start.png" /usr/share/q10/start.png

# Theme "q10": LXQt's dark theme with its red highlights swapped for Windows blues.
rm -rf /usr/share/lxqt/themes/q10; cp -r /usr/share/lxqt/themes/dark /usr/share/lxqt/themes/q10
python3 - /usr/share/lxqt/themes/q10/*.qss <<'PY'
import re, sys
# every strongly red accent (R high, G and B low) -> the Windows blue of similar brightness
def blue(m):
    h = m.group(0); r, g, b = (int(h[i:i + 2], 16) for i in (1, 3, 5))
    if r > 0x60 and g < 0x40 and b < 0x40:
        return "#004e8c" if r < 0x90 else ("#0063b1" if r < 0xc0 else "#0078d4")
    return h
for f in sys.argv[1:]:
    s = open(f).read()
    s = re.sub(r"#[0-9a-fA-F]{6}\b", blue, s).replace("rgb(128, 0, 0)", "rgb(0, 99, 177)")
    open(f, "w").write(s)
PY

# ── session: startlxqt, with openbox as the window manager ─────────────────────────────────────
[ -f $BK/q10-session ] || cp $SESSION $BK/q10-session
cat > $SESSION <<'EOS'
#!/bin/sh
# Q10 desktop session (q10-desktop.service): LXQt on openbox; falls back to bare openbox.
xset s off -dpms
[ -n "$Q10_APP" ] && sh -c "$Q10_APP" &
command -v startlxqt >/dev/null && exec startlxqt
xterm -geometry 100x30+40+40 &
exec openbox-session
EOS
chmod 755 $SESSION

mkdir -p $H/.config/lxqt $H/.config/pcmanfm-qt/lxqt $H/.config/openbox $H/.local/share/applications
cat > $H/.config/lxqt/session.conf <<'EOS'
[General]
__userfile__=true
window_manager=openbox
leave_confirmation=false

[Environment]
GTK_CSD=0
EOS
cat > $H/.config/lxqt/lxqt.conf <<'EOS'
[General]
__userfile__=true
icon_theme=Papirus-Dark
theme=q10
single_click_activate=false

# Windows-11 dark palette with its blue accent (Fusion otherwise highlights in LXQt-dark red).
palette_override=true

[Palette]
window_color=#202020
window_text_color=#ffffff
highlight_color=#0078d4
highlighted_text_color=#ffffff
link_color=#4cc2ff
link_visited_color=#b4a0ff
tooltip_base_color=#2b2b2b
tooltip_text_color=#ffffff

[Qt]
style=Fusion
font="Noto Sans,10,-1,5,50,0,0,0,0,0"
EOS
# Taskbar: Windows layout — start, pinned apps, open windows, tray, volume, clock, show-desktop.
cat > $H/.config/lxqt/panel.conf <<'EOS'
[General]
__userfile__=true
panels=panel1

[panel1]
position=Bottom
alignment=-1
panelSize=46
iconSize=30
lineCount=1
width=100
width-percent=true
lockPanel=true
# volume drives the softvol "Master" from scripts/himedia/audio/asound.conf (the card itself has no
# mixer controls; without asound.conf the plugin only shows an error icon).
plugins=fancymenu, quicklaunch, taskbar, statusnotifier, tray, volume, worldclock, showdesktop

[fancymenu]
type=fancymenu
ownIcon=true
icon=/usr/share/q10/start.png
showText=false
filterClear=true
favorites\size=8
favorites\1\desktopFile=/usr/share/applications/pcmanfm-qt.desktop
favorites\2\desktopFile=/usr/share/applications/chromium.desktop
favorites\3\desktopFile=/usr/share/applications/qterminal.desktop
favorites\4\desktopFile=/root/.local/share/applications/q10-kodi.desktop
favorites\5\desktopFile=/root/.local/share/applications/q10-android.desktop
favorites\6\desktopFile=/root/.local/share/applications/q10-menu.desktop
favorites\7\desktopFile=/usr/share/applications/featherpad.desktop
favorites\8\desktopFile=/usr/share/applications/lxqt-config.desktop

[quicklaunch]
type=quicklaunch
apps\size=4
apps\1\desktop=/usr/share/applications/pcmanfm-qt.desktop
apps\2\desktop=/usr/share/applications/chromium.desktop
apps\3\desktop=/usr/share/applications/qterminal.desktop
apps\4\desktop=/root/.local/share/applications/q10-menu.desktop

[taskbar]
type=taskbar
buttonWidth=220
groupingEnabled=true
showGroupOnHover=true
raiseOnCurrentDesktop=true
iconByClass=true

[statusnotifier]
type=statusnotifier

[tray]
type=tray

[volume]
type=volume
audioEngine=Alsa
device=0
showOnClick=true

[worldclock]
type=worldclock
formatType=custom
customFormat="'<b>'HH:mm'</b><br/><font size=\"-2\">'d/MM/yyyy'</font>'"
showWeekNumber=false

[showdesktop]
type=showdesktop
EOS
cat > $H/.config/pcmanfm-qt/lxqt/settings.conf <<'EOS'
[Desktop]
Wallpaper=/usr/share/q10/wallpaper.png
WallpaperMode=zoom
DesktopShortcuts=Home, Trash, Computer
DesktopIconSize=56
ShowHidden=false
Font="Noto Sans,10,-1,5,50,0,0,0,0,0"
FgColor=#ffffff
ShadowColor=#000000

[Behavior]
SingleClick=false

[Window]
FixedWidth=1280
FixedHeight=760
LastWindowWidth=1280
LastWindowHeight=760
RememberWindowSize=true

[System]
Terminal=qterminal
EOS
# openbox: LXQt starts plain `openbox`, which reads rc.xml (NOT lxqt-rc.xml) — write both.
# Theme = our Q10-Dark (Debian's arc-theme has no openbox-3 variant); Windows button order.
rm -rf /usr/share/themes/Q10-Dark; cp -r "$here/Q10-Dark" /usr/share/themes/Q10-Dark
src=/etc/xdg/openbox/lxqt-rc.xml; [ -f $src ] || src=/etc/xdg/openbox/rc.xml
python3 - "$src" $H/.config/openbox/rc.xml $H/.config/openbox/lxqt-rc.xml <<'PY'
import re, sys
s = open(sys.argv[1]).read()
s = re.sub(r"(<theme>\s*<name>)[^<]*(</name>)", r"\1Q10-Dark\2", s, count=1)
s = re.sub(r"<titleLayout>[^<]*</titleLayout>", "<titleLayout>NLIMC</titleLayout>", s, count=1)
for out in sys.argv[2:]:
    open(out, "w").write(s)
PY

# Desktop-window check: once in ~10 starts pcmanfm-qt came up with no desktop window (no wallpaper,
# no icons, 2026-10-12). 25 s after login, start it again if the window is missing.
mkdir -p $H/.config/autostart
cat > $H/.config/autostart/q10-desktop-check.desktop <<'EOS'
[Desktop Entry]
Type=Application
Name=Q10 desktop check
Exec=sh -c 'sleep 25; xwininfo -root -tree | grep -q pcmanfm-desktop || { pkill -x pcmanfm-qt; pcmanfm-qt --desktop --profile=lxqt & }'
NoDisplay=true
X-LXQt-Need-Tray=false
EOS

# The Windows key opens the start menu (LXQt binds only Alt+F1 by default).
gk=$H/.config/lxqt/globalkeyshortcuts.conf
[ -f $gk ] || cp /etc/xdg/lxqt/globalkeyshortcuts.conf $gk 2>/dev/null || touch $gk
grep -q '^\[Super_L' $gk || cat >> $gk <<'EOS'

[Super_L.90]
Comment=Start menu (Windows key)
Enabled=true
path=/panel/fancymenu/show_hide
EOS

# Session switching from the start menu and the taskbar.
mk() { cat > $H/.local/share/applications/$1.desktop <<EOD
[Desktop Entry]
Type=Application
Name=$2
Comment=$3
Exec=$4
Icon=$5
Categories=System;
EOD
}
mk q10-menu "Switch session" "Desktop, Kodi or Android" "systemctl --no-block start q10-session-menu.service" preferences-desktop-display
mk q10-kodi "Kodi" "Media center (hardware video)" "/usr/local/sbin/q10-mode switch kodi" kodi
mk q10-android "Android 13" "Android apps, full screen" "/usr/local/sbin/q10-mode switch android" android-studio
[ $was_active = 1 ] && systemctl start q10-desktop
echo "installed$([ $was_active = 1 ] && echo ', desktop restarted' || echo '; takes effect at the next desktop start')"
