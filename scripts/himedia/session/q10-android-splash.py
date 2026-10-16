#!/usr/bin/python3
"""q10-android-splash — full-screen "Android is starting" screen shown inside cage while
Waydroid boots (~100 s of black otherwise, Tim 2026-10-12). Phases are read from the HOST's
process list (container processes are visible there): polling `waydroid shell` would cost a
Python start-up per poll on a CPU that is busy booting Android. Exits once the launcher runs;
Android's own window is mapped on top before that, so cage shows it as soon as it exists."""
import os, subprocess, time
import gi
gi.require_version("Gtk", "3.0")
from gi.repository import Gtk, GLib

PHASES = [  # (process pattern on the host, text once it exists)
    (None, "Starting the Android container"),
    ("surfaceflinger", "Starting Android graphics"),
    ("system_server", "Starting Android system"),
    ("launcher3", "Opening the home screen"),
]
CSS = b"""
window { background: #0e121a; }
#title { color: #f3f6fb; font: bold 64px "DejaVu Sans"; }
#phase { color: #9aa6b8; font: 34px "DejaVu Sans"; }
#hint  { color: #6b778a; font: 24px "DejaVu Sans"; }
"""

def running(pat):
    return subprocess.run(["pgrep", "-f", pat], stdout=subprocess.DEVNULL).returncode == 0

class Splash(Gtk.Window):
    def __init__(self):
        super().__init__(title="Starting Android")
        prov = Gtk.CssProvider(); prov.load_from_data(CSS)
        Gtk.StyleContext.add_provider_for_screen(self.get_screen(), prov, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION)
        box = Gtk.Box(orientation=Gtk.Orientation.VERTICAL, spacing=28, valign=Gtk.Align.CENTER, halign=Gtk.Align.CENTER)
        self.title = Gtk.Label(label="Android 13", name="title")
        self.spin = Gtk.Spinner(); self.spin.set_size_request(72, 72); self.spin.start()
        self.phase = Gtk.Label(name="phase")
        self.hint = Gtk.Label(label="First start takes about 3 minutes, later ones about 1-2.  Long-press MENU for other sessions.", name="hint")
        for w in (self.title, self.spin, self.phase, self.hint):
            box.pack_start(w, False, False, 0)
        self.add(box); self.fullscreen()
        self.t0 = time.monotonic(); self.step = 0; self.done_at = None
        GLib.timeout_add(1000, self.tick); self.tick()

    def tick(self):
        while self.step + 1 < len(PHASES) and running(PHASES[self.step + 1][0]):
            self.step += 1
        el = int(time.monotonic() - self.t0)
        self.phase.set_text("%s…   %d s" % (PHASES[self.step][1], el))
        if self.step == len(PHASES) - 1 and self.done_at is None:
            self.done_at = el
        if (self.done_at is not None and el - self.done_at >= 5) or el > 400:
            Gtk.main_quit(); return False
        return True

if __name__ == "__main__":
    os.environ.setdefault("GDK_BACKEND", "wayland")
    w = Splash(); w.connect("destroy", Gtk.main_quit); w.show_all(); Gtk.main()
