const CACHE_NAME = 'maeuse-v6';
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
  if (e.request.method !== 'GET') return;

  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(networkFirst(e.request));
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const response = await fetch(request, { cache: 'no-store' });

    if (response && response.ok) {
      cache.put(request, response.clone());
    }

    return response;
  } catch (error) {
    const cachedResponse = await cache.match(request, {
      ignoreSearch: request.mode === 'navigate'
    });

    if (cachedResponse) {
      return cachedResponse;
    }

    if (request.mode === 'navigate') {
      const appShell = await cache.match('./index.html');
      if (appShell) return appShell;
    }

    throw error;
  }
}
