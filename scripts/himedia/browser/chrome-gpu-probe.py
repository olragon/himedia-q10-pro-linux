#!/usr/bin/env python3
"""Chromium GPU probe for the Q10 (run ON the box, X desktop up on :0).

Launches Chromium with a given flag set on the real display, reads chrome://gpu over the DevTools
protocol, then runs gpu-test.html (40 CSS layers + WebGL) and reports page fps, whole-box CPU,
Chromium CPU and panfrost job faults. One run = one flag set, so flag sets compare like for like.

usage: chrome-gpu-probe.py --label NAME [--secs 20] [-- <extra chromium flags>]
needs: python3-websocket (apt), chromium, /root/gpu-test.html
"""
import argparse, json, os, re, shutil, subprocess, sys, time, urllib.request
import websocket  # python3-websocket

PORT = 9333
PROFILE = "/root/.q10-chrome-probe"

def cpu_total():
    with open("/proc/stat") as f:
        v = list(map(int, f.readline().split()[1:]))
    return v[0] + v[1] + v[2]          # user+nice+system ticks, all cores

def proc_cpu(pids):
    t = 0
    for p in pids:
        try:
            with open(f"/proc/{p}/stat") as f:
                s = f.read().rsplit(")", 1)[1].split()
            t += int(s[11]) + int(s[12])
        except OSError:
            pass
    return t

def chrome_pids():
    out = subprocess.run(["pgrep", "-f", f"user-data-dir={PROFILE}"], capture_output=True, text=True).stdout
    return [int(x) for x in out.split()]

def js_faults():
    out = subprocess.run(["dmesg"], capture_output=True, text=True).stdout
    return out.count("js fault")

class Tab:
    def __init__(self, ws_url):
        # no Origin header: DevTools rejects a non-allowlisted origin (403) unless --remote-allow-origins
        self.ws = websocket.create_connection(ws_url, timeout=30, suppress_origin=True); self.i = 0
    def call(self, method, **params):
        self.i += 1; self.ws.send(json.dumps({"id": self.i, "method": method, "params": params}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get("id") == self.i:
                return m.get("result", m)
    def eval(self, expr):
        r = self.call("Runtime.evaluate", expression=expr, returnByValue=True, awaitPromise=True)
        return r.get("result", {}).get("value")

def wait_tab():
    for _ in range(60):
        try:
            tabs = json.load(urllib.request.urlopen(f"http://127.0.0.1:{PORT}/json"))
            pages = [t for t in tabs if t.get("type") == "page"]
            if pages:
                return pages[0]["webSocketDebuggerUrl"]
        except OSError:
            pass
        time.sleep(0.5)
    raise SystemExit("chromium did not expose a DevTools page")

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True); ap.add_argument("--secs", type=int, default=20)
    ap.add_argument("--page", default="/root/gpu-test.html")
    ap.add_argument("flags", nargs="*")
    a = ap.parse_args()
    shutil.rmtree(PROFILE, ignore_errors=True)
    subprocess.run(["dmesg", "-C"])
    env = dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":0"))
    cmd = ["chromium", "--no-sandbox", f"--user-data-dir={PROFILE}", f"--remote-debugging-port={PORT}",
           "--no-first-run", "--no-default-browser-check", "--start-fullscreen", "--disable-features=Translate",
           *a.flags, "about:blank"]
    p = subprocess.Popen(cmd, env=env, stdout=subprocess.DEVNULL, stderr=open(f"/tmp/chrome-probe-{a.label}.log", "w"),
                         start_new_session=True)
    try:
        tab = Tab(wait_tab())
        tab.call("Page.navigate", url="chrome://gpu"); time.sleep(4)
        gpu = tab.eval("(()=>{const v=document.querySelector('info-view');"
                       "return v&&v.shadowRoot?v.shadowRoot.innerText:document.body.innerText})()") or ""
        feats = dict(re.findall(r"^\s*\*?\s*([A-Z][A-Za-z /\-]+?):\s+(.+)$", gpu.split("Problems Detected")[0], re.M))
        keep = ["Canvas", "Compositing", "Rasterization", "Video Decode", "WebGL", "WebGL2", "OpenGL",
                "Multiple Raster Threads", "Skia Graphite", "WebGPU"]
        renderer = (re.search(r"GL_RENDERER\s+(.+)", gpu) or [None, "?"])[1].strip()
        angle = (re.search(r"(GL_IMPLEMENTATION|GL implementation parts)\s+(.+)", gpu) or [None, None, "?"])[2].strip()
        tab.call("Page.navigate", url="file://" + a.page); time.sleep(5)        # warm up
        c0, k0, f0 = cpu_total(), proc_cpu(chrome_pids()), js_faults()
        samples = []
        t_end = time.time() + a.secs
        while time.time() < t_end:
            time.sleep(2); samples.append(tab.eval("window.__fps") or 0)
        c1, k1, f1 = cpu_total(), proc_cpu(chrome_pids()), js_faults()
        webgl = tab.eval("window.__webgl")
        res = {"label": a.label, "flags": a.flags, "renderer": renderer, "gl_impl": angle,
               "features": {k: v for k, v in feats.items() if k.strip() in keep},
               "fps_median": sorted(samples)[len(samples) // 2] if samples else 0, "fps_samples": samples,
               "webgl": webgl, "box_cpu_s": round((c1 - c0) / 100, 2), "chrome_cpu_s": round((k1 - k0) / 100, 2),
               "secs": a.secs, "js_faults": f1 - f0}
        print(json.dumps(res, indent=1))
        with open(f"/tmp/chrome-gpu-{a.label}.txt", "w") as f:
            f.write(gpu)
    finally:
        os.killpg(p.pid, 15); time.sleep(1)
        try: os.killpg(p.pid, 9)
        except OSError: pass

if __name__ == "__main__":
    main()
