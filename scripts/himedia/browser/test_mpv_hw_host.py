import io, json, os, struct, sys, tempfile, unittest
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mpv_hw_host as h


def frame(obj):
    d = json.dumps(obj).encode()
    return struct.pack("=I", len(d)) + d


class Framing(unittest.TestCase):
    def test_round_trip(self):
        buf = io.BytesIO()
        h.write_message(buf, {"ok": True, "s": "é☃"})
        buf.seek(0)
        self.assertEqual(h.read_message(buf), {"ok": True, "s": "é☃"})
        self.assertIsNone(h.read_message(buf))  # clean EOF

    def test_read_rejects_garbage(self):
        for raw in (b"\x01\x00", struct.pack("=I", 10) + b"abc"):
            with self.assertRaises(h.BridgeError):
                h.read_message(io.BytesIO(raw))
        with self.assertRaises(h.BridgeError):
            h.read_message(io.BytesIO(struct.pack("=I", h.MAX_MESSAGE + 1)))
        with self.assertRaises(h.BridgeError):
            h.read_message(io.BytesIO(struct.pack("=I", 4) + b"nope"))


class Validation(unittest.TestCase):
    def test_accepts_http_https(self):
        for u in ("https://www.youtube.com/watch?v=abc&t=1", "http://example.com/a.mp4", "HTTPS://Example.com/"):
            self.assertEqual(h.validate_url(u), u)

    def test_rejects_other_schemes(self):
        for u in ("file:///etc/passwd", "javascript:alert(1)", "ftp://x/y", "ytdl://x", "data:text/html,x", "-o /tmp/x", "//host/x", "https:///nohost"):
            with self.assertRaises(h.BridgeError, msg=u):
                h.validate_url(u)

    def test_rejects_whitespace_control_and_size(self):
        for u in ("https://a/b c", "https://a/\nb", "https://a/\x00", " https://a/", "https://a/" + "x" * h.MAX_URL, "", None, 5):
            with self.assertRaises(h.BridgeError, msg=repr(u)):
                h.validate_url(u)

    def test_metacharacters_are_data(self):
        u = "https://a.example/v?x=$(reboot)&y=`id`;rm%20-rf%20/|cat'\"<>"
        self.assertEqual(h.validate_url(u), u)
        argv = h.build_argv(u, "x11egl", mpv="/m")
        self.assertEqual(argv[-2:], ["--", u])           # one element, after --, untouched
        self.assertEqual(sum(1 for a in argv if "reboot" in a), 1)


class Argv(unittest.TestCase):
    def test_x11(self):
        a = h.build_argv("https://a/b", "x11egl", mpv="/m")
        self.assertEqual(a[0], "/m")
        for want in ("--hwdec=v4l2request", "--profile=fast", "--fullscreen", "--vo=gpu", "--gpu-context=x11egl",
                     "--ytdl-format=" + h.YTDL_FORMAT):
            self.assertIn(want, a)
        self.assertFalse(any(x.startswith("--drm-device") for x in a))
        self.assertIn("avc1", h.YTDL_FORMAT)

    def test_drm(self):
        a = h.build_argv("https://a/b", "drm", mpv="/m")
        self.assertIn("--gpu-context=drm", a)
        self.assertIn("--drm-device=" + h.DRM_DEVICE, a)

    def test_invalid_url_never_builds(self):
        with self.assertRaises(h.BridgeError):
            h.build_argv("file:///x", "x11egl")

    def test_pick_vo(self):
        self.assertEqual(h.pick_vo(["drm", "x11egl"], True), "x11egl")
        self.assertIsNone(h.pick_vo(["drm"], True))        # X running, mpv without x11: must not try DRM
        self.assertEqual(h.pick_vo(["drm"], False), "drm")
        self.assertIsNone(h.pick_vo([], False))


class Launch(unittest.TestCase):
    def test_handle_play_launches_detached_without_shell(self):
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, "mpv")
            argvlog = os.path.join(d, "argv.txt")
            ytdlp = os.path.join(d, "yt-dlp")
            with open(fake, "w") as f: f.write('#!/bin/sh\nif [ "$1" = "--gpu-context=help" ]; then printf "Available GPU contexts:\\n    x11egl  X11/EGL\\n    drm     DRM/EGL\\n"; exit 0; fi\nprintf "%%s\\n" "$@" > "%s"\n' % argvlog)
            with open(ytdlp, "w") as f: f.write("#!/bin/sh\n")
            os.chmod(fake, 0o755); os.chmod(ytdlp, 0o755)
            old = (h.MPV, h.LOG, h.PIDFILE)
            h.MPV, h.LOG, h.PIDFILE = fake, os.path.join(d, "log"), os.path.join(d, "pid")
            oldpath = os.environ["PATH"]
            os.environ["PATH"] = d + os.pathsep + oldpath
            try:
                url = "https://a.example/v?x=$(touch${IFS}%s/pwned)&y=;id" % d
                r = h.handle({"action": "play", "url": url}, env={"DISPLAY": ":0", "PATH": os.environ["PATH"]})
                self.assertTrue(r["ok"]); self.assertEqual(r["vo"], "x11egl")
                for _ in range(50):
                    if os.path.exists(argvlog): break
                    import time; time.sleep(0.1)
                with open(argvlog) as f: got = f.read().split("\n")
                self.assertIn(url, got)                              # URL arrived as one argument
                self.assertFalse(os.path.exists(os.path.join(d, "pwned")))
                self.assertEqual(open(h.PIDFILE).read(), str(r["pid"]))
                self.assertIn("launch:", open(h.LOG).read())
                with self.assertRaises(h.BridgeError):
                    h.handle({"action": "play", "url": "file:///etc/passwd"}, env={})
                with self.assertRaises(h.BridgeError):
                    h.handle({"action": "rm"}, env={})
            finally:
                h.MPV, h.LOG, h.PIDFILE = old
                os.environ["PATH"] = oldpath


if __name__ == "__main__":
    unittest.main()
