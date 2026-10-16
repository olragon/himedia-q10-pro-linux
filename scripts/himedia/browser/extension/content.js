// Overlay button on <video> elements: click sends this frame's URL to mpv (HW). No dependencies.
(() => {
  if (window.__q10MpvOverlay) return;
  window.__q10MpvOverlay = true;
  const btn = document.createElement("button");
  btn.textContent = "Play in mpv (HW)";
  btn.style.cssText = "position:fixed;z-index:2147483647;display:none;padding:4px 8px;font:12px sans-serif;" +
    "background:#ff8c00;color:#111;border:0;border-radius:4px;cursor:pointer;opacity:.92";
  btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    chrome.runtime.sendMessage({ type: "play", url: location.href });
  });
  document.documentElement.appendChild(btn);
  let hideTimer = 0;
  let last = 0;
  document.addEventListener("mousemove", (e) => {
    const now = Date.now();
    if (now - last < 200) return;           // throttle
    last = now;
    // players put their own overlays above <video>, so look through the whole stack at the pointer
    const v = document.elementsFromPoint(e.clientX, e.clientY).find((el) => el.tagName === "VIDEO");
    if (!v) return;
    const r = v.getBoundingClientRect();
    if (r.width < 200 || r.height < 120) return;
    btn.style.left = Math.max(0, r.left + 8) + "px";
    btn.style.top = Math.max(0, r.top + 8) + "px";
    btn.style.display = "block";
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => { btn.style.display = "none"; }, 3000);
  }, true);
})();
