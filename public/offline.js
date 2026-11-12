// Descargas en este dispositivo (teléfono o PC): guarda las páginas en el almacenamiento del navegador
// para leer sin conexión. Requiere contexto seguro (HTTPS o localhost) porque usa Cache Storage.

import { STANDALONE, appFetch } from './platform.js';

export const DL_CACHE = 'lector-descargas';
const META_KEY = 'deviceDownloads';
export const deviceSupported = typeof caches !== 'undefined' && (window.isSecureContext || STANDALONE);

const readMeta = () => { try { return JSON.parse(localStorage.getItem(META_KEY) || '{}'); } catch { return {}; } };
const writeMeta = m => localStorage.setItem(META_KEY, JSON.stringify(m));
const k = (src, cid) => `${src}:${cid}`;
const manifestUrl = (src, cid) => `/__descarga/${encodeURIComponent(src)}/${encodeURIComponent(cid)}.json`;

export const isOnDevice = (src, cid) => !!readMeta()[k(src, cid)];
export function deviceList() {
  const groups = {};
  for (const d of Object.values(readMeta())) {
    const g = groups[`${d.source}:${d.seriesId}`] ||= { source: d.source, seriesId: d.seriesId, seriesTitle: d.seriesTitle, cover: d.cover, chapters: [], bytes: 0 };
    g.chapters.push(d); g.bytes += d.bytes || 0;
  }
  for (const g of Object.values(groups)) g.chapters.sort((a, b) => (parseFloat(b.number) || 0) - (parseFloat(a.number) || 0));
  return Object.values(groups).sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle, 'es'));
}

// ----- Cola -----
const queue = [];
const listeners = new Set();
export const onDeviceQueue = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const notify = () => listeners.forEach(fn => { try { fn(queue); } catch {} });
export const deviceQueue = () => queue;
let running = false;

export function saveToDevice(items) {
  if (!deviceSupported) throw new Error('Este navegador no permite guardar sin conexión en esta dirección');
  navigator.storage?.persist?.().catch(() => {});
  let added = 0;
  for (const it of items) {
    const key = k(it.source, it.chapterId);
    if (isOnDevice(it.source, it.chapterId) || queue.some(q => q.key === key && q.status !== 'error')) continue;
    const i = queue.findIndex(q => q.key === key); if (i >= 0) queue.splice(i, 1);
    queue.push({ ...it, key, status: 'queued', done: 0, total: it.pages || 0, error: null });
    added++;
  }
  notify(); run();
  return added;
}
export function cancelDevice(key) {
  const j = queue.find(q => q.key === key); if (!j) return;
  if (j.status === 'downloading') j.status = 'cancelled'; else queue.splice(queue.indexOf(j), 1);
  notify();
}

async function run() {
  if (running) return; running = true;
  try {
    for (let job; (job = queue.find(q => q.status === 'queued'));) {
      job.status = 'downloading'; notify();
      try { await saveChapter(job); job.status = 'done'; }
      catch (e) { if (job.status !== 'cancelled') { job.status = 'error'; job.error = e.message; } }
      notify();
      if (job.status !== 'error') setTimeout(() => { const i = queue.indexOf(job); if (i >= 0) { queue.splice(i, 1); notify(); } }, 4000);
    }
  } finally { running = false; }
}

async function put(cache, url, urls) {
  const res = await appFetch(url);
  if (!res.ok) throw new Error(`Error ${res.status} al descargar`);
  const blob = await res.clone().blob();
  await cache.put(url, res);
  urls.push(url);
  return blob.size;
}

async function saveChapter(job) {
  try { await saveChapterOnce(job, false); }
  catch (e) {
    // MangaDex entrega enlaces temporales: si fallan, se pide otro servidor y se reintenta una vez
    if (job.status === 'cancelled' || job.source !== 'mangadex') throw e;
    job.done = 0; notify();
    await saveChapterOnce(job, true);
  }
}

async function saveChapterOnce(job, refresh) {
  const cache = await caches.open(DL_CACHE);
  const urls = [];
  let bytes = 0;
  const base = `/api/s/${job.source}`;
  const sid = encodeURIComponent(job.seriesId), cid = encodeURIComponent(job.chapterId);
  // ficha y lista de capítulos (para abrir la serie sin conexión)
  for (const u of [`${base}/series/${sid}`, `${base}/series/${sid}/chapters`]) await put(cache, u, []);
  if (job.cover) { try { await put(cache, job.cover, []); } catch {} }
  const pagesUrl = `${base}/chapters/${cid}/pages`;
  const res = await appFetch(refresh ? `${pagesUrl}?refresh=1` : pagesUrl);
  if (!res.ok) throw new Error('No se pudo obtener la lista de páginas');
  const info = await res.clone().json();
  const targets = info.kind === 'images' ? info.pages.map(p => p.url) : [info.url];
  job.total = targets.length; notify();
  let next = 0;
  const worker = async () => {
    while (next < targets.length) {
      if (job.status === 'cancelled') throw new Error('Cancelado');
      const url = targets[next++];
      bytes += await put(cache, url, urls);
      job.done++; notify();
    }
  };
  try {
    await Promise.all([worker(), worker(), worker()]);
  } catch (e) {
    await Promise.all(urls.map(u => cache.delete(u)));
    throw e;
  }
  await cache.put(pagesUrl, new Response(JSON.stringify(info), { headers: { 'Content-Type': 'application/json' } })); urls.push(pagesUrl);
  await cache.put(manifestUrl(job.source, job.chapterId), new Response(JSON.stringify(urls), { headers: { 'Content-Type': 'application/json' } }));
  const meta = readMeta();
  meta[job.key] = { source: job.source, seriesId: job.seriesId, chapterId: job.chapterId, seriesTitle: job.seriesTitle, cover: job.cover,
    label: job.label, number: job.number, bytes, pages: targets.length, at: Date.now() };
  writeMeta(meta);
}

export async function removeFromDevice(src, chapterId) {
  const cache = await caches.open(DL_CACHE);
  const mres = await cache.match(manifestUrl(src, chapterId));
  if (mres) {
    const urls = await mres.json();
    await Promise.all(urls.map(u => cache.delete(u)));
    await cache.delete(manifestUrl(src, chapterId));
  }
  const meta = readMeta();
  const d = meta[k(src, chapterId)];
  delete meta[k(src, chapterId)];
  writeMeta(meta);
  // si ya no queda ningún capítulo de la serie, borrar también su ficha
  if (d && !Object.values(meta).some(x => x.source === src && x.seriesId === d.seriesId)) {
    const sid = encodeURIComponent(d.seriesId);
    await cache.delete(`/api/s/${src}/series/${sid}`); await cache.delete(`/api/s/${src}/series/${sid}/chapters`);
    if (d.cover) await cache.delete(d.cover);
  }
}

export async function storageInfo() {
  try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch { return null; }
}
export const fmtBytes = b => b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : b >= 1e6 ? (b / 1e6).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1e3)) + ' KB';
