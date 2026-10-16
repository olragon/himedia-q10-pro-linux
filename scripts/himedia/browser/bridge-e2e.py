#!/usr/bin/env python3
"""End-to-end test of the Chromium -> mpv HW bridge, ON the box (X up on :0, run under q10-wd-run).

Launches Chromium through its normal wrapper (so /etc/chromium.d applies: GPU override +
--load-extension), finds the bridge extension's service worker over DevTools, and makes THAT worker
call chrome.runtime.sendNativeMessage — the same call a toolbar click makes. The clip is served
over local HTTP because the host accepts http(s) only. Then it checks mpv is running with hardware
decoding and counts panfrost job faults.

usage: bridge-e2e.py [--clip /root/h264-1080p.h264] [--secs 12]
"""
import argparse, functools, http.server, json, os, shutil, subprocess, threading, time, urllib.request
import websocket

EXT_ID = "ndcllcbcfbjcioigndaglbfkaofdpaee"
PORT, HTTP_PORT = 9334, 8088
PROFILE = "/root/.q10-bridge-e2e"
LOG = "/var/log/q10-mpv-bridge.log"

def targets():
    return json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))

def native(ws_url, msg, wait=10):
    """Call sendNativeMessage inside the extension's worker, then poll for the reply.
    (Runtime.evaluate with awaitPromise never returned in an MV3 service worker here; fire + poll does.)"""
    ws = websocket.create_connection(ws_url, timeout=15, suppress_origin=True); n = [0]
    def ev(expr):
        n[0] += 1; ws.send(json.dumps({"id": n[0], "method": "Runtime.evaluate",
                                        "params": {"expression": expr, "returnByValue": True}}))
        while True:
            m = json.loads(ws.recv())
            if m.get("id") == n[0]:
                return m.get("result", {}).get("result", {}).get("value")
    ev("globalThis.__r=null; chrome.runtime.sendNativeMessage('vn.himedia.mpv_hw', %s, x => {globalThis.__r ="
       " JSON.stringify(x || {error: chrome.runtime.lastError && chrome.runtime.lastError.message})}); 1" % json.dumps(msg))
    for _ in range(wait * 4):
        r = ev("globalThis.__r")
        if r:
            ws.close(); return json.loads(r)
        time.sleep(0.25)
    ws.close(); return {"error": "no reply in %d s" % wait}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--clip", default="/root/h264-1080p.h264")
    ap.add_argument("--secs", type=int, default=12); a = ap.parse_args()
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=os.path.dirname(a.clip))
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", HTTP_PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    shutil.rmtree(PROFILE, ignore_errors=True); subprocess.run(["dmesg", "-C"])
    log_start = os.path.getsize(LOG) if os.path.exists(LOG) else 0
    env = dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":0"))
    p = subprocess.Popen(["chromium", "--no-sandbox", f"--user-data-dir={PROFILE}", f"--remote-debugging-port={PORT}",
                          "--no-first-run", "about:blank"], env=env, stdout=subprocess.DEVNULL,
                         stderr=open("/tmp/bridge-e2e-chrome.log", "w"), start_new_session=True)
    res = {"extension_loaded": False}
    try:
        sw = None
        for _ in range(60):
            try:
                sw = next((t for t in targets() if t.get("url", "").startswith(f"chrome-extension://{EXT_ID}/")), None)
            except OSError:
                pass
            if sw: break
            time.sleep(0.5)
        if not sw:
            raise SystemExit(json.dumps({"extension_loaded": False, "hint": "--load-extension ignored? see doc"}))
        res["extension_loaded"] = True
        res["ping"] = native(sw["webSocketDebuggerUrl"], {"action": "ping"}, wait=30)  # cold self-test runs yt-dlp + mpv probes: >10 s seen
        url = f"http://127.0.0.1:{HTTP_PORT}/{os.path.basename(a.clip)}"
        c0 = sum(map(int, open("/proc/stat").readline().split()[1:4]))
        res["play"] = native(sw["webSocketDebuggerUrl"], {"action": "play", "url": url})
        time.sleep(a.secs)
        c1 = sum(map(int, open("/proc/stat").readline().split()[1:4]))
        res["mpv_running"] = subprocess.run(["pgrep", "-f", "mpv-v4l2req|/opt/mpv-v4l2req/bin/mpv"], capture_output=True).returncode == 0
        # mpv runs --no-terminal, so the log has no decoder line: check the decoder's device nodes in
        # mpv's open files instead — /dev/media0 + /dev/video0 held open IS the V4L2 request decoder.
        pids = subprocess.run(["pgrep", "-f", "/opt/mpv-v4l2req/bin/mpv"], capture_output=True, text=True).stdout.split()
        fds = set()
        for pid in pids:
            for fd in os.listdir(f"/proc/{pid}/fd"):
                try: fds.add(os.readlink(f"/proc/{pid}/fd/{fd}"))
                except OSError: pass
        res["mpv_decoder_fds"] = sorted(x for x in fds if x.startswith(("/dev/media", "/dev/video", "/dev/dri")))
        res["hw_decode"] = any(x.startswith("/dev/media") for x in fds) and any(x.startswith("/dev/video") for x in fds)
        res["box_cpu_s"] = round((c1 - c0) / 100, 2); res["secs"] = a.secs
        res["js_faults"] = subprocess.run(["dmesg"], capture_output=True, text=True).stdout.count("js fault")
        print(json.dumps(res, indent=1))
    finally:
        subprocess.run(["pkill", "-f", "/opt/mpv-v4l2req/bin/mpv"])
        try: os.killpg(p.pid, 15)
        except OSError: pass
        srv.shutdown()

if __name__ == "__main__":
    main()
