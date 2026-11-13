// Fuente Comic Book Plus (comicbookplus.com): biblioteca de cómics de dominio público.
// No tiene API: se leen sus páginas públicas, igual que su lector web (sin cuenta).
//   Géneros  → https://comicbookplus.com/?cbplus=<género>        (página N: <género>_l_n_<N-1>)
//   Serie    → https://comicbookplus.com/?cid=<id>               (lista de números con datos schema.org)
//   Número   → https://comicbookplus.com/?dlid=<id>              (se abre en su sitio)
import { TTLCache, RateLimiter, HttpError } from '../util.js';

const BASE = 'https://comicbookplus.com';
const UA = 'LectorPersonal/1.0 (uso personal)';

export const GENRES = [
  ['superhero', 'Superhéroes'], ['adventure', 'Aventura'], ['horror', 'Terror'], ['crime', 'Crimen'],
  ['sciencefiction', 'Ciencia ficción'], ['fantasywhimsey', 'Fantasía'], ['humor', 'Humor'], ['romance', 'Romance'],
  ['western', 'Western'], ['military', 'Guerra'], ['jungle', 'Selva'], ['detective', 'Detectives'],
  ['maskedmysterymen', 'Enmascarados'], ['leadingladies', 'Heroínas'], ['monsters', 'Monstruos'], ['pirates', 'Piratas'],
  ['spyespionage', 'Espionaje'], ['funnyanimals', 'Animales graciosos'], ['childrenteenagers', 'Infantil y juvenil'],
  ['classictales', 'Cuentos clásicos'], ['comicstripspinoff', 'Tiras cómicas'], ['mediastars', 'Cine y estrellas'],
  ['anthology', 'Antologías'], ['oneshots', 'Números únicos'], ['sports', 'Deportes'], ['aviation', 'Aviación'],
  ['atomic', 'Era atómica'], ['boxingmartialarts', 'Boxeo y artes marciales'], ['nonfiction', 'No ficción'],
  ['westernheroes', 'Héroes del Oeste'], ['school', 'Escuela'], ['religious', 'Religiosos'], ['annual', 'Anuales'],
];

// ---------- utilidades de HTML (sin DOM, funciona en Node y en el teléfono) ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export const decode = s => String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e) =>
  e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENT[e.toLowerCase()] ?? m);
const text = s => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')); return m ? decode(m[2] ?? m[3]) : null; };
const abs = (u, base = BASE + '/') => { try { return new URL(u, base).toString(); } catch { return null; } };
// Quita el panel lateral (últimos subidos, etc.) para no confundir sus enlaces con el contenido
const mainOf = html => { const i = html.indexOf('class="mainbody"'); return i >= 0 ? html.slice(i) : html; };

// Página de género: bloques de serie (título + portada + descripción)
export function parseGenre(html, pageUrl) {
  const body = mainOf(html);
  const out = [], seen = new Set();
  const blocks = body.split(/<div class="cbpLtable(?:left|right)?">/).slice(1);
  for (const b of blocks) {
    const a = b.match(/<td[^>]*class="w"[^>]*>\s*<a[^>]*href="([^"]*\?cid=(\d+))"[^>]*>([\s\S]*?)<\/a>/);
    if (!a || seen.has(a[2])) continue;
    seen.add(a[2]);
    const img = b.match(/<td[^>]*class="v"[^>]*>[\s\S]*?<img\b[^>]*>/);
    const src = img ? attr(img[0].match(/<img\b[^>]*>/)[0], 'src') : null;
    const desc = [...b.matchAll(/<td class="y">([\s\S]*?)<\/td>/g)].map(m => text(m[1])).pop() || '';
    out.push({ cid: a[2], title: text(a[3]), cover: src && /^https?:|^\//.test(src) ? abs(src, pageUrl) : null, description: desc });
  }
  const next = /_l_n_\d+/.test(body.match(/class="cbpnext(?:texttd|pointtd)"[\s\S]{0,300}/)?.[0] || '');
  return { series: out, hasMore: next };
}

// Página de serie: filas schema.org de cada número
export function parseSeries(html) {
  const body = mainOf(html);
  const title = text(body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1]) || null;
  const description = attr(html.match(/<meta[^>]*itemprop="description"[^>]*>/)?.[0] || html.match(/<meta[^>]*name="description"[^>]*>/)?.[0] || '', 'content') || '';
  const issues = [];
  for (const row of body.split(/<tr\b[^>]*itemtype="https:\/\/schema\.org\/Book"[^>]*>/).slice(1)) {
    const r = row.split(/<\/tr>/)[0];
    const meta = p => attr(r.match(new RegExp(`<meta[^>]*itemprop="${p}"[^>]*>`))?.[0] || '', 'content');
    const dlid = (meta('discussionUrl') || r.match(/\?dlid=(\d+)/)?.[0] || '').match(/dlid=(\d+)/)?.[1];
    if (!dlid) continue;
    const name = text(r.match(/itemprop="name"[^>]*>([\s\S]*?)<\/span>/)?.[1]) || attr(r.match(/<img\b[^>]*>/)?.[0] || '', 'alt');
    const date = attr(r.match(/<time[^>]*>/)?.[0] || '', 'datetime');
    const pages = Number(text(r.match(/itemprop="numberOfPages"[^>]*>([\s\S]*?)<\/td>/)?.[1])) || null;
    issues.push({ dlid, name, number: Number(text(r.match(/itemprop="position"[^>]*>([\s\S]*?)<\/td>/)?.[1])) || null,
      date, pages, lang: meta('inLanguage') || 'en', thumb: meta('thumbnailUrl') });
  }
  return { title, description, issues };
}

// Página de un número: dónde están sus imágenes
export function parseIssue(html) {
  const js = (html.match(/<script>\s*\/\/<!\[CDATA\[([\s\S]*?)<\/script>/) || [])[1] || html;
  const website = (js.match(/website\s*=\s*([^;]+);/)?.[1] || '').replace(/["'+\s]/g, '') || 'https://box01.comicbookplus.com/';
  const comicloc = js.match(/comicloc\s*=\s*"([^"]+)"/)?.[1];
  const count = Number(js.match(/comicnumpages\s*=\s*(\d+)/)?.[1]) || 0;
  const name = attr(html.match(/<meta[^>]*itemprop="name"[^>]*>/)?.[0] || '', 'content')?.replace(/ - Comic Book Plus$/, '');
  const lang = attr(html.match(/<meta[^>]*itemprop="inLanguage"[^>]*>/)?.[0] || '', 'content') || 'en';
  const main = html.match(/<img\b[^>]*id="maincomic"[^>]*>/)?.[0];
  return { website, comicloc, count, name, lang, firstImage: main ? attr(main, 'src') : null };
}

export function createCbplus({ fetchText, base = BASE }) {
  const cache = new TTLCache(300);
  const limiter = new RateLimiter({ minIntervalMs: 400 }); // sin prisas: es un sitio sin fines de lucro
  const img = u => (u ? `/api/img?u=${encodeURIComponent(u)}` : null);
  const url = qs => `${base}/?${qs}`;

  async function get(u, ttl = 15 * 60_000) {
    const hit = cache.get(u);
    if (hit) return hit;
    let html;
    try { html = await limiter.schedule(() => fetchText(u, { 'User-Agent': UA, Referer: base + '/' })); }
    catch (e) { throw new HttpError(502, `No se pudo conectar con Comic Book Plus (${e.message || e})`); }
    return cache.set(u, html, ttl);
  }

  async function list({ page = 1, q = '', filters = {} }) {
    if (q) throw new HttpError(400, 'Comic Book Plus no tiene buscador propio: entra a un género y elige la serie.');
    const g = filters.path;
    if (!g) {
      return { items: GENRES.map(([id, name]) => ({ source: 'cbplus', id: 'g-' + id, title: name, cover: null, type: 'carpeta', languages: [],
        href: `#/explore?${new URLSearchParams({ src: 'cbplus', mode: 'popular', f: JSON.stringify({ path: id, name }) })}` })), hasMore: false };
    }
    const pageUrl = url(page === 1 ? `cbplus=${g}` : `cbplus=${g}_l_n_${page - 1}`);
    const { series, hasMore } = parseGenre(await get(pageUrl), pageUrl);
    return { items: series.map(s => ({ source: 'cbplus', id: s.cid, title: s.title, cover: img(s.cover), type: 'cómic', languages: ['en'] })), hasMore, folder: filters.name };
  }

  async function seriesData(cid) {
    if (!/^\d+$/.test(cid)) throw new HttpError(404, 'Serie no encontrada');
    const s = parseSeries(await get(url(`cid=${cid}`)));
    if (!s.issues.length) throw new HttpError(404, 'Esta serie de Comic Book Plus no tiene números para leer en línea');
    return s;
  }

  async function series(cid) {
    const s = await seriesData(cid);
    const langs = [...new Set(s.issues.map(i => i.lang.slice(0, 2)))];
    const years = s.issues.map(i => Number((i.date || '').slice(0, 4))).filter(Boolean);
    return {
      source: 'cbplus', id: cid, title: s.title || 'Sin título', altTitles: [], description: s.description, descriptionLang: 'en',
      cover: img(s.issues[0].thumb), authors: [], artists: [], status: 'Finalizado', type: 'cómic', demographic: null, genres: [],
      contentRating: 'safe', year: years.length ? Math.min(...years) : null, readingDir: 'ltr', languages: langs,
      notice: 'Cómics de dominio público de Comic Book Plus. Cada número se abre en su sitio (gratis y sin cuenta), porque ellos solo permiten ver las páginas desde su propio lector.',
    };
  }

  async function chapters(cid) {
    const s = await seriesData(cid);
    return s.issues.map(i => ({ id: i.dlid, external: `${BASE}/?dlid=${i.dlid}`, number: i.number, volume: null, title: i.name, lang: i.lang.slice(0, 2),
      group: 'Comic Book Plus', date: i.date ? Date.parse(i.date.length === 7 ? i.date + '-01' : i.date) || null : null, pages: i.pages })).reverse();
  }

  // Comic Book Plus protege sus imágenes para que solo su lector web las muestre (llave + firma temporal).
  // Respetamos eso: la app trae el catálogo y cada número se abre en su sitio, donde también se sostienen con anuncios.
  async function pages() {
    throw new HttpError(403, 'Los números de Comic Book Plus se leen en su sitio. Toca el capítulo para abrirlo allí.');
  }

  return {
    id: 'cbplus', name: 'Comic Book Plus', description: 'Más de 40,000 cómics de dominio público de la Edad de Oro',
    capabilities: { popular: true, latest: false, search: false, filters: false, folders: true },
    list, getFilters: async () => ({}), series, chapters, pages,
  };
}
