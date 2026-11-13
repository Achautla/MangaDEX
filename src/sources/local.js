// Fuente local: lee tu carpeta de cómics/manga.
// Estructura esperada: BIBLIOTECA/<Serie>/<capítulo>.cbz|cbr|zip|pdf|epub  (o carpetas de imágenes)
// Un archivo suelto en la raíz se trata como una serie de un solo tomo.
import fs from 'node:fs/promises';
import path from 'node:path';
import { naturalCompare, IMAGE_RE, b64url, HttpError } from '../util.js';
import { openArchive, readComicInfo } from '../archive.js';

const BOOK_RE = /\.(cbz|zip|cbr|rar|pdf|epub)$/i;

export function createLocal(config) {
  const root = path.resolve(config.libraryDir);
  let index = null; // { series: Map<id, {...}> }
  let scanning = null;

  const safe = rel => {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new HttpError(400, 'Ruta no válida');
    return abs;
  };

  async function listDir(dir) {
    try { return await fs.readdir(dir, { withFileTypes: true }); } catch { return []; }
  }

  // Busca capítulos dentro de una carpeta de serie (recursivo, 3 niveles).
  async function findChapters(dir, depth = 0) {
    const entries = (await listDir(dir)).sort((a, b) => naturalCompare(a.name, b.name));
    const out = [];
    const imgs = entries.filter(e => e.isFile() && IMAGE_RE.test(e.name));
    if (imgs.length && depth > 0) out.push({ abs: dir, kind: 'folder' });
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isFile() && BOOK_RE.test(e.name)) out.push({ abs, kind: kindOf(e.name) });
      else if (e.isDirectory() && depth < 3) out.push(...await findChapters(abs, depth + 1));
    }
    return out;
  }

  const kindOf = name => {
    const ext = path.extname(name).toLowerCase();
    if (ext === '.pdf') return 'pdf';
    if (ext === '.epub') return 'epub';
    if (ext === '.cbr' || ext === '.rar') return 'rar';
    return 'zip';
  };

  const chapterNumber = name => {
    const m = name.match(/(?:cap(?:[ií]tulo)?|ch(?:apter)?|c|#|vol(?:umen)?|v|tomo)[\s._-]*(\d+(?:\.\d+)?)/i) || name.match(/(\d+(?:\.\d+)?)(?!.*\d)/);
    return m ? m[1] : null;
  };

  async function scan() {
    const series = new Map();
    await fs.mkdir(root, { recursive: true });
    for (const e of (await listDir(root)).sort((a, b) => naturalCompare(a.name, b.name))) {
      const abs = path.join(root, e.name);
      let chapters;
      if (e.isDirectory()) {
        chapters = await findChapters(abs, 0);
        // carpeta de imágenes directamente en la serie = un capítulo
        if (!chapters.length && (await listDir(abs)).some(x => x.isFile() && IMAGE_RE.test(x.name))) chapters = [{ abs, kind: 'folder' }];
      } else if (e.isFile() && BOOK_RE.test(e.name)) {
        chapters = [{ abs, kind: kindOf(e.name) }];
      } else continue;
      if (!chapters.length) continue;

      const rel = path.relative(root, abs);
      const id = b64url.enc(rel);
      const title = e.isDirectory() ? e.name : e.name.replace(BOOK_RE, '');
      const chs = chapters.map(c => {
        const crel = path.relative(root, c.abs);
        const label = path.relative(abs, c.abs) || path.basename(c.abs);
        return {
          id: b64url.enc(crel), kind: c.kind,
          number: chapterNumber(path.basename(c.abs)),
          volume: null,
          title: label.replace(BOOK_RE, ''),
          lang: null, group: 'Archivo local', date: null, pages: null,
        };
      });
      const s = {
        source: 'local', id, title, altTitles: [], description: '',
        cover: `/api/local/cover/${id}`,
        authors: [], artists: [], status: null, type: 'cómic', demographic: null,
        genres: [], contentRating: 'safe', year: null, readingDir: 'ltr', languages: [], descriptionLang: null,
        chapters: chs,
      };
      // Metadatos de ComicInfo.xml (del primer archivo que lo tenga)
      const first = chapters.find(c => c.kind === 'zip' || c.kind === 'rar');
      if (first) {
        try {
          const info = await readComicInfo(first.abs, first.kind);
          if (info) {
            if (info.Series) s.title = info.Series;
            s.description = info.Summary || '';
            s.genres = (info.Genre || '').split(/[,;]/).map(x => x.trim()).filter(Boolean);
            s.authors = (info.Writer || '').split(',').map(x => x.trim()).filter(Boolean);
            s.artists = (info.Penciller || '').split(',').map(x => x.trim()).filter(Boolean);
            s.year = Number(info.Year) || null;
            if (info.LanguageISO) s.languages = [info.LanguageISO.toLowerCase()];
            if (/yes/i.test(info.Manga || '')) { s.type = 'manga'; s.readingDir = 'rtl'; }
            if (info.Format && /webtoon|long strip/i.test(info.Format)) { s.type = 'manhwa'; s.readingDir = 'webtoon'; }
          }
        } catch { /* archivo dañado: se ignora el metadato */ }
      }
      if (s.languages[0]) chs.forEach(c => { c.lang = s.languages[0]; });
      if (chs.every(c => c.kind === 'epub')) s.type = 'libro';
      series.set(id, s);
    }
    index = { series, at: Date.now() };
    return index;
  }

  async function ensure() {
    if (index) return index;
    scanning ??= scan().finally(() => { scanning = null; });
    return scanning;
  }

  const strip = ({ chapters, ...s }) => ({ ...s, chapterCount: chapters.length });
  const norm = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  async function list({ mode = 'popular', page = 1, q = '', filters = {} }) {
    const all = [...(await ensure()).series.values()];
    let items = all;
    if (q) items = items.filter(s => norm(s.title).includes(norm(q)));
    if (filters.include?.length) items = items.filter(s => filters.include.every(g => s.genres.includes(g)));
    if (filters.exclude?.length) items = items.filter(s => !filters.exclude.some(g => s.genres.includes(g)));
    if (filters.type?.length) items = items.filter(s => filters.type.includes(s.type));
    if (mode === 'latest') items = [...items].reverse();
    const per = 60;
    return { items: items.slice((page - 1) * per, page * per).map(strip), hasMore: items.length > page * per };
  }

  async function getFilters() {
    const genres = new Set();
    for (const s of (await ensure()).series.values()) s.genres.forEach(g => genres.add(g));
    return {
      tags: { 'Géneros': [...genres].sort((a, b) => a.localeCompare(b, 'es')).map(g => ({ id: g, name: g })) },
      type: [['manga', 'Manga'], ['manhwa', 'Manhwa / webtoon'], ['cómic', 'Cómic'], ['libro', 'Libro (EPUB)']],
    };
  }

  async function getSeries(id) {
    const s = (await ensure()).series.get(id);
    if (!s) throw new HttpError(404, 'Serie no encontrada');
    return s;
  }

  async function chapterById(cid) {
    for (const s of (await ensure()).series.values()) {
      const c = s.chapters.find(c => c.id === cid);
      if (c) return { s, c, abs: safe(b64url.dec(cid)) };
    }
    throw new HttpError(404, 'Capítulo no encontrado');
  }

  async function pages(cid) {
    const { c, abs } = await chapterById(cid);
    if (c.kind === 'pdf' || c.kind === 'epub') return { kind: c.kind, url: `/api/local/raw/${cid}` };
    const arc = await openArchive(abs, c.kind);
    return { kind: 'images', pages: arc.names.map((_, i) => ({ url: `/api/local/page/${cid}/${i}` })) };
  }

  async function pageImage(cid, n) {
    const { c, abs } = await chapterById(cid);
    const arc = await openArchive(abs, c.kind);
    if (!(n >= 0 && n < arc.names.length)) throw new HttpError(404, 'Página fuera de rango');
    return { data: await arc.read(n), name: arc.names[n] };
  }

  async function coverImage(sid) {
    const s = await getSeries(sid);
    const c = s.chapters.find(c => c.kind !== 'pdf' && c.kind !== 'epub');
    if (!c) return null;
    return pageImage(c.id, 0);
  }

  async function rawFile(cid) {
    const { c, abs } = await chapterById(cid);
    if (c.kind !== 'pdf' && c.kind !== 'epub') throw new HttpError(400, 'No es PDF ni EPUB');
    return { abs, type: c.kind === 'pdf' ? 'application/pdf' : 'application/epub+zip' };
  }

  // Archivo original para exportarlo (las carpetas de imágenes se empaquetan como ZIP).
  async function originalFile(cid) {
    const { c, abs } = await chapterById(cid);
    if (c.kind === 'folder') {
      const files = (await fs.readdir(abs)).filter(n => IMAGE_RE.test(n)).sort(naturalCompare).map(n => ({ abs: path.join(abs, n), name: n }));
      return { kind: 'folder', name: path.basename(abs) + '.cbz', files };
    }
    return { kind: c.kind, abs, name: path.basename(abs) };
  }

  return {
    id: 'local',
    originalFile,
    name: 'Mis archivos',
    description: `Carpeta: ${root}`,
    capabilities: { popular: true, latest: true, search: true, filters: true, updates: false },
    list, getFilters,
    series: async id => strip(await getSeries(id)),
    chapters: async id => [...(await getSeries(id)).chapters].reverse(),
    pages, pageImage, coverImage, rawFile,
    rescan: async () => { index = null; const i = await ensure(); return i.series.size; },
  };
}
