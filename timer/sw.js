/* CubeTimer Service Worker —— 离线可用（App Shell 缓存） */
const CACHE = 'cubetimer-v29';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './store.js',
  './scramble.js',
  './manifest.json',
  './icon.svg',
  './ds-chan.png',
  './supabase-config.js',
  './mascot-chibi.png', './mascot-full.jpg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  // Supabase API 一律走网络，不缓存
  if (url.hostname.endsWith('supabase.co')) return;

  // 图片等大文件：缓存优先（很少变化，离线也要能用）
  const dest = e.request.destination;
  if (dest === 'image' || dest === 'font') {
    e.respondWith(
      caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
        if (res && res.ok) { const c = res.clone(); caches.open(CACHE).then((k) => k.put(e.request, c)); }
        return res;
      }))
    );
    return;
  }

  // HTML / JS / CSS：网络优先 —— 更新后第一次打开就能拿到新版，
  // 断网时自动回退到缓存，离线仍可用
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res && res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('./index.html')))
  );
});
