// Service Worker — Dentalab Pedidos PWA
// Estrategia simple y segura:
//  - El HTML principal: red primero (para que el catálogo/precios estén siempre al día),
//    con el HTML cacheado como respaldo si no hay conexión.
//  - Íconos/manifest: cache primero (no cambian casi nunca).
//  - Todo lo demás (Firebase, APIs externas, WhatsApp, etc.): SIEMPRE va directo a la red,
//    el service worker no lo toca.

const CACHE_NAME = 'dentalab-pedidos-v3';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './qrcode.min.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Solo manejar GET del mismo origen — todo lo demás (Firebase, WhatsApp, APIs) pasa directo.
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Navegación (el HTML de la página): red primero, cache como respaldo offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', resClone));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Resto de archivos propios (íconos, manifest): cache primero, red como respaldo.
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
