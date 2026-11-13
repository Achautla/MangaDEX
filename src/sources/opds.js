// Fuente OPDS 1.2: catálogos de Komga, Kavita, Calibre-Web, bibliotecas digitales, etc.
// Cada catálogo que agregues en Ajustes aparece como una pestaña en Explorar.
//  - Carpetas (feeds de navegación) → tarjetas que abren la carpeta.
//  - Libros y cómics (entradas de adquisición) → ficha con sus formatos: EPUB, PDF, CBZ, CBR o páginas por streaming (OPDS-PSE).
import { parseXml, kids, kid, textOf, attr } from '../xml.js';
import { TTLCache, HttpError } from '../util.js';

const UA = 'LectorPersonal/1.0 (uso personal)';
const REL_ACQ = /^http:\/\/opds-spec\.org\/acquisition/;
const REL_IMG = /^http:\/\/opds-spec\.org\/image(\/thumbnail)?$/;
const REL_PSE = 'http://vaemendis.net/opds-pse/stream';
const isCatalogType = t => /application\/atom\+xml/.test(t || '');

// ids seguros para URL (funcionan en Node y en el teléfono)
export const encodeId = obj => btoa(unescape(encodeURIComponent(JSON.stringify(obj)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const decodeId = id => { try { return JSON.parse(decodeURIComponent(escape(atob(id.replace(/-/g, '+').replace(/_/g, '/'))))); } catch { throw new HttpError(400, 'Identificador no válido'); } };

export function formatOf(type = '', href = '') {
  const t = type.toLowerCase(), h = href.toLowerCase().split('?')[0];
  if (/epub/.test(t) || h.endsWith('.epub')) return 'epub';
  if (/pdf/.test(t) || h.endsWith('.pdf')) return 'pdf';
  if (/rar|cbr/.test(t) || /\.(cbr|rar)$/.test(h)) return 'rar';
  if (/zip|cbz|comicbook/.test(t) || /\.(cbz|zip)$/.test(h)) return 'zip';
  return null;
}
const FORMAT_LABEL = { pse: 'Leer en línea (página por página)', epub: 'Libro EPUB', pdf: 'PDF', zip: 'Cómic CBZ', rar: 'Cómic CBR' };

export function createOpds({ catalog, fetch: http = fetch, openRemote }) {
  const cache = new TTLCache(200);
  const entries = new Map(); // id -> entrada leída
  const pageUrls = new Map(); // url del feed -> [url página 1, página 2, …]
  const authHeader = catalog.user ? { Authorization: 'Basic ' + btoa(unescape(encodeURIComponent(`${catalog.user}:${catalog.pass || ''}`))) } : {};
  const srcId = catalog.id;
  const res = (u, kind) => `/api/opds/res?c=${encodeURIComponent(srcId)}&k=${kind}&u=${encodeURIComponent(u)}`;

  async function getXml(url, any = false) {
    const hit = cache.get(url);
    if (hit) return hit;
    let r;
    try { r = await http(url, { headers: { 'User-Agent': UA, Accept: 'application/atom+xml, application/xml, text/xml, */*', ...authHeader } }); }
    catch { throw new HttpError(502, `No se pudo conectar con “${catalog.name}”. Revisa la dirección y tu conexión.`); }
    if (r.status === 401 || r.status === 403) throw new HttpError(401, `“${catalog.name}” pidió usuario y contraseña (o los que pusiste no son correctos).`);
    if (!r.ok) throw new HttpError(502, `“${catalog.name}” respondió ${r.status}`);
    const text = await r.text();
    if (!any && !/<feed[\s>]/.test(text) && !/<entry[\s>]/.test(text)) throw new HttpError(502, `“${catalog.name}” no devolvió un catálogo OPDS válido`);
    return cache.set(url, parseXml(text), 5 * 60_000);
  }

  function readEntry(e, base) {
    const links = kids(e, 'link').map(l => ({ rel: l.attrs.rel || '', type: l.attrs.type || '', href: l.attrs.href ? new URL(l.attrs.href, base).toString() : '', count: attr(l, 'count'), node: l }));
    const img = links.find(l => /\/image$/.test(l.rel)) || links.find(l => REL_IMG.test(l.rel));
    const thumb = links.find(l => /thumbnail/.test(l.rel)) || img;
    const formats = [];
    const pse = links.find(l => l.rel === REL_PSE);
    if (pse) formats.push({ fmt: 'pse', href: pse.href, count: Number(pse.count) || 0 });
    for (const l of links.filter(l => REL_ACQ.test(l.rel))) {
      const f = formatOf(l.type, l.href);
      if (f && !formats.some(x => x.fmt === f)) formats.push({ fmt: f, href: l.href });
    }
    const nav = !formats.length ? links.find(l => isCatalogType(l.type) && l.rel !== 'self' && l.rel !== 'up') || links.find(l => isCatalogType(l.type)) : null;
    return {
      eid: textOf(kid(e, 'id')) || nav?.href || formats[0]?.href,
      title: textOf(kid(e, 'title')) || 'Sin título',
      summary: textOf(kid(e, 'summary')) || textOf(kid(e, 'content')),
      authors: kids(e, 'author').map(a => textOf(kid(a, 'name'))).filter(Boolean),
      language: textOf(kid(e, 'language')) || null,
      categories: kids(e, 'category').map(c => c.attrs.label || c.attrs.term).filter(Boolean),
      year: (textOf(kid(e, 'issued')) || textOf(kid(e, 'published')) || '').slice(0, 4) || null,
      cover: thumb?.href ? res(thumb.href, 'img') : null,
      formats, nav: nav?.href || null,
    };
  }

  const typeFor = e => e.formats.some(f => f.fmt === 'pse' || f.fmt === 'zip' || f.fmt === 'rar') ? 'cómic' : e.formats.length ? 'libro' : 'carpeta';
  const lang = l => (l ? l.toLowerCase().replace('_', '-').replace(/^spa$/, 'es').replace(/^eng$/, 'en') : null);

  function toItem(e, feedUrl) {
    if (e.nav) {
      return { source: srcId, id: encodeId({ n: e.nav }), title: e.title, cover: e.cover, type: 'carpeta', languages: [],
        href: `#/explore?${new URLSearchParams({ src: srcId, mode: 'popular', f: JSON.stringify({ path: e.nav, name: e.title }) })}` };
    }
    const id = encodeId({ f: feedUrl, e: e.eid });
    entries.set(id, e);
    return { source: srcId, id, title: e.title, cover: e.cover, type: typeFor(e), languages: e.language ? [lang(e.language)] : [], year: e.year };
  }

  async function searchUrl(root, q) {
    const s = kids(root, 'link').find(l => l.attrs.rel === 'search');
    if (!s) return null;
    const href = new URL(s.attrs.href, catalog.url).toString();
    if (/\{searchTerms\}/.test(href)) return href.replace('{searchTerms}', encodeURIComponent(q));
    // Descripción OpenSearch
    const desc = await getXml(href, true).catch(() => null);
    const tpl = desc && (kids(kid(desc, 'OpenSearchDescription') || desc, 'Url').find(u => /atom/.test(u.attrs.type || '')) || kids(kid(desc, 'OpenSearchDescription') || desc, 'Url')[0]);
    return tpl ? new URL(tpl.attrs.template.replace('{searchTerms}', encodeURIComponent(q)).replace(/\{[^}]+\?\}/g, ''), href).toString() : null;
  }

  async function list({ page = 1, q = '', filters = {} }) {
    let start = filters.path || catalog.url;
    if (q) {
      const rootFeed = kid(await getXml(catalog.url), 'feed');
      const su = await searchUrl(rootFeed, q);
      if (!su) throw new HttpError(400, `“${catalog.name}” no permite buscar. Navega por sus carpetas.`);
      start = su;
    }
    // páginas siguientes (rel="next")
    let urls = pageUrls.get(start) || [start];
    while (urls.length < page) {
      const f = kid(await getXml(urls[urls.length - 1]), 'feed');
      const next = kids(f, 'link').find(l => l.attrs.rel === 'next');
      if (!next) return { items: [], hasMore: false };
      urls = [...urls, new URL(next.attrs.href, urls[urls.length - 1]).toString()];
    }
    pageUrls.set(start, urls);
    const url = urls[page - 1];
    const feed = kid(await getXml(url), 'feed');
    if (!feed) throw new HttpError(502, 'Catálogo OPDS no válido');
    const items = kids(feed, 'entry').map(e => toItem(readEntry(e, url), url));
    return { items, hasMore: !!kids(feed, 'link').find(l => l.attrs.rel === 'next'), folder: filters.name || textOf(kid(feed, 'title')) };
  }

  async function entryFor(id) {
    if (entries.has(id)) return entries.get(id);
    const { f, e } = decodeId(id);
    if (!f) throw new HttpError(404, 'No encontrado');
    const feed = kid(await getXml(f), 'feed') || kid(await getXml(f), 'entry');
    const node = (feed.local === 'entry' ? [feed] : kids(feed, 'entry')).map(x => readEntry(x, f)).find(x => x.eid === e);
    if (!node) throw new HttpError(404, 'Este elemento ya no está en el catálogo');
    entries.set(id, node);
    return node;
  }

  async function series(id) {
    const e = await entryFor(id);
    return {
      source: srcId, id, title: e.title, altTitles: [], description: e.summary.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), descriptionLang: null,
      cover: e.cover, authors: e.authors, artists: [], status: null, type: typeFor(e), demographic: null,
      genres: e.categories.map(c => ({ id: c, name: c })), contentRating: 'safe', year: Number(e.year) || null,
      readingDir: 'ltr', languages: e.language ? [lang(e.language)] : [],
    };
  }

  async function chapters(id) {
    const e = await entryFor(id);
    return e.formats.map((f, i) => ({ id: encodeId({ ...decodeId(id), i }), number: null, volume: null, title: FORMAT_LABEL[f.fmt],
      lang: e.language ? lang(e.language) : null, group: catalog.name, date: null, pages: f.count || null, fmt: f.fmt })).reverse();
  }

  async function pages(chId) {
    const d = decodeId(chId);
    const e = await entryFor(encodeId({ f: d.f, e: d.e }));
    const f = e.formats[d.i];
    if (!f) throw new HttpError(404, 'Formato no disponible');
    if (f.fmt === 'pse') {
      return { kind: 'images', pages: Array.from({ length: f.count }, (_, n) => ({
        url: res(f.href.replace(/\{pageNumber\}|%7BpageNumber%7D/gi, n).replace(/\{maxWidth\}|%7BmaxWidth%7D/gi, 1600), 'img') })) };
    }
    if (f.fmt === 'epub' || f.fmt === 'pdf') return { kind: f.fmt, url: res(f.href, 'file') };
    // CBZ / CBR: el servidor o el teléfono lo descarga completo y lo abre
    const count = await openRemote(srcId, f.href, f.fmt);
    if (!count) throw new HttpError(422, 'El archivo no tiene imágenes');
    return { kind: 'images', pages: Array.from({ length: count }, (_, n) => ({ url: `${res(f.href, 'arc')}&f=${f.fmt}&i=${n}` })) };
  }

  return {
    id: srcId, name: catalog.name, description: `Catálogo OPDS: ${catalog.url}`,
    capabilities: { popular: true, latest: false, search: true, filters: false, opds: true },
    list, getFilters: async () => ({}), series, chapters, pages,
    // para el proxy de recursos (imágenes, archivos) con la autenticación del catálogo
    fetchResource: (u, opts = {}) => http(u, { ...opts, headers: { 'User-Agent': UA, ...authHeader, ...(opts.headers || {}) } }),
    catalogUrl: catalog.url,
  };
}
