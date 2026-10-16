"""PowerKey state machine tests. Run on the Mac:  python3 -m unittest -v test_power"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import q10power  # noqa: E402
from q10power import KEY_POWER, KEY_WAKEUP, PowerKey, step_for  # noqa: E402


class Press(unittest.TestCase):
    def test_short_press(self):
        p = PowerKey()
        self.assertIsNone(p.feed(KEY_POWER, 1, 0.0))
        self.assertEqual(p.feed(KEY_POWER, 0, 0.3), "short")

    def test_hold_fires_long_once_and_release_is_silent(self):
        p = PowerKey()
        p.feed(KEY_POWER, 1, 0.0)
        for t in (0.5, 1.0, 2.0, 2.9):
            self.assertIsNone(p.feed(KEY_POWER, 2, t))       # IR repeats
        self.assertEqual(p.feed(KEY_POWER, 2, 3.1), "long")
        self.assertIsNone(p.feed(KEY_POWER, 2, 3.5))         # not twice
        self.assertIsNone(p.feed(KEY_POWER, 0, 4.0))         # release after long: not a short too

    def test_long_from_poll_without_repeats(self):
        p = PowerKey()
        p.feed(KEY_POWER, 1, 0.0)
        self.assertIsNone(p.poll(2.0))
        self.assertEqual(p.poll(3.0), "long")

    def test_ir_repeat_without_press_starts_timing(self):
        p = PowerKey()
        self.assertIsNone(p.feed(KEY_POWER, 2, 0.0))
        self.assertEqual(p.feed(KEY_POWER, 0, 0.2), "short")

    def test_bounce_after_action(self):
        p = PowerKey()
        p.feed(KEY_POWER, 1, 0.0)
        self.assertEqual(p.feed(KEY_POWER, 0, 0.2), "short")
        p.quiet(0.2)
        p.feed(KEY_POWER, 1, 0.5)
        self.assertIsNone(p.feed(KEY_POWER, 0, 0.7))          # within 1.5 s: ignored
        p.feed(KEY_POWER, 1, 2.0)
        self.assertEqual(p.feed(KEY_POWER, 0, 2.2), "short")

    def test_wakeup_key_and_other_keys(self):
        p = PowerKey()
        self.assertEqual(p.feed(KEY_WAKEUP, 1, 0.0), "wake")
        self.assertIsNone(p.feed(KEY_WAKEUP, 0, 0.1))
        self.assertIsNone(p.feed(28, 1, 0.0))                 # ENTER


class Steps(unittest.TestCase):
    def test_press_toggles_standby_and_hold_turns_off(self):
        self.assertEqual(step_for("on", "short"), "standby")
        self.assertEqual(step_for("standby", "short"), "wake")
        self.assertEqual(step_for("on", "long"), "off")
        self.assertEqual(step_for("standby", "long"), "off")

    def test_any_key_from_off_boots(self):
        for act in ("short", "long", "wake"):
            self.assertEqual(step_for("off", act), "boot")

    def test_nothing_happens_without_a_key(self):
        self.assertIsNone(step_for("on", None))
        self.assertIsNone(step_for("on", "wake"))           # already awake


class State(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.dir = tempfile.mkdtemp()
        self._run_dir = q10power.run_dir
        q10power.run_dir = lambda: self.dir

    def tearDown(self):
        q10power.run_dir = self._run_dir

    def test_no_file_is_on_and_each_mode_reads_back(self):
        self.assertEqual(q10power.power_state(), "on")
        for mode in ("standby", "off"):
            q10power.write_state(mode, session="audio")
            self.assertEqual(q10power.power_state(), mode)

    def test_a_file_from_before_modes_existed_is_standby(self):
        with open(q10power.state_path(), "w") as f:
            f.write('{"session": "audio", "vt": 11}')
        self.assertEqual(q10power.power_state(), "standby")


if __name__ == "__main__":
    unittest.main()
