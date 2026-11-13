// Service worker: la app abre sin conexión y lee lo guardado en este dispositivo.
const SHELL_CACHE = 'lector-shell-v5';
const API_CACHE = 'lector-api';
const IMG_CACHE = 'lector-portadas';
const DL_CACHE = 'lector-descargas';
const SHELL = ['/', '/styles.css', '/app.js', '/reader.js', '/offline.js', '/platform.js', '/config.js', '/manifest.json', '/favicon.png', '/icon-192.png',
  '/icon-512.png', '/brand/logo-256.png', '/brand/portada.jpg', '/vendor/jszip.js', '/vendor/pdf.mjs', '/vendor/pdf.worker.mjs', '/vendor/epub.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  const keep = [SHELL_CACHE, API_CACHE, IMG_CACHE, DL_CACHE];
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => !keep.includes(k)).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

const isPageLike = p => /^\/api\/(img|local\/page|local\/raw|dl\/page)\b/.test(p) || /^\/api\/s\/[^/]+\/chapters\/[^/]+\/pages$/.test(p);

async function networkFirst(req, cacheName, { fallbackDl = false } = {}) {
  const fromCache = async () => {
    const hit = (fallbackDl && await (await caches.open(DL_CACHE)).match(req)) || await (await caches.open(cacheName)).match(req);
    if (!hit) return null;
    const headers = new Headers(hit.headers); headers.set('X-Offline', '1'); // avisa a la app que es una copia
    return new Response(await hit.blob(), { status: hit.status, headers });
  };
  try {
    const res = await fetch(req);
    if (res.ok) { const copy = res.clone(); caches.open(cacheName).then(c => c.put(req, copy)); return res; }
    if (res.status >= 500) return (await fromCache()) || res; // el servidor no alcanzó la fuente (sin internet)
    return res;
  } catch (err) {
    const hit = await fromCache();
    if (hit) return hit;
    return new Response(JSON.stringify({ error: 'Sin conexión con el servidor', offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const p = url.pathname;

  if (p.startsWith('/api/')) {
    // 1) lo descargado en el dispositivo siempre gana (no gasta datos)
    if (isPageLike(p) || p.startsWith('/api/local/cover/')) {
      e.respondWith((async () => {
        const dl = await (await caches.open(DL_CACHE)).match(req);
        if (dl) return dl;
        // 2) portadas: caché primero
        const coverLike = p.startsWith('/api/local/cover/') || (p === '/api/img' && url.search.includes('covers'));
        if (coverLike) {
          const c = await (await caches.open(IMG_CACHE)).match(req);
          if (c) return c;
          try { const res = await fetch(req); if (res.ok) { const copy = res.clone(); caches.open(IMG_CACHE).then(x => x.put(req, copy)); } return res; }
          catch { return new Response('', { status: 504 }); }
        }
        try { return await fetch(req); }
        catch { return new Response(JSON.stringify({ error: 'No está guardado en este dispositivo', offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } }); }
      })());
      return;
    }
    // 3) datos (biblioteca, ficha, ajustes…): red primero y copia para usar sin conexión
    if (/^\/api\/(dl\/file|dl\/series)\//.test(p)) return; // archivos para guardar: directo
    e.respondWith(networkFirst(req, API_CACHE, { fallbackDl: /^\/api\/s\/[^/]+\/series\//.test(p) }));
    return;
  }
  // 4) la interfaz: red primero, caché si no hay conexión
  e.respondWith(fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(SHELL_CACHE).then(c => c.put(req, copy)); }
    return res;
  }).catch(async () => (await caches.match(req, { ignoreSearch: true })) || caches.match('/')));
});
