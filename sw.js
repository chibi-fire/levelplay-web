// Service Worker: アプリ本体のファイルだけをキャッシュし、オフラインでも起動できるようにする。
// 音源は File / blob URL で扱うためここを通らない。念のため、下の一覧にないものは一切キャッシュしない。

const CACHE = "levelplay-app-v1";
const APP_FILES = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/analyzer.js",
  "./js/loudness.js",
  "./js/player.js",
  "./js/limiter-worklet.js",
  "./manifest.webmanifest",
  "./icons/icon.svg",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

const appUrls = new Set(APP_FILES.map((p) => new URL(p, self.registration.scope).href));

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  url.search = "";
  if (!appUrls.has(url.href)) return; // アプリ本体以外は素通し（キャッシュしない）
  // 更新をすぐ反映するため、まずネットワーク。つながらないときだけキャッシュを使う。
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(url.href, copy));
        }
        return res;
      })
      .catch(() => caches.match(url.href))
  );
});
