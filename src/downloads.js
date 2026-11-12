// Descargas en la computadora: cada capítulo se guarda como un CBZ (ZIP de imágenes + ComicInfo.xml).
// Los capítulos descargados se leen sin internet y se pueden exportar como archivo.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import { openArchive } from './archive.js';
import { HttpError, sleep } from './util.js';

const safeName = s => String(s || 'sin-nombre').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'sin-nombre';
const xmlEsc = s => String(s ?? '').replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

export function createDownloads({ config, store, sources }) {
  const root = path.join(config.dataDir, 'descargas');
  fs.mkdirSync(root, { recursive: true });
  const db = store.db;
  db.downloads ||= {};          // "fuente:capítulo" -> datos del CBZ
  db.downloadSnapshots ||= {};  // "fuente:serie" -> { series, chapters } para leer sin internet
  const queue = [];             // trabajos en memoria
  let running = false;

  const key = (src, cid) => `${src}:${cid}`;
  const label = c => [c.volume ? `Vol. ${c.volume}` : '', c.number ? `Cap. ${c.number}` : '', c.title || ''].filter(Boolean).join(' ') || 'Oneshot';

  async function enqueue(src, seriesId, chapterIds) {
    const source = sources[src];
    if (!source) throw new HttpError(404, 'Fuente desconocida');
    if (src === 'local') throw new HttpError(400, 'Los archivos locales ya están en tu computadora');
    const [series, chapters] = await Promise.all([source.series(seriesId), source.chapters(seriesId)]);
    db.downloadSnapshots[key(src, seriesId)] = { series, chapters, at: Date.now() };
    store.save();
    warmCover(series.cover);
    let added = 0;
    for (const cid of chapterIds) {
      const c = chapters.find(x => x.id === cid);
      if (!c) continue;
      const k = key(src, cid);
      if (db.downloads[k] || queue.some(j => j.key === k && j.status !== 'error')) continue;
      const old = queue.findIndex(j => j.key === k);
      if (old >= 0) queue.splice(old, 1);
      queue.push({ key: k, source: src, seriesId, chapterId: cid, seriesTitle: series.title, cover: series.cover,
        chapter: c, label: label(c), status: 'queued', done: 0, total: c.pages || 0, error: null });
      added++;
    }
    run();
    return added;
  }

  // Calienta la caché de la portada para que se vea sin internet.
  function warmCover(cover) {
    if (cover) fetch(`http://127.0.0.1:${config.port}${cover}`).catch(() => {});
  }

  async function run() {
    if (running) return;
    running = true;
    try {
      for (let job; (job = queue.find(j => j.status === 'queued'));) {
        job.status = 'downloading';
        try { await downloadChapter(job); job.status = 'done'; }
        catch (e) { if (job.status !== 'cancelled') { job.status = 'error'; job.error = e.message; } }
        // los terminados se quitan de la cola después de un momento
        if (job.status === 'done') setTimeout(() => { const i = queue.indexOf(job); if (i >= 0) queue.splice(i, 1); }, 15000);
      }
    } finally { running = false; }
  }

  const resolve = url => {
    if (url.startsWith('/api/img?u=')) return decodeURIComponent(url.slice('/api/img?u='.length));
    if (/^https?:/.test(url)) return url;
    return `http://127.0.0.1:${config.port}${url}`;
  };

  async function fetchImage(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const r = await fetch(resolve(url), { headers: { 'User-Agent': 'LectorPersonal/1.0' }, signal: AbortSignal.timeout(30000) });
        if (r.ok) return { buf: Buffer.from(await r.arrayBuffer()), type: r.headers.get('content-type') || 'image/jpeg' };
        if (r.status === 403 || r.status === 404) throw Object.assign(new Error('expirado'), { expired: true });
      } catch (e) { if (e.expired) throw e; }
      await sleep(800 * (attempt + 1));
    }
    throw new Error('No se pudo descargar una página');
  }

  async function downloadChapter(job) {
    const source = sources[job.source];
    let info = await source.pages(job.chapterId);
    if (info.kind !== 'images') throw new Error('Formato no descargable');
    job.total = info.pages.length;
    const files = new Array(info.pages.length);
    let refreshP = null, next = 0;
    const worker = async () => {
      while (next < info.pages.length) {
        if (job.status === 'cancelled') throw new Error('Cancelado');
        const i = next++;
        let img;
        try { img = await fetchImage(info.pages[i].url); }
        catch (e) {
          if (job.source !== 'mangadex') throw e;
          // El enlace temporal caducó: se pide otro servidor una sola vez y todos los hilos lo esperan.
          refreshP ||= source.pages(job.chapterId, { refresh: true }).then(fresh => { info = fresh; });
          await refreshP;
          img = await fetchImage(info.pages[i].url);
        }
        const ext = /png/.test(img.type) ? 'png' : /webp/.test(img.type) ? 'webp' : /gif/.test(img.type) ? 'gif' : 'jpg';
        files[i] = { name: `${String(i + 1).padStart(3, '0')}.${ext}`, buf: img.buf };
        job.done++;
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (job.status === 'cancelled') throw new Error('Cancelado');

    const snap = db.downloadSnapshots[key(job.source, job.seriesId)];
    const s = snap?.series || {};
    const dir = path.join(root, job.source, safeName(job.seriesTitle) + ' [' + safeName(job.seriesId).slice(0, 12) + ']');
    await fsp.mkdir(dir, { recursive: true });
    const base = `${safeName(job.label)}${job.chapter.group ? ' - ' + safeName(job.chapter.group) : ''}`;
    const file = path.join(dir, base + '.cbz');
    const tmp = file + '.part';
    const comicInfo = `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo>
  <Series>${xmlEsc(job.seriesTitle)}</Series>
  <Number>${xmlEsc(job.chapter.number || '')}</Number>
  ${job.chapter.volume ? `<Volume>${xmlEsc(job.chapter.volume)}</Volume>` : ''}
  <Title>${xmlEsc(job.chapter.title || '')}</Title>
  <Summary>${xmlEsc(s.description || '')}</Summary>
  <Writer>${xmlEsc((s.authors || []).join(', '))}</Writer>
  <Penciller>${xmlEsc((s.artists || []).join(', '))}</Penciller>
  <Genre>${xmlEsc((s.genres || []).map(g => g.name || g).join(', '))}</Genre>
  <Translator>${xmlEsc(job.chapter.group || '')}</Translator>
  <LanguageISO>${xmlEsc(job.chapter.lang || 'es')}</LanguageISO>
  <Manga>${s.type === 'manga' ? 'YesAndRightToLeft' : 'No'}</Manga>
  ${s.readingDir === 'webtoon' ? '<Format>Webtoon</Format>' : ''}
  <PageCount>${files.length}</PageCount>
</ComicInfo>`;
    await new Promise((ok, fail) => {
      const out = fs.createWriteStream(tmp);
      const zip = new ZipArchive({ store: true }); // las imágenes ya vienen comprimidas
      out.on('close', ok); zip.on('error', fail); out.on('error', fail);
      zip.pipe(out);
      zip.append(comicInfo, { name: 'ComicInfo.xml' });
      for (const f of files) zip.append(f.buf, { name: f.name });
      zip.finalize();
    });
    await fsp.rename(tmp, file);
    const st = await fsp.stat(file);
    db.downloads[job.key] = {
      source: job.source, seriesId: job.seriesId, chapterId: job.chapterId, seriesTitle: job.seriesTitle, cover: job.cover,
      label: job.label, number: job.chapter.number, group: job.chapter.group, lang: job.chapter.lang,
      file: path.relative(root, file), bytes: st.size, pages: files.length, at: Date.now(),
    };
    store.save();
  }

  function cancel(k) {
    const j = queue.find(j => j.key === k);
    if (!j) return false;
    if (j.status === 'queued' || j.status === 'error') queue.splice(queue.indexOf(j), 1);
    else j.status = 'cancelled';
    setTimeout(() => { const i = queue.indexOf(j); if (i >= 0 && j.status === 'cancelled') queue.splice(i, 1); }, 2000);
    return true;
  }
  function retry(k) {
    const j = queue.find(j => j.key === k && j.status === 'error');
    if (j) { j.status = 'queued'; j.done = 0; j.error = null; run(); }
    return !!j;
  }

  async function remove(src, cid) {
    const d = db.downloads[key(src, cid)];
    if (!d) return false;
    await fsp.rm(path.join(root, d.file), { force: true });
    delete db.downloads[key(src, cid)];
    store.save();
    return true;
  }
  async function removeSeries(src, sid) {
    for (const d of Object.values(db.downloads)) if (d.source === src && d.seriesId === sid) await remove(src, d.chapterId);
    delete db.downloadSnapshots[key(src, sid)];
    store.save();
  }

  function status() {
    const bySeries = {};
    for (const d of Object.values(db.downloads)) {
      const k = key(d.source, d.seriesId);
      const g = bySeries[k] ||= { source: d.source, seriesId: d.seriesId, seriesTitle: d.seriesTitle, cover: d.cover, chapters: [], bytes: 0 };
      g.chapters.push(d); g.bytes += d.bytes;
    }
    for (const g of Object.values(bySeries)) g.chapters.sort((a, b) => (parseFloat(b.number) || 0) - (parseFloat(a.number) || 0));
    return {
      queue: queue.map(({ chapter, ...j }) => j),
      series: Object.values(bySeries).sort((a, b) => a.seriesTitle.localeCompare(b.seriesTitle, 'es')),
    };
  }

  const get = (src, cid) => {
    const d = db.downloads[key(src, cid)];
    if (!d) return null;
    const abs = path.join(root, d.file);
    return fs.existsSync(abs) ? { ...d, abs } : null;
  };

  async function pagesFor(src, cid) {
    const d = get(src, cid);
    if (!d) return null;
    const arc = await openArchive(d.abs, 'zip');
    return { kind: 'images', downloaded: true, pages: arc.names.map((_, i) => ({ url: `/api/dl/page/${src}/${encodeURIComponent(cid)}/${i}` })) };
  }
  async function pageImage(src, cid, n) {
    const d = get(src, cid);
    if (!d) throw new HttpError(404, 'No descargado');
    const arc = await openArchive(d.abs, 'zip');
    if (!(n >= 0 && n < arc.names.length)) throw new HttpError(404, 'Página fuera de rango');
    return { data: await arc.read(n), name: arc.names[n] };
  }

  return {
    enqueue, cancel, retry, remove, removeSeries, status, get, pagesFor, pageImage,
    snapshot: (src, sid) => db.downloadSnapshots[key(src, sid)] || null,
    isDownloaded: (src, cid) => !!db.downloads[key(src, cid)],
  };
}
