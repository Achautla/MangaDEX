// Lector: modos página (der→izq / izq→der), doble página y vertical continuo (webtoon).
// Abre imágenes (MangaDex, CBZ, CBR), PDF (pdf.js) y EPUB (epub.js).
import { api, esc, toast, getSettings, chapterLabel, isDark } from './app.js';
import { STANDALONE, resolveImage, getBlob, logError } from './platform.js';

const LOGO = '/brand/logo-256.png';
const loadingHTML = '<div class="msg"><img class="loading-logo" src="/brand/logo-256.png" alt="Cargando…"></div>';

const MODES = ['rtl', 'ltr', 'webtoon'];
const MODE_LABEL = { rtl: 'Der → Izq', ltr: 'Izq → Der', webtoon: 'Vertical' };

export async function openReader(root, { src, seriesId, chapterId }) {
  const settings = await getSettings();
  const bgPref = settings.background || 'theme';
  const white = bgPref === 'white' || (bgPref === 'theme' && !isDark());
  root.innerHTML = `<div class="reader hide-ui ${white ? 'white' : ''}" tabindex="0">
    <div class="stage">${loadingHTML}</div>
    <div class="zones"><div data-z="left"></div><div data-z="center"></div><div data-z="right"></div></div>
    <div class="pagenum" hidden></div>
    <div class="ui top">
      <button class="btn icon" data-act="close" aria-label="Salir del lector" title="Salir del lector"><svg viewBox="0 0 24 24"><path d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg></button>
      <div class="grow"><div class="title" data-ui="series"></div><div class="sub" data-ui="chapter"></div></div>
    </div>
    <div class="ui bottom">
      <div class="slider">
        <button class="btn icon" data-act="prevch" aria-label="Capítulo anterior" title="Capítulo anterior"><svg viewBox="0 0 24 24"><path d="M6 6h2v12H6zm3.5 6 8.5 6V6z"/></svg></button>
        <span class="small" data-ui="cur">1</span>
        <input type="range" min="1" max="1" value="1" data-ui="range" aria-label="Página">
        <span class="small" data-ui="tot">1</span>
        <button class="btn icon" data-act="nextch" aria-label="Capítulo siguiente" title="Capítulo siguiente"><svg viewBox="0 0 24 24"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg></button>
      </div>
      <div class="tools">
        <button class="btn" data-act="mode" title="Cambiar modo de lectura"></button>
        <button class="btn" data-act="double" title="Doble página">Doble página</button>
        <button class="btn" data-act="fit" title="Ajuste de la imagen">Ajustar: alto</button>
        <span class="zoomctl" role="group" aria-label="Zoom">
          <button class="btn icon" data-act="zout" aria-label="Alejar" title="Alejar">−</button>
          <button class="btn" data-act="zreset" data-ui="zl" title="Restablecer zoom">100%</button>
          <button class="btn icon" data-act="zin" aria-label="Acercar" title="Acercar">+</button>
        </span>
      </div>
    </div>
  </div>`;
  const el = root.querySelector('.reader');
  const stage = el.querySelector('.stage');
  const ui = k => el.querySelector(`[data-ui="${k}"]`);
  const range = ui('range');
  el.focus();

  // ----- Datos de la serie y capítulos -----
  let series, chapters;
  try {
    [series, chapters] = await Promise.all([
      api(`/api/s/${src}/series/${encodeURIComponent(seriesId)}`),
      api(`/api/s/${src}/series/${encodeURIComponent(seriesId)}/chapters`),
    ]);
  } catch (e) {
    stage.innerHTML = `<div class="msg">${esc(e.message)}<br><br><button class="btn" data-act="close">Volver</button></div>`;
    el.classList.remove('hide-ui');
    stage.querySelector('[data-act]').onclick = () => history.back();
    return () => {};
  }
  ui('series').textContent = series.title;

  const modeKey = `mode:${src}:${seriesId}`;
  let mode = localStorage.getItem(modeKey) || settings.readerMode?.[series.type] || series.readingDir || 'rtl';
  let double = settings.doublePage && innerWidth > innerHeight;
  let fitWidth = false;

  let chIdx = chapters.findIndex(c => c.id === chapterId);
  if (chIdx < 0) chIdx = 0;
  let doc = null;        // { kind, count, render(i) }
  let page = 0;
  let destroyed = false;
  let saveTimer = null;
  let epub = null;

  // capítulos ordenados del más nuevo al más viejo: "siguiente" = índice menor con otro número
  function neighbor(dir) {
    const cur = chapters[chIdx];
    const cands = [];
    for (let i = chIdx + (dir > 0 ? -1 : 1); i >= 0 && i < chapters.length; i += dir > 0 ? -1 : 1) {
      const c = chapters[i];
      if (c.external) continue; // se leen en el sitio oficial
      if (c.number && cur.number && c.number === cur.number) continue;
      if (cands.length && c.number !== cands[0].c.number) break;
      cands.push({ c, i });
    }
    if (!cands.length) return null;
    return (cands.find(x => x.c.group === cur.group) || cands[0]).i;
  }

  // ----- Guardar progreso -----
  // Se guarda con una pequeña pausa; al cambiar de capítulo o salir se envía de inmediato.
  let pending = null;
  function flushProgress() {
    clearTimeout(saveTimer);
    if (!pending) return;
    const body = pending; pending = null;
    api('/api/progress', { method: 'PUT', body }).catch(() => {});
  }
  function saveProgress(extra = {}) {
    const c = chapters[chIdx];
    pending = {
      source: src, seriesId, chapterId: c.id, page: Math.min(page, Math.max(0, (doc?.count || 1) - 1)), total: doc?.count || 0,
      seriesTitle: series.title, cover: series.cover, chapterLabel: chapterLabel(c), type: series.type, ...extra,
    };
    c.progress = { ...(c.progress || {}), page: pending.page, total: pending.total, cfi: pending.cfi, done: c.progress?.done || (pending.total > 0 && pending.page >= pending.total - 1) };
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flushProgress, 700);
  }

  // ----- Carga de un capítulo -----
  async function loadChapter(idx, startPage = null) {
    flushProgress();
    chIdx = idx;
    const c = chapters[idx];
    if (location.hash !== `#/read/${src}/${encodeURIComponent(seriesId)}/${encodeURIComponent(c.id)}`) {
      history.replaceState(null, '', `#/read/${src}/${encodeURIComponent(seriesId)}/${encodeURIComponent(c.id)}`);
    }
    ui('chapter').textContent = `${chapterLabel(c)}${c.group && c.group !== 'Archivo local' ? ' · ' + c.group : ''}`;
    el.querySelector('[data-act="prevch"]').disabled = neighbor(-1) == null;
    el.querySelector('[data-act="nextch"]').disabled = neighbor(1) == null;
    stage.innerHTML = loadingHTML;
    if (c.external) {
      stage.innerHTML = `<div class="end"><img class="loading-logo" style="animation:none" src="${LOGO}" alt=""><h3>${esc(chapterLabel(c))}</h3>
        <p>Este capítulo está publicado en un sitio oficial y se lee allá.</p>
        <a class="btn primary" href="${esc(c.external)}" target="_blank" rel="noopener">Abrir en el sitio oficial ↗</a>
        <button class="btn" data-act="close">Volver a la serie</button></div>`;
      stage.querySelector('[data-act="close"]').addEventListener('click', close);
      el.classList.remove('hide-ui');
      return;
    }
    if (epub) { epub.destroy(); epub = null; }
    try {
      const info = await api(`/api/s/${src}/chapters/${encodeURIComponent(c.id)}/pages`);
      if (destroyed) return;
      if (info.kind === 'epub') return openEpub(info.url, c);
      doc = info.kind === 'pdf' ? await pdfDoc(info.url) : imageDoc(info.pages, c);
    } catch (e) {
      stage.innerHTML = `<div class="msg">No se pudo abrir el capítulo: ${esc(e.message)}<br><br><button class="btn" data-retry>Reintentar</button></div>`;
      stage.querySelector('[data-retry]').onclick = () => loadChapter(idx, startPage);
      el.classList.remove('hide-ui');
      return;
    }
    const prog = c.progress;
    page = startPage ?? (prog && !prog.done && prog.page < doc.count ? prog.page : 0);
    range.max = doc.count; ui('tot').textContent = doc.count;
    layout();
    saveProgress();
  }

  function imageDoc(pages, c) {
    let urls = pages.map(p => p.url);
    let refreshP = null;
    // Mientras llega la imagen se ve el logo de la app; si falla, se reintenta y al final se ofrece "Reintentar".
    async function load(i, img, attempt = 0) {
      try {
        const real = STANDALONE ? await resolveImage(urls[i]) : urls[i];
        await new Promise((ok, fail) => { const t = new Image(); t.onload = ok; t.onerror = () => fail(new Error('La imagen no cargó')); t.src = real; });
        if (!img.isConnected && !img._keep) return;
        img.src = real; img.alt = `Página ${i + 1}`;
        img.classList.remove('loading-logo');
        img.dispatchEvent(new Event('pageready'));
      } catch (e) {
        if (attempt === 0 && src === 'mangadex') {
          // La URL temporal de MangaDex@Home pudo caducar: se pide un servidor nuevo (una vez para todas las páginas)
          refreshP ||= api(`/api/s/${src}/chapters/${encodeURIComponent(c.id)}/pages?refresh=1`).then(f => { urls = f.pages.map(p => p.url); }).catch(() => {});
          await refreshP;
          return load(i, img, 1);
        }
        if (attempt < 2) { await new Promise(r => setTimeout(r, 1200)); return load(i, img, attempt + 1); }
        logError(`Página ${i + 1} de ${chapterLabel(c)} (${src})`, e);
        const box = document.createElement('div');
        box.className = 'pg-error';
        box.innerHTML = `<img src="${LOGO}" alt=""><p>No se pudo cargar la página ${i + 1}.</p><button class="btn" type="button">Reintentar</button>`;
        box.querySelector('button').onclick = ev => { ev.stopPropagation(); box.replaceWith(img); load(i, img, 1); };
        img.replaceWith(box);
      }
    }
    return {
      kind: 'images', count: urls.length,
      render(i) {
        const img = new Image();
        img.decoding = 'async'; img.alt = 'Cargando…'; img.draggable = false;
        img.className = 'loading-logo'; img.src = LOGO; img.dataset.i = i;
        queueMicrotask(() => load(i, img));
        return img;
      },
      preload(i) { for (let k = i + 1; k <= i + 4 && k < urls.length; k++) { if (STANDALONE) resolveImage(urls[k]).catch(() => {}); else { const p = new Image(); p.src = urls[k]; } } },
    };
  }

  async function pdfDoc(url) {
    const pdfjs = await import('/vendor/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdf.worker.mjs';
    // se descarga completo (así también funciona desde lo guardado sin conexión)
    const blob = await getBlob(url).catch(() => { throw new Error('No se pudo abrir el PDF'); });
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(await blob.arrayBuffer()) }).promise;
    return {
      kind: 'pdf', count: pdf.numPages,
      render(i) {
        const canvas = document.createElement('canvas');
        canvas.dataset.i = i;
        pdf.getPage(i + 1).then(p => {
          const base = p.getViewport({ scale: 1 });
          const target = Math.min(2000, (mode === 'webtoon' ? Math.min(innerWidth, 800) : innerWidth / (double ? 2 : 1)) * devicePixelRatio);
          const vp = p.getViewport({ scale: Math.max(target / base.width, 1) });
          canvas.width = vp.width; canvas.height = vp.height;
          canvas.style.aspectRatio = `${vp.width} / ${vp.height}`;
          return p.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
        }).catch(() => {});
        return canvas;
      },
      preload() {},
    };
  }

  async function openEpub(url, c) {
    if (!window.ePub) await new Promise((ok, fail) => { const s = document.createElement('script'); s.src = '/vendor/epub.js'; s.onload = ok; s.onerror = fail; document.head.appendChild(s); });
    doc = { kind: 'epub', count: 0 };
    el.classList.remove('webtoon'); el.classList.add('paged');
    el.querySelector('[data-act="mode"]').hidden = true;
    el.querySelector('[data-act="double"]').hidden = true;
    el.querySelector('[data-act="fit"]').hidden = true;
    el.querySelector('.zoomctl').hidden = true;
    stage.innerHTML = '<div class="epub"></div>';
    const blob = await getBlob(url).catch(() => { throw new Error('No se pudo abrir el libro'); });
    const book = window.ePub(await blob.arrayBuffer());
    const rendition = book.renderTo(stage.firstChild, { width: '100%', height: '100%', flow: 'paginated', spread: 'none' });
    const dark = isDark();
    rendition.themes.default({ body: { color: (dark ? '#e6e9ef' : '#1b2330') + ' !important', background: (dark ? '#141a22' : '#fbfaf7') + ' !important', 'line-height': '1.6' }, a: { color: (dark ? '#3d9cf0' : '#1674d1') + ' !important' } });
    epub = { destroy: () => book.destroy(), next: () => rendition.next(), prev: () => rendition.prev(), rendition };
    await rendition.display(c.progress?.cfi || undefined);
    book.ready.then(() => book.locations.generate(1600)).then(() => {
      const total = book.locations.length();
      range.max = total || 1; ui('tot').textContent = '100%';
      doc.count = total;
    }).catch(() => {});
    rendition.on('relocated', loc => {
      const pct = loc.start.percentage || 0;
      page = book.locations.length() ? book.locations.locationFromCfi(loc.start.cfi) : 0;
      ui('cur').textContent = `${Math.round(pct * 100)}%`; range.value = page + 1;
      saveProgress({ cfi: loc.start.cfi, page, total: doc.count });
    });
    range.oninput = () => { const cfi = book.locations.cfiFromLocation(Number(range.value) - 1); if (cfi) rendition.display(cfi); };
  }

  // ----- Presentación -----
  function layout() {
    if (!doc || doc.kind === 'epub') return;
    el.classList.remove('at-end');
    el.classList.toggle('webtoon', mode === 'webtoon');
    el.classList.toggle('paged', mode !== 'webtoon');
    el.classList.toggle('double', double && mode !== 'webtoon');
    el.classList.toggle('fit-width', fitWidth);
    range.classList.toggle('rtl', mode === 'rtl');
    el.querySelector('[data-act="mode"]').textContent = `Modo: ${MODE_LABEL[mode]}`;
    el.querySelector('[data-act="double"]').hidden = mode === 'webtoon';
    el.querySelector('[data-act="double"]').classList.toggle('primary', double);
    el.querySelector('[data-act="fit"]').hidden = mode === 'webtoon';
    el.querySelector('[data-act="fit"]').textContent = fitWidth ? 'Ajustar: ancho' : 'Ajustar: alto';
    setWz(1);
    if (mode === 'webtoon') buildWebtoon(); else showPage(page);
  }

  // Modo página: una o dos páginas; la "página" doc.count es la tarjeta de fin de capítulo.
  function showPage(i) {
    page = Math.max(0, Math.min(i, doc.count));
    stage.scrollTop = 0;
    el.classList.toggle('at-end', page >= doc.count);
    if (page >= doc.count) return endCard();
    const step = double ? 2 : 1;
    if (double && page % 2 === 1 && page > 0) page -= 1;
    const els = [doc.render(page)];
    if (double && page + 1 < doc.count) els.push(doc.render(page + 1));
    if (mode === 'rtl') els.reverse();
    const wrap = document.createElement('div');
    wrap.className = 'zoom';
    wrap.append(...els);
    stage.replaceChildren(wrap);
    resetZoom();
    // al cargar la imagen cambia su tamaño: recalcular límites del desplazamiento
    els.forEach(m => m.addEventListener?.('pageready', () => applyZoom(), { once: true }));
    doc.preload(page + step - 1);
    updateCounter();
    saveProgress();
  }

  function endCard() {
    resetZoom();
    const n = neighbor(1);
    stage.innerHTML = `<div class="end"><h3>Terminaste ${esc(chapterLabel(chapters[chIdx]))}</h3>
      ${n != null ? `<button class="btn primary" data-next>Siguiente: ${esc(chapterLabel(chapters[n]))}</button>` : '<p class="muted">No hay más capítulos en español por ahora.</p>'}
      <button class="btn" data-act="close">Volver a la serie</button></div>`;
    stage.querySelector('[data-next]')?.addEventListener('click', () => loadChapter(n, 0));
    stage.querySelector('[data-act="close"]').addEventListener('click', close);
    saveProgress(); // page ya está limitado a la última página al guardar
    updateCounter();
  }

  function buildWebtoon() {
    const n = neighbor(1);
    stage.innerHTML = Array.from({ length: doc.count }, (_, i) => `<div class="pg" data-p="${i}"><img class="loading-logo" src="${LOGO}" alt=""></div>`).join('') +
      `<div class="end"><h3>Fin de ${esc(chapterLabel(chapters[chIdx]))}</h3>${n != null ? `<button class="btn primary" data-next>Siguiente: ${esc(chapterLabel(chapters[n]))}</button>` : '<p class="muted">No hay más capítulos en español por ahora.</p>'}</div>`;
    stage.querySelector('[data-next]')?.addEventListener('click', () => loadChapter(n, 0));
    const loadObs = new IntersectionObserver(entries => {
      for (const e of entries) {
        if (!e.isIntersecting || e.target.dataset.loaded) continue;
        const i = Number(e.target.dataset.p); e.target.dataset.loaded = '1';
        const media = doc.render(i);
        const done = () => e.target.classList.add('loaded');
        media.addEventListener?.('pageready', done);
        if (media.tagName === 'CANVAS') done();
        e.target.replaceChildren(media);
      }
    }, { root: stage, rootMargin: '2000px 0px' });
    const posObs = new IntersectionObserver(entries => {
      for (const e of entries) if (e.isIntersecting) { page = Number(e.target.dataset.p); updateCounter(); saveProgress(); }
    }, { root: stage, rootMargin: '-50% 0px -50% 0px' });
    stage.querySelectorAll('.pg').forEach(p => { loadObs.observe(p); posObs.observe(p); });
    observers.push(loadObs, posObs);
    const target = stage.querySelector(`[data-p="${page}"]`);
    if (page > 0 && target) {
      // cargar las páginas anteriores para que el salto quede en su sitio
      requestAnimationFrame(() => target.scrollIntoView());
    }
    updateCounter();
  }
  const observers = [];

  function updateCounter() {
    const shown = Math.min(page, doc.count - 1) + 1;
    ui('cur').textContent = shown; range.value = shown;
    const pn = el.querySelector('.pagenum');
    pn.hidden = false; pn.textContent = `${shown} / ${doc.count}`;
  }

  // ----- Navegación -----
  const step = () => (double && mode !== 'webtoon' ? 2 : 1);
  function go(delta) {
    if (epub) return delta > 0 ? epub.next() : epub.prev();
    if (!doc) return;
    if (mode === 'webtoon') { stage.scrollBy({ top: delta * innerHeight * 0.85, behavior: 'smooth' }); return; }
    if (delta < 0 && page === 0) { const p = neighbor(-1); if (p != null) loadChapter(p, 0); return; }
    if (delta > 0 && page >= doc.count) { const n = neighbor(1); if (n != null) loadChapter(n, 0); return; }
    showPage(page + delta * step());
  }
  const toggleUI = () => el.classList.toggle('hide-ui');
  function close() {
    location.hash = `#/series/${src}/${encodeURIComponent(seriesId)}`;
  }

  // ----- Zoom -----
  // Modo página: pellizcar, doble toque al centro, arrastrar para mover; botones − / +; Ctrl+rueda en PC.
  // Modo vertical: pellizcar o doble toque para ensanchar las páginas (se desplaza en ambos ejes).
  const Z = { s: 1, x: 0, y: 0 };
  let wz = 1;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const zoomWrap = () => stage.querySelector(':scope > .zoom');
  const zoomLabel = () => { const l = ui('zl'); if (l) l.textContent = `${Math.round((mode === 'webtoon' ? wz : Z.s) * 100)}%`; };
  function applyZoom() {
    const w = zoomWrap(); if (!w) return;
    const W = stage.clientWidth, H = stage.clientHeight, h = w.offsetHeight;
    Z.s = clamp(Z.s, 1, 5);
    Z.x = clamp(Z.x, Math.min(0, W - W * Z.s), 0);
    Z.y = clamp(Z.y, Math.min(0, H - h * Z.s), 0);
    w.style.transform = `translate(${Z.x}px, ${Z.y}px) scale(${Z.s})`;
    el.classList.toggle('zoomed', Z.s > 1.01);
    zoomLabel();
  }
  function resetZoom() { Z.s = 1; Z.x = 0; Z.y = 0; applyZoom(); zoomLabel(); }
  function zoomAt(ns, cx, cy) {
    const r = stage.getBoundingClientRect();
    const px = (cx - r.left - Z.x) / Z.s, py = (cy - r.top - Z.y) / Z.s;
    Z.s = clamp(ns, 1, 5);
    Z.x = cx - r.left - px * Z.s; Z.y = cy - r.top - py * Z.s;
    applyZoom();
  }
  function setWz(nz, cx, cy) {
    const old = wz; wz = clamp(nz, 1, 3);
    if (mode !== 'webtoon') { stage.style.removeProperty('--wz'); zoomLabel(); return; }
    const r = stage.getBoundingClientRect();
    const mx = (cx ?? r.left + r.width / 2) - r.left, my = (cy ?? r.top + r.height / 2) - r.top;
    const fx = (stage.scrollLeft + mx) / old, fy = (stage.scrollTop + my) / old;
    stage.style.setProperty('--wz', wz);
    stage.scrollLeft = fx * wz - mx;
    stage.scrollTop = fy * wz - my;
    zoomLabel();
  }
  const centerOf = () => { const r = stage.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; };

  // Toques en modo página (capa .zones encima de la imagen)
  const zones = el.querySelector('.zones');
  let g = null, moved = false;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => [(a.clientX + b.clientX) / 2, (a.clientY + b.clientY) / 2];
  zones.addEventListener('touchstart', e => {
    const t = e.touches;
    if (t.length === 2) {
      const [mx, my] = mid(t[0], t[1]);
      g = { kind: 'pinch', d0: dist(t[0], t[1]), s0: Z.s, x0: Z.x, y0: Z.y, mx, my };
      moved = true;
    } else if (t.length === 1 && (!g || g.kind !== 'pinch')) {
      g = { kind: 'one', sx: t[0].clientX, sy: t[0].clientY, zx: Z.x, zy: Z.y };
      moved = false;
    }
  }, { passive: true });
  zones.addEventListener('touchmove', e => {
    if (!g) return;
    const t = e.touches;
    if (g.kind === 'pinch' && t.length >= 2) {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const [mx, my] = mid(t[0], t[1]);
      const ns = clamp(g.s0 * dist(t[0], t[1]) / g.d0, 1, 5);
      const px = (g.mx - r.left - g.x0) / g.s0, py = (g.my - r.top - g.y0) / g.s0;
      Z.s = ns; Z.x = mx - r.left - px * ns; Z.y = my - r.top - py * ns;
      applyZoom();
    } else if (g.kind === 'one' && t.length === 1) {
      const dx = t[0].clientX - g.sx, dy = t[0].clientY - g.sy;
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) moved = true;
      const w = zoomWrap();
      const canPan = Z.s > 1.01 || (w && w.offsetHeight > stage.clientHeight + 2);
      if (canPan) { e.preventDefault(); Z.x = g.zx + dx; Z.y = g.zy + dy; applyZoom(); g.panned = true; }
    }
  }, { passive: false });
  zones.addEventListener('touchend', e => {
    if (!g) return;
    if (g.kind === 'one' && !g.panned && e.changedTouches.length) {
      const dx = e.changedTouches[0].clientX - g.sx, dy = e.changedTouches[0].clientY - g.sy;
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy)) { go((dx < 0) !== (mode === 'rtl') ? 1 : -1); }
    }
    if (e.touches.length === 0) { g = null; setTimeout(() => { moved = false; }, 400); }
    else if (g?.kind === 'pinch' && e.touches.length === 1) g = null; // terminar el pellizco limpio
  });
  // Toques: lados = pasar página; centro = barras (doble toque = zoom)
  let lastCenter = 0, centerTimer = null;
  zones.addEventListener('click', e => {
    if (moved) { moved = false; return; }
    const z = e.target.dataset.z;
    if (z === 'center') {
      const now = Date.now();
      if (now - lastCenter < 300) {
        clearTimeout(centerTimer); lastCenter = 0;
        if (Z.s > 1.01) resetZoom(); else zoomAt(2.5, e.clientX, e.clientY);
        return;
      }
      lastCenter = now;
      centerTimer = setTimeout(toggleUI, 280);
      return;
    }
    if (!el.classList.contains('hide-ui')) { el.classList.add('hide-ui'); return; }
    const forward = (z === 'right') !== (mode === 'rtl');
    go(forward ? 1 : -1);
  });
  // PC: Ctrl + rueda = zoom; rueda sola desplaza si la página no cabe
  el.addEventListener('wheel', e => {
    if (epub) return;
    if (e.ctrlKey) {
      e.preventDefault();
      const f = Math.exp(-e.deltaY / 300);
      if (mode === 'webtoon') setWz(wz * f, e.clientX, e.clientY); else zoomAt(Z.s * f, e.clientX, e.clientY);
    } else if (mode !== 'webtoon' && zoomWrap()) {
      const w = zoomWrap();
      if (Z.s > 1.01 || w.offsetHeight > stage.clientHeight + 2) { e.preventDefault(); Z.y -= e.deltaY; Z.x -= e.deltaX; applyZoom(); }
    }
  }, { passive: false });

  // Modo vertical: pellizcar sobre la tira, doble toque, y tocar para barras
  let wg = null, downY = 0, lastWT = 0, wTimer = null;
  stage.addEventListener('touchstart', e => {
    if (mode !== 'webtoon' || e.touches.length !== 2) return;
    const [mx, my] = mid(e.touches[0], e.touches[1]);
    wg = { d0: dist(e.touches[0], e.touches[1]), z0: wz, mx, my };
  }, { passive: true });
  stage.addEventListener('touchmove', e => {
    if (!wg || e.touches.length < 2) return;
    e.preventDefault();
    setWz(wg.z0 * dist(e.touches[0], e.touches[1]) / wg.d0, wg.mx, wg.my);
  }, { passive: false });
  stage.addEventListener('touchend', e => { if (e.touches.length < 2) wg = null; });
  stage.addEventListener('pointerdown', e => { downY = e.clientY; });
  stage.addEventListener('click', e => {
    if (mode !== 'webtoon' || epub || Math.abs(e.clientY - downY) > 8 || e.target.closest('button')) return;
    const now = Date.now();
    if (now - lastWT < 300) { clearTimeout(wTimer); lastWT = 0; setWz(wz > 1.01 ? 1 : 2, e.clientX, e.clientY); return; }
    lastWT = now;
    wTimer = setTimeout(toggleUI, 280);
  });

  const onKey = e => {
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;
    const k = e.key;
    if (k === 'Escape') return close();
    if (k === 'm') return el.querySelector('[data-act="mode"]').click();
    if (mode === 'webtoon' && !epub) {
      if (k === ' ' || k === 'PageDown') { e.preventDefault(); go(1); }
      if (k === 'PageUp') { e.preventDefault(); go(-1); }
      return;
    }
    if (k === 'ArrowRight') go(mode === 'rtl' ? -1 : 1);
    else if (k === 'ArrowLeft') go(mode === 'rtl' ? 1 : -1);
    else if (k === ' ' || k === 'ArrowDown' || k === 'PageDown') { e.preventDefault(); go(1); }
    else if (k === 'ArrowUp' || k === 'PageUp') { e.preventDefault(); go(-1); }
  };
  document.addEventListener('keydown', onKey);

  el.querySelector('.ui.top').addEventListener('click', e => { if (e.target.closest('[data-act="close"]')) close(); });
  el.querySelector('.ui.bottom').addEventListener('click', e => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'prevch') { const p = neighbor(-1); if (p != null) loadChapter(p, 0); }
    if (act === 'nextch') { const n = neighbor(1); if (n != null) loadChapter(n, 0); }
    if (act === 'mode') {
      mode = MODES[(MODES.indexOf(mode) + 1) % MODES.length];
      localStorage.setItem(modeKey, mode);
      observers.splice(0).forEach(o => o.disconnect());
      layout(); toast(`Modo: ${MODE_LABEL[mode]} (se recuerda para esta serie)`);
    }
    if (act === 'double') { double = !double; layout(); }
    if (act === 'fit') { fitWidth = !fitWidth; layout(); }
    if (act === 'zin' || act === 'zout' || act === 'zreset') {
      const f = act === 'zin' ? 1.5 : act === 'zout' ? 1 / 1.5 : 0;
      const [cx, cy] = centerOf();
      if (mode === 'webtoon') setWz(f ? wz * f : 1, cx, cy);
      else if (f) zoomAt(Z.s * f, cx, cy); else resetZoom();
    }
  });
  range.addEventListener('input', () => {
    if (!doc || epub) return;
    const target = Number(range.value) - 1;
    if (mode === 'webtoon') stage.querySelector(`[data-p="${target}"]`)?.scrollIntoView();
    else showPage(target);
  });

  await loadChapter(chIdx);

  return () => {
    destroyed = true;
    flushProgress(); // guardar al salir
    document.removeEventListener('keydown', onKey);
    observers.forEach(o => o.disconnect());
    if (epub) epub.destroy();
  };
}
