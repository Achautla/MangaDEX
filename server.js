// Lector personal de cómics, manga y manhwa — servidor.
// Uso: npm start  → abre http://localhost:3000 (o la IP de tu PC desde el celular).
import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createStore } from './src/store.js';
import { createMangaDex } from './src/sources/mangadex.js';
import { createLocal } from './src/sources/local.js';
import { createDownloads } from './src/downloads.js';
import { createArchive } from './src/sources/archive.js';
import { createTranslator } from './src/translate.js';
import { createComicBooks, CACHE_DIR } from './src/sources/comicbooks.js';
import { ZipArchive } from 'archiver';
import { HttpError } from './src/util.js';
import { createMarmota } from './src/sources/marmota.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- Configuración (config.json o variables de entorno) ----------
let fileCfg = {};
try { fileCfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8')); } catch {}
const config = {
  port: Number(process.env.PORT || fileCfg.port || 3000),
  libraryDir: process.env.LIBRARY_DIR || fileCfg.libraryDir || path.join(__dirname, 'biblioteca'),
  dataDir: process.env.DATA_DIR || fileCfg.dataDir || path.join(__dirname, 'datos'),
  mangadexApi: process.env.MANGADEX_API || fileCfg.mangadexApi || 'https://api.mangadex.org',
  mangadexUploads: process.env.MANGADEX_UPLOADS || fileCfg.mangadexUploads || 'https://uploads.mangadex.org',
  mangadexImageHosts: (process.env.MANGADEX_IMAGE_HOSTS || fileCfg.mangadexImageHosts || 'mangadex.network,mangadex.org,archive.org').split(',').map(s => s.trim()),
  mangadexReport: process.env.MANGADEX_REPORT !== '0',
  imageCacheMB: Number(process.env.IMAGE_CACHE_MB || fileCfg.imageCacheMB || 1024),
};

const store = createStore(path.join(config.dataDir, 'db.json'));
const local = createLocal(config);
const mangadex = createMangaDex(config, store.settings);
const archive = createArchive({ archiveBase: process.env.ARCHIVE_BASE, iiifBase: process.env.IIIF_BASE });
const comicbooks = createComicBooks(); // <--- NUEVA LÍNEA
const sources = { mangadex, archive, local, comicbooks }; // <--- MODIFICADO
const marmota = createMarmota();
const sources = { mangadex, archive, local, comicbooks, marmota }; // Añade 'marmota'
const downloads = createDownloads({ config, store, sources });
store.db.translations ||= {};
const translator = createTranslator({
  base: process.env.TRANSLATE_API || undefined,
  email: () => store.settings().translateEmail || '',
  cache: {
    get: k => store.db.translations[k],
    set: (k, v) => {
      const t = store.db.translations; t[k] = v;
      const keys = Object.keys(t); if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach(x => delete t[x]);
      store.save();
    },
  },
});
const imgCacheDir = path.join(config.dataDir, 'cache-imagenes');
fs.mkdirSync(imgCacheDir, { recursive: true });

const app = express();
app.use(express.json({ limit: '2mb' }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const src = id => { const s = sources[id]; if (!s) throw new HttpError(404, 'Fuente desconocida'); return s; };

// ---------- Fuentes ----------
app.get('/api/sources', (req, res) => {
  res.json(Object.values(sources).map(({ id, name, description, capabilities }) => ({ id, name, description, capabilities })));
});

app.get('/api/s/:src/filters', wrap(async (req, res) => res.json(await src(req.params.src).getFilters())));

app.get('/api/s/:src/list', wrap(async (req, res) => {
  const { mode = 'popular', page = '1', q = '', filters = '{}' } = req.query;
  let f; try { f = JSON.parse(filters); } catch { throw new HttpError(400, 'Filtros inválidos'); }
  res.json(await src(req.params.src).list({ mode, page: Number(page) || 1, q: String(q).trim(), filters: f }));
}));

// Si la fuente no responde (sin internet), se usa la copia guardada al descargar.
async function withSnapshot(srcId, seriesId, fn, pick) {
  try { return { data: await fn(), offline: false }; }
  catch (e) {
    const snap = downloads.snapshot(srcId, seriesId);
    if (!snap) throw e;
    return { data: pick(snap), offline: true };
  }
}

app.get('/api/s/:src/series/:id', wrap(async (req, res) => {
  const { src: sid, id } = req.params;
  const { data, offline } = await withSnapshot(sid, id, () => src(sid).series(id), s => s.series);
  res.json({ ...data, offline, inLibrary: !!store.db.library[`${sid}:${id}`] });
}));

app.get('/api/s/:src/series/:id/chapters', wrap(async (req, res) => {
  const { src: sid, id } = req.params;
  const { data, offline } = await withSnapshot(sid, id, () => src(sid).chapters(id),
    s => s.chapters.filter(c => downloads.isDownloaded(sid, c.id)));
  const p = store.db.progress;
  res.json(data.map(c => ({ ...c, progress: p[`${sid}:${c.id}`] || null, downloaded: downloads.isDownloaded(sid, c.id), offline })));
}));

app.get('/api/s/:src/chapters/:id/pages', wrap(async (req, res) => {
  const local = await downloads.pagesFor(req.params.src, req.params.id);
  if (local) return res.json(local);
  res.json(await src(req.params.src).pages(req.params.id, { refresh: req.query.refresh === '1' }));
}));

// ---------- Traducción de sinopsis ----------
app.post('/api/translate', wrap(async (req, res) => {
  const { text = '', from = 'autodetect' } = req.body || {};
  if (store.settings().translate === false) return res.json({ text, translated: false });
  res.json(await translator.translate(String(text), from || 'autodetect'));
}));

// ---------- Descargas en la computadora ----------
app.get('/api/downloads', (req, res) => res.json(downloads.status()));
app.post('/api/downloads', wrap(async (req, res) => {
  const { source, seriesId, chapterIds = [] } = req.body || {};
  if (!source || !seriesId || !chapterIds.length) throw new HttpError(400, 'Faltan datos');
  res.json({ added: await downloads.enqueue(source, seriesId, chapterIds) });
}));
app.post('/api/downloads/cancel', (req, res) => res.json({ ok: downloads.cancel(req.body?.key) }));
app.post('/api/downloads/retry', (req, res) => res.json({ ok: downloads.retry(req.body?.key) }));
app.delete('/api/downloads/:src/:cid', wrap(async (req, res) => res.json({ ok: await downloads.remove(req.params.src, req.params.cid) })));
app.delete('/api/downloads-series/:src/:sid', wrap(async (req, res) => { await downloads.removeSeries(req.params.src, req.params.sid); res.json({ ok: true }); }));
app.get('/api/dl/page/:src/:cid/:n', wrap(async (req, res) => sendImage(res, await downloads.pageImage(req.params.src, req.params.cid, Number(req.params.n)))));

// Exportar como archivo: un capítulo (CBZ o el archivo original) o la colección completa (ZIP).
const attach = (res, name) => res.set('Content-Disposition', `attachment; filename="${name.replace(/[^\w.\- ]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`);
app.get('/api/dl/file/:src/:cid', wrap(async (req, res) => {
  const { src: sid, cid } = req.params;
  if (sid === 'local') {
    const f = await local.originalFile(cid);
    attach(res, f.name);
    if (f.kind === 'folder') return zipStream(res, f.files);
    return res.sendFile(f.abs);
  }
  const d = downloads.get(sid, cid);
  if (!d) throw new HttpError(404, 'Primero descarga este capítulo en la computadora');
  attach(res, `${d.seriesTitle} - ${d.label}.cbz`);
  res.type('application/vnd.comicbook+zip').sendFile(d.abs);
}));
app.get('/api/dl/series/:src/:sid', wrap(async (req, res) => {
  const { src: srcId, sid } = req.params;
  let files, title;
  if (srcId === 'local') {
    const s = await local.series(sid);
    title = s.title;
    files = [];
    for (const c of await local.chapters(sid)) {
      const f = await local.originalFile(c.id);
      if (f.kind === 'folder') f.files.forEach(x => files.push({ abs: x.abs, name: `${f.name.replace(/\.cbz$/, '')}/${x.name}` }));
      else files.push({ abs: f.abs, name: f.name });
    }
  } else {
    const st = downloads.status().series.find(g => g.source === srcId && g.seriesId === sid);
    if (!st) throw new HttpError(404, 'No hay capítulos descargados de esta serie');
    title = st.seriesTitle;
    files = st.chapters.map(c => { const d = downloads.get(srcId, c.chapterId); return d && { abs: d.abs, name: path.basename(d.abs) }; }).filter(Boolean);
  }
  attach(res, `${title}.zip`);
  zipStream(res, files);
}));
function zipStream(res, files) {
  res.type('application/zip');
  const zip = new ZipArchive({ store: true });
  zip.on('error', () => res.destroy());
  zip.pipe(res);
  for (const f of files) zip.file(f.abs, { name: f.name });
  zip.finalize();
}

// ---------- Proxy de imágenes de MangaDex (con caché en disco) ----------
app.get('/api/img', wrap(async (req, res) => {
  const u = String(req.query.u || '');
  let url; try { url = new URL(u); } catch { throw new HttpError(400, 'URL inválida'); }
  const allowed = config.mangadexImageHosts.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
  if (!allowed) throw new HttpError(403, 'Host no permitido');
  // Las URLs de MangaDex@Home llevan un token temporal: la clave de caché usa solo /data/<hash>/<archivo>.
  const stable = (u.match(/\/(data|data-saver)\/[^?]+/) || [u])[0];
  const key = crypto.createHash('sha1').update(stable).digest('hex');
  const file = path.join(imgCacheDir, key.slice(0, 2), key);
  try {
    const data = await fsp.readFile(file);
    const type = (await fsp.readFile(file + '.type', 'utf8').catch(() => 'image/jpeg'));
    res.set('Content-Type', type).set('Cache-Control', 'public, max-age=604800').send(data);
    return;
  } catch {}
  const t0 = Date.now();
  let r;
  try {
    r = await fetch(u, { headers: { 'User-Agent': 'LectorPersonal/1.0' }, signal: AbortSignal.timeout(20000) });
  } catch {
    mangadex.report(u, false, 0, Date.now() - t0);
    throw new HttpError(502, 'No se pudo descargar la imagen');
  }
  if (!r.ok) { mangadex.report(u, false, 0, Date.now() - t0); throw new HttpError(502, `Imagen: ${r.status}`); }
  const buf = Buffer.from(await r.arrayBuffer());
  mangadex.report(u, true, buf.length, Date.now() - t0);
  const type = r.headers.get('content-type') || 'image/jpeg';
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, buf); await fsp.writeFile(file + '.type', type);
  res.set('Content-Type', type).set('Cache-Control', 'public, max-age=604800').send(buf);
}));

// ---------- Proxy de imágenes de ComicBooks (extraídas de CBZ) ----------
app.get('/api/comicbooks/page/:comicId/:index', wrap(async (req, res) => {
  const { comicId, index } = req.params;
  const extractPath = path.join(CACHE_DIR, comicId);
  
  try {
    const files = (await fsp.readdir(extractPath))
      .filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f))
      .sort();
    
    const file = files[Number(index)];
    if (!file) throw new HttpError(404, 'Página no encontrada');
    
    const filePath = path.join(extractPath, file);
    const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
    res.set('Content-Type', `image/${ext}`).set('Cache-Control', 'public, max-age=86400');
    res.sendFile(filePath);
  } catch (e) {
    throw new HttpError(404, 'Imagen no disponible');
  }
}));

// ---------- Archivos locales ----------
const sendImage = (res, img) => {
  const ext = path.extname(img.name).slice(1).toLowerCase().replace('jpg', 'jpeg');
  res.set('Content-Type', `image/${ext || 'jpeg'}`).set('Cache-Control', 'public, max-age=86400').send(img.data);
};
app.get('/api/local/page/:cid/:n', wrap(async (req, res) => sendImage(res, await local.pageImage(req.params.cid, Number(req.params.n)))));
app.get('/api/local/cover/:sid', wrap(async (req, res) => {
  const img = await local.coverImage(req.params.sid);
  if (!img) return res.redirect('/icon-512.png');
  sendImage(res, img);
}));
app.get('/api/local/raw/:cid', wrap(async (req, res) => {
  const f = await local.rawFile(req.params.cid);
  res.type(f.type).sendFile(f.abs);
}));
app.post('/api/local/rescan', wrap(async (req, res) => res.json({ series: await local.rescan() })));

// ---------- Biblioteca ----------
app.get('/api/library', (req, res) => {
  const items = Object.values(store.db.library).sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
  // contar capítulos sin leer guardados en la entrada
  res.json(items);
});
app.post('/api/library', (req, res) => {
  const s = req.body || {};
  if (!s.source || !s.id) throw new HttpError(400, 'Faltan datos');
  const key = `${s.source}:${s.id}`;
  store.db.library[key] = {
    ...store.db.library[key],
    source: s.source, id: s.id, title: s.title, cover: s.cover, type: s.type,
    readingDir: s.readingDir, category: s.category || store.db.library[key]?.category || 'General',
    addedAt: store.db.library[key]?.addedAt || Date.now(),
  };
  store.save(); res.json(store.db.library[key]);
});
app.delete('/api/library/:src/:id', (req, res) => {
  delete store.db.library[`${req.params.src}:${req.params.id}`]; store.save(); res.json({ ok: true });
});

// ---------- Progreso e historial ----------
app.put('/api/progress', (req, res) => {
  const { source, seriesId, chapterId, page = 0, total = 0, cfi, seriesTitle, cover, chapterLabel, type } = req.body || {};
  if (!source || !chapterId) throw new HttpError(400, 'Faltan datos');
  const key = `${source}:${chapterId}`;
  const done = total > 0 && page >= total - 1;
  const prev = store.db.progress[key];
  store.db.progress[key] = { seriesId, page, total, cfi, done: done || prev?.done || false, updatedAt: Date.now() };
  const h = store.db.history.filter(x => !(x.source === source && x.seriesId === seriesId));
  h.unshift({ source, seriesId, seriesTitle, cover, chapterId, chapterLabel, page, total, type, at: Date.now() });
  store.db.history = h.slice(0, 200);
  const lib = store.db.library[`${source}:${seriesId}`];
  if (lib) lib.lastReadAt = Date.now();
  store.save(); res.json(store.db.progress[key]);
});
app.post('/api/progress/mark', (req, res) => {
  // marcar capítulos como leídos / no leídos
  const { source, seriesId, chapterIds = [], done = true } = req.body || {};
  for (const id of chapterIds) {
    const key = `${source}:${id}`;
    if (done) store.db.progress[key] = { ...(store.db.progress[key] || {}), seriesId, done: true, updatedAt: Date.now() };
    else delete store.db.progress[key];
  }
  store.save(); res.json({ ok: true });
});
app.get('/api/history', (req, res) => res.json(store.db.history));
app.delete('/api/history', (req, res) => { store.db.history = []; store.save(); res.json({ ok: true }); });

// ---------- Novedades de la biblioteca ----------
app.get('/api/updates', wrap(async (req, res) => {
  const lib = Object.values(store.db.library).filter(s => s.source === 'mangadex');
  if (!lib.length) return res.json([]);
  const byId = Object.fromEntries(lib.map(s => [s.id, s]));
  const list = await mangadex.updates(lib.map(s => s.id));
  res.json(list.filter(u => byId[u.seriesId]).map(u => ({
    ...u, source: 'mangadex', seriesTitle: byId[u.seriesId].title, cover: byId[u.seriesId].cover,
    read: !!store.db.progress[`mangadex:${u.chapterId}`]?.done,
  })));
}));

// ---------- Ajustes ----------
app.get('/api/settings', (req, res) => res.json({ ...store.settings(), libraryDir: path.resolve(config.libraryDir) }));
app.put('/api/settings', (req, res) => {
  const allowed = ['languages', 'contentRating', 'dataSaver', 'readerMode', 'doublePage', 'background', 'theme', 'profile', 'translate', 'translateEmail'];
  for (const k of allowed) if (k in (req.body || {})) store.db.settings[k] = req.body[k];
  store.save(); res.json(store.settings());
});
app.delete('/api/cache', wrap(async (req, res) => {
  await fsp.rm(imgCacheDir, { recursive: true, force: true }); await fsp.mkdir(imgCacheDir, { recursive: true });
  res.json({ ok: true });
}));

// ---------- Archivos de la interfaz ----------
const vendor = (route, file) => app.get(route, (req, res) => res.sendFile(path.join(__dirname, 'node_modules', file)));
vendor('/vendor/pdf.mjs', 'pdfjs-dist/build/pdf.min.mjs');
vendor('/vendor/pdf.worker.mjs', 'pdfjs-dist/build/pdf.worker.min.mjs');
vendor('/vendor/epub.js', 'epubjs/dist/epub.min.js');
vendor('/vendor/jszip.js', 'jszip/dist/jszip.min.js');
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || 'Error interno' });
});

// Limpieza de la caché de imágenes cuando supera el límite (cada hora).
async function pruneCache() {
  const files = [];
  for (const d of await fsp.readdir(imgCacheDir).catch(() => [])) {
    for (const f of await fsp.readdir(path.join(imgCacheDir, d)).catch(() => [])) {
      if (f.endsWith('.type')) continue;
      const p = path.join(imgCacheDir, d, f);
      const st = await fsp.stat(p).catch(() => null);
      if (st) files.push({ p, size: st.size, t: st.atimeMs });
    }
  }
  let total = files.reduce((a, f) => a + f.size, 0);
  const max = config.imageCacheMB * 1024 * 1024;
  for (const f of files.sort((a, b) => a.t - b.t)) {
    if (total <= max) break;
    await fsp.rm(f.p, { force: true }); await fsp.rm(f.p + '.type', { force: true });
    total -= f.size;
  }
}
setInterval(pruneCache, 3600_000).unref();

process.on('SIGINT', () => { store.flush(); process.exit(0); });
process.on('SIGTERM', () => { store.flush(); process.exit(0); });

app.listen(config.port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  console.log(`\n📚 Lector listo`);
  console.log(`   En esta PC:      http://localhost:${config.port}`);
  ips.forEach(ip => console.log(`   En tu celular:   http://${ip}:${config.port}`));
  console.log(`   Carpeta local:   ${path.resolve(config.libraryDir)}\n`);
});
