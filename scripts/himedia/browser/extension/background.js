// Play in mpv (HW): service worker. Sends a URL to the native host and reports the reply.
const HOST = "vn.himedia.mpv_hw";
const MENU_ID = "q10-play-mpv";

function isHttp(u) { return typeof u === "string" && /^https?:\/\//i.test(u); }

function badge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color });
  chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }), 4000);
}

function notify(title, message) {
  chrome.notifications.create({
    type: "basic",
    iconUrl: chrome.runtime.getURL("icon48.png"),
    title,
    message: String(message).slice(0, 300),
  });
}

function play(url) {
  if (!isHttp(url)) { badge("ERR", "#b00020"); notify("mpv (HW)", "Not an http(s) URL: " + url); return; }
  chrome.runtime.sendNativeMessage(HOST, { action: "play", url }, (reply) => {
    const err = chrome.runtime.lastError;
    if (err) { badge("ERR", "#b00020"); notify("mpv (HW): host not reachable", err.message); return; }
    if (reply && reply.ok) { badge("OK", "#1b7f3b"); notify("mpv (HW)", "Playing, pid " + reply.pid + " (" + reply.vo + ")"); }
    else { badge("ERR", "#b00020"); notify("mpv (HW): refused", (reply && reply.error) || "no reply"); }
  });
}

// What to send for a context-menu click: link > media element source > page.
function pickUrl(info, tab) {
  if (info.linkUrl && isHttp(info.linkUrl)) return info.linkUrl;
  if (info.mediaType === "video" && isHttp(info.srcUrl)) return info.srcUrl;
  return info.frameUrl && isHttp(info.frameUrl) && info.frameId ? info.frameUrl : (info.pageUrl || (tab && tab.url));
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: "Play in mpv (HW)", contexts: ["page", "link", "video", "frame"] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => { if (info.menuItemId === MENU_ID) play(pickUrl(info, tab)); });
chrome.action.onClicked.addListener((tab) => play(tab && tab.url));
chrome.runtime.onMessage.addListener((msg, sender) => { if (msg && msg.type === "play") play(msg.url || (sender.tab && sender.tab.url)); });
