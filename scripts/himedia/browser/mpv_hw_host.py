#!/usr/bin/python3
"""Native-messaging host `vn.himedia.mpv_hw`: hands a web URL to the hardware-decoding mpv on the Q10 Pro.

Protocol: Chromium native messaging = 4-byte native-endian length + UTF-8 JSON, both directions.
  in : {"action":"play","url":"https://..."}   |  {"action":"ping"}
  out: {"ok":true,"pid":123,"vo":"x11egl","argv":[...]}  |  {"ok":false,"error":"..."}
Stdlib only. Never uses a shell: the URL is one argv element, placed after `--`.
"""
import json
import os
import shutil
import signal
import struct
import subprocess
import sys
import time
from urllib.parse import urlsplit

MPV = os.environ.get("Q10_MPV_BIN", "/usr/local/bin/mpv-v4l2req")
LOG = os.environ.get("Q10_MPV_LOG", "/var/log/q10-mpv-bridge.log")
PIDFILE = os.environ.get("Q10_MPV_PIDFILE", "/run/q10-mpv-bridge.pid")
DRM_DEVICE = os.environ.get("Q10_DRM_DEVICE", "/dev/dri/card1")
# H.264 first: it is the only codec proven on the box's stateless decoder; AV1 has no hardware at all.
YTDL_FORMAT = ("bv*[vcodec^=avc1][height<=1080]+ba/b[vcodec^=avc1][height<=1080]/b[height<=1080]")
MAX_URL = 4096
MAX_MESSAGE = 1024 * 1024


class BridgeError(Exception):
    pass


# --- framing -----------------------------------------------------------------------------------
def read_message(stream):
    """Return the decoded JSON object, or None on clean EOF."""
    head = stream.read(4)
    if len(head) == 0:
        return None
    if len(head) < 4:
        raise BridgeError("truncated length prefix")
    (n,) = struct.unpack("=I", head)
    if n > MAX_MESSAGE:
        raise BridgeError("message too large")
    body = stream.read(n)
    if len(body) < n:
        raise BridgeError("truncated message body")
    try:
        obj = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise BridgeError("bad JSON: %s" % e)
    if not isinstance(obj, dict):
        raise BridgeError("message must be a JSON object")
    return obj


def write_message(stream, obj):
    data = json.dumps(obj, separators=(",", ":")).encode("utf-8")
    stream.write(struct.pack("=I", len(data)) + data)
    stream.flush()


# --- validation --------------------------------------------------------------------------------
def validate_url(url):
    """Accept only a single-token http(s) URL. Shell metacharacters are fine: they are data, never parsed by a shell."""
    if not isinstance(url, str):
        raise BridgeError("url must be a string")
    if not url or len(url) > MAX_URL:
        raise BridgeError("url empty or longer than %d" % MAX_URL)
    if any(ord(c) < 0x21 or ord(c) == 0x7F for c in url):
        raise BridgeError("url contains whitespace or control characters")
    parts = urlsplit(url)
    if parts.scheme.lower() not in ("http", "https"):
        raise BridgeError("only http and https URLs are accepted")
    if not parts.hostname:
        raise BridgeError("url has no host")
    return url


# --- mpv command line ----------------------------------------------------------------------------
def mpv_gpu_contexts(mpv=None):
    """Names listed by `mpv --gpu-context=help`. Empty list if mpv cannot be asked."""
    try:
        out = subprocess.run([mpv or MPV, "--gpu-context=help"], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    names = []
    for line in out.splitlines():
        line = line.strip()
        if line and not line.endswith(":") and " " in line and not line.startswith(("Available", "Exiting")):
            names.append(line.split()[0])
    return names


def pick_vo(contexts, have_display):
    """x11egl inside a live X session; DRM only when there is no X (Xorg holds DRM master). None = cannot display."""
    if have_display:
        return "x11egl" if "x11egl" in contexts else None
    return "drm" if "drm" in contexts else None


def build_argv(url, vo, mpv=None):
    argv = [mpv or MPV, "--no-terminal", "--hwdec=v4l2request", "--profile=fast", "--fullscreen",
            "--ytdl-format=" + YTDL_FORMAT, "--vo=gpu", "--gpu-context=" + vo]
    if vo == "drm":
        argv.append("--drm-device=" + DRM_DEVICE)
    argv += ["--", validate_url(url)]
    return argv


def have_display(env):
    return bool(env.get("DISPLAY")) or os.path.exists("/tmp/.X11-unix/X0")


# --- process control ---------------------------------------------------------------------------
def stop_previous(pidfile=None):
    """One decoder instance only: end the mpv this host started before, if it still is one."""
    pidfile = pidfile or PIDFILE
    try:
        pid = int(open(pidfile).read().strip())
        with open("/proc/%d/cmdline" % pid, "rb") as f:
            if b"mpv" not in f.read():
                return
        os.kill(pid, signal.SIGTERM)
        time.sleep(0.5)
    except (OSError, ValueError):
        pass


def launch(argv, env, log=None, pidfile=None):
    logf = open(log or LOG, "ab")
    try:
        logf.write(("\n[%s] launch: %s\n" % (time.strftime("%F %T"), " ".join(argv))).encode())
        logf.flush()
        proc = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=logf, stderr=logf, env=env,
                                start_new_session=True, close_fds=True)
    finally:
        logf.close()
    try:
        with open(pidfile or PIDFILE, "w") as f:
            f.write(str(proc.pid))
    except OSError:
        pass
    return proc.pid


def handle(msg, env=None):
    env = dict(os.environ if env is None else env)
    action = msg.get("action")
    if action == "ping":
        return {"ok": True, "yt_dlp": bool(shutil.which("yt-dlp")), "mpv": os.path.exists(MPV),
                "contexts": mpv_gpu_contexts()}
    if action != "play":
        raise BridgeError("unknown action")
    url = validate_url(msg.get("url"))
    if not os.path.exists(MPV):
        raise BridgeError("mpv not installed: " + MPV)
    if not shutil.which("yt-dlp"):
        raise BridgeError("yt-dlp not installed (apt install yt-dlp)")
    display = have_display(env)
    if display:
        env.setdefault("DISPLAY", ":0")
    vo = pick_vo(mpv_gpu_contexts(), display)
    if vo is None:
        raise BridgeError("this mpv lacks the needed gpu context (x11egl needs the X11 build; see docs)")
    argv = build_argv(url, vo)
    stop_previous()
    return {"ok": True, "pid": launch(argv, env), "vo": vo, "argv": argv}


def main():
    inp, out = sys.stdin.buffer, sys.stdout.buffer
    try:
        msg = read_message(inp)
        if msg is None:
            return 0
        reply = handle(msg)
    except BridgeError as e:
        reply = {"ok": False, "error": str(e)}
    except Exception as e:  # never leave the browser without an answer
        reply = {"ok": False, "error": "internal error: %s" % e}
    if not reply.get("ok"):
        try:
            with open(LOG, "a") as f:
                f.write("[%s] refused: %s\n" % (time.strftime("%F %T"), reply.get("error")))
        except OSError:
            pass
    write_message(out, reply)
    return 0


if __name__ == "__main__":
    sys.exit(main())
