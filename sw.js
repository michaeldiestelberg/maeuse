const CACHE_NAME = 'maeuse-v5';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './voice-utils.js',
  './manifest.json',
  './assets/logo.svg',
  './assets/icon-76.png',
  './assets/icon-120.png',
  './assets/icon-152.png',
  './assets/icon-180.png',
  './assets/icon-192.png',
  './assets/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(c => c.addAll(ASSETS)).then(() => {
      if (!self.registration.active) {
        return self.skipWaiting();
      }
    })
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('message', e => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request))
  );
});
