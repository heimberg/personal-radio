const VERSION = 'personal-radio-shell-v1';
const SHELL = ['./', './manifest.webmanifest', './icons/radio.svg'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(VERSION).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== VERSION).map(key => caches.delete(key))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).then(response => {
      if (response.ok) void caches.open(VERSION).then(cache => cache.put('./', response.clone()));
      return response;
    }).catch(async () => (await caches.match('./')) || Response.error()));
    return;
  }

  // Cache app assets only. Never persist audio, API responses, or user-generated blobs.
  if (/\.(?:js|css|svg|webmanifest)$/.test(url.pathname)) {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      if (response.ok) void caches.open(VERSION).then(cache => cache.put(request, response.clone()));
      return response;
    })));
  }
});
