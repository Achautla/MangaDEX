// Fuente MANGA Plus (Shueisha): servicio oficial y gratuito con capítulos en español.
// La API (no documentada) responde en protobuf; aquí hay un lector mínimo sin dependencias.
// Las imágenes vienen cifradas con XOR: el servidor o el teléfono las descifran al mostrarlas.
import { TTLCache, HttpError } from '../util.js';

const API = 'https://jumpg-webapi.tokyo-cdn.com/api';
const LANGS = { 0: 'en', 1: 'es-la', 2: 'fr', 3: 'id', 4: 'pt-br', 5: 'ru', 6: 'th', 7: 'de', 9: 'vi' };
const PAGE = 30;

// ---------- protobuf mínimo ----------
function readVarint(b, p) {
  let v = 0, mul = 1, byte;
  do { byte = b[p.i++]; v += (byte & 0x7f) * mul; mul *= 128; } while (byte & 0x80);
  return v;
}
// Devuelve { [campo]: [valores] } — números para varint, Uint8Array para bytes/mensajes/strings.
export function decodeProto(b) {
  const out = {}, p = { i: 0 };
  while (p.i < b.length) {
    const key = readVarint(b, p), field = Math.floor(key / 8), wt = key & 7;
    let v;
    if (wt === 0) v = readVarint(b, p);
    else if (wt === 2) { const len = readVarint(b, p); v = b.subarray(p.i, p.i + len); p.i += len; }
    else if (wt === 1) { v = b.subarray(p.i, p.i + 8); p.i += 8; }
    else if (wt === 5) { v = b.subarray(p.i, p.i + 4); p.i += 4; }
    else throw new Error('protobuf no válido');
    (out[field] ||= []).push(v);
  }
  return out;
}
const dec = new TextDecoder();
const str = (m, f) => (m?.[f]?.[0] instanceof Uint8Array ? dec.decode(m[f][0]) : '');
const num = (m, f) => (typeof m?.[f]?.[0] === 'number' ? m[f][0] : 0);
const msg = (m, f) => (m?.[f]?.[0] instanceof Uint8Array ? decodeProto(m[f][0]) : null);
const msgs = (m, f) => (m?.[f] || []).filter(x => x instanceof Uint8Array).map(decodeProto);

// ---------- cifrado de imágenes ----------
export function decryptImage(bytes, hexKey) {
  if (!hexKey) return bytes;
  const key = new Uint8Array(hexKey.match(/../g).map(h => parseInt(h, 16)));
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length];
  return out;
}

export function createMangaPlus({ fetchBytes, getSettings, api = API }) {
  const cache = new TTLCache(100);
  const session = (globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random().toString(16).slice(2));
  const img = (u, k) => `/api/mplus/img?u=${encodeURIComponent(u)}${k ? `&k=${k}` : ''}`;

  async function call(pathq) {
    const hit = cache.get(pathq);
    if (hit) return hit;
    let bytes;
    try {
      bytes = await fetchBytes(`${api}/${pathq}`, { 'SESSION-TOKEN': session, Origin: 'https://mangaplus.shueisha.co.jp', Referer: 'https://mangaplus.shueisha.co.jp/' });
    } catch (e) { throw new HttpError(502, `MANGA Plus no respondió (${e.message || e})`); }
    const res = decodeProto(bytes);
    const err = msg(res, 2);
    if (err) {
      const action = num(err, 1);
      const pop = msg(err, 3) || msg(err, 2);
      throw new HttpError(action === 3 ? 451 : 502, action === 3 ? 'MANGA Plus no está disponible desde tu país.' : action === 2 ? 'MANGA Plus está en mantenimiento. Intenta más tarde.' : `MANGA Plus: ${str(pop, 2) || str(pop, 1) || 'error'}`);
    }
    const ok = msg(res, 1);
    if (!ok) throw new HttpError(502, 'MANGA Plus devolvió una respuesta vacía');
    return cache.set(pathq, ok, 10 * 60_000);
  }

  const wanted = () => {
    const l = getSettings().languages || ['es', 'es-la'];
    const set = new Set(l.map(x => (x === 'es' ? 'es-la' : x)));
    return code => set.has(code);
  };
  const mapTitle = t => ({
    source: 'mangaplus', id: String(num(t, 1)), title: str(t, 2), author: str(t, 3),
    cover: str(t, 4) ? img(str(t, 4)) : null, type: 'manga', languages: [LANGS[num(t, 7)] || 'en'], views: num(t, 6),
  });

  async function allTitles() {
    const ok = await call('title_list/allV2');
    const groups = msgs(msg(ok, 25), 1);
    const seen = new Set(), out = [];
    for (const g of groups) for (const t of msgs(g, 2)) {
      const m = mapTitle(t);
      if (m.id !== '0' && !seen.has(m.id)) { seen.add(m.id); out.push(m); }
    }
    return out;
  }

  async function list({ page = 1, q = '', mode = 'popular' }) {
    const ok = wanted();
    let items = (await allTitles()).filter(t => ok(t.languages[0]));
    if (q) {
      const n = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      const qq = n(q);
      items = items.filter(t => n(t.title).includes(qq) || n(t.author).includes(qq));
    }
    if (mode === 'popular') items.sort((a, b) => b.views - a.views);
    const slice = items.slice((page - 1) * PAGE, page * PAGE).map(({ views, author, ...t }) => t);
    return { items: slice, hasMore: items.length > page * PAGE };
  }

  async function detail(id) {
    const ok = await call(`title_detailV3?title_id=${encodeURIComponent(id)}`);
    const d = msg(ok, 8);
    if (!d) throw new HttpError(404, 'Serie no encontrada en MANGA Plus');
    return d;
  }

  async function series(id) {
    const d = await detail(id);
    const t = msg(d, 1);
    const lang = LANGS[num(t, 7)] || 'en';
    return {
      source: 'mangaplus', id, title: str(t, 2), altTitles: [], description: str(d, 3), descriptionLang: lang === 'es-la' ? 'es' : lang,
      cover: str(t, 4) ? img(str(t, 4)) : null, authors: str(t, 3) ? str(t, 3).split(/\s*\/\s*/) : [], artists: [],
      status: str(d, 7) || null, type: 'manga', demographic: null, genres: [], contentRating: 'safe', year: null,
      readingDir: 'rtl', languages: [lang],
      notice: 'MANGA Plus deja gratis los primeros y los últimos capítulos de cada serie. Los de en medio se leen en su app con suscripción.',
    };
  }

  async function chapters(id) {
    const d = await detail(id);
    const lang = LANGS[num(msg(d, 1), 7)] || 'en';
    const now = Date.now() / 1000;
    const out = [];
    for (const g of msgs(d, 28)) for (const f of [2, 3, 4]) for (const c of msgs(g, f)) {
      const end = num(c, 7);
      const name = str(c, 3);
      const n = parseFloat((name.match(/[\d.]+/) || [])[0]);
      out.push({ id: String(num(c, 2)), number: Number.isFinite(n) ? n : null, volume: null, title: str(c, 4) || name, lang,
        group: 'MANGA Plus', date: num(c, 6) ? num(c, 6) * 1000 : null, pages: null, ...(end && end < now ? { unavailable: true } : {}) });
    }
    return out.reverse();
  }

  async function pages(chId) {
    const ok = await call(`manga_viewer?chapter_id=${encodeURIComponent(chId)}&split=yes&img_quality=super_high`);
    const v = msg(ok, 10);
    const list = msgs(v, 1).map(p => msg(p, 1)).filter(Boolean).filter(mp => str(mp, 1));
    if (!list.length) throw new HttpError(403, 'Este capítulo no está disponible gratis en MANGA Plus.');
    return { kind: 'images', pages: list.map(mp => ({ url: img(str(mp, 1), str(mp, 5)) })) };
  }

  return {
    id: 'mangaplus', name: 'MANGA Plus', description: 'Manga oficial y gratuito de Shueisha (One Piece, Jujutsu Kaisen, Dandadan…)',
    capabilities: { popular: true, latest: false, search: true, filters: false },
    list, getFilters: async () => ({}), series, chapters, pages,
  };
}
