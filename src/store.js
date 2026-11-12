// Almacenamiento en un archivo JSON (biblioteca, progreso, historial y ajustes).
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT = {
  library: {},   // "fuente:id" -> serie resumida + addedAt + category
  progress: {},  // "fuente:capítulo" -> { seriesId, page, total, done, cfi, updatedAt }
  history: [],   // últimas lecturas
  settings: {
    languages: ['es', 'es-la'],
    contentRating: ['safe', 'suggestive'],
    dataSaver: false,
    readerMode: { manga: 'rtl', manhwa: 'webtoon', manhua: 'webtoon', 'cómic': 'ltr', libro: 'ltr' },
    doublePage: false,
    background: 'theme',
    theme: 'light',
    profile: null,
  },
};

export function createStore(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let db;
  try { db = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { db = {}; }
  db = { ...structuredClone(DEFAULT), ...db, settings: { ...DEFAULT.settings, ...(db.settings || {}) } };

  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, file); // escritura atómica
    }, 300);
  };

  return {
    get db() { return db; },
    settings: () => db.settings,
    save,
    flush() { clearTimeout(timer); fs.writeFileSync(file, JSON.stringify(db)); },
  };
}
