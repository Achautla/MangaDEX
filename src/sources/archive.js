// Fuente Internet Archive: cómics clásicos de dominio público (API oficial, sin cuenta).
// Búsqueda: https://archive.org/advancedsearch.php · Metadatos: https://archive.org/metadata/{id}
// Páginas: manifiesto IIIF https://iiif.archive.org/iiif/3/{id}/manifest.json
//
// Solo se usan colecciones de editoriales de la Edad de Oro cuyo contenido es de dominio público,
// y además cualquier cómic marcado por el Archive con licencia de dominio público.
import { TTLCache, RateLimiter, HttpError } from '../util.js';

const UA = 'LectorPersonal/1.0 (uso personal)';

export const PD_COLLECTIONS = [
  ['fawcett-comics', 'Fawcett Comics'],
  ['captainmarveladventures', 'Captain Marvel Adventures (Fawcett)'],
  ['fawcett-americas-greatest-comics', "America's Greatest Comics (Fawcett)"],
  ['fawcett-beware-terror-tales', 'Beware! Terror Tales (Fawcett)'],
  ['bulletman', 'Bulletman (Fawcett)'],
  ['tandywhizkids', 'Whiz Kids (Fawcett)'],
  ['ace-comics', 'Ace Comics'],
  ['four-favorites-comics', 'Four Favorites (Ace)'],
  ['super-mystery-comics', 'Super-Mystery Comics (Ace)'],
  ['webofmystery-comics', 'Web of Mystery (Ace)'],
  ['crime-must-pay-ace', 'Crime Must Pay the Penalty (Ace)'],
  ['comic-ace-dotty', 'Dotty (Ace)'],
];

export function createArchive(config) {
  const http = config.fetch || fetch;
  const IA = config.archiveBase || 'https://archive.org';
  const IIIF = config.iiifBase || 'https://iiif.archive.org';
  const cache = new TTLCache(400);
  const limiter = new RateLimiter({ minIntervalMs: 150 });

  async function getJson(url, ttl = 10 * 60_000) {
    const hit = cache.get(url);
    if (hit) return hit;
    let res;
    try {
      res = await limiter.schedule(() => http(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(25000) }));
    } catch {
      throw new HttpError(502, 'No se pudo conectar con Internet Archive. Revisa tu conexión a internet.');
    }
    if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `Internet Archive respondió ${res.status}`);
    return cache.set(url, await res.json(), ttl);
  }

  const proxied = u => `/api/img?u=${encodeURIComponent(u)}`;
  const cover = id => proxied(`${IA}/services/img/${encodeURIComponent(id)}`);
  const first = v => Array.isArray(v) ? v[0] : v;
  const yearOf = d => { const m = String(d.year || d.date || d.identifier || '').match(/(19[2-6]\d)/); return m ? Number(m[1]) : null; };
  const langOf = l => { const v = String(first(l) || '').toLowerCase(); return /^(spa|spanish|español|es)/.test(v) ? 'es' : /^(eng|english|en)$/.test(v) ? 'en' : v || null; };
  const collName = id => PD_COLLECTIONS.find(([c]) => c === id)?.[1];

  function baseQuery(filters = {}) {
    let cols = PD_COLLECTIONS.map(([c]) => c);
    if (filters.include?.length) cols = cols.filter(c => filters.include.includes(c));
    if (filters.exclude?.length) cols = cols.filter(c => !filters.exclude.includes(c));
    const parts = [];
    if (cols.length) parts.push(`collection:(${cols.join(' OR ')})`);
    if (!filters.include?.length) parts.push('(collection:comics AND licenseurl:*publicdomain*)');
    let q = `(${parts.join(' OR ')}) AND mediatype:texts`;
    if (filters.type?.includes('es')) q += ' AND language:(spa OR spanish OR Spanish OR español)';
    if (filters.type?.includes('en')) q += ' AND language:(eng OR english OR English)';
    return q;
  }

  async function list({ mode = 'popular', page = 1, q = '', filters = {} }) {
    let query = baseQuery(filters);
    if (q) query += ` AND title:(${q.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').trim()})`;
    const url = new URL(`${IA}/advancedsearch.php`);
    url.searchParams.set('q', query);
    for (const f of ['identifier', 'title', 'year', 'date', 'creator', 'collection', 'language']) url.searchParams.append('fl[]', f);
    url.searchParams.append('sort[]', mode === 'latest' ? 'addeddate desc' : filters.order === 'title' ? 'titleSorter asc' : filters.order === 'year' ? 'year asc' : 'downloads desc');
    url.searchParams.set('rows', '30');
    url.searchParams.set('page', String(page));
    url.searchParams.set('output', 'json');
    const json = await getJson(url.toString());
    const docs = json.response?.docs || [];
    return {
      items: docs.map(d => ({
        source: 'archive', id: d.identifier, title: first(d.title) || d.identifier.replace(/[_-]+/g, ' '),
        cover: cover(d.identifier), type: 'cómic', year: yearOf(d),
      })),
      hasMore: page * 30 < (json.response?.numFound || 0),
    };
  }

  async function getFilters() {
    return {
      tags: { 'Colecciones (dominio público)': PD_COLLECTIONS.map(([id, name]) => ({ id, name })) },
      type: [['es', 'En español'], ['en', 'En inglés']],
      order: [['downloads', 'Más leídos'], ['title', 'A-Z'], ['year', 'Más antiguos']],
    };
  }

  async function series(id) {
    const meta = (await getJson(`${IA}/metadata/${encodeURIComponent(id)}`)).metadata;
    if (!meta) throw new HttpError(404, 'No se encontró en Internet Archive');
    const strip = s => String(first(s) || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    const cols = [].concat(meta.collection || []).map(collName).filter(Boolean);
    return {
      source: 'archive', id, title: strip(meta.title) || id, altTitles: [],
      description: strip(meta.description) + `\n\nFuente: Internet Archive (archive.org/details/${id}).`,
      cover: cover(id), authors: [].concat(meta.creator || []).map(strip).filter(Boolean),
      artists: [], status: 'Finalizado', type: 'cómic', demographic: null,
      genres: cols.map(name => ({ id: [].concat(meta.collection).find(c => collName(c) === name), name })),
      contentRating: 'safe', year: yearOf({ ...meta, identifier: id }), readingDir: 'ltr', language: langOf(meta.language),
    };
  }

  async function chapters(id) {
    const s = await series(id);
    return [{ id, number: null, volume: null, title: 'Número completo', lang: s.language || 'en', group: 'Internet Archive', date: null, pages: null }];
  }

  async function pages(id) {
    // Manifiesto IIIF: una imagen por página, con tamaño ajustable
    try {
      const man = await getJson(`${IIIF}/iiif/3/${encodeURIComponent(id)}/manifest.json`, 60 * 60_000);
      const imgs = (man.items || []).map(cv => {
        const body = cv.items?.[0]?.items?.[0]?.body;
        const svc = first(body?.service)?.id || first(body?.service)?.['@id'];
        return svc ? `${svc}/full/1400,/0/default.jpg` : body?.id;
      }).filter(Boolean);
      if (imgs.length) return { kind: 'images', pages: imgs.map(u => ({ url: proxied(u) })) };
    } catch { /* sin derivado de imágenes: se intenta el PDF */ }
    const meta = await getJson(`${IA}/metadata/${encodeURIComponent(id)}`);
    const pdf = (meta.files || []).find(f => /\.pdf$/i.test(f.name));
    if (pdf) return { kind: 'pdf', url: proxied(`${IA}/download/${encodeURIComponent(id)}/${encodeURIComponent(pdf.name)}`) };
    throw new HttpError(404, 'Este cómic no tiene páginas legibles en línea');
  }

  return {
    id: 'archive',
    name: 'Clásicos',
    description: 'Cómics de la Edad de Oro de dominio público, desde Internet Archive.',
    capabilities: { popular: true, latest: true, search: true, filters: true, updates: false },
    list, getFilters, series, chapters, pages,
  };
}
