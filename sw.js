const CACHE = 'backrooms-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // WebSocket и Railway — не кешируем
  if (e.request.url.includes('railway.app') || e.request.url.startsWith('ws')) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        // Кешируем только успешные GET-запросы
        if (!res || res.status !== 200 || res.type === 'opaque') return res;
        if (e.request.method !== 'GET') return res;
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match('/index.html'));
    })
  );
});
