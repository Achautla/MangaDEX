// "Servidor" dentro del APK: atiende las mismas rutas /api/* que server.js, pero todo ocurre en el teléfono.
//  - MangaDex: HTTP nativo (sin CORS).
//  - Biblioteca, progreso, historial y ajustes: localStorage.
//  - "Mis archivos": CBZ/CBR/PDF/EPUB importados, guardados en IndexedDB.
import { createMangaDex } from '../shared/sources/mangadex.js';
import { createArchive } from '../shared/sources/archive.js';
import { createLibres } from '../shared/sources/peppercarrot.js';
import { createCbplus } from '../shared/sources/cbplus.js';
import { createTranslator } from '../shared/translate.js';
import { createOpds } from '../shared/sources/opds.js';
import { createMangaPlus, decryptImage } from '../shared/sources/mangaplus.js';
import { nativeFetch } from '../platform.js';

const DL_CACHE = 'lector-descargas';
const IMG_CACHE = 'lector-imagenes';
const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;
const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---------- Datos (localStorage) ----------
const DEFAULT_SETTINGS = {
  languages: ['es', 'es-la'], contentRating: ['safe', 'suggestive'], dataSaver: false,
  readerMode: { manga: 'rtl', manhwa: 'webtoon', manhua: 'webtoon', 'cómic': 'ltr', libro: 'ltr' },
  doublePage: false, background: 'theme', theme: 'light', profile: null,
};
let db;
try { db = JSON.parse(localStorage.getItem('db') || '{}'); } catch { db = {}; }
db = { library: {}, progress: {}, history: [], ...db, settings: { ...DEFAULT_SETTINGS, ...(db.settings || {}) } };
let saveTimer;
const save = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => localStorage.setItem('db', JSON.stringify(db)), 250); };
addEventListener('pagehide', () => localStorage.setItem('db', JSON.stringify(db)));
document.addEventListener('visibilitychange', () => { if (document.hidden) localStorage.setItem('db', JSON.stringify(db)); });

// ---------- MangaDex ----------
const mdConfig = {
  mangadexApi: window.MANGADEX_API || 'https://api.mangadex.org',
  mangadexUploads: window.MANGADEX_UPLOADS || 'https://uploads.mangadex.org',
  mangadexReport: false,
  fetch: (url, opts = {}) => nativeFetch(url, { headers: opts.headers, responseType: 'json' }),
};
const mangadex = createMangaDex(mdConfig, () => db.settings);
const archive = createArchive({ fetch: (url, opts = {}) => nativeFetch(url, { headers: opts.headers, responseType: 'json', timeout: 60000 }), archiveBase: window.ARCHIVE_BASE, iiifBase: window.IIIF_BASE });

// ---------- IndexedDB para archivos importados ----------
let idbP = null;
function idb() {
  idbP ||= new Promise((ok, fail) => {
    const r = indexedDB.open('lector-archivos', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files', { keyPath: 'id' });
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
  return idbP;
}
async function tx(mode, fn) {
  const d = await idb();
  return new Promise((ok, fail) => {
    const t = d.transaction('files', mode);
    const store = t.objectStore('files');
    let out;
    Promise.resolve(fn(store)).then(v => { out = v; });
    t.oncomplete = () => ok(out);
    t.onerror = () => fail(t.error);
  });
}
const req = r => new Promise((ok, fail) => { r.onsuccess = () => ok(r.result); r.onerror = () => fail(r.error); });
const allFiles = () => tx('readonly', s => req(s.getAll()));
const getFile = id => tx('readonly', s => req(s.get(id)));

// ---------- Fuente local (archivos importados) ----------
const slug = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'serie';
const kindOf = name => {
  const ext = name.split('.').pop().toLowerCase();
  return ext === 'pdf' ? 'pdf' : ext === 'epub' ? 'epub' : (ext === 'cbr' || ext === 'rar') ? 'rar' : 'zip';
};
const chapterNumber = name => {
  const m = name.match(/(?:cap(?:[ií]tulo)?|ch(?:apter)?|c|#|vol(?:umen)?|v|tomo)[\s._-]*(\d+(?:\.\d+)?)/i) || name.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
  return m ? m[1] : null;
};
const guessSeries = name => name.replace(/\.[^.]+$/, '')
  .replace(/(?:[\s._-]+|^)(?:-\s*)?(?:cap(?:[ií]tulo)?|ch(?:apter)?|vol(?:umen)?|tomo|v|c|#)\.?[\s._-]*\d+(?:\.\d+)?.*$/i, '')
  .replace(/[\s._-]+\d+(?:\.\d+)?$/, '').trim() || name.replace(/\.[^.]+$/, '');

let unrarMod = null;
async function rarExtract(blob, names = null) {
  unrarMod ||= Promise.all([import('/vendor/unrar.mjs'), fetch('/vendor/unrar.wasm').then(r => r.arrayBuffer())]);
  const [mod, wasm] = await unrarMod;
  const data = await blob.arrayBuffer();
  const list = [...(await mod.createExtractorFromData({ wasmBinary: wasm, data })).getFileList().fileHeaders]
    .filter(h => !h.flags.directory).map(h => h.name);
  const want = names ? list.filter(n => names(n)) : list;
  const ex = await mod.createExtractorFromData({ wasmBinary: wasm, data });
  const files = new Map();
  for (const f of ex.extract({ files: want }).files) files.set(f.fileHeader.name, f.extraction);
  return { list, files };
}
async function readComicInfo(blob, kind) {
  let xml = null;
  try {
    if (kind === 'zip') {
      const zip = await window.JSZip.loadAsync(blob);
      const f = Object.values(zip.files).find(f => /(^|\/)comicinfo\.xml$/i.test(f.name));
      if (f) xml = await f.async('string');
    } else if (kind === 'rar') {
      const { files } = await rarExtract(blob, n => /(^|\/)comicinfo\.xml$/i.test(n));
      const first = [...files.values()][0];
      if (first) xml = new TextDecoder().decode(first);
    }
  } catch { return null; }
  if (!xml) return null;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const get = t => doc.getElementsByTagName(t)[0]?.textContent?.trim() || '';
  return { Series: get('Series'), Summary: get('Summary'), Genre: get('Genre'), Writer: get('Writer'), Penciller: get('Penciller'), Manga: get('Manga'), Format: get('Format'), Number: get('Number'), LanguageISO: get('LanguageISO') };
}

export async function importFiles(fileList, onProgress) {
  let n = 0;
  for (const file of fileList) {
    if (!/\.(cbz|zip|cbr|rar|pdf|epub)$/i.test(file.name)) continue;
    const kind = kindOf(file.name);
    const info = await readComicInfo(file, kind);
    const seriesTitle = info?.Series || guessSeries(file.name);
    const rec = {
      id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
      name: file.name, kind, blob: file, size: file.size, addedAt: Date.now(),
      seriesId: slug(seriesTitle), seriesTitle,
      number: info?.Number || chapterNumber(file.name),
      lang: (info?.LanguageISO || '').toLowerCase() || null,
      summary: info?.Summary || '', genres: (info?.Genre || '').split(/[,;]/).map(x => x.trim()).filter(Boolean),
      authors: (info?.Writer || '').split(',').map(x => x.trim()).filter(Boolean),
      type: kind === 'epub' ? 'libro' : /webtoon|long strip/i.test(info?.Format || '') ? 'manhwa' : /yes/i.test(info?.Manga || '') ? 'manga' : 'cómic',
    };
    await tx('readwrite', s => req(s.put(rec)));
    n++; onProgress?.(n);
  }
  return n;
}
export async function removeLocalSeries(sid) {
  const files = (await allFiles()).filter(f => f.seriesId === sid);
  await tx('readwrite', s => Promise.all(files.map(f => req(s.delete(f.id)))));
}

const localSeries = async () => {
  const groups = new Map();
  for (const f of await allFiles()) {
    const g = groups.get(f.seriesId) || { files: [], f };
    g.files.push(f); groups.set(f.seriesId, g);
  }
  return [...groups.values()].map(({ files, f }) => {
    files.sort((a, b) => collator.compare(a.name, b.name));
    const genres = [...new Set(files.flatMap(x => x.genres))];
    return {
      source: 'local', id: f.seriesId, title: f.seriesTitle, altTitles: [], description: files.find(x => x.summary)?.summary || '',
      cover: files.some(x => x.kind === 'zip' || x.kind === 'rar') ? `/api/local/cover/${encodeURIComponent(f.seriesId)}` : '/icon-512.png',
      authors: [...new Set(files.flatMap(x => x.authors))], artists: [], status: null,
      type: files.every(x => x.kind === 'epub') ? 'libro' : files.find(x => x.type !== 'cómic')?.type || 'cómic',
      demographic: null, genres: genres.map(g => ({ id: g, name: g })), contentRating: 'safe', year: null,
      languages: [...new Set(files.map(x => x.lang).filter(Boolean))], descriptionLang: null,
      readingDir: files.some(x => x.type === 'manga') ? 'rtl' : files.some(x => x.type === 'manhwa') ? 'webtoon' : 'ltr',
      chapters: files.map(x => ({ id: x.id, kind: x.kind, number: x.number, volume: null, title: x.name.replace(/\.[^.]+$/, ''), lang: x.lang || null, group: 'Archivo importado', date: x.addedAt, pages: null })),
      addedAt: Math.max(...files.map(x => x.addedAt)),
    };
  }).sort((a, b) => collator.compare(a.title, b.title));
};
const strip = ({ chapters, addedAt, ...s }) => ({ ...s, chapterCount: chapters.length });
const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const local = {
  id: 'local', name: 'Mis archivos', description: 'Archivos importados en este teléfono', capabilities: { popular: true, latest: true, search: true, filters: true },
  async list({ mode, page = 1, q = '', filters = {} }) {
    let items = await localSeries();
    if (q) items = items.filter(s => norm(s.title).includes(norm(q)));
    if (filters.include?.length) items = items.filter(s => filters.include.every(g => s.genres.some(x => x.id === g)));
    if (filters.exclude?.length) items = items.filter(s => !filters.exclude.some(g => s.genres.some(x => x.id === g)));
    if (filters.type?.length) items = items.filter(s => filters.type.includes(s.type));
    if (mode === 'latest') items.sort((a, b) => b.addedAt - a.addedAt);
    const per = 60;
    return { items: items.slice((page - 1) * per, page * per).map(strip), hasMore: items.length > page * per };
  },
  async getFilters() {
    const genres = new Set((await localSeries()).flatMap(s => s.genres.map(g => g.name)));
    return {
      tags: { 'Géneros': [...genres].sort((a, b) => a.localeCompare(b, 'es')).map(g => ({ id: g, name: g })) },
      type: [['manga', 'Manga'], ['manhwa', 'Manhwa / webtoon'], ['cómic', 'Cómic'], ['libro', 'Libro (EPUB)']],
    };
  },
  async series(id) {
    const s = (await localSeries()).find(x => x.id === id);
    if (!s) throw new HttpError(404, 'Serie no encontrada');
    return strip(s);
  },
  async chapters(id) {
    const s = (await localSeries()).find(x => x.id === id);
    if (!s) throw new HttpError(404, 'Serie no encontrada');
    return [...s.chapters].reverse();
  },
  async pages(cid) {
    const f = await getFile(cid);
    if (!f) throw new HttpError(404, 'Archivo no encontrado');
    if (f.kind === 'pdf' || f.kind === 'epub') return { kind: f.kind, url: `/api/local/raw/${cid}` };
    const arc = await openArchive(f);
    return { kind: 'images', pages: arc.names.map((_, i) => ({ url: `/api/local/page/${cid}/${i}` })) };
  },
};

const archives = new Map(); // id -> Promise<{names, read}>
function openArchive(f) {
  if (archives.has(f.id)) return archives.get(f.id);
  if (archives.size >= 3) archives.delete(archives.keys().next().value);
  const p = (async () => {
    if (f.kind === 'rar') {
      const { list, files } = await rarExtract(f.blob, n => IMAGE_RE.test(n));
      const names = list.filter(n => IMAGE_RE.test(n)).sort(collator.compare);
      return { names, read: async i => new Blob([files.get(names[i])], { type: mimeOf(names[i]) }) };
    }
    const zip = await window.JSZip.loadAsync(f.blob);
    const entries = Object.values(zip.files).filter(e => !e.dir && IMAGE_RE.test(e.name) && !/(^|\/)(__MACOSX|\.)/.test(e.name))
      .sort((a, b) => collator.compare(a.name, b.name));
    return { names: entries.map(e => e.name), read: async i => new Blob([await entries[i].async('arraybuffer')], { type: mimeOf(entries[i].name) }) };
  })();
  p.catch(() => archives.delete(f.id));
  archives.set(f.id, p);
  return p;
}
const mimeOf = n => { const e = n.split('.').pop().toLowerCase(); return e === 'jpg' ? 'image/jpeg' : `image/${e}`; };

// ---------- MANGA Plus ----------
const mangaplus = createMangaPlus({
  api: window.MANGAPLUS_API || undefined,
  getSettings: () => db.settings,
  fetchBytes: async (url, headers) => {
    const r = await nativeFetch(url, { headers, responseType: 'blob' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return new Uint8Array(await (await r.blob()).arrayBuffer());
  },
});

const libres = createLibres({ fetch: (url, opts = {}) => nativeFetch(url, { headers: opts.headers, responseType: 'json' }), base: window.PEPPER_BASE || undefined, getSettings: () => db.settings });
const cbplus = createCbplus({ base: window.CBPLUS_BASE || undefined, fetchText: async (url, headers) => {
  const r = await nativeFetch(url, { headers, responseType: 'text', timeout: 30000 });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
} });
const sources = { mangadex, mangaplus, archive, cbplus, libres, local };

// ---------- Catálogos OPDS ----------
const opdsFetch = (url, opts = {}) => nativeFetch(url, { headers: opts.headers, responseType: 'text' });
const opdsBlobs = new Map(); // url -> Promise<Blob>
function opdsBlob(cat, url) {
  if (opdsBlobs.has(url)) return opdsBlobs.get(url);
  if (opdsBlobs.size >= 3) opdsBlobs.delete(opdsBlobs.keys().next().value);
  const p = (async () => {
    const r = await nativeFetch(url, { headers: cat.authHeaders, responseType: 'blob', timeout: 120000 });
    if (!r.ok) throw new HttpError(502, `El catálogo respondió ${r.status}`);
    return r.blob();
  })();
  p.catch(() => opdsBlobs.delete(url));
  opdsBlobs.set(url, p);
  return p;
}
async function opdsArchive(cat, url, fmt) {
  return openArchive({ id: 'opds:' + url, kind: fmt, blob: await opdsBlob(cat, url) });
}
let opdsKey = '';
function syncOpds() {
  const cats = db.settings.opdsCatalogs || [];
  const k = JSON.stringify(cats);
  if (k === opdsKey) return;
  opdsKey = k;
  for (const id of Object.keys(sources)) if (id.startsWith('opds-')) delete sources[id];
  for (const c of cats) {
    if (!c?.id || !c.url) continue;
    const s = createOpds({ catalog: c, fetch: opdsFetch, openRemote: async (sid, url, fmt) => (await opdsArchive(sources[sid], url, fmt)).names.length });
    s.authHeaders = c.user ? { Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(`${c.user}:${c.pass || ''}`))) } : {};
    sources[c.id] = s;
  }
}
syncOpds();

// Traducciones guardadas en el teléfono
let tcache; try { tcache = JSON.parse(localStorage.getItem('translations') || '{}'); } catch { tcache = {}; }
const translator = createTranslator({
  base: window.TRANSLATE_API || undefined,
  fetch: (url, opts = {}) => nativeFetch(url, { headers: opts.headers, responseType: 'json' }),
  email: () => db.settings.translateEmail || '',
  cache: {
    get: k => tcache[k],
    set: (k, v) => {
      tcache[k] = v;
      const keys = Object.keys(tcache); if (keys.length > 1500) keys.slice(0, keys.length - 1500).forEach(x => delete tcache[x]);
      try { localStorage.setItem('translations', JSON.stringify(tcache)); } catch {}
    },
  },
});
const src = id => { syncOpds(); const s = sources[id]; if (!s) throw new HttpError(404, 'Fuente desconocida'); return s; };

// ---------- Copias para leer sin conexión ----------
async function fromDeviceCache(url) {
  try { return await (await caches.open(DL_CACHE)).match(url); } catch { return null; }
}
async function jsonFromDevice(url) {
  const r = await fromDeviceCache(url);
  return r ? r.json() : null;
}

// ---------- Rutas ----------
export async function handleApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body || {};
  const [p, qs = ''] = path.split('?');
  const q = new URLSearchParams(qs);
  const parts = p.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // sin "api"
  const key = (a, b) => `${a}:${b}`;
  try {
    switch (parts[0]) {
      case 'settings':
        if (method === 'PUT') {
          for (const k of ['languages', 'contentRating', 'dataSaver', 'readerMode', 'doublePage', 'background', 'theme', 'profile', 'translate', 'translateEmail', 'opdsCatalogs']) if (k in body) db.settings[k] = body[k];
          save();
        }
        return { ...db.settings, libraryDir: null, standalone: true };
      case 'translate':
        if (db.settings.translate === false) return { text: body.text || '', translated: false };
        return translator.translate(String(body.text || ''), body.from || 'autodetect');
      case 'sources':
        syncOpds();
        return Object.values(sources).map(({ id, name, description, capabilities }) => ({ id, name, description, capabilities }));
      case 's': {
        const [, sid, what, id, sub] = parts;
        if (what === 'filters') return src(sid).getFilters();
        if (what === 'list') return src(sid).list({ mode: q.get('mode') || 'popular', page: Number(q.get('page')) || 1, q: (q.get('q') || '').trim(), filters: JSON.parse(q.get('filters') || '{}') });
        if (what === 'series' && !sub) {
          let s;
          try { s = await src(sid).series(id); } catch (e) { s = await jsonFromDevice(path); if (!s) throw e; s.offline = true; }
          return { ...s, inLibrary: !!db.library[key(sid, id)] };
        }
        if (what === 'series' && sub === 'chapters') {
          let list;
          try { list = await src(sid).chapters(id); }
          catch (e) {
            // sin internet: solo los capítulos guardados en el teléfono
            list = await jsonFromDevice(path); if (!list) throw e;
            const saved = await Promise.all(list.map(c => fromDeviceCache(`/api/s/${sid}/chapters/${encodeURIComponent(c.id)}/pages`)));
            list = list.filter((_, i) => saved[i]);
          }
          return list.map(c => ({ ...c, progress: db.progress[key(sid, c.id)] || null, downloaded: false }));
        }
        if (what === 'chapters' && sub === 'pages') {
          if (q.get('refresh') !== '1') { const saved = await jsonFromDevice(p); if (saved) return saved; }
          return src(sid).pages(id, { refresh: q.get('refresh') === '1' });
        }
        break;
      }
      case 'library':
        if (method === 'GET') return Object.values(db.library).sort((a, b) => (b.lastReadAt || b.addedAt) - (a.lastReadAt || a.addedAt));
        if (method === 'POST') {
          const k = key(body.source, body.id);
          db.library[k] = { ...db.library[k], source: body.source, id: body.id, title: body.title, cover: body.cover, type: body.type, readingDir: body.readingDir, languages: body.languages || db.library[k]?.languages,
            category: body.category || db.library[k]?.category || 'General', addedAt: db.library[k]?.addedAt || Date.now() };
          save(); return db.library[k];
        }
        if (method === 'DELETE') { delete db.library[key(parts[1], parts[2])]; save(); return { ok: true }; }
        break;
      case 'progress':
        if (parts[1] === 'mark') {
          for (const id of body.chapterIds || []) {
            const k = key(body.source, id);
            if (body.done !== false) db.progress[k] = { ...(db.progress[k] || {}), seriesId: body.seriesId, done: true, updatedAt: Date.now() };
            else delete db.progress[k];
          }
          save(); return { ok: true };
        } else {
          const { source, seriesId, chapterId, page = 0, total = 0, cfi, seriesTitle, cover, chapterLabel, type } = body;
          const k = key(source, chapterId);
          const prev = db.progress[k];
          db.progress[k] = { seriesId, page, total, cfi, done: (total > 0 && page >= total - 1) || prev?.done || false, updatedAt: Date.now() };
          db.history = [{ source, seriesId, seriesTitle, cover, chapterId, chapterLabel, page, total, type, at: Date.now() },
            ...db.history.filter(x => !(x.source === source && x.seriesId === seriesId))].slice(0, 200);
          const lib = db.library[key(source, seriesId)]; if (lib) lib.lastReadAt = Date.now();
          save(); return db.progress[k];
        }
      case 'history':
        if (method === 'DELETE') { db.history = []; save(); return { ok: true }; }
        return db.history;
      case 'updates': {
        const lib = Object.values(db.library).filter(s => s.source === 'mangadex');
        if (!lib.length) return [];
        const byId = Object.fromEntries(lib.map(s => [s.id, s]));
        const list = await mangadex.updates(lib.map(s => s.id));
        return list.filter(u => byId[u.seriesId]).map(u => ({ ...u, source: 'mangadex', seriesTitle: byId[u.seriesId].title, cover: byId[u.seriesId].cover, read: !!db.progress[`mangadex:${u.chapterId}`]?.done }));
      }
      case 'downloads':
        return { queue: [], series: [], standalone: true };
      case 'local':
        if (parts[1] === 'rescan') return { series: (await localSeries()).length };
        break;
      case 'cache':
        await caches.delete(IMG_CACHE); return { ok: true };
    }
    throw new HttpError(404, 'Ruta no encontrada');
  } catch (e) {
    // Sin internet: el mismo mensaje que el modo servidor
    if (!e.status && !navigator.onLine) throw new Error('Sin conexión a internet. Solo puedes leer lo guardado en este teléfono.');
    throw e;
  }
}

// ---------- Imágenes y archivos ----------
export async function blobFor(url, { skipDevice = false } = {}) {
  if (!skipDevice) { const saved = await fromDeviceCache(url); if (saved) return saved.blob(); }
  const [p, qs = ''] = url.split('?');
  const parts = p.split('/').filter(Boolean).slice(1).map(decodeURIComponent);
  if (parts[0] === 'img') {
    const remote = new URLSearchParams(qs).get('u');
    const isCover = /\/covers\/|\/services\/img\//.test(remote);
    const cache = isCover ? await caches.open(IMG_CACHE).catch(() => null) : null;
    const hit = cache && await cache.match(url);
    if (hit) return hit.blob();
    const fb = new URLSearchParams(qs).get('f');
    const timeout = /\.pdf($|\?)/i.test(remote) ? 180000 : 45000;
    let r = await nativeFetch(remote, { responseType: 'blob', timeout }).catch(e => { if (!fb) throw e; return null; });
    // Plan B (Internet Archive): si el tamaño pedido falla, se pide la imagen original
    if ((!r || !r.ok) && fb) r = await nativeFetch(fb, { responseType: 'blob', timeout });
    if (!r.ok && !isCover) throw new HttpError(r.status, `Imagen: ${r.status}`);
    const blob = await r.blob();
    if (cache && r.ok) cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type } })).catch(() => {});
    return blob;
  }
  if (parts[0] === 'mplus' && parts[1] === 'img') {
    const qp = new URLSearchParams(qs), k = qp.get('k') || '';
    const cache = !k ? await caches.open(IMG_CACHE).catch(() => null) : null;
    const hit = cache && await cache.match(url);
    if (hit) return hit.blob();
    const r = await nativeFetch(qp.get('u'), { responseType: 'blob', timeout: 30000, headers: { Referer: 'https://mangaplus.shueisha.co.jp/' } });
    if (!r.ok) throw new HttpError(r.status, `Imagen: ${r.status}`);
    let blob = await r.blob();
    if (k) blob = new Blob([decryptImage(new Uint8Array(await blob.arrayBuffer()), k)], { type: 'image/jpeg' });
    if (cache) cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type } })).catch(() => {});
    return blob;
  }
  if (parts[0] === 'opds' && parts[1] === 'res') {
    const qp = new URLSearchParams(qs);
    const cat = src(qp.get('c')), u = qp.get('u'), k = qp.get('k');
    if (k === 'arc') { const arc = await opdsArchive(cat, u, qp.get('f') === 'rar' ? 'rar' : 'zip'); return arc.read(Number(qp.get('i')) || 0); }
    if (k === 'file') { const b = await opdsBlob(cat, u); return /epub/i.test(u) || /epub/.test(b.type) ? new Blob([b], { type: 'application/epub+zip' }) : new Blob([b], { type: 'application/pdf' }); }
    const cache = await caches.open(IMG_CACHE).catch(() => null);
    const hit = cache && await cache.match(url);
    if (hit) return hit.blob();
    const r = await nativeFetch(u, { responseType: 'blob', timeout: 30000, headers: cat.authHeaders });
    if (!r.ok) throw new HttpError(r.status, `Imagen: ${r.status}`);
    const blob = await r.blob();
    if (cache) cache.put(url, new Response(blob, { headers: { 'Content-Type': blob.type } })).catch(() => {});
    return blob;
  }
  if (parts[0] === 'local') {
    if (parts[1] === 'raw') { const f = await getFile(parts[2]); if (!f) throw new HttpError(404, 'Archivo no encontrado'); return f.blob; }
    if (parts[1] === 'page') { const f = await getFile(parts[2]); const arc = await openArchive(f); return arc.read(Number(parts[3])); }
    if (parts[1] === 'cover') {
      const s = (await localSeries()).find(x => x.id === parts[2]);
      const c = s?.chapters.find(c => c.kind === 'zip' || c.kind === 'rar');
      if (!c) return (await fetch('/icon-512.png')).blob();
      const arc = await openArchive(await getFile(c.id)); return arc.read(0);
    }
  }
  throw new HttpError(404, 'Recurso no encontrado');
}

// Construye un CBZ (para exportar) a partir de las páginas guardadas o en línea.
export async function buildCbz(source, chapterId, label, onProgress) {
  const info = await handleApi(`/api/s/${source}/chapters/${encodeURIComponent(chapterId)}/pages`);
  if (info.kind !== 'images') {
    const blob = await blobFor(info.url);
    return { blob, ext: info.kind };
  }
  const zip = new window.JSZip();
  let i = 0;
  for (const pg of info.pages) {
    const b = await blobFor(pg.url);
    const ext = (b.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    zip.file(`${String(++i).padStart(3, '0')}.${ext}`, b);
    onProgress?.(i, info.pages.length);
  }
  return { blob: await zip.generateAsync({ type: 'blob', compression: 'STORE', mimeType: 'application/vnd.comicbook+zip' }), ext: 'cbz' };
}
