// Pirate Reader — lector personal de cómics, manhwa y manga (SPA sin compilación).
import { openReader } from './reader.js';
import { STANDALONE, platformApi, imgAttr, shareFiles, syncSystemBars, logError, readLog, clearLog } from './platform.js';
import {
  deviceSupported, saveToDevice, removeFromDevice, deviceList, isOnDevice, deviceQueue, onDeviceQueue,
  cancelDevice, storageInfo, fmtBytes,
} from './offline.js';

const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- API (con modo sin conexión) ----------
let offline = false;
const OFFLINE_MSG = STANDALONE ? 'Sin conexión a internet: mostrando lo guardado en este teléfono.' : 'Sin conexión con la computadora: mostrando lo guardado en este dispositivo.';
const PENDING_KEY = 'pendingProgress';
export async function api(path, opts = {}) {
  if (STANDALONE) {
    // APK: no hay servidor, las rutas se atienden dentro de la app
    try {
      const data = await platformApi(path, opts);
      if (!navigator.onLine) setOffline(true);
      else if (offline) setOffline(false);
      return data;
    } catch (e) {
      if (!navigator.onLine) setOffline(true);
      logError(`API ${path.split('?')[0]}`, e);
      throw e;
    }
  }
  let res;
  try {
    res = await fetch(path, {
      ...opts,
      headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
  } catch {
    setOffline(true);
    // el progreso de lectura se guarda para enviarlo cuando vuelva la conexión
    if (path === '/api/progress' && opts.method === 'PUT') { queueProgress(opts.body); return opts.body; }
    throw new Error('Sin conexión con el servidor. Solo puedes leer lo guardado en este dispositivo.');
  }
  const data = await res.json().catch(() => ({}));
  if (data?.offline && res.status === 503) {
    setOffline(true);
    if (path === '/api/progress' && opts.method === 'PUT') { queueProgress(opts.body); return opts.body; }
    throw new Error(path.includes('/pages') ? 'Este capítulo no está guardado en este dispositivo y no hay conexión con la computadora.' : 'Sin conexión con el servidor. Solo puedes leer lo guardado en este dispositivo.');
  }
  if (res.headers.get('X-Offline')) setOffline(true);
  else if (offline) { setOffline(false); flushProgress(); }
  if (!res.ok) { const err = new Error(data.error || `Error ${res.status}`); logError(`API ${path.split('?')[0]}`, err); throw err; }
  return data;
}
function queueProgress(body) {
  const q = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
  q[`${body.source}:${body.chapterId}`] = body;
  localStorage.setItem(PENDING_KEY, JSON.stringify(q));
}
async function flushProgress() {
  const q = JSON.parse(localStorage.getItem(PENDING_KEY) || '{}');
  localStorage.removeItem(PENDING_KEY);
  for (const body of Object.values(q)) await api('/api/progress', { method: 'PUT', body }).catch(() => {});
}
function setOffline(v) {
  if (offline === v) return;
  offline = v;
  document.body.classList.toggle('is-offline', v);
  $('.offline-bar')?.remove();
  if (v && !document.body.classList.contains('reading')) view.insertAdjacentHTML('afterbegin', `<div class="offline-bar">${OFFLINE_MSG}</div>`);
}
window.addEventListener('online', () => { api('/api/settings').catch(() => {}); });

let toastTimer;
export function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}
let settingsCache = null;
export async function getSettings(force) {
  if (!settingsCache || force) {
    try {
      settingsCache = await api('/api/settings');
      localStorage.setItem('settingsCopy', JSON.stringify(settingsCache));
    } catch (e) {
      const copy = localStorage.getItem('settingsCopy');
      if (!copy) throw e;
      settingsCache = JSON.parse(copy);
    }
  }
  return settingsCache;
}

// ---------- Tema ----------
export function applyTheme(theme = 'light') {
  try { localStorage.setItem('theme', theme); } catch {}
  const t = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', t === 'dark' ? '#0f141b' : '#f5f7fa');
  syncSystemBars(t === 'dark');
}
export const isDark = () => document.documentElement.dataset.theme === 'dark';
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (localStorage.getItem('theme') === 'system') applyTheme('system'); });

// ---------- Perfil ----------
const AVATARS = [['📚', '#1674d1'], ['🐉', '#ef6c1a'], ['⚔️', '#6a4bd6'], ['🌙', '#283b8f'], ['🔥', '#d2462b'], ['🌸', '#c2286b'], ['🦊', '#e07b10'], ['🎧', '#0d8a7c']];
export function avatarHTML(p, cls = '') {
  const a = p?.avatar || {};
  if (a.type === 'photo' && a.value) return `<span class="avatar ${cls}"><img src="${esc(a.value)}" alt=""></span>`;
  if (a.type === 'emoji') return `<span class="avatar ${cls}" style="background:${esc(a.color)}" aria-hidden="true">${esc(a.value)}</span>`;
  return `<span class="avatar ${cls}" style="background:var(--accent)" aria-hidden="true">${esc((p?.name || '?').trim()[0]?.toUpperCase() || '?')}</span>`;
}
function updateNavAvatar(p) {
  const nav = $('#nav-avatar');
  if (!nav) return;
  nav.outerHTML = avatarHTML(p).replace('class="avatar ', 'id="nav-avatar" class="avatar ');
}

const ICON = {
  search: '<svg viewBox="0 0 24 24"><path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/></svg>',
  filter: '<svg viewBox="0 0 24 24"><path d="M3 5h18l-7 8v6l-4 2v-8z"/></svg>',
  back: '<svg viewBox="0 0 24 24"><path d="M15.4 5.4 14 4l-8 8 8 8 1.4-1.4L8.8 12z"/></svg>',
  refresh: '<svg viewBox="0 0 24 24"><path d="M12 4a8 8 0 0 1 7.4 5H17v2h6V5h-2v2.3A10 10 0 1 0 22 12h-2a8 8 0 1 1-8-8z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="m9 16.2-4.2-4.2-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>',
  sort: '<svg viewBox="0 0 24 24"><path d="M7 4 3 8h3v12h2V8h3zm10 16 4-4h-3V4h-2v12h-3z"/></svg>',
  download: '<svg viewBox="0 0 24 24"><path d="M11 3h2v9.2l3.3-3.3 1.4 1.4L12 16l-5.7-5.7 1.4-1.4 3.3 3.3zM4 18h16v2H4z"/></svg>',
  pc: '<svg viewBox="0 0 24 24"><path d="M3 4h18v12H3zm2 2v8h14V6zM8 18h8v2H8z"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><path d="M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v13h10V5zm4 14v1h2v-1z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7zm3 2v8h2v-8zm4 0v8h2v-8z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 2h8l6 6v14H6zm7 1.5V9h5.5zM9 13h6v2H9zm0 4h6v2H9z"/></svg>',
  history: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 1-8.5 6h2.2A7 7 0 1 0 12 5V3zm-1 4h2v5l4 2.3-1 1.7-5-3z"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M10.3 2h3.4l.5 2.6 1.9.8 2.2-1.5 2.4 2.4-1.5 2.2.8 1.9 2.6.5v3.4l-2.6.5-.8 1.9 1.5 2.2-2.4 2.4-2.2-1.5-1.9.8-.5 2.6h-3.4l-.5-2.6-1.9-.8-2.2 1.5-2.4-2.4 1.5-2.2-.8-1.9L2 13.7v-3.4l2.6-.5.8-1.9-1.5-2.2 2.4-2.4 2.2 1.5 1.9-.8zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>',
  chevron: '<svg viewBox="0 0 24 24"><path d="M8.6 5.4 10 4l8 8-8 8-1.4-1.4 6.6-6.6z"/></svg>',
  user: '<svg viewBox="0 0 24 24"><path d="M12 3a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9zm0 11c4.4 0 8 2.2 8 5v2H4v-2c0-2.8 3.6-5 8-5z"/></svg>',
  camera: '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M9 3h6l1.5 2H20a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h3.5zm3 5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z"/></svg>',
};

const typeLabel = t => ({ manga: 'Manga', manhwa: 'Manhwa', manhua: 'Manhua', 'cómic': 'Cómic', libro: 'Libro' }[t] || t || '');
// Etiquetas de idioma del contenido
const LANG_NAME = { es: 'Español (España)', 'es-la': 'Español latino', en: 'Inglés', 'pt-br': 'Portugués', pt: 'Portugués', fr: 'Francés', it: 'Italiano', de: 'Alemán', ja: 'Japonés', ko: 'Coreano', zh: 'Chino' };
const langName = l => (l ? LANG_NAME[l] || l.toUpperCase() : 'Idioma no indicado');
const langShort = l => (!l ? '?' : l.startsWith('es') ? 'ES' : l.split('-')[0].toUpperCase());
const langBadge = langs => {
  const shorts = [...new Set((langs || []).map(langShort))];
  return `<span class="badge lang" title="${esc((langs || []).map(langName).join(', ') || 'Idioma no indicado')}">${esc(shorts.length ? shorts.join(' · ') : '?')}</span>`;
};
export { langName };
const chapterLabel = c => {
  const parts = [];
  if (c.volume) parts.push(`Vol. ${c.volume}`);
  if (c.number) parts.push(`Cap. ${c.number}`);
  const base = parts.join(' ') || (c.title ? '' : 'Oneshot');
  return c.title ? (base ? `${base} · ${c.title}` : c.title) : base;
};
export { chapterLabel, typeLabel };
const fmtDate = d => d ? new Date(d).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' }) : '';

function cardHTML(s, extra = '') {
  const href = `#/series/${s.source}/${encodeURIComponent(s.id)}`;
  return `<a class="card" href="${href}">
    <div class="cover">${s.cover ? `<img loading="lazy" ${imgAttr(s.cover)} alt="">` : ''}
      ${s.type ? `<span class="badge">${esc(typeLabel(s.type))}</span>` : ''}${langBadge(s.languages)}${extra}</div>
    <div class="t">${esc(s.title)}</div></a>`;
}
const skeletonGrid = n => `<div class="grid">${Array.from({ length: n }, () => '<div class="card"><div class="cover skel"></div><div class="skel" style="height:14px;width:80%"></div></div>').join('')}</div>`;
const errorBox = (msg, retry = true) => `<div class="err">${esc(msg)} ${retry ? '<button class="btn" data-retry style="margin-left:8px">Reintentar</button>' : ''}</div>`;

// ---------- Router ----------
const routes = {
  welcome: viewWelcome, library: viewLibrary, updates: viewUpdates, history: viewHistory, explore: viewExplore,
  settings: viewSettings, series: viewSeries, read: viewRead, downloads: viewDownloads, more: viewMore,
};
const TAB_OF = { history: 'more', settings: 'more', welcome: 'more', series: null, read: null };
let cleanup = null;
async function route() {
  if (cleanup) { try { cleanup(); } catch {} cleanup = null; }
  document.body.classList.remove('reading', 'welcoming');
  const raw = location.hash.slice(2) || 'library';
  const [pathPart, query = ''] = raw.split('?');
  const [name, ...params] = pathPart.split('/').map(decodeURIComponent);
  // Primera vez: pantalla de bienvenida para crear el perfil
  let settings = null;
  try { settings = await getSettings(); } catch {}
  if (settings && !settings.profile && name !== 'welcome') { location.replace('#/welcome'); return; }
  const fn = routes[name] || viewLibrary;
  const tab = name in TAB_OF ? TAB_OF[name] : name;
  document.querySelectorAll('.tabs a').forEach(a => a.classList.toggle('on', a.dataset.tab === tab));
  view.innerHTML = '';
  window.scrollTo(0, 0);
  if (offline && name !== 'read') view.insertAdjacentHTML('afterbegin', `<div class="offline-bar">${OFFLINE_MSG}</div>`);
  const res = await fn(params, new URLSearchParams(query));
  if (typeof res === 'function') cleanup = res;
}
window.addEventListener('hashchange', route);

// ---------- Bienvenida / editar perfil ----------
async function viewWelcome(_, qs) {
  const s = await getSettings().catch(() => ({}));
  const editing = !!s.profile;
  document.body.classList.toggle('welcoming', !editing);
  const p = s.profile || {};
  let avatar = p.avatar || { type: 'emoji', value: AVATARS[0][0], color: AVATARS[0][1] };
  const lang = (s.languages || ['es', 'es-la']).length === 2 ? 'both' : s.languages[0];
  const theme = localStorage.getItem('theme') || s.theme || 'light';
  view.innerHTML = `<div class="welcome">
    ${editing ? `<button class="btn" id="back" style="margin-bottom:16px">${ICON.back}Volver</button>` : `<img class="hero-img" src="/brand/portada.jpg" alt="Pirate Reader — Cómics, Manhwa y Manga">`}
    <h1>${editing ? 'Editar perfil' : 'Bienvenido'}</h1>
    <p class="muted" style="margin:0">${editing ? (STANDALONE ? 'Tus cambios se guardan en este teléfono.' : 'Los cambios se aplican en todos tus dispositivos.') : (STANDALONE ? 'Crea tu perfil para empezar. Tu biblioteca, progreso y descargas quedan guardados en este teléfono.' : 'Crea tu perfil para empezar. Tu biblioteca, progreso y descargas quedan guardados en tu computadora.')}</p>
    <form class="form" id="pf" novalidate>
      <div>
        <label class="lbl" for="pname">Tu nombre</label>
        <input class="input" id="pname" name="name" maxlength="40" autocomplete="nickname" value="${esc(p.name || '')}" required>
        <div class="field-err" id="pname-err" hidden></div>
      </div>
      <div>
        <span class="lbl">Avatar</span>
        <div class="avatars" id="avs" role="group" aria-label="Elige un avatar">
          ${AVATARS.map(([e, c]) => `<button type="button" data-e="${e}" data-c="${c}" aria-label="Avatar ${e}">${avatarHTML({ avatar: { type: 'emoji', value: e, color: c } })}</button>`).join('')}
          <label class="upload" title="Usar una foto" aria-label="Usar una foto">${ICON.camera}<input type="file" accept="image/*" id="photo" hidden></label>
          <span id="photo-prev"></span>
        </div>
      </div>
      <div>
        <span class="lbl">Capítulos en</span>
        <div class="options">
          ${[['both', 'Español latino y de España', 'Muestra más capítulos'], ['es-la', 'Solo español latino', ''], ['es', 'Solo español de España', '']].map(([v, l, h]) =>
            `<label class="option"><input type="radio" name="lang" value="${v}" ${lang === v ? 'checked' : ''}><span class="grow">${l}${h ? `<br><span class="muted small">${h}</span>` : ''}</span></label>`).join('')}
        </div>
      </div>
      <div>
        <span class="lbl">Apariencia</span>
        <div class="options">
          ${[['light', 'Claro'], ['dark', 'Oscuro'], ['system', 'Automático (según tu dispositivo)']].map(([v, l]) =>
            `<label class="option"><input type="radio" name="theme" value="${v}" ${theme === v ? 'checked' : ''}><span class="grow">${l}</span></label>`).join('')}
        </div>
        <div class="hint">Puedes cambiarlo cuando quieras en Ajustes.</div>
      </div>
      <button class="btn primary" type="submit" style="min-height:48px">${editing ? 'Guardar cambios' : 'Crear perfil y empezar'}</button>
    </form></div>`;
  $('#back')?.addEventListener('click', () => history.back());
  const markAvatar = () => {
    view.querySelectorAll('#avs button').forEach(b => b.setAttribute('aria-pressed', String(avatar.type === 'emoji' && b.dataset.e === avatar.value)));
    $('#photo-prev').innerHTML = avatar.type === 'photo' ? `<button type="button" aria-pressed="true" aria-label="Tu foto">${avatarHTML({ avatar })}</button>` : '';
  };
  markAvatar();
  $('#avs').addEventListener('click', e => {
    const b = e.target.closest('button[data-e]'); if (!b) return;
    avatar = { type: 'emoji', value: b.dataset.e, color: b.dataset.c }; markAvatar();
  });
  $('#photo').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    try { avatar = { type: 'photo', value: await resizeImage(f, 256) }; markAvatar(); }
    catch { toast('No se pudo leer esa imagen'); }
  });
  view.querySelectorAll('input[name=theme]').forEach(r => r.onchange = () => applyTheme(r.value)); // vista previa inmediata
  const nameEl = $('#pname'), errEl = $('#pname-err');
  const validate = () => {
    const ok = nameEl.value.trim().length >= 2;
    nameEl.classList.toggle('invalid', !ok); errEl.hidden = ok;
    errEl.textContent = ok ? '' : 'Escribe al menos 2 letras para tu nombre.';
    return ok;
  };
  nameEl.addEventListener('blur', () => { if (nameEl.value) validate(); });
  nameEl.addEventListener('input', () => { if (!errEl.hidden) validate(); });
  if (!editing) nameEl.focus();
  $('#pf').onsubmit = async e => {
    e.preventDefault();
    if (!validate()) { nameEl.focus(); return; }
    const fd = new FormData(e.target);
    const langs = fd.get('lang') === 'both' ? ['es-la', 'es'] : [fd.get('lang')];
    const profile = { name: nameEl.value.trim(), avatar, createdAt: p.createdAt || Date.now() };
    const btn = e.target.querySelector('[type=submit]'); btn.disabled = true;
    try {
      settingsCache = await api('/api/settings', { method: 'PUT', body: { profile, languages: langs, theme: fd.get('theme') } });
      localStorage.setItem('settingsCopy', JSON.stringify(settingsCache));
      applyTheme(fd.get('theme'));
      updateNavAvatar(profile);
      toast(editing ? 'Perfil actualizado' : `¡Listo, ${profile.name}!`);
      location.hash = editing ? '#/more' : '#/explore';
    } catch (err) { toast(err.message); btn.disabled = false; }
  };
}
function resizeImage(file, size) {
  return new Promise((ok, fail) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = c.height = size;
      const s = Math.min(img.width, img.height);
      c.getContext('2d').drawImage(img, (img.width - s) / 2, (img.height - s) / 2, s, s, 0, 0, size, size);
      URL.revokeObjectURL(img.src); ok(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = fail;
    img.src = URL.createObjectURL(file);
  });
}

// ---------- Biblioteca ----------
async function viewLibrary() {
  const s = await getSettings().catch(() => ({}));
  const top = `<div class="topbar">
      <div class="brand grow"><img src="/brand/logo-256.png" alt=""><span class="wordmark"><span class="a">PIRATE</span> <span class="b">READER</span></span></div>
      <a href="#/more" aria-label="Tu perfil">${avatarHTML(s.profile)}</a></div>`;
  view.insertAdjacentHTML('beforeend', top + `<div class="head"><h1>Biblioteca</h1></div><div id="libbody">${skeletonGrid(6)}</div>`);
  const body = $('#libbody');
  let items, hist = [];
  try { [items, hist] = await Promise.all([api('/api/library'), api('/api/history').catch(() => [])]); }
  catch (e) {
    // sin conexión: mostrar lo guardado en el dispositivo
    const dev = deviceList();
    body.innerHTML = dev.length ? `<div class="grid">${dev.map(g => cardHTML({ source: g.source, id: g.seriesId, title: g.seriesTitle, cover: g.cover }, `<span class="badge count">${g.chapters.length}</span>`)).join('')}</div>`
      : errorBox(e.message);
    body.querySelector('[data-retry]')?.addEventListener('click', route);
    return;
  }
  const cont = hist.filter(h => h.total && h.page < h.total - 1).slice(0, 6);
  const contHTML = cont.length ? `<h2 style="margin-top:0">Continuar leyendo</h2><div class="continue">${cont.map(h => `
    <a class="row" href="#/read/${h.source}/${encodeURIComponent(h.seriesId)}/${encodeURIComponent(h.chapterId)}">
      <img class="thumb" ${imgAttr(h.cover || '/icon-192.png')} alt="">
      <div class="grow"><div class="title">${esc(h.seriesTitle)}</div><div class="muted small">${esc(h.chapterLabel)} · pág. ${h.page + 1}/${h.total}</div>
      <div class="bar"><i style="width:${Math.round(((h.page + 1) / h.total) * 100)}%"></i></div></div></a>`).join('')}</div>` : '';
  if (!items.length) {
    body.innerHTML = contHTML + `<div class="empty"><h3>Tu biblioteca está vacía</h3>Busca un manga o manhwa y pulsa “Agregar a biblioteca”.<br>
      <a class="btn primary" href="#/explore">Explorar catálogo</a></div>`;
    return;
  }
  const cats = [...new Set(items.map(i => i.category || 'General'))];
  let cat = sessionStorage.getItem('libcat') || 'Todas', q = '';
  if (cat !== 'Todas' && !cats.includes(cat)) cat = 'Todas';
  body.innerHTML = contHTML + `
    <div class="head" style="margin-top:${cont.length ? 16 : 0}px">
      <div class="chips" id="cats" style="flex:1">${cats.length > 1 ? ['Todas', ...cats].map(c => `<button class="chip ${c === cat ? 'on' : ''}" data-cat="${esc(c)}">${esc(c)}</button>`).join('') : ''}</div>
      <label class="field" style="max-width:280px">${ICON.search}<input id="libq" type="search" placeholder="Filtrar" aria-label="Filtrar biblioteca"></label></div>
    <div id="libgrid"></div>`;
  const draw = () => {
    const list = items.filter(i => (cat === 'Todas' || (i.category || 'General') === cat) && (!q || i.title.toLowerCase().includes(q)));
    $('#libgrid').innerHTML = list.length ? `<div class="grid">${list.map(i => cardHTML(i)).join('')}</div>`
      : `<div class="empty"><h3>Sin resultados</h3>Prueba otra categoría o búsqueda.</div>`;
  };
  $('#cats').addEventListener('click', e => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    cat = b.dataset.cat; sessionStorage.setItem('libcat', cat);
    view.querySelectorAll('[data-cat]').forEach(x => x.classList.toggle('on', x === b)); draw();
  });
  $('#libq').addEventListener('input', e => { q = e.target.value.toLowerCase(); draw(); });
  draw();
}

// ---------- Novedades ----------
async function viewUpdates() {
  view.insertAdjacentHTML('beforeend', `<div class="head"><h1>Novedades</h1><button class="btn icon" id="ref" aria-label="Actualizar" title="Actualizar">${ICON.refresh}</button></div><div id="upd"><div class="empty"><div class="spin" style="margin:auto"></div></div></div>`);
  const load = async () => {
    const box = $('#upd');
    try {
      const list = await api('/api/updates');
      if (!list.length) { box.innerHTML = `<div class="empty"><h3>Sin capítulos nuevos</h3>Aquí aparecen los últimos capítulos en español de las series de MangaDex que guardes en tu biblioteca.</div>`; return; }
      const groups = {};
      for (const u of list) (groups[fmtDate(u.date)] ||= []).push(u);
      box.innerHTML = Object.entries(groups).map(([d, us]) => `<h2>${esc(d)}</h2><div class="rows">${us.map(u => `
        <a class="row ${u.read ? 'read' : ''}" href="#/read/${u.source}/${encodeURIComponent(u.seriesId)}/${encodeURIComponent(u.chapterId)}">
          <img class="thumb" loading="lazy" ${imgAttr(u.cover)} alt="">
          <div class="grow"><div class="title">${esc(u.seriesTitle)}</div>
          <div class="muted small">${esc(chapterLabel(u))}${u.group ? ' · ' + esc(u.group) : ''}</div></div>
          ${u.read ? '<span class="badge">Leído</span>' : ''}</a>`).join('')}</div>`).join('');
    } catch (e) { box.innerHTML = errorBox(e.message); box.querySelector('[data-retry]').onclick = load; }
  };
  $('#ref').onclick = load;
  load();
}

// ---------- Historial ----------
async function viewHistory() {
  view.insertAdjacentHTML('beforeend', `<button class="btn" id="back" style="margin-bottom:16px">${ICON.back}Perfil</button><div class="head"><h1>Historial</h1></div><div id="hist"></div>`);
  $('#back').onclick = () => { location.hash = '#/more'; };
  const list = await api('/api/history').catch(e => { $('#hist').innerHTML = errorBox(e.message, false); return null; });
  if (!list) return;
  if (!list.length) { $('#hist').innerHTML = `<div class="empty"><h3>Aún no has leído nada</h3>Lo que leas aparecerá aquí para continuar donde te quedaste.<br><a class="btn primary" href="#/explore">Explorar</a></div>`; return; }
  view.querySelector('.head').insertAdjacentHTML('beforeend', '<button class="btn" id="clr">Borrar historial</button>');
  $('#clr').onclick = async () => {
    if (!confirm('¿Borrar todo el historial de lectura? El progreso de cada capítulo se conserva.')) return;
    await api('/api/history', { method: 'DELETE' }); route();
  };
  $('#hist').innerHTML = `<div class="rows">${list.map(h => {
    const pct = h.total ? Math.round(((h.page + 1) / h.total) * 100) : 0;
    return `<a class="row" href="#/read/${h.source}/${encodeURIComponent(h.seriesId)}/${encodeURIComponent(h.chapterId)}">
      <img class="thumb" loading="lazy" ${imgAttr(h.cover || '/icon-192.png')} alt="">
      <div class="grow"><div class="title">${esc(h.seriesTitle)}</div>
        <div class="muted small">${esc(h.chapterLabel)}${h.total ? ` · pág. ${h.page + 1}/${h.total}` : ''} · ${new Date(h.at).toLocaleString('es-MX', { dateStyle: 'short', timeStyle: 'short' })}</div>
        ${h.total ? `<div class="bar"><i style="width:${pct}%"></i></div>` : ''}</div>
      <span class="btn">Continuar</span></a>`;
  }).join('')}</div>`;
}

// ---------- Explorar ----------
const filterCache = {};
async function viewExplore(_, qs) {
  const sources = await api('/api/sources');
  const st = {
    src: qs.get('src') || localStorage.getItem('src') || 'mangadex',
    mode: qs.get('mode') || 'popular',
    q: qs.get('q') || '',
    f: JSON.parse(qs.get('f') || '{}'),
  };
  localStorage.setItem('src', st.src);
  const setHash = patch => {
    Object.assign(st, patch);
    const p = new URLSearchParams({ src: st.src, mode: st.mode });
    if (st.q) p.set('q', st.q);
    if (Object.keys(st.f).length) p.set('f', JSON.stringify(st.f));
    location.hash = `#/explore?${p}`;
  };
  // El tipo (manga, manhwa, cómics…) se elige con las pestañas rápidas y no cuenta como búsqueda
  const nFilters = Object.entries(st.f).reduce((a, [k, v]) => k === 'type' && v?.length === 1 ? a : a + (Array.isArray(v) ? v.length : v ? 1 : 0), 0);
  const quickTypes = st.src === 'mangadex'
    ? [['', 'Todo'], ['manga', 'Manga'], ['manhwa', 'Manhwa'], ['manhua', 'Manhua'], ['comic', 'Cómics']]
    : st.src === 'archive' ? [['', 'Todo'], ['es', 'En español'], ['en', 'En inglés']]
    : [['', 'Todo'], ['manga', 'Manga'], ['manhwa', 'Manhwa'], ['cómic', 'Cómics'], ['libro', 'Libros']];
  const curType = st.f.type?.length === 1 ? st.f.type[0] : '';
  view.innerHTML = `
    <div class="head"><h1>Explorar</h1>
      <div class="seg" role="tablist" aria-label="Fuente">${sources.map(s => `<button role="tab" class="${s.id === st.src ? 'on' : ''}" data-src="${s.id}" title="${esc(s.description)}">${esc(s.name)}</button>`).join('')}</div></div>
    <form id="sf" class="head" style="margin-bottom:12px">
      <label class="field">${ICON.search}<input id="q" type="search" enterkeyhint="search" placeholder="Buscar título…" value="${esc(st.q)}" aria-label="Buscar título"></label>
      <button type="button" class="btn" id="fbtn">${ICON.filter}Filtros${nFilters ? ` (${nFilters})` : ''}</button>
    </form>
    <div class="chips" style="margin-bottom:12px" role="group" aria-label="Tipo">${quickTypes.map(([v, l]) => `<button class="chip ${curType === v ? 'on' : ''}" data-qtype="${v}">${l}</button>`).join('')}</div>
    ${st.q || nFilters ? `<div class="head"><span class="muted small">Resultados de búsqueda</span><button class="btn" id="clear">Limpiar búsqueda</button></div>` :
      `<div class="seg" style="margin-bottom:16px">${[['popular', 'Populares'], ['latest', 'Recientes']].map(([m, l]) => `<button class="${st.mode === m ? 'on' : ''}" data-mode="${m}">${l}</button>`).join('')}</div>`}
    <div id="res">${skeletonGrid(12)}</div>
    <div id="more" style="height:48px"></div>`;

  view.querySelectorAll('[data-src]').forEach(b => b.onclick = () => setHash({ src: b.dataset.src, f: {}, q: '' }));
  view.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => setHash({ mode: b.dataset.mode }));
  view.querySelectorAll('[data-qtype]').forEach(b => b.onclick = () => {
    const f = { ...st.f }; if (b.dataset.qtype) f.type = [b.dataset.qtype]; else delete f.type;
    setHash({ f });
  });
  $('#clear')?.addEventListener('click', () => setHash({ q: '', f: {}, mode: 'popular' }));
  $('#sf').onsubmit = e => { e.preventDefault(); setHash({ q: $('#q').value.trim(), mode: 'search' }); };
  // búsqueda al escribir (con pausa)
  let deb; $('#q').addEventListener('input', e => {
    clearTimeout(deb); const v = e.target.value.trim();
    deb = setTimeout(() => { if (v !== st.q && (v.length >= 3 || v === '')) setHash({ q: v, mode: v ? 'search' : 'popular' }); }, 600);
  });
  $('#fbtn').onclick = () => openFilters(st.src, st.f, f => setHash({ f, mode: 'search' }));

  const mode = st.q || nFilters ? 'search' : st.mode;
  let page = 1, loading = false, done = false;
  const res = $('#res');
  async function loadPage() {
    if (loading || done) return; loading = true;
    try {
      const p = new URLSearchParams({ mode, page, q: st.q, filters: JSON.stringify(st.f) });
      const data = await api(`/api/s/${st.src}/list?${p}`);
      if (page === 1) res.innerHTML = data.items.length ? '<div class="grid"></div>' :
        `<div class="empty"><h3>No hay resultados</h3>${st.src === 'local' ? (STANDALONE ? 'Importa tus archivos CBZ, CBR, PDF o EPUB desde Ajustes → Mis archivos.<br><a class="btn primary" href="#/settings">Importar archivos</a>' : 'Copia tus archivos CBZ, CBR, PDF o EPUB a la carpeta de la biblioteca y pulsa “Volver a escanear” en Ajustes.') : 'Prueba con otro título o quita algunos filtros.'}</div>`;
      res.querySelector('.grid')?.insertAdjacentHTML('beforeend', data.items.map(s => cardHTML(s)).join(''));
      done = !data.hasMore; page++;
    } catch (e) {
      if (page === 1) res.innerHTML = errorBox(e.message); else toast(e.message);
      res.querySelector('[data-retry]')?.addEventListener('click', () => { res.innerHTML = skeletonGrid(12); loading = false; loadPage(); });
      done = true;
    } finally { loading = false; }
  }
  const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) loadPage(); }, { rootMargin: '600px' });
  io.observe($('#more'));
  await loadPage();
  return () => io.disconnect();
}

async function openFilters(src, current, onApply) {
  let def = filterCache[src];
  if (!def) {
    try { def = filterCache[src] = await api(`/api/s/${src}/filters`); } catch (e) { toast(e.message); return; }
  }
  const f = structuredClone({ include: [], exclude: [], ...current });
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  const tri = (id, name) => {
    const cls = f.include.includes(id) ? 'inc' : f.exclude.includes(id) ? 'exc' : '';
    return `<button type="button" class="chip ${cls}" data-tag="${esc(id)}">${cls === 'inc' ? '+ ' : cls === 'exc' ? '− ' : ''}${esc(name)}</button>`;
  };
  const multi = (key, opts, title) => opts?.length ? `<h3>${title}</h3><div class="chips">${opts.map(([v, l]) =>
    `<button type="button" class="chip ${(f[key] || []).includes(v) ? 'on' : ''}" data-k="${key}" data-v="${esc(v)}">${esc(l)}</button>`).join('')}</div>` : '';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Filtros">
    <header><h2>Filtros</h2><button class="btn" data-reset>Limpiar</button></header>
    <div class="body">
      ${def.order ? `<h3>Ordenar por</h3><select data-order aria-label="Ordenar por"><option value="">Predeterminado</option>${def.order.map(([v, l]) => `<option value="${v}" ${f.order === v ? 'selected' : ''}>${l}</option>`).join('')}</select>` : ''}
      ${multi('type', def.type, 'Tipo')}
      ${multi('status', def.status, 'Estado')}
      ${multi('demographic', def.demographic, 'Demografía')}
      ${multi('contentRating', def.contentRating, 'Clasificación')}
      <p class="muted small" style="margin-top:16px">Toca un género una vez para <b>incluirlo</b>, dos para <b>excluirlo</b> y tres para quitarlo.</p>
      ${Object.entries(def.tags || {}).filter(([, t]) => t.length).map(([g, tags]) => `<h3>${esc(g)}</h3><div class="chips">${tags.map(t => tri(t.id, t.name)).join('')}</div>`).join('')}
    </div>
    <footer><button class="btn" data-close>Cancelar</button><span style="flex:1"></span><button class="btn primary" data-apply>Aplicar filtros</button></footer></div>`;
  document.body.appendChild(bg);
  const prevFocus = document.activeElement;
  bg.querySelector('[data-apply]').focus();
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  bg.addEventListener('click', e => {
    if (e.target === bg || e.target.closest('[data-close]')) return close();
    const t = e.target.closest('[data-tag]');
    if (t) {
      const id = t.dataset.tag, name = t.textContent.replace(/^[+−] /, '');
      if (f.include.includes(id)) { f.include = f.include.filter(x => x !== id); f.exclude.push(id); t.className = 'chip exc'; t.textContent = '− ' + name; }
      else if (f.exclude.includes(id)) { f.exclude = f.exclude.filter(x => x !== id); t.className = 'chip'; t.textContent = name; }
      else { f.include.push(id); t.className = 'chip inc'; t.textContent = '+ ' + name; }
      return;
    }
    const m = e.target.closest('[data-k]');
    if (m) {
      const arr = f[m.dataset.k] ||= [];
      const i = arr.indexOf(m.dataset.v);
      if (i >= 0) arr.splice(i, 1); else arr.push(m.dataset.v);
      m.classList.toggle('on', i < 0); return;
    }
    if (e.target.closest('[data-reset]')) { close(); onApply({}); return; }
    if (e.target.closest('[data-apply]')) {
      const order = bg.querySelector('[data-order]')?.value;
      if (order) f.order = order; else delete f.order;
      for (const k of Object.keys(f)) if (Array.isArray(f[k]) && !f[k].length) delete f[k];
      close(); onApply(f);
    }
  });
}

// ---------- Ficha de serie ----------
async function viewSeries([src, id]) {
  view.insertAdjacentHTML('beforeend', `<div class="hero"><div class="cover skel"></div><div><div class="skel" style="height:28px;width:70%"></div></div></div>`);
  let s, chapters;
  try {
    [s, chapters] = await Promise.all([api(`/api/s/${src}/series/${encodeURIComponent(id)}`), api(`/api/s/${src}/series/${encodeURIComponent(id)}/chapters`)]);
  } catch (e) {
    view.innerHTML = `<button class="btn" onclick="history.back()">${ICON.back}Volver</button>` + errorBox(e.message);
    view.querySelector('[data-retry]').onclick = route; return;
  }
  let asc = localStorage.getItem('chapAsc') === '1';
  const ordered = () => asc ? [...chapters].reverse() : chapters;
  const readable = chapters.filter(c => !c.external);
  const oldestFirst = [...readable].reverse();
  const inProgress = [...readable].filter(c => c.progress && !c.progress.done && c.progress.updatedAt).sort((a, b) => b.progress.updatedAt - a.progress.updatedAt)[0];
  let lastDoneIdx = -1; oldestFirst.forEach((c, i) => { if (c.progress?.done) lastDoneIdx = i; });
  const doneNums = new Set(oldestFirst.filter(c => c.progress?.done && c.number).map(c => c.number));
  const lastGroup = oldestFirst[lastDoneIdx]?.group;
  const nextUnread = oldestFirst.slice(lastDoneIdx + 1).filter(c => !c.number || !doneNums.has(c.number));
  const nextPick = nextUnread.find(c => c.number === nextUnread[0]?.number && c.group === lastGroup) || nextUnread[0];
  const cont = inProgress || (lastDoneIdx >= 0 ? nextPick : null) || oldestFirst[0];
  const genreChip = g => {
    const gid = typeof g === 'string' ? g : g.id, gname = typeof g === 'string' ? g : g.name;
    return `<a class="chip" href="#/explore?${new URLSearchParams({ src, mode: 'search', f: JSON.stringify({ include: [gid] }) })}">${esc(gname)}</a>`;
  };
  const meta = [typeLabel(s.type), s.status, s.year, s.demographic && s.demographic[0].toUpperCase() + s.demographic.slice(1)].filter(Boolean);
  view.innerHTML = (offline || s.offline ? '<div class="offline-bar">Sin conexión: solo se muestran los capítulos descargados.</div>' : '') + `
    <button class="btn" id="back" style="margin-bottom:16px">${ICON.back}Volver</button>
    <div class="hero">
      <div class="cover">${s.cover ? `<img ${imgAttr(s.cover)} alt="Portada de ${esc(s.title)}">` : ''}</div>
      <div>
        <h1>${esc(s.title)}</h1>
        <div class="muted small">${esc([...new Set([...(s.authors || []), ...(s.artists || [])])].join(', '))}</div>
        <div class="meta">${meta.map(m => `<span>${esc(m)}</span>`).join('<span>·</span>')}<span>·</span><span>${chapters.length} capítulos</span></div>
        <div class="chips" style="margin:4px 0 8px" aria-label="Idiomas">${(() => { const ls = [...new Set([...(s.languages || []), ...chapters.map(c => c.lang).filter(Boolean)])]; return ls.length ? ls.map(l => `<span class="chip langchip">${esc(langName(l))}</span>`).join('') : '<span class="chip langchip">Idioma no indicado</span>'; })()}</div>
        <div class="actions">
          ${cont ? `<a class="btn primary" href="#/read/${src}/${encodeURIComponent(id)}/${encodeURIComponent(cont.id)}">${inProgress || lastDoneIdx >= 0 ? 'Continuar' : 'Empezar a leer'} · ${esc(chapterLabel(cont))}</a>` : ''}
          <button class="btn" id="lib">${s.inLibrary ? ICON.check + 'En biblioteca' : ICON.plus + 'Agregar a biblioteca'}</button>
          <button class="btn" id="dl">${ICON.download}Descargar</button>
          <button class="btn" id="cat" ${s.inLibrary ? '' : 'hidden'}>Cambiar categoría</button>
        </div>
      </div>
    </div>
    ${s.genres?.length ? `<div class="chips" style="margin:16px 0">${s.genres.map(genreChip).join('')}</div>` : ''}
    ${s.description ? `<div class="desc" id="desc">${esc(s.description)}</div>
      <div class="desc-note muted small" id="desc-note" ${s.descriptionLang === 'es' ? 'hidden' : ''}>${s.descriptionLang === 'es' ? '' : 'Traduciendo la sinopsis…'}</div>
      <button class="btn" id="more" style="margin-bottom:8px">Ver más</button>` : '<p class="muted small">Esta obra no tiene sinopsis.</p>'}
    ${src === 'mangadex' ? '<p class="muted small">Contenido de MangaDex. El crédito de cada traducción es del grupo indicado en el capítulo.</p>' : ''}
    ${src === 'archive' ? `<p class="muted small">Cómic de dominio público alojado en Internet Archive. <a href="https://archive.org/details/${encodeURIComponent(id)}" target="_blank" rel="noopener" style="color:var(--accent)">Ver en archive.org</a></p>` : ''}
    <div class="head" style="margin-top:24px"><h2 style="margin:0;flex:1">Capítulos</h2>
      <button class="btn" id="markall">Marcar todo leído</button>
      <button class="btn icon" id="sort" aria-label="Invertir orden" title="Invertir orden">${ICON.sort}</button></div>
    <div id="chaps"></div>`;
  $('#back').onclick = () => history.length > 1 ? history.back() : (location.hash = '#/explore');
  const descEl = $('#desc');
  // La sinopsis siempre en español: si viene en otro idioma, se traduce automáticamente
  if (descEl && s.descriptionLang !== 'es') {
    const note = $('#desc-note'), original = s.description;
    api('/api/translate', { method: 'POST', body: { text: original, from: s.descriptionLang || 'autodetect' } }).then(r => {
      if (!document.body.contains(descEl)) return;
      if (r.translated) {
        let showingOriginal = false;
        descEl.textContent = r.text;
        note.hidden = false;
        note.innerHTML = `Traducción automática${r.from ? ` del ${esc(langName(r.from).toLowerCase())}` : ''} · <button class="linkbtn" id="orig">Ver original</button>`;
        $('#orig').onclick = () => { showingOriginal = !showingOriginal; descEl.textContent = showingOriginal ? original : r.text; $('#orig').textContent = showingOriginal ? 'Ver traducción' : 'Ver original'; };
      } else if (r.error) { note.hidden = false; note.textContent = `Sinopsis en su idioma original (${r.error.toLowerCase()}).`; }
      else note.hidden = true;
    }).catch(() => { note.hidden = false; note.textContent = 'Sinopsis en su idioma original (no se pudo traducir).'; });
  }
  if (descEl) {
    if (descEl.scrollHeight <= descEl.clientHeight + 4) $('#more').remove();
    else $('#more').onclick = e => { descEl.classList.toggle('open'); e.target.textContent = descEl.classList.contains('open') ? 'Ver menos' : 'Ver más'; };
  }
  let inLib = s.inLibrary;
  $('#lib').onclick = async () => {
    try {
      if (inLib) await api(`/api/library/${src}/${encodeURIComponent(id)}`, { method: 'DELETE' });
      else await api('/api/library', { method: 'POST', body: { source: src, id, title: s.title, cover: s.cover, type: s.type, readingDir: s.readingDir, languages: s.languages } });
      inLib = !inLib;
      $('#cat').hidden = !inLib;
      $('#lib').innerHTML = inLib ? ICON.check + 'En biblioteca' : ICON.plus + 'Agregar a biblioteca';
      toast(inLib ? 'Agregado a tu biblioteca' : 'Quitado de tu biblioteca');
    } catch (e) { toast(e.message); }
  };
  $('#cat').onclick = async () => {
    const name = prompt('Nombre de la categoría (por ejemplo: Leyendo, Pendientes, Terminados):');
    if (!name?.trim()) return;
    try {
      await api('/api/library', { method: 'POST', body: { source: src, id, title: s.title, cover: s.cover, type: s.type, readingDir: s.readingDir, languages: s.languages, category: name.trim() } });
      toast(`Movido a “${name.trim()}”`);
    } catch (e) { toast(e.message); }
  };

  // Estado de descarga de cada capítulo (computadora y este dispositivo)
  const devQ = () => new Map(deviceQueue().map(j => [j.key, j]));
  let serverQ = new Map();
  const dlIcons = c => {
    const onDev = isOnDevice(src, c.id), sq = serverQ.get(`${src}:${c.id}`), dq = devQ().get(`${src}:${c.id}`);
    const prog = sq && sq.status !== 'done' ? sq : dq && dq.status !== 'done' ? dq : null;
    if (prog) return `<span class="status ${prog.status === 'error' ? 'err' : ''}">${prog.status === 'error' ? 'Error' : prog.status === 'queued' ? 'En cola' : `${prog.done}/${prog.total || '…'}`}</span>`;
    return `<span class="icons">${c.downloaded || sq?.status === 'done' ? `<span title="Descargado en la computadora" class="dl-ok">${ICON.pc}</span>` : ''}${onDev ? `<span title="Guardado en este dispositivo" class="dl-dev">${ICON.phone}</span>` : ''}</span>`;
  };
  const drawChaps = () => {
    $('#chaps').innerHTML = chapters.length ? `<div class="rows">${ordered().map(c => {
      const p = c.progress, done = p?.done;
      const meta = esc([c.group, fmtDate(c.date), p && !done && p.total ? `pág. ${p.page + 1}/${p.total}` : ''].filter(Boolean).join(' · '));
      const tag = `<span class="status lang">${esc(langName(c.lang))}</span>`;
      if (c.external) return `<div class="row" data-row="${esc(c.id)}">
        <a class="grow" href="${esc(c.external)}" target="_blank" rel="noopener">
          <div class="title">${esc(chapterLabel(c))}</div>
          <div class="muted small">${tag} Sitio oficial · se abre en el navegador${meta ? ' · ' + meta : ''}</div></a>
        <span class="status">Externo ↗</span></div>`;
      return `<div class="row ${done ? 'read' : ''}" data-row="${esc(c.id)}">
        <a class="grow" href="#/read/${src}/${encodeURIComponent(id)}/${encodeURIComponent(c.id)}">
          <div class="title">${esc(chapterLabel(c))}</div>
          <div class="muted small">${tag} ${meta}</div></a>
        <span data-dl-state>${dlIcons(c)}</span>
        <button class="btn icon" data-mark="${esc(c.id)}" aria-label="${done ? 'Marcar como no leído' : 'Marcar como leído'}" title="${done ? 'Marcar como no leído' : 'Marcar como leído'}" style="${done ? 'color:var(--ok)' : ''}">${ICON.check}</button></div>`;
    }).join('')}</div>` : `<div class="empty"><h3>No hay capítulos en los idiomas elegidos</h3>Esta serie no tiene capítulos en ${esc((settingsCache?.languages || ['es-la', 'es']).map(langName).join(', ').toLowerCase())}. Puedes activar otro idioma en Ajustes.<br><a class="btn" href="#/settings">Ir a Ajustes</a></div>`;
  };
  const refreshStates = () => chapters.forEach(c => { const el = view.querySelector(`[data-row="${CSS.escape(c.id)}"] [data-dl-state]`); if (el) el.innerHTML = dlIcons(c); });
  drawChaps();
  $('#sort').onclick = () => { asc = !asc; localStorage.setItem('chapAsc', asc ? '1' : '0'); drawChaps(); };
  const mark = async (ids, done) => {
    await api('/api/progress/mark', { method: 'POST', body: { source: src, seriesId: id, chapterIds: ids, done } });
    for (const c of chapters) if (ids.includes(c.id)) c.progress = done ? { ...(c.progress || {}), done: true } : null;
    drawChaps();
  };
  $('#chaps').addEventListener('click', e => {
    const b = e.target.closest('[data-mark]'); if (!b) return;
    const c = chapters.find(c => c.id === b.dataset.mark);
    mark([c.id], !c.progress?.done).catch(err => toast(err.message));
  });
  $('#markall').onclick = () => mark(readable.map(c => c.id), true).catch(err => toast(err.message));
  $('#dl').onclick = () => {
    if (!readable.length) { toast('Esta serie solo tiene capítulos en sitios oficiales; no se pueden descargar.'); return; }
    openDownloadSheet({ src, id, s, chapters: readable, onStart: () => poll() });
  };

  // Seguimiento del progreso mientras haya descargas activas
  let timer = null;
  const poll = async () => {
    clearTimeout(timer);
    try {
      const st = await api('/api/downloads');
      serverQ = new Map(st.queue.map(j => [j.key, j]));
      const doneNow = new Set(st.series.filter(g => g.source === src && g.seriesId === id).flatMap(g => g.chapters.map(c => c.chapterId)));
      chapters.forEach(c => { c.downloaded = doneNow.has(c.id); });
      refreshStates();
      if (st.queue.some(j => j.status === 'queued' || j.status === 'downloading')) timer = setTimeout(poll, 1200);
    } catch {}
  };
  const unsub = onDeviceQueue(() => refreshStates());
  if (!offline) poll();
  return () => { clearTimeout(timer); unsub(); };
}

function openDownloadSheet({ src, id, s, chapters, onStart }) {
  const unread = chapters.filter(c => !c.progress?.done);
  const oldestUnread = [...unread].reverse();
  const isLocal = src === 'local';
  const deviceOnly = isLocal || STANDALONE;
  const lastDest = deviceOnly || !navigator.onLine ? 'device' : localStorage.getItem('dlDest') || 'server';
  const serverDone = chapters.filter(c => c.downloaded).length;
  const bg = document.createElement('div');
  bg.className = 'sheet-bg';
  bg.innerHTML = `<div class="sheet" role="dialog" aria-modal="true" aria-label="Descargar">
    <header><h2>Descargar “${esc(s.title)}”</h2></header>
    <div class="body">
      <h3>Capítulos</h3>
      <div class="options">
        ${[['all', `Todos (${chapters.length})`], ['unread', `No leídos (${unread.length})`], ['next5', 'Los siguientes 5 sin leer'], ['pick', 'Elegir capítulos…']].map(([v, l], i) =>
          `<label class="option"><input type="radio" name="scope" value="${v}" ${i === (unread.length ? 1 : 0) ? 'checked' : ''}><span class="grow">${l}</span></label>`).join('')}
      </div>
      <div id="pick" hidden style="margin-top:8px"><div class="rows" style="max-height:240px;overflow:auto">${chapters.map(c => `
        <label class="setting" style="cursor:pointer"><input type="checkbox" value="${esc(c.id)}"><span class="grow">${esc(chapterLabel(c))} <span class="muted small">${esc(c.group || '')}</span></span></label>`).join('')}</div></div>
      <h3>Dónde guardarlos</h3>
      <div class="options">
        ${deviceOnly ? '' : `<label class="option"><input type="radio" name="dest" value="server" ${lastDest === 'server' ? 'checked' : ''}><span class="grow"><b>En la computadora</b><br><span class="muted small">Se guardan como archivos CBZ. Los lees sin internet desde cualquier dispositivo conectado a tu PC y puedes exportarlos.</span></span></label>`}
        <label class="option" ${deviceSupported ? '' : 'style="opacity:.55"'}><input type="radio" name="dest" value="device" ${lastDest === 'device' || deviceOnly ? 'checked' : ''} ${deviceSupported ? '' : 'disabled'}><span class="grow"><b>En este dispositivo</b><br><span class="muted small">${STANDALONE ? 'Para leer sin internet. Desde Descargas puedes exportarlos como CBZ.' : deviceSupported ? 'Para leer sin conexión aunque la computadora esté apagada.' : 'No disponible en esta dirección. Ve a Descargas para ver cómo activarlo.'}</span></span></label>
      </div>
      ${STANDALONE ? '' : isLocal ? `<p class="small" style="margin-top:16px"><a class="btn" href="/api/dl/series/local/${encodeURIComponent(id)}">${ICON.file}Guardar los archivos (.zip)</a></p>` :
        serverDone ? `<p class="small" style="margin-top:16px"><a class="btn" href="/api/dl/series/${src}/${encodeURIComponent(id)}">${ICON.file}Exportar la colección descargada (.zip, ${serverDone} cap.)</a></p>` : ''}
    </div>
    <footer><button class="btn" data-close>Cancelar</button><span style="flex:1"></span><button class="btn primary" data-go>Descargar</button></footer></div>`;
  document.body.appendChild(bg);
  const prevFocus = document.activeElement;
  const close = () => { bg.remove(); document.removeEventListener('keydown', onKey); prevFocus?.focus(); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const pickBox = bg.querySelector('#pick');
  const selected = () => {
    const scope = bg.querySelector('input[name=scope]:checked').value;
    if (scope === 'all') return chapters;
    if (scope === 'unread') return unread;
    if (scope === 'next5') return oldestUnread.slice(0, 5);
    const ids = [...pickBox.querySelectorAll('input:checked')].map(i => i.value);
    return chapters.filter(c => ids.includes(c.id));
  };
  const updateBtn = () => {
    pickBox.hidden = bg.querySelector('input[name=scope]:checked').value !== 'pick';
    const n = selected().length;
    const go = bg.querySelector('[data-go]');
    go.textContent = n ? `Descargar ${n} capítulo${n === 1 ? '' : 's'}` : 'Elige capítulos';
    go.disabled = !n || !bg.querySelector('input[name=dest]:checked');
  };
  bg.addEventListener('change', updateBtn);
  updateBtn();
  bg.querySelector('[data-go]').focus();
  bg.addEventListener('click', async e => {
    if (e.target === bg || e.target.closest('[data-close]')) return close();
    if (!e.target.closest('[data-go]')) return;
    const list = selected();
    const dest = bg.querySelector('input[name=dest]:checked').value;
    localStorage.setItem('dlDest', dest);
    try {
      if (dest === 'server') {
        const r = await api('/api/downloads', { method: 'POST', body: { source: src, seriesId: id, chapterIds: list.map(c => c.id) } });
        toast(r.added ? `${r.added} capítulo(s) en cola en la computadora` : 'Esos capítulos ya estaban descargados');
      } else {
        const n = saveToDevice(list.map(c => ({ source: src, seriesId: id, chapterId: c.id, seriesTitle: s.title, cover: s.cover,
          label: chapterLabel(c), number: c.number, pages: c.pages })));
        toast(n ? `Guardando ${n} capítulo(s) en este dispositivo. Mantén la app abierta.` : 'Esos capítulos ya estaban en este dispositivo');
      }
      close(); onStart?.();
    } catch (err) { toast(err.message); }
  });
}

// ---------- Descargas ----------
async function viewDownloads() {
  view.insertAdjacentHTML('beforeend', `<div class="head"><h1>Descargas</h1></div><div id="dlbody"><div class="empty"><div class="spin" style="margin:auto"></div></div></div>`);
  const body = $('#dlbody');
  let timer = null, st = null, open = new Set(JSON.parse(sessionStorage.getItem('dlOpen') || '[]'));
  const secureHelp = `<div class="notice"><b>Para guardar en este teléfono y leer con la computadora apagada</b>, el navegador necesita una conexión segura.
    La forma rápida en Chrome para Android: abre <b>chrome://flags/#unsafely-treat-insecure-origin-as-secure</b>, actívalo, escribe <b>${esc(location.origin)}</b> y reinicia Chrome.
    Mientras tanto puedes descargar en la computadora y exportar los capítulos como CBZ. Más opciones en el archivo LEEME.</div>`;
  const qRow = (j, kind) => `<div class="row dl-row">
      <div class="grow"><div class="title">${esc(j.seriesTitle)} · ${esc(j.label)}</div>
        <div class="muted small">${kind === 'server' ? 'Computadora' : 'Este dispositivo'} · ${j.status === 'queued' ? 'En cola' : j.status === 'error' ? 'Error: ' + esc(j.error || '') : j.status === 'done' ? 'Listo' : j.status === 'cancelled' ? 'Cancelando…' : `Descargando ${j.done}/${j.total || '…'}`}</div>
        ${j.status === 'downloading' ? `<div class="bar"><i style="width:${j.total ? Math.round(j.done / j.total * 100) : 0}%"></i></div>` : ''}</div>
      ${j.status === 'error' && kind === 'server' ? `<button class="btn" data-retry-key="${esc(j.key)}">Reintentar</button>` : ''}
      ${j.status !== 'done' ? `<button class="btn" data-cancel-key="${esc(j.key)}" data-kind="${kind}">${j.status === 'error' ? 'Quitar' : 'Cancelar'}</button>` : ''}</div>`;
  const group = (g, kind) => {
    const gid = `${kind}:${g.source}:${g.seriesId}`, isOpen = open.has(gid);
    return `<div class="rows" style="margin-bottom:12px">
      <div class="row"><img class="thumb" ${imgAttr(g.cover || '/icon-192.png')} alt="">
        <button class="grow" data-toggle="${esc(gid)}" style="text-align:left;background:none;border:0;cursor:pointer;padding:0" aria-expanded="${isOpen}">
          <div class="title">${esc(g.seriesTitle)}</div><div class="muted small">${g.chapters.length} capítulo${g.chapters.length === 1 ? '' : 's'} · ${fmtBytes(g.bytes)}</div></button>
        ${kind === 'server' ? `<a class="btn icon" href="/api/dl/series/${g.source}/${encodeURIComponent(g.seriesId)}" title="Exportar colección (.zip)" aria-label="Exportar colección (.zip)">${ICON.file}</a>` : ''}
        ${kind === 'device' && STANDALONE ? `<button class="btn icon" data-export-series="${esc(gid)}" title="Exportar colección (CBZ)" aria-label="Exportar colección (CBZ)">${ICON.file}</button>` : ''}
        <a class="btn" href="#/series/${g.source}/${encodeURIComponent(g.seriesId)}">Abrir</a></div>
      ${isOpen ? g.chapters.map(c => `<div class="row">
        <a class="grow" href="#/read/${c.source}/${encodeURIComponent(c.seriesId)}/${encodeURIComponent(c.chapterId)}"><div class="title">${esc(c.label)}</div>
          <div class="muted small">${c.pages} págs. · ${fmtBytes(c.bytes)}${c.group ? ' · ' + esc(c.group) : ''}</div></a>
        ${kind === 'server' ? `<a class="btn icon" href="/api/dl/file/${c.source}/${encodeURIComponent(c.chapterId)}" title="Guardar archivo CBZ" aria-label="Guardar archivo CBZ">${ICON.file}</a>
          ${deviceSupported && !isOnDevice(c.source, c.chapterId) ? `<button class="btn icon" data-todev='${esc(JSON.stringify({ source: c.source, seriesId: c.seriesId, chapterId: c.chapterId, seriesTitle: c.seriesTitle, cover: c.cover, label: c.label, number: c.number, pages: c.pages }))}' title="Guardar también en este dispositivo" aria-label="Guardar también en este dispositivo">${ICON.phone}</button>` : ''}` : ''}
        ${kind === 'device' && STANDALONE ? `<button class="btn icon" data-export='${esc(JSON.stringify({ source: c.source, chapterId: c.chapterId, name: `${c.seriesTitle} - ${c.label}` }))}' title="Exportar CBZ" aria-label="Exportar CBZ">${ICON.file}</button>` : ''}
        <button class="btn icon danger" data-del="${kind}" data-src="${c.source}" data-cid="${esc(c.chapterId)}" data-label="${esc(c.label)}" title="Borrar" aria-label="Borrar ${esc(c.label)}">${ICON.trash}</button></div>`).join('') : ''}
    </div>`;
  };
  const draw = async () => {
    const dev = deviceList(), dq = deviceQueue();
    const queue = [...(st?.queue || []).map(j => qRow(j, 'server')), ...dq.map(j => qRow(j, 'device'))];
    const info = deviceSupported ? await storageInfo() : null;
    body.innerHTML = `
      ${queue.length ? `<h2>En proceso</h2><div class="rows">${queue.join('')}</div>` : ''}
      ${STANDALONE ? '' : `<h2>${ICON.pc.replace('<svg', '<svg width="18" height="18" style="vertical-align:-3px;fill:currentColor"')} En la computadora</h2>
      ${st ? (st.series.length ? st.series.map(g => group(g, 'server')).join('') : '<p class="muted">Nada descargado todavía. En la ficha de una serie pulsa “Descargar”.</p>')
        : '<p class="muted">Sin conexión con la computadora.</p>'}`}
      <h2>${ICON.phone.replace('<svg', '<svg width="18" height="18" style="vertical-align:-3px;fill:currentColor"')} ${STANDALONE ? 'En este teléfono' : 'En este dispositivo'}</h2>
      ${deviceSupported ? (dev.length ? dev.map(g => group(g, 'device')).join('') : '<p class="muted">Nada descargado todavía. En la ficha de una serie pulsa “Descargar”.</p>') : secureHelp}
      ${info ? `<p class="muted small">Espacio usado por la app en este dispositivo: ${fmtBytes(info.used)}${info.quota ? ` de ${fmtBytes(info.quota)} disponibles` : ''}.</p>` : ''}`;
  };
  const load = async () => {
    clearTimeout(timer);
    try { st = await api('/api/downloads'); } catch { st = null; }
    await draw();
    if (st?.queue.some(j => j.status === 'queued' || j.status === 'downloading') || deviceQueue().length) timer = setTimeout(load, 1200);
  };
  body.addEventListener('click', async e => {
    const t = e.target.closest('[data-toggle]');
    if (t) { const g = t.dataset.toggle; open.has(g) ? open.delete(g) : open.add(g); sessionStorage.setItem('dlOpen', JSON.stringify([...open])); return draw(); }
    const c = e.target.closest('[data-cancel-key]');
    if (c) {
      if (c.dataset.kind === 'server') await api('/api/downloads/cancel', { method: 'POST', body: { key: c.dataset.cancelKey } }).catch(() => {});
      else cancelDevice(c.dataset.cancelKey);
      return load();
    }
    const r = e.target.closest('[data-retry-key]');
    if (r) { await api('/api/downloads/retry', { method: 'POST', body: { key: r.dataset.retryKey } }).catch(err => toast(err.message)); return load(); }
    const ex = e.target.closest('[data-export]');
    if (ex) { exportChapters([JSON.parse(ex.dataset.export)], ex); return; }
    const exs = e.target.closest('[data-export-series]');
    if (exs) {
      const g = deviceList().find(g => `device:${g.source}:${g.seriesId}` === exs.dataset.exportSeries);
      if (g) exportChapters([...g.chapters].reverse().map(c => ({ source: c.source, chapterId: c.chapterId, name: `${c.seriesTitle} - ${c.label}` })), exs);
      return;
    }
    const d = e.target.closest('[data-todev]');
    if (d) { try { saveToDevice([JSON.parse(d.dataset.todev)]); toast('Guardando en este dispositivo…'); load(); } catch (err) { toast(err.message); } return; }
    const del = e.target.closest('[data-del]');
    if (del) {
      const where = del.dataset.del === 'server' ? 'de la computadora' : 'de este dispositivo';
      if (!confirm(`¿Borrar “${del.dataset.label}” ${where}?`)) return;
      try {
        if (del.dataset.del === 'server') await api(`/api/downloads/${del.dataset.src}/${encodeURIComponent(del.dataset.cid)}`, { method: 'DELETE' });
        else await removeFromDevice(del.dataset.src, del.dataset.cid);
        toast('Borrado'); load();
      } catch (err) { toast(err.message); }
    }
  });
  const unsub = onDeviceQueue(() => { if (!timer) load(); else draw(); });
  await load();
  return () => { clearTimeout(timer); unsub(); };
}

// Exportar capítulos guardados como CBZ (APK): abre "Compartir" para guardarlos en Archivos, Drive, etc.
async function exportChapters(list, btn) {
  if (btn) btn.disabled = true;
  try {
    const { buildCbz } = await import('./standalone/backend.js');
    const files = [];
    for (const [i, c] of list.entries()) {
      toast(`Preparando ${i + 1} de ${list.length}…`);
      const { blob, ext } = await buildCbz(c.source, c.chapterId, c.name);
      files.push({ blob, name: `${c.name}.${ext}` });
    }
    await shareFiles(files);
  } catch (e) { if (!/cancel/i.test(e.message)) toast('No se pudo exportar: ' + e.message); }
  if (btn) btn.disabled = false;
}

// ---------- Perfil (más) ----------
async function viewMore() {
  const s = await getSettings().catch(() => ({}));
  const p = s.profile || {};
  const since = p.createdAt ? new Date(p.createdAt).toLocaleDateString('es-MX', { month: 'long', year: 'numeric' }) : '';
  let stats = '';
  try {
    const [lib, hist] = await Promise.all([api('/api/library'), api('/api/history')]);
    stats = `${lib.length} serie${lib.length === 1 ? '' : 's'} en tu biblioteca · ${hist.length} leída${hist.length === 1 ? '' : 's'} recientemente`;
  } catch {}
  const row = (href, icon, label, sub = '') => `<a class="row menu-row" href="${href}">${icon}<div class="grow"><div>${label}</div>${sub ? `<div class="muted small">${sub}</div>` : ''}</div>${ICON.chevron.replace('<svg', '<svg style="width:18px;height:18px;fill:var(--muted)"')}</a>`;
  view.insertAdjacentHTML('beforeend', `<div class="head"><h1>Perfil</h1></div>
    <div class="profile-card">${avatarHTML(p, 'lg')}<div class="grow"><h2>${esc(p.name || 'Sin nombre')}</h2>
      <div class="muted small">${since ? `Lector desde ${esc(since)}` : ''}</div><div class="muted small">${esc(stats)}</div></div>
      <a class="btn" href="#/welcome">Editar</a></div>
    <div class="rows">
      ${row('#/history', ICON.history, 'Historial', 'Lo último que leíste')}
      ${row('#/downloads', ICON.download, 'Descargas', 'En la computadora y en este dispositivo')}
      ${row('#/settings', ICON.gear, 'Ajustes', 'Tema, idioma, lector y almacenamiento')}
    </div>
    <div style="text-align:center;margin-top:32px"><img src="/brand/logo-256.png" alt="" width="56" height="56" style="border-radius:14px;margin:0 auto 8px">
      <div class="wordmark"><span class="a">PIRATE</span> <span class="b">READER</span></div>
      <div class="muted small" style="margin-top:4px">Cómics | Manhwa | Manga · uso personal</div></div>`);
}

// ---------- Lector ----------
async function viewRead([src, seriesId, chapterId]) {
  document.body.classList.add('reading');
  $('.offline-bar')?.remove();
  return openReader(view, { src, seriesId, chapterId });
}

// ---------- Ajustes ----------
async function viewSettings() {
  const s = await getSettings(true).catch(() => getSettings());
  const types = [['manga', 'Manga'], ['manhwa', 'Manhwa'], ['manhua', 'Manhua'], ['cómic', 'Cómic'], ['libro', 'Libro']];
  const modes = [['rtl', 'Página, derecha a izquierda'], ['ltr', 'Página, izquierda a derecha'], ['webtoon', 'Vertical continuo (webtoon)']];
  const theme = localStorage.getItem('theme') || s.theme || 'light';
  const ck = (name, val, label) => `<div class="setting"><label for="${name}-${val}">${label}</label><input type="checkbox" id="${name}-${val}" data-arr="${name}" value="${val}" ${s[name]?.includes(val) ? 'checked' : ''}></div>`;
  view.insertAdjacentHTML('beforeend', `<button class="btn" id="back" style="margin-bottom:16px">${ICON.back}Perfil</button><div class="head"><h1>Ajustes</h1></div>
    <h2>Apariencia</h2>
    <div class="rows">
      <div class="setting"><label for="theme">Tema</label><select id="theme">${[['light', 'Claro'], ['dark', 'Oscuro'], ['system', 'Automático']].map(([v, l]) => `<option value="${v}" ${theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <div class="setting"><label for="bgc">Fondo del lector</label><select id="bgc">${[['theme', 'Según el tema'], ['black', 'Negro'], ['white', 'Blanco']].map(([v, l]) => `<option value="${v}" ${(s.background || 'theme') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <h2>Sinopsis</h2>
    <div class="rows">
      <div class="setting"><label for="tr">Traducir sinopsis al español automáticamente</label><input type="checkbox" id="tr" ${s.translate !== false ? 'checked' : ''}></div>
      <div class="setting" style="flex-wrap:wrap"><label for="tre" style="flex:1 1 220px">Correo para ampliar el límite de traducción (opcional)<br><span class="muted small">Sin correo: unas 10 sinopsis al día. Con correo: unas 100. Lo usa solo el servicio MyMemory.</span></label>
        <input class="input" id="tre" type="email" inputmode="email" autocomplete="email" placeholder="tucorreo@ejemplo.com" value="${esc(s.translateEmail || '')}" style="max-width:280px"></div>
    </div>
    <h2>Idioma de los capítulos (MangaDex)</h2>
    <div class="rows">${ck('languages', 'es-la', 'Español latinoamericano')}${ck('languages', 'es', 'Español de España')}${ck('languages', 'en', 'Inglés <span class="muted small">— mucho más catálogo, sobre todo cómics</span>')}</div>
    <h2>Clasificación de contenido</h2>
    <p class="muted small" style="margin:-4px 0 8px">Marca “Erótico” y “Adulto (+18)” para ver contenido explícito en el catálogo.</p>
    <div class="rows">${ck('contentRating', 'safe', 'Apto para todos')}${ck('contentRating', 'suggestive', 'Sugerente')}${ck('contentRating', 'erotica', 'Erótico')}${ck('contentRating', 'pornographic', 'Adulto (+18)')}</div>
    <h2>Lector</h2>
    <div class="rows">
      ${types.map(([t, l]) => `<div class="setting"><label for="m-${t}">Modo para ${l}</label><select id="m-${t}" data-mode="${t}">${modes.map(([v, ml]) => `<option value="${v}" ${s.readerMode?.[t] === v ? 'selected' : ''}>${ml}</option>`).join('')}</select></div>`).join('')}
      <div class="setting"><label for="dp">Doble página en pantallas horizontales</label><input type="checkbox" id="dp" ${s.doublePage ? 'checked' : ''}></div>
      <div class="setting"><label for="ds">Ahorro de datos (imágenes comprimidas de MangaDex)</label><input type="checkbox" id="ds" ${s.dataSaver ? 'checked' : ''}></div>
    </div>
    <h2>Mis archivos</h2>
    ${STANDALONE ? `<div class="rows"><div class="setting"><div class="grow"><div>Importar archivos de este teléfono</div>
      <div class="muted small">CBZ, CBR, ZIP, RAR, PDF o EPUB. Se agrupan por serie según su nombre o su ComicInfo.xml y aparecen en Explorar → Mis archivos.</div></div>
      <label class="btn primary">Importar<input type="file" id="imp" multiple accept=".cbz,.cbr,.zip,.rar,.pdf,.epub,application/zip,application/pdf,application/epub+zip,application/x-cbr,application/x-cbz,application/vnd.comicbook+zip,application/vnd.comicbook-rar,*/*" hidden></label></div></div>` : `
    <div class="rows"><div class="setting"><div class="grow"><div>Carpeta de la biblioteca</div><div class="muted small" style="word-break:break-all">${esc(s.libraryDir || '')}</div>
      <div class="muted small">Formatos: CBZ, CBR, ZIP, RAR, PDF, EPUB y carpetas de imágenes. Una subcarpeta por serie.</div></div>
      <button class="btn" id="rescan">Volver a escanear</button></div></div>`}
    <h2>Diagnóstico</h2>
    <div class="rows"><div class="setting"><div class="grow"><div>Registro de errores</div><div class="muted small" id="diag-count"></div></div>
      <button class="btn" id="diag-show">Ver</button></div></div>
    <div id="diag" hidden style="margin-top:8px"></div>
    <h2>Almacenamiento</h2>
    <div class="rows"><div class="setting"><label>${STANDALONE ? 'Caché de portadas' : 'Caché de imágenes en la computadora'}</label><button class="btn" id="cache">Vaciar caché</button></div></div>`);
  $('#back').onclick = () => { location.hash = '#/more'; };
  const save = async patch => {
    try { const lib = s.libraryDir; settingsCache = await api('/api/settings', { method: 'PUT', body: patch }); settingsCache.libraryDir = lib; localStorage.setItem('settingsCopy', JSON.stringify(settingsCache)); toast('Guardado'); }
    catch (e) { toast(e.message); }
  };
  $('#theme').onchange = e => { applyTheme(e.target.value); save({ theme: e.target.value }); };
  view.querySelectorAll('[data-arr]').forEach(el => el.onchange = () => {
    const name = el.dataset.arr;
    const vals = [...view.querySelectorAll(`[data-arr="${name}"]:checked`)].map(x => x.value);
    if (!vals.length) { el.checked = true; toast('Deja al menos una opción marcada'); return; }
    save({ [name]: vals });
  });
  view.querySelectorAll('[data-mode]').forEach(el => el.onchange = () => {
    const rm = { ...s.readerMode }; view.querySelectorAll('[data-mode]').forEach(x => rm[x.dataset.mode] = x.value); s.readerMode = rm; save({ readerMode: rm });
  });
  $('#dp').onchange = e => save({ doublePage: e.target.checked });
  $('#tr').onchange = e => save({ translate: e.target.checked });
  $('#tre').addEventListener('change', e => {
    const v = e.target.value.trim();
    if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) { toast('Escribe un correo válido o déjalo vacío'); e.target.classList.add('invalid'); return; }
    e.target.classList.remove('invalid'); save({ translateEmail: v });
  });
  const diagCount = () => { const n = readLog().length; $('#diag-count').textContent = n ? `${n} error(es) recientes` : 'Sin errores registrados'; };
  diagCount();
  $('#diag-show').onclick = () => {
    const box = $('#diag'), log = readLog();
    box.hidden = !box.hidden;
    if (box.hidden) return;
    box.innerHTML = log.length ? `<div class="rows">${log.map(x => `<div class="row"><div class="grow"><div class="small">${esc(x.where)}</div><div class="muted small" style="word-break:break-word">${esc(x.msg)}</div><div class="muted small">${new Date(x.at).toLocaleString('es-MX')}</div></div></div>`).join('')}</div>
      <div class="actions"><button class="btn" id="diag-copy">Copiar registro</button><button class="btn danger" id="diag-clear">Borrar registro</button></div>`
      : '<p class="muted">No hay errores registrados.</p>';
    $('#diag-copy')?.addEventListener('click', async () => {
      const txt = log.map(x => `${new Date(x.at).toISOString()} | ${x.where} | ${x.msg}`).join('\n');
      try { await navigator.clipboard.writeText(txt); toast('Registro copiado'); } catch { toast('No se pudo copiar'); }
    });
    $('#diag-clear')?.addEventListener('click', () => { clearLog(); box.hidden = true; diagCount(); toast('Registro borrado'); });
  };
  $('#ds').onchange = e => save({ dataSaver: e.target.checked });
  $('#bgc').onchange = e => save({ background: e.target.value });
  $('#imp')?.addEventListener('change', async e => {
    const files = [...e.target.files]; if (!files.length) return;
    try {
      const { importFiles } = await import('./standalone/backend.js');
      const n = await importFiles(files, i => toast(`Importando ${i} de ${files.length}…`));
      toast(n ? `${n} archivo(s) importados` : 'Ningún archivo compatible');
      if (n) location.hash = '#/explore?src=local&mode=popular';
    } catch (err) { toast('No se pudo importar: ' + err.message); }
    e.target.value = '';
  });
  if ($('#rescan')) $('#rescan').onclick = async e => {
    e.target.disabled = true; e.target.textContent = 'Escaneando…';
    try { const r = await api('/api/local/rescan', { method: 'POST' }); toast(`${r.series} series encontradas`); }
    catch (err) { toast(err.message); }
    e.target.disabled = false; e.target.textContent = 'Volver a escanear';
  };
  $('#cache').onclick = async () => { if (!confirm('¿Vaciar la caché de imágenes? Se volverán a descargar al leer.')) return; await api('/api/cache', { method: 'DELETE' }).catch(e => toast(e.message)); toast('Caché vaciada'); };
}

// ---------- Inicio ----------
if (!STANDALONE && 'serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
getSettings().then(s => {
  updateNavAvatar(s.profile);
  // el tema elegido en otro dispositivo se aplica aquí si este no tiene uno propio guardado
  if (s.theme && !localStorage.getItem('theme')) applyTheme(s.theme);
}).catch(() => {});
route();
