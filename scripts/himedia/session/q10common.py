"""Shared bits of the Q10 session switcher: paths, key names, log, lock.

Every path is resolved PER CALL from the environment (tests and the box both rely on that);
nothing is captured at import time.
"""
import fcntl
import os
import subprocess
import sys
import time

# The sessions, in menu order. "stock-android" is not a unit: it kexecs the vendor kernel.
SESSIONS = ("desktop", "audio", "kodi", "web", "android", "stock-android")
UNIT_SESSIONS = {  # session -> systemd unit
    "desktop": "q10-desktop.service",
    "audio": "q10-audio.service",
    "kodi": "q10-kodi.service",
    "web": "q10-web.service",
    "android": "q10-android.service",
}
# What may be the persisted default / the q10.session= value. stock-android is excluded on purpose:
# "reboot returns here" + "default = stock-android" would be an endless Android<->Debian boot loop.
BOOTABLE = ("desktop", "audio", "kodi", "web", "android")

# Linux input-event codes (include/uapi/linux/input-event-codes.h). Numeric on purpose: the pure
# logic and the tests must not need python-evdev. Names are the ones in himedia_q10.toml.
KEYS = {
    "ESC": 1, "ENTER": 28, "SPACE": 57, "KPENTER": 96, "HOME": 102, "UP": 103, "LEFT": 105,
    "RIGHT": 106, "DOWN": 108, "MENU": 139, "SETUP": 141, "BACK": 158, "OK": 352,
    # HDMI-CEC remote (kernel rc-cec keymap): <Exit> 0x0d is the TV remote's Back/Return key.
    "EXIT": 174,
}
CODE_TO_NAME = {v: k for k, v in KEYS.items()}


def state_dir():
    return os.environ.get("Q10_STATE_DIR", "/var/lib/q10/session")


def log_dir():
    return os.environ.get("Q10_LOG_DIR", "/var/log/q10")


def run_dir():
    return os.environ.get("Q10_RUN_DIR", "/run/q10")


def systemctl_bin():
    return os.environ.get("Q10_SYSTEMCTL", "systemctl")


def log(msg, tag="q10-mode"):
    """stderr (journald when run by a unit), /var/log/q10/session.log, and logger(1) from a shell."""
    line = "%s %s: %s" % (time.strftime("%Y-%m-%dT%H:%M:%S%z"), tag, msg)
    print(line, file=sys.stderr, flush=True)
    try:
        os.makedirs(log_dir(), exist_ok=True)
        with open(os.path.join(log_dir(), "session.log"), "a") as f:
            f.write(line + "\n")
    except OSError:
        pass
    if not os.environ.get("JOURNAL_STREAM") and not os.environ.get("Q10_NO_JOURNAL"):
        try:
            subprocess.run(["logger", "-t", tag, msg], timeout=5, check=False)
        except (OSError, subprocess.SubprocessError):
            pass


def try_lock(name):
    """Non-blocking exclusive flock on run_dir()/name. Returns the fd (keep it open) or None if held."""
    os.makedirs(run_dir(), exist_ok=True)
    fd = os.open(os.path.join(run_dir(), name), os.O_CREAT | os.O_RDWR, 0o644)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        os.close(fd)
        return None
    return fd
