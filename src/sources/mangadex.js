// Fuente MangaDex: API pública v5, filtrada a traducciones en español.
// Docs: https://api.mangadex.org/docs/
import { TTLCache, RateLimiter, sleep, HttpError } from '../util.js';

const UA = 'LectorPersonal/1.0 (uso personal)';

// Nombres en español de las etiquetas de MangaDex (la API solo las da en inglés).
const TAG_ES = {
  'Action': 'Acción', 'Adventure': 'Aventura', 'Comedy': 'Comedia', 'Drama': 'Drama', 'Fantasy': 'Fantasía', 'Horror': 'Terror',
  'Mystery': 'Misterio', 'Romance': 'Romance', 'Sci-Fi': 'Ciencia ficción', 'Slice of Life': 'Recuentos de la vida', 'Sports': 'Deportes',
  'Thriller': 'Suspenso', 'Tragedy': 'Tragedia', 'Psychological': 'Psicológico', 'Historical': 'Histórico', 'Isekai': 'Isekai',
  'Crime': 'Crimen', 'Medical': 'Médico', 'Philosophical': 'Filosófico', 'Superhero': 'Superhéroes', 'Mecha': 'Mecha', 'Wuxia': 'Wuxia',
  'Magical Girls': 'Chicas mágicas', "Boys' Love": 'Boys Love (BL)', "Girls' Love": 'Girls Love (GL)', 'Martial Arts': 'Artes marciales',
  'School Life': 'Vida escolar', 'Supernatural': 'Sobrenatural', 'Magic': 'Magia', 'Monsters': 'Monstruos', 'Demons': 'Demonios',
  'Ghosts': 'Fantasmas', 'Vampires': 'Vampiros', 'Zombies': 'Zombis', 'Aliens': 'Extraterrestres', 'Animals': 'Animales',
  'Reincarnation': 'Reencarnación', 'Time Travel': 'Viajes en el tiempo', 'Survival': 'Supervivencia', 'Post-Apocalyptic': 'Postapocalíptico',
  'Military': 'Militar', 'Police': 'Policía', 'Mafia': 'Mafia', 'Delinquents': 'Delincuentes', 'Samurai': 'Samurái', 'Ninja': 'Ninja',
  'Cooking': 'Cocina', 'Music': 'Música', 'Video Games': 'Videojuegos', 'Virtual Reality': 'Realidad virtual', 'Traditional Games': 'Juegos tradicionales',
  'Office Workers': 'Oficinistas', 'Harem': 'Harem', 'Reverse Harem': 'Harem inverso', 'Villainess': 'Villana', 'Gyaru': 'Gyaru',
  'Monster Girls': 'Chicas monstruo', 'Genderswap': 'Cambio de género', 'Crossdressing': 'Travestismo', 'Incest': 'Incesto',
  'Gore': 'Gore', 'Sexual Violence': 'Violencia sexual', 'Oneshot': 'Historia única', 'Long Strip': 'Tira larga (webtoon)',
  'Full Color': 'A color', 'Web Comic': 'Webcómic', '4-Koma': '4-koma', 'Adaptation': 'Adaptación', 'Anthology': 'Antología',
  'Award Winning': 'Premiado', 'Doujinshi': 'Doujinshi', 'Fan Colored': 'Coloreado por fans', 'Official Colored': 'Coloreado oficial',
  'Self-Published': 'Autopublicado',
};
const HIDDEN_TAGS = new Set(['Loli', 'Shota']);
const tagName = n => TAG_ES[n.en] || n.es || n.en;


export function createMangaDex(config, getSettings) {
  const API = config.mangadexApi;
  const http = config.fetch || fetch; // en el APK se usa HTTP nativo
  const UPLOADS = config.mangadexUploads;
  const cache = new TTLCache(800);
  // ~5 peticiones/seg global; /at-home tiene límite propio (40/min).
  const globalLimiter = new RateLimiter({ minIntervalMs: 220 });
  const atHomeLimiter = new RateLimiter({ minIntervalMs: 220, maxPerWindow: 38, windowMs: 60000 });

  const langs = () => getSettings().languages?.length ? getSettings().languages : ['es', 'es-la'];
  const ratings = () => getSettings().contentRating?.length ? getSettings().contentRating : ['safe', 'suggestive'];

  async function api(path, params = {}, { ttl = 5 * 60_000, limiter = globalLimiter } = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      if (Array.isArray(v)) v.forEach(x => url.searchParams.append(k, x));
      else url.searchParams.append(k, v);
    }
    const key = url.toString();
    const hit = cache.get(key);
    if (hit) return hit;
    for (let attempt = 0; attempt < 3; attempt++) {
      let res;
      try {
        res = await limiter.schedule(() => http(key, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) }));
      } catch {
        throw new HttpError(502, 'No se pudo conectar con MangaDex. Revisa tu conexión a internet.');
      }
      if (res.status === 429) {
        const retry = Number(res.headers.get('retry-after')) || 2 ** attempt;
        await sleep(retry * 1000);
        continue;
      }
      if (!res.ok) throw new HttpError(res.status === 404 ? 404 : 502, `MangaDex respondió ${res.status}`);
      const json = await res.json();
      if (json.result === 'error') throw new HttpError(502, json.errors?.[0]?.detail || 'Error de MangaDex');
      return ttl ? cache.set(key, json, ttl) : json;
    }
    throw new HttpError(503, 'MangaDex está limitando las peticiones; intenta en un momento');
  }

  const pickTitle = (obj = {}) =>
    obj['es-la'] || obj.es || obj.en || obj['ja-ro'] || obj['ko-ro'] || obj['zh-ro'] || Object.values(obj)[0] || 'Sin título';

  const TYPE_BY_LANG = { ja: 'manga', ko: 'manhwa', zh: 'manhua', 'zh-hk': 'manhua' };
  const LANGS_BY_TYPE = { manga: ['ja'], manhwa: ['ko'], manhua: ['zh', 'zh-hk'] };

  function mapManga(m) {
    const a = m.attributes;
    const rel = type => (m.relationships || []).filter(r => r.type === type && r.attributes);
    const cover = rel('cover_art')[0];
    const altEs = (a.altTitles || []).map(t => t['es-la'] || t.es).filter(Boolean);
    const type = TYPE_BY_LANG[a.originalLanguage] || 'cómic';
    return {
      source: 'mangadex',
      id: m.id,
      title: altEs[0] && !a.title.es && !a.title['es-la'] ? altEs[0] : pickTitle(a.title),
      altTitles: [...new Set([...(a.altTitles || []).map(pickTitle), pickTitle(a.title)])].slice(0, 8),
      description: a.description?.['es-la'] || a.description?.es || a.description?.en || '',
      cover: cover ? `/api/img?u=${encodeURIComponent(`${UPLOADS}/covers/${m.id}/${cover.attributes.fileName}.512.jpg`)}` : null,
      authors: rel('author').map(r => r.attributes.name),
      artists: rel('artist').map(r => r.attributes.name),
      status: { ongoing: 'En curso', completed: 'Finalizado', hiatus: 'En pausa', cancelled: 'Cancelado' }[a.status] || a.status,
      type,
      demographic: a.publicationDemographic || null,
      genres: (a.tags || []).filter(t => t.attributes.group === 'genre' || t.attributes.group === 'theme')
        .filter(t => !HIDDEN_TAGS.has(t.attributes.name.en))
        .map(t => ({ id: t.id, name: tagName(t.attributes.name) })),
      contentRating: a.contentRating,
      year: a.year,
      readingDir: type === 'manga' ? 'rtl' : type === 'cómic' ? 'ltr' : 'webtoon',
      lastChapter: a.lastChapter || null,
    };
  }

  const baseListParams = () => ({
    limit: 30,
    'includes[]': ['cover_art'],
    'availableTranslatedLanguage[]': langs(),
    'contentRating[]': ratings(),
    hasAvailableChapters: 'true',
  });

  async function list({ mode = 'popular', page = 1, q = '', filters = {} }) {
    const params = baseListParams();
    params.offset = (Math.max(1, page) - 1) * params.limit;
    if (mode === 'latest') params['order[latestUploadedChapter]'] = 'desc';
    else if (mode === 'popular') params['order[followedCount]'] = 'desc';
    else {
      const order = filters.order || (q ? 'relevance' : 'followedCount');
      params[`order[${order}]`] = order === 'title' ? 'asc' : 'desc';
    }
    if (q) params.title = q;
    if (filters.include?.length) params['includedTags[]'] = filters.include;
    if (filters.exclude?.length) params['excludedTags[]'] = filters.exclude;
    if (filters.status?.length) params['status[]'] = filters.status;
    if (filters.demographic?.length) params['publicationDemographic[]'] = filters.demographic;
    if (filters.type?.length) params['originalLanguage[]'] = filters.type.flatMap(t => LANGS_BY_TYPE[t] || []);
    if (filters.contentRating?.length) params['contentRating[]'] = filters.contentRating;
    const json = await api('/manga', params);
    return {
      items: json.data.map(mapManga),
      hasMore: json.offset + json.data.length < Math.min(json.total, 10000),
    };
  }

  async function getFilters() {
    const json = await api('/manga/tag', {}, { ttl: 24 * 3600_000 });
    const tags = json.data.filter(t => !HIDDEN_TAGS.has(t.attributes.name.en)).map(t => ({
      id: t.id,
      name: tagName(t.attributes.name),
      group: t.attributes.group,
    })).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    return {
      tags: {
        'Géneros': tags.filter(t => t.group === 'genre'),
        'Temas': tags.filter(t => t.group === 'theme'),
        'Formato': tags.filter(t => t.group === 'format'),
        'Contenido': tags.filter(t => t.group === 'content'),
      },
      type: [['manga', 'Manga (Japón)'], ['manhwa', 'Manhwa (Corea)'], ['manhua', 'Manhua (China)']],
      status: [['ongoing', 'En curso'], ['completed', 'Finalizado'], ['hiatus', 'En pausa'], ['cancelled', 'Cancelado']],
      demographic: [['shounen', 'Shōnen'], ['shoujo', 'Shōjo'], ['seinen', 'Seinen'], ['josei', 'Josei']],
      contentRating: [['safe', 'Apto'], ['suggestive', 'Sugerente'], ['erotica', 'Erótico'], ['pornographic', 'Adulto']],
      order: [['relevance', 'Relevancia'], ['followedCount', 'Popularidad'], ['latestUploadedChapter', 'Última actualización'],
        ['createdAt', 'Recién agregados'], ['rating', 'Mejor valorados'], ['title', 'A-Z'], ['year', 'Año']],
    };
  }

  async function series(id) {
    const json = await api(`/manga/${id}`, { 'includes[]': ['cover_art', 'author', 'artist'] });
    return mapManga(json.data);
  }

  async function chapters(id) {
    const out = [];
    for (let offset = 0; offset < 5000; offset += 500) {
      const json = await api(`/manga/${id}/feed`, {
        limit: 500, offset,
        'translatedLanguage[]': langs(),
        'contentRating[]': ['safe', 'suggestive', 'erotica', 'pornographic'],
        'order[volume]': 'desc', 'order[chapter]': 'desc',
        'includes[]': ['scanlation_group'],
      }, { ttl: 2 * 60_000 });
      for (const c of json.data) {
        const a = c.attributes;
        if (a.externalUrl || a.pages === 0) continue; // capítulos alojados fuera de MangaDex
        out.push({
          id: c.id,
          number: a.chapter,
          volume: a.volume,
          title: a.title || '',
          lang: a.translatedLanguage,
          group: (c.relationships || []).filter(r => r.type === 'scanlation_group' && r.attributes).map(r => r.attributes.name).join(', ') || 'Sin grupo',
          date: a.readableAt || a.publishAt,
          pages: a.pages,
        });
      }
      if (offset + json.data.length >= json.total) break;
    }
    return out;
  }

  async function pages(chapterId, { refresh = false } = {}) {
    const key = `athome:${chapterId}`;
    if (refresh) cache.delete(key);
    let info = cache.get(key);
    if (!info) {
      info = await api(`/at-home/server/${chapterId}`, {}, { ttl: 0, limiter: atHomeLimiter });
      cache.set(key, info, 10 * 60_000); // la baseUrl dura ~15 min
    }
    const saver = getSettings().dataSaver;
    const quality = saver ? 'data-saver' : 'data';
    const files = saver ? info.chapter.dataSaver : info.chapter.data;
    return {
      kind: 'images',
      pages: files.map(f => ({
        url: `/api/img?u=${encodeURIComponent(`${info.baseUrl}/${quality}/${info.chapter.hash}/${f}`)}`,
      })),
    };
  }

  // Novedades: últimos capítulos en español de las series guardadas (1 petición por cada 100 series).
  async function updates(ids) {
    const out = [];
    for (let i = 0; i < ids.length; i += 100) {
      const json = await api('/chapter', {
        limit: 100,
        'manga[]': ids.slice(i, i + 100),
        'translatedLanguage[]': langs(),
        'contentRating[]': ['safe', 'suggestive', 'erotica', 'pornographic'],
        'order[readableAt]': 'desc',
        'includes[]': ['scanlation_group'],
      }, { ttl: 5 * 60_000 });
      for (const c of json.data) {
        if (c.attributes.externalUrl || c.attributes.pages === 0) continue;
        const manga = (c.relationships || []).find(r => r.type === 'manga');
        out.push({
          seriesId: manga?.id, chapterId: c.id, number: c.attributes.chapter,
          title: c.attributes.title || '', date: c.attributes.readableAt,
          group: (c.relationships || []).filter(r => r.type === 'scanlation_group' && r.attributes).map(r => r.attributes.name).join(', '),
        });
      }
    }
    return out;
  }

  // Si un nodo de MangaDex@Home falla, se le avisa a MangaDex (lo pide su documentación).
  function report(url, success, bytes, ms) {
    if (!config.mangadexReport || !/mangadex\.network/.test(url)) return;
    fetch('https://api.mangadex.network/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ url, success, bytes, duration: ms, cached: false }),
    }).catch(() => {});
  }

  return {
    id: 'mangadex',
    name: 'MangaDex (español)',
    description: 'Catálogo en línea con traducciones al español de España y Latinoamérica.',
    capabilities: { popular: true, latest: true, search: true, filters: true, updates: true },
    list, getFilters, series, chapters, pages, updates, report,
    imageHosts: config.mangadexImageHosts,
  };
}
