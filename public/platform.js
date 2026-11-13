// Capa de plataforma: la misma interfaz funciona en dos modos.
//  - "server": navegador conectado al servidor de tu PC (npm start).
//  - "standalone": APK de Android (Capacitor). No hay servidor: la app habla directo con MangaDex
//    por HTTP nativo (sin restricciones CORS) y guarda todo en el teléfono.
export const MODE = window.APP_MODE === 'standalone' ? 'standalone' : 'server';
export const STANDALONE = MODE === 'standalone';
const Cap = window.Capacitor;
export const isNative = !!Cap?.isNativePlatform?.();
// @capacitor/core (vendor/capacitor.js) registra los plugins nativos sin necesidad de compilar JS.
const core = window.capacitorExports;
const plugin = name => core?.registerPlugin(name);
const Filesystem = isNative ? plugin('Filesystem') : null;
const Share = isNative ? plugin('Share') : null;
const AppPlugin = isNative ? plugin('App') : null;

let backend = null; // se carga solo en modo standalone
async function getBackend() {
  if (!backend) backend = await import('./standalone/backend.js');
  return backend;
}

// ---------- Registro de errores (Ajustes → Diagnóstico) ----------
const LOG_KEY = 'diagLog';
export function logError(where, err) {
  try {
    const log = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
    log.unshift({ at: Date.now(), where: String(where).slice(0, 120), msg: String(err?.message || err).slice(0, 300) });
    localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(0, 60)));
  } catch {}
}
export const readLog = () => { try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]'); } catch { return []; } };
export const clearLog = () => localStorage.removeItem(LOG_KEY);
window.addEventListener('error', e => { if (e.message) logError('Error de la app', `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`); });
window.addEventListener('unhandledrejection', e => logError('Promesa sin manejar', e.reason));

// ---------- HTTP nativo ----------
const UA = 'LectorPersonal/1.0 (uso personal)';
// Devuelve un objeto parecido a Response; en el APK usa CapacitorHttp (nativo), en el navegador fetch.
export async function nativeFetch(url, { responseType = 'json', headers = {}, timeout = 20000 } = {}) {
  if (!isNative) {
    const res = await fetch(url, { headers: { ...headers }, signal: AbortSignal.timeout(timeout) });
    return res;
  }
  const r = await core.CapacitorHttp.request({
    url, method: 'GET', headers: { 'User-Agent': UA, ...headers }, responseType,
    connectTimeout: timeout, readTimeout: timeout,
  });
  const hdrs = new Headers(r.headers || {});
  const status = r.status;
  return {
    ok: status >= 200 && status < 300, status, headers: hdrs,
    json: async () => (typeof r.data === 'string' ? JSON.parse(r.data) : r.data),
    text: async () => (typeof r.data === 'string' ? r.data : JSON.stringify(r.data)),
    blob: async () => b64ToBlob(r.data, hdrs.get('content-type') || 'application/octet-stream'),
  };
}
async function b64ToBlob(b64, type) {
  return (await fetch(`data:${type};base64,${b64}`)).blob();
}

// ---------- API ----------
// En modo standalone las rutas /api/* se atienden dentro de la app.
export async function platformApi(path, opts) {
  const b = await getBackend();
  return b.handleApi(path, opts);
}

// ---------- Imágenes y archivos ----------
const objUrls = new Map(); // url de la app -> object URL
const MAX_OBJ = 400;
function remember(key, objUrl) {
  objUrls.set(key, objUrl);
  if (objUrls.size > MAX_OBJ) {
    const [k, v] = objUrls.entries().next().value;
    objUrls.delete(k); URL.revokeObjectURL(v);
  }
  return objUrl;
}
// Devuelve un Blob para una URL de la app (/api/img, /api/local/page, /api/local/raw, /api/dl/page…).
export async function getBlob(url) {
  if (!STANDALONE) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Error ${res.status}`);
    return res.blob();
  }
  return (await getBackend()).blobFor(url);
}
// URL utilizable en <img>: en modo servidor es la misma; en el APK, un object URL.
export async function resolveImage(url) {
  if (!STANDALONE || !url || !url.startsWith('/api/')) return url;
  const hit = objUrls.get(url);
  if (hit) return hit;
  return remember(url, URL.createObjectURL(await getBlob(url)));
}
// Response para guardar en Cache Storage (descargas en el dispositivo).
export async function appFetch(url) {
  if (!STANDALONE) return fetch(url, { cache: 'no-store' });
  const b = await getBackend();
  if (/^\/api\/s\/[^/]+\/(series|chapters)\//.test(url)) {
    const data = await b.handleApi(url, {});
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
  }
  const blob = await b.blobFor(url, { skipDevice: true });
  return new Response(blob, { headers: { 'Content-Type': blob.type || 'application/octet-stream' } });
}

// Atributos de una <img>: en el APK la imagen se resuelve después (data-src).
const PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const escA = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function imgAttr(url) {
  if (!url) return `src="${PIXEL}"`;
  if (!STANDALONE || !url.startsWith('/api/')) return `src="${escA(url)}"`;
  return `src="${PIXEL}" data-src="${escA(url)}"`;
}
if (STANDALONE) {
  const io = new IntersectionObserver(entries => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      io.unobserve(e.target);
      const img = e.target, src = img.dataset.src;
      resolveImage(src).then(u => { if (img.dataset.src === src) img.src = u; }).catch(() => { img.src = '/icon-192.png'; });
    }
  }, { rootMargin: '400px' });
  const scan = root => root.querySelectorAll?.('img[data-src]').forEach(img => io.observe(img));
  new MutationObserver(muts => muts.forEach(m => m.addedNodes.forEach(n => {
    if (n.nodeType !== 1) return;
    if (n.matches?.('img[data-src]')) io.observe(n);
    scan(n);
  }))).observe(document.documentElement, { childList: true, subtree: true });
}

// ---------- Exportar archivos ----------
// En el APK se abre el menú "Compartir" de Android (Guardar en Archivos, Drive, otra app…).
export async function shareFiles(files) {
  const uris = [];
  for (const f of files) {
    const data = await blobToB64(f.blob);
    const path = `exportar/${f.name.replace(/[\\/:*?"<>|]/g, '_')}`;
    const w = await Filesystem.writeFile({ path, data, directory: 'CACHE', recursive: true });
    uris.push(w.uri);
  }
  await Share.share({ title: files.length === 1 ? files[0].name : `${files.length} archivos`, files: uris, dialogTitle: 'Guardar o enviar' });
}
function blobToB64(blob) {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).split(',')[1]);
    r.onerror = fail;
    r.readAsDataURL(blob);
  });
}

// ---------- Botón "atrás" de Android ----------
// Barra de estado acorde al tema (iconos oscuros en tema claro).
export function syncSystemBars(dark) {
  if (isNative) core.SystemBars?.setStyle({ style: dark ? 'DARK' : 'LIGHT' }).catch(() => {});
}

if (AppPlugin) {
  AppPlugin.addListener('backButton', () => {
    const sheet = document.querySelector('.sheet-bg');
    if (sheet) { sheet.remove(); return; }
    const h = location.hash;
    if (!h || h === '#/library' || h === '#/' || h === '#/welcome') AppPlugin.exitApp();
    else history.back();
  });
}
