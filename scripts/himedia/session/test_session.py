"""Pure-part tests for the Q10 session switcher. Run on the Mac:  python3 -m unittest -v test_session
(from scripts/himedia/session). No box, no evdev, no systemd needed."""
import os
import stat
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import q10common  # noqa: E402,F401
import q10hotkey  # noqa: E402
import q10menu  # noqa: E402
import q10mode  # noqa: E402
from q10common import KEYS  # noqa: E402


class Env(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.saved = dict(os.environ)
        self.addCleanup(lambda: (os.environ.clear(), os.environ.update(self.saved)))
        t = self.tmp.name
        os.environ.update({"Q10_STATE_DIR": t + "/state", "Q10_LOG_DIR": t + "/log", "Q10_RUN_DIR": t + "/run",
                           "Q10_NO_JOURNAL": "1"})


class Cmdline(unittest.TestCase):
    def test_parse(self):
        p = q10mode.parse_cmdline_session
        self.assertEqual(p("console=ttyS0 q10.session=kodi quiet"), "kodi")
        self.assertIsNone(p("console=ttyS0 quiet"))
        self.assertEqual(p("q10.session=desktop q10.session=android"), "android")  # last wins
        self.assertIsNone(p("q10.session=bogus"))
        self.assertIsNone(p("q10.session=stock-android"))  # would boot-loop
        self.assertIsNone(p("xq10.session=kodi"))


class Default(Env):
    def test_default_and_persist(self):
        self.assertEqual(q10mode.get_default(), "desktop")
        q10mode.set_default("kodi")
        self.assertEqual(q10mode.get_default(), "kodi")
        self.assertEqual(open(self.tmp.name + "/state/default").read(), "kodi\n")

    def test_refuses_stock_android_and_junk(self):
        for bad in ("stock-android", "nope", ""):
            with self.assertRaises(ValueError):
                q10mode.set_default(bad)

    def test_corrupt_file_falls_back(self):
        os.makedirs(self.tmp.name + "/state")
        open(self.tmp.name + "/state/default", "w").write("garbage")
        self.assertEqual(q10mode.get_default(), "desktop")


class Avail(Env):
    def test_missing_things_are_unavailable(self):
        a = q10mode.availability(exists=lambda p: False, which=lambda n: None, executable=lambda p: False)
        self.assertEqual(a["android"], (False, "Waydroid not installed"))
        self.assertFalse(a["stock-android"][0])
        self.assertFalse(a["kodi"][0])
        self.assertEqual(a["audio"], (False, "mpd not installed"))

    def test_audio_needs_nowplaying(self):
        a = q10mode.availability(exists=lambda p: True, which=lambda n: "/x/" + n,
                                 executable=lambda p: "nowplaying" not in p)
        self.assertEqual(a["audio"], (False, "audio mode not installed"))

    def test_audio_is_bootable_and_has_unit(self):
        self.assertIn("audio", q10common.BOOTABLE)
        self.assertEqual(q10common.UNIT_SESSIONS["audio"], "q10-audio.service")
        self.assertEqual(q10mode.SESSION_VT["audio"], 11)

    def test_all_present(self):
        a = q10mode.availability(exists=lambda p: True, which=lambda n: "/x/" + n, executable=lambda p: True)
        self.assertTrue(all(ok for ok, _ in a.values()))

    def test_android_needs_initialised_images(self):
        a = q10mode.availability(exists=lambda p: not p.endswith("waydroid.cfg"), which=lambda n: "/x/" + n,
                                 executable=lambda p: True)
        self.assertEqual(a["android"], (False, "Android images not installed"))

    def test_stock_needs_manifest(self):
        a = q10mode.availability(exists=lambda p: "manifest" not in p, which=lambda n: "/x", executable=lambda p: True)
        self.assertEqual(a["stock-android"], (False, "stock Android kit missing"))

    def test_display(self):
        self.assertFalse(q10mode.display_present(False, ["connected"]))
        self.assertTrue(q10mode.display_present(True, []))
        self.assertFalse(q10mode.display_present(True, ["disconnected\n"]))
        self.assertTrue(q10mode.display_present(True, ["disconnected\n", "connected\n"]))


class Switch(Env):
    """switch() against a fake systemctl: asserts the ORDER stop-active-then-start-target."""

    def fake(self, active):
        path = self.tmp.name + "/systemctl"
        log = self.tmp.name + "/calls"
        open(path, "w").write('#!/bin/sh\necho "$@" >> %s\n'
                              'if [ "$1" = is-active ]; then [ "$3" = %s ] && exit 0 || exit 3; fi\nexit 0\n' % (log, active))
        os.chmod(path, 0o755)
        os.environ["Q10_SYSTEMCTL"] = path
        os.environ["Q10_UNIT_DIR"] = self.tmp.name
        open(self.tmp.name + "/q10-desktop.service", "w").close()
        k = self.tmp.name + "/kodi"
        open(k, "w").write("#!/bin/sh\n")
        os.chmod(k, 0o755)
        os.environ["Q10_KODI_BIN"] = k
        return log

    def test_order(self):
        log = self.fake("q10-desktop.service")
        self.assertEqual(q10mode.switch("kodi"), 0)
        calls = [l for l in open(log).read().splitlines() if not l.startswith("is-active")]
        self.assertEqual(calls, ["stop q10-desktop.service", "start q10-kodi.service"])

    def test_unavailable_refused_and_nothing_stopped(self):
        log = self.fake("q10-desktop.service")
        self.assertEqual(q10mode.switch("stock-android"), 2)
        self.assertEqual(q10mode.switch("bogus"), 2)
        calls = open(log).read().splitlines() if os.path.exists(log) else []
        self.assertFalse([l for l in calls if l.startswith(("stop", "start"))])


class AudioSettingsFromMenu(Env):
    """The menu's "Audio settings" row opens the page, then the menu again; a session choice still wins."""

    def test_page_then_menu_again_then_session(self):
        from unittest import mock
        choices = iter([(0, "audio-settings"), (0, "audio-settings"), (0, "kodi")])
        with mock.patch.object(q10mode, "try_lock", return_value=object()), \
                mock.patch.object(q10mode, "active_session", return_value=None), \
                mock.patch.object(q10mode, "stop_sessions"), \
                mock.patch.object(q10mode, "run_menu", side_effect=lambda *a, **k: next(choices)) as menu, \
                mock.patch.object(q10mode, "run_audio_page") as page, \
                mock.patch.object(q10mode, "switch", return_value=0) as sw:
            self.assertEqual(q10mode.cmd_menu(None), 0)
        self.assertEqual(page.call_count, 2)
        self.assertEqual(menu.call_count, 3)
        sw.assert_called_once_with("kodi")

    def test_row_marked_unavailable_without_audio_mode(self):
        from unittest import mock
        os.environ["Q10_AUDIO_PAGE"] = self.tmp.name + "/missing"
        seen = {}

        def fake_run(cmd, **kw):
            seen["cmd"] = cmd
            return mock.Mock(returncode=3, stdout="")
        with mock.patch.object(q10mode, "ensure_video_stack"), \
                mock.patch.object(q10mode.subprocess, "run", side_effect=fake_run):
            q10mode.run_menu("desktop", None, 0, True)
        self.assertIn("audio-settings=audio mode not installed", seen["cmd"])


class Menu(unittest.TestCase):
    def mk(self, **kw):
        kw.setdefault("now", 0.0)
        return q10menu.MenuState(**kw)

    def test_default_selected_and_unavailable_default_skipped(self):
        self.assertEqual(self.mk(default="kodi").selected(), "kodi")
        self.assertEqual(self.mk(default="android", unavailable={"android": "x"}).selected(), "desktop")

    def test_countdown_picks_default(self):
        s = self.mk(default="kodi", countdown=10)
        self.assertEqual(s.remaining(0), 10)
        self.assertEqual(s.remaining(7.2), 3)
        s.tick(9.9)
        self.assertFalse(s.done)
        s.tick(10.0)
        self.assertTrue(s.done)
        self.assertEqual(s.result, "kodi")

    def test_key_stops_countdown(self):
        s = self.mk(default="desktop", countdown=10)
        self.assertTrue(s.key("DOWN", 1.0))
        self.assertIsNone(s.remaining(1.0))
        s.tick(99)
        self.assertFalse(s.done)

    def test_navigation_wraps_and_ok_chooses(self):
        s = self.mk(default="desktop", countdown=0)
        s.key("UP", 1.0)
        self.assertEqual(s.selected(), "audio-settings")   # last row: settings, below the sessions
        s.key("DOWN", 2.0)
        self.assertEqual(s.selected(), "desktop")
        s.key("DOWN", 3.0)
        s.key("ENTER", 4.0)
        self.assertEqual(s.result, "audio")  # menu order: desktop, audio, kodi, ...

    def test_ok_on_unavailable_refuses(self):
        s = self.mk(default="desktop", unavailable={"audio": "mpd not installed"})
        s.key("DOWN", 1.0)
        s.key("OK", 2.0)
        self.assertFalse(s.done)
        self.assertIn("mpd not installed", s.message)

    def test_stock_android_needs_confirmation(self):
        s = self.mk(default="desktop", countdown=0)
        s.key("UP", 1.0)
        s.key("UP", 1.5)
        s.key("ENTER", 2.0)
        self.assertEqual(s.confirming, "stock-android")
        self.assertFalse(s.done)
        s.key("BACK", 3.0)
        self.assertIsNone(s.confirming)
        s.key("ENTER", 4.0)
        s.key("ENTER", 5.0)
        self.assertEqual(s.result, "stock-android")

    def test_back_only_cancels_when_allowed(self):
        s = self.mk(countdown=0)
        s.key("BACK", 1.0)
        self.assertFalse(s.done)
        s = self.mk(countdown=0, cancel_ok=True)
        s.key("BACK", 1.0)
        self.assertTrue(s.done)
        self.assertIsNone(s.result)

    def test_cec_remote_keys_reach_the_menu(self):
        """The kernel rc-cec keymap: Select=KEY_OK(352), Up/Down=KEY_UP/DOWN, Exit(0x0d)=KEY_EXIT(174).
        Every code must resolve to a name the menu understands, and Exit must act as Back."""
        for code, name in ((352, "OK"), (103, "UP"), (108, "DOWN"), (105, "LEFT"), (106, "RIGHT"),
                           (141, "SETUP"), (139, "MENU"), (174, "EXIT")):
            self.assertEqual(q10common.CODE_TO_NAME[code], name)
        s = self.mk(countdown=0, cancel_ok=True)
        s.key("EXIT", 1.0)
        self.assertTrue(s.done)
        self.assertIsNone(s.result)
        s = self.mk(countdown=0)
        s.key("DOWN", 1.0)
        s.key("OK", 2.0)                                # select with the CEC Select key
        self.assertTrue(s.done)
        self.assertIsNotNone(s.result)

    def test_grace_repeat_and_dedupe(self):
        s = self.mk(countdown=0)
        self.assertFalse(s.key("DOWN", 0.1))          # inside grace
        self.assertTrue(s.key("DOWN", 1.0))
        self.assertFalse(s.key("DOWN", 1.01))         # same key, two devices
        self.assertTrue(s.key("DOWN", 1.5, repeat=True))
        self.assertFalse(s.key("ENTER", 2.0, repeat=True))  # held OK must not select
        self.assertFalse(s.done)


class Render(unittest.TestCase):
    def test_png_is_1080p(self):
        from PIL import Image
        st = q10menu.MenuState({"android": "Waydroid not installed"}, "desktop", "kodi", 10, now=0.0)
        with tempfile.TemporaryDirectory() as d:
            p = d + "/m.png"
            self.assertEqual(q10menu.main(["--screenshot", p, "--unavailable", "android=Waydroid not installed"]), 0)
            im = Image.open(p)
            self.assertEqual(im.size, (1920, 1080))
            self.assertGreater(len(set(im.convert("RGB").resize((96, 54)).getdata())), 5)  # not a blank frame
        self.assertEqual(q10menu.render(st).size, (1920, 1080))

    def test_splash_text_is_drawn_and_scaled(self):
        im = q10menu.render_splash("Resuming Music\u2026", "", (1280, 720))
        self.assertEqual(im.size, (1280, 720))
        self.assertGreater(len(set(im.getdata())), 2)          # text, not a flat frame
        self.assertEqual(q10mode.session_title("audio"), "Music")
        self.assertEqual(q10mode.session_title("nope"), "nope")


class Framebuffer(unittest.TestCase):
    def info(self, **kw):
        i = {"xres": 4, "yres": 2, "xres_virtual": 4, "yres_virtual": 2, "yoffset": 0, "bpp": 32,
             "red": (16, 8, 0), "green": (8, 8, 0), "blue": (0, 8, 0), "stride": 16}
        i.update(kw)
        return i

    def test_parse_var(self):
        buf = bytearray(160)
        struct.pack_into(q10menu.VAR_FMT, buf, 0, 1920, 1080, 1920, 2160, 0, 1080, 32, 0, 16, 8, 0, 8, 8, 0, 0, 8, 0, 24, 8, 0)
        v = q10menu.parse_var(buf)
        self.assertEqual((v["xres"], v["yres"], v["bpp"], v["yoffset"]), (1920, 1080, 32, 1080))
        self.assertEqual(v["red"], (16, 8, 0))

    def test_xrgb8888(self):
        from PIL import Image
        im = Image.new("RGB", (4, 2), (255, 0, 0))
        im.putpixel((1, 0), (0, 255, 0))
        im.putpixel((2, 0), (0, 0, 255))
        raw = q10menu.encode_frame(im, self.info())
        self.assertEqual(len(raw), 32)
        self.assertEqual(raw[0:4], bytes([0, 0, 255, 0]))     # red   -> B G R X
        self.assertEqual(raw[4:8], bytes([0, 255, 0, 0]))     # green
        self.assertEqual(raw[8:12], bytes([255, 0, 0, 0]))    # blue

    def test_rgb565(self):
        from PIL import Image
        im = Image.new("RGB", (4, 2), (255, 0, 0))
        im.putpixel((1, 0), (0, 255, 0))
        im.putpixel((2, 0), (0, 0, 255))
        raw = q10menu.encode_frame(im, self.info(bpp=16, red=(11, 5, 0), green=(5, 6, 0), blue=(0, 5, 0), stride=8))
        px = struct.unpack("<8H", raw)
        self.assertEqual(px[0], 0xF800)
        self.assertEqual(px[1], 0x07E0)
        self.assertEqual(px[2], 0x001F)

    def test_stride_padding_and_resize(self):
        from PIL import Image
        raw = q10menu.encode_frame(Image.new("RGB", (1920, 1080)), self.info(xres=8, yres=2, stride=40))
        self.assertEqual(len(raw), 80)                        # 8 px * 4 B = 32, padded to 40, x2 rows
        self.assertEqual(raw[32:40], bytes(8))


class LongPress(unittest.TestCase):
    def test_fires_once_after_threshold(self):
        lp = q10hotkey.LongPress([KEYS["SETUP"]], 1.5)
        self.assertFalse(lp.feed(141, 1, 0.0))
        self.assertFalse(lp.feed(141, 2, 1.0))
        self.assertTrue(lp.feed(141, 2, 1.6))
        self.assertFalse(lp.feed(141, 2, 2.0))     # once per press
        self.assertFalse(lp.feed(141, 0, 2.1))     # release after firing: no second fire
        self.assertFalse(lp.feed(141, 1, 3.0))     # a fresh short press...
        self.assertFalse(lp.feed(141, 0, 3.2))     # ...does nothing

    def test_poll_fires_without_repeat_events(self):
        lp = q10hotkey.LongPress([KEYS["MENU"]], 1.5)
        lp.feed(KEYS["MENU"], 1, 0.0)
        self.assertFalse(lp.poll(1.0))
        self.assertTrue(lp.poll(1.5))

    def test_other_keys_ignored(self):
        lp = q10hotkey.LongPress([KEYS["SETUP"]], 1.5)
        lp.feed(KEYS["HOME"], 1, 0.0)
        self.assertFalse(lp.poll(5.0))



class PickFbTest(unittest.TestCase):
    def _root(self, names):
        import tempfile
        d = tempfile.mkdtemp()
        for fb, name in names.items():
            os.makedirs(os.path.join(d, fb)); open(os.path.join(d, fb, "name"), "w").write(name + "\n")
        return d

    def test_vdp_is_fb1_when_simpledrm_kept_fb0(self):
        import q10menu
        self.assertEqual(q10menu.pick_fb(self._root({"fb0": "simpledrmdrmfb", "fb1": "histb-vdpdrmfb"})), "/dev/fb1")

    def test_vdp_is_fb0_after_eviction(self):
        import q10menu
        self.assertEqual(q10menu.pick_fb(self._root({"fb0": "histb-vdpdrmfb"})), "/dev/fb0")

    def test_falls_back_to_fb0_without_vdp(self):
        import q10menu
        self.assertEqual(q10menu.pick_fb(self._root({"fb0": "simpledrmdrmfb"})), "/dev/fb0")


class DoubleTapTest(unittest.TestCase):
    def test_two_quick_taps_fire(self):
        import q10hotkey
        d = q10hotkey.DoubleTap([139])
        self.assertFalse(d.feed(139, 1, 0.0)); self.assertFalse(d.feed(139, 0, 0.1))
        self.assertFalse(d.feed(139, 1, 0.4)); self.assertTrue(d.feed(139, 0, 0.5))

    def test_slow_taps_do_not_fire(self):
        import q10hotkey
        d = q10hotkey.DoubleTap([139])
        d.feed(139, 1, 0.0); d.feed(139, 0, 0.1)
        d.feed(139, 1, 1.5); self.assertFalse(d.feed(139, 0, 1.6))

    def test_hold_then_tap_does_not_fire(self):
        import q10hotkey
        d = q10hotkey.DoubleTap([139])
        d.feed(139, 1, 0.0); d.feed(139, 0, 2.0)   # a hold
        d.feed(139, 1, 2.2); self.assertFalse(d.feed(139, 0, 2.3))

    def test_other_keys_ignored(self):
        import q10hotkey
        d = q10hotkey.DoubleTap([139])
        d.feed(103, 1, 0); d.feed(103, 0, 0.1); d.feed(103, 1, 0.2)
        self.assertFalse(d.feed(103, 0, 0.3))

if __name__ == "__main__":
    unittest.main()
