// Fuente "Webcomics libres": obras con licencia libre que se pueden leer y compartir legalmente.
// Por ahora: Pepper&Carrot de David Revoy (CC BY 4.0), con su API oficial documentada en
// https://www.peppercarrot.com/en/documentation/130_API.html
import { TTLCache, HttpError } from '../util.js';

const UA = 'LectorPersonal/1.0 (uso personal)';
const pad = n => String(n).padStart(2, '0');

export function createLibres({ fetch: http = fetch, base = 'https://peppercarrot.com/0_sources', getSettings = () => ({}) }) {
  const cache = new TTLCache(20);
  const img = u => `/api/img?u=${encodeURIComponent(u)}`;

  async function episodes() {
    const hit = cache.get('eps');
    if (hit) return hit;
    let r;
    try { r = await http(`${base}/episodes.json`, { headers: { 'User-Agent': UA, Accept: 'application/json' } }); }
    catch { throw new HttpError(502, 'No se pudo conectar con Pepper&Carrot'); }
    if (!r.ok) throw new HttpError(502, `Pepper&Carrot respondió ${r.status}`);
    const list = (await r.json()).map((e, i) => ({
      dir: e.name, n: Number((e.name.match(/^ep(\d+)/) || [])[1]) || i + 1,
      title: e.name.replace(/^ep\d+_/, '').replace(/-/g, ' '),
      pages: (Number(e.total_pages) || 0) + 1, langs: e.translated_languages || [],
    }));
    return cache.set('eps', list, 60 * 60_000);
  }
  // Español si existe la traducción; si no, el idioma que el usuario tenga activo; si no, inglés.
  function langFor(ep) {
    const want = (getSettings().languages || ['es']).map(l => (l.startsWith('es') ? 'es' : l));
    return want.find(l => ep.langs.includes(l)) || (ep.langs.includes('es') ? 'es' : 'en');
  }
  const pageUrl = (ep, lang, p) => `${base}/${ep.dir}/low-res/${lang}_Pepper-and-Carrot_by-David-Revoy_E${pad(ep.n)}P${pad(p)}.jpg`;

  const SERIES = {
    id: 'pepper-carrot', title: 'Pepper&Carrot',
    description: 'Pepper es una joven bruja aprendiz de la escuela de magia Chaosah y Carrot es su gato. Juntos viven aventuras llenas de humor, pociones que salen mal y otras brujas rivales en el mundo de Hereva. Webcomic de fantasía de David Revoy, publicado con licencia libre Creative Commons Atribución 4.0: se puede leer, descargar y compartir gratis.',
  };

  async function list({ q = '' }) {
    const eps = await episodes();
    if (q && !/pepper|carrot|bruja|revoy/i.test(q)) return { items: [], hasMore: false };
    const first = eps[0];
    return { items: [{ source: 'libres', id: SERIES.id, title: SERIES.title, cover: first ? img(pageUrl(first, langFor(first), 0)) : null, type: 'cómic', languages: ['es'], year: 2014 }], hasMore: false };
  }

  async function series(id) {
    if (id !== SERIES.id) throw new HttpError(404, 'No encontrado');
    const eps = await episodes();
    const first = eps[0];
    return {
      source: 'libres', id, title: SERIES.title, altTitles: [], description: SERIES.description, descriptionLang: 'es',
      cover: first ? img(pageUrl(first, langFor(first), 0)) : null, authors: ['David Revoy'], artists: ['David Revoy'],
      status: 'En publicación', type: 'cómic', demographic: null,
      genres: [{ id: 'fantasia', name: 'Fantasía' }, { id: 'comedia', name: 'Comedia' }], contentRating: 'safe', year: 2014,
      readingDir: 'ltr', languages: [...new Set(eps.map(langFor))],
      notice: 'Pepper&Carrot © David Revoy · licencia CC BY 4.0 · peppercarrot.com',
    };
  }

  async function chapters(id) {
    if (id !== SERIES.id) throw new HttpError(404, 'No encontrado');
    return (await episodes()).map(ep => ({ id: ep.dir, number: ep.n, volume: null, title: ep.title, lang: langFor(ep), group: 'Pepper&Carrot', date: null, pages: ep.pages })).reverse();
  }

  async function pages(chId) {
    const ep = (await episodes()).find(e => e.dir === chId);
    if (!ep) throw new HttpError(404, 'Episodio no encontrado');
    const lang = langFor(ep);
    return { kind: 'images', pages: Array.from({ length: ep.pages }, (_, p) => ({ url: img(pageUrl(ep, lang, p)) })) };
  }

  return {
    id: 'libres', name: 'Webcomics libres', description: 'Cómics con licencia libre, como Pepper&Carrot (en español)',
    capabilities: { popular: true, latest: false, search: true, filters: false },
    list, getFilters: async () => ({}), series, chapters, pages,
  };
}
