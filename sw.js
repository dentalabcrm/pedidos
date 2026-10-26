// Service Worker — Dentalab Pedidos PWA
// Estrategia simple y segura:
//  - El HTML principal: red primero (para que el catálogo/precios estén siempre al día),
//    con el HTML cacheado como respaldo si no hay conexión.
//  - Íconos/manifest: cache primero (no cambian casi nunca).
//  - FOTOS de productos (miniaturas de Google Drive): se muestran como siempre, directo desde
//    Google; además, en segundo plano, se guarda una copia liviana en este dispositivo. Si no hay
//    internet (o Google las frena), se muestra la copia guardada. Si algo falla al guardar, se
//    ignora: las fotos siguen funcionando igual que antes.
//  - Todo lo demás (Firebase, APIs externas, WhatsApp, etc.): SIEMPRE va directo a la red,
//    el service worker no lo toca.

const CACHE_NAME = 'dentalab-pedidos-v23';
const FOTOS_CACHE = 'dentalab-fotos-v1';   // fotos guardadas para usar sin internet (se conserva entre versiones)
const FOTOS_MAX = 2500;                    // tope de fotos guardadas; al pasarse se borran las más viejas
const FOTOS_MAX_ANCHO = 400;               // solo se guardan miniaturas (sz=w150, w200, w300…), no las grandes del zoom
const FOTOS_HOST = 'drive.google.com';
const FOTOS_PATH = '/thumbnail';
const FOTOS_PROXY = 'https://images.weserv.nl/'; // proxy con CORS (el mismo que ya usa el PDF con fotos) para poder guardar una copia legible
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
      Promise.all(keys.filter((k) => k !== CACHE_NAME && k !== FOTOS_CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fotos ──────────────────────────────────────────────────────────────────────
// Clave estable de una foto (id + tamaño), ignorando parámetros de reintento como "_r=…".
function fotoClave(urlStr) {
  try {
    const u = new URL(urlStr);
    if (u.hostname !== FOTOS_HOST || u.pathname !== FOTOS_PATH) return null;
    const id = u.searchParams.get('id');
    const sz = u.searchParams.get('sz') || 'w300';
    const ancho = parseInt(String(sz).replace(/\D/g, ''), 10) || 0;
    if (!id || ancho <= 0 || ancho > FOTOS_MAX_ANCHO) return null;
    return `${u.origin}${FOTOS_PATH}?id=${encodeURIComponent(id)}&sz=${encodeURIComponent(sz)}`;
  } catch (e) { return null; }
}

// Cola para no pedir muchas copias a la vez (máx. 4 al mismo tiempo)
const _cola = [];
let _activos = 0;
const _enCurso = new Set();
let _desdeUltimoRecorte = 0;

function guardarFotoEnSegundoPlano(key) {
  if (_enCurso.has(key)) return Promise.resolve();
  _enCurso.add(key);
  return new Promise((resolve) => { _cola.push({ key, resolve }); _bombear(); });
}
function _bombear() {
  while (_activos < 4 && _cola.length) {
    const job = _cola.shift();
    _activos++;
    _guardarUna(job.key)
      .catch(() => {})
      .finally(() => { _activos--; _enCurso.delete(job.key); job.resolve(); _bombear(); });
  }
}
async function _guardarUna(key) {
  const cache = await caches.open(FOTOS_CACHE);
  if (await cache.match(key)) return;
  const u = new URL(key);
  const original = `${FOTOS_HOST}${FOTOS_PATH}?id=${u.searchParams.get('id')}&sz=${u.searchParams.get('sz')}`;
  const prox = `${FOTOS_PROXY}?url=${encodeURIComponent(original)}&w=240&we&q=72&output=jpg`;
  const r = await fetch(prox, { mode: 'cors', credentials: 'omit' });
  if (!r.ok) return;
  if (!String(r.headers.get('content-type') || '').startsWith('image/')) return;
  await cache.put(key, r);
  if (++_desdeUltimoRecorte >= 25) { _desdeUltimoRecorte = 0; await _recortar(cache); }
}
async function _recortar(cache) {
  const keys = await cache.keys();
  if (keys.length <= FOTOS_MAX) return;
  const sobran = keys.length - FOTOS_MAX + 100; // se borra de más para no recortar en cada foto nueva
  for (let i = 0; i < sobran; i++) await cache.delete(keys[i]); // las más viejas primero
}
async function responderFoto(event, req, key) {
  try {
    const cache = await caches.open(FOTOS_CACHE);
    const guardada = await cache.match(key);
    if (guardada) return guardada;
  } catch (e) { /* si el cache falla, se sigue por la red como siempre */ }
  const res = await fetch(req); // igual que antes: directo desde Google (si no hay internet, esto falla y la página muestra su diente)
  if (res && (res.ok || res.type === 'opaque')) event.waitUntil(guardarFotoEnSegundoPlano(key));
  return res;
}

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Fotos de productos (miniaturas de Drive): con copia local para cuando no hay internet.
  if (req.method === 'GET' && req.destination === 'image') {
    const key = fotoClave(req.url);
    if (key) { event.respondWith(responderFoto(event, req, key)); return; }
  }

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
