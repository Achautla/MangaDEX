// src/sources/comicbooks.js
import * as comicsApi from 'comicbooks-api';
import mfLink from 'mediafire-getlink';
import AdmZip from 'adm-zip';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const comicsCache = new Map();
// Carpeta temporal donde se guardarán las imágenes extraídas
export const CACHE_DIR = path.join(os.tmpdir(), 'comicbooks-cache'); 

const makeId = (title) => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

// Función que descarga el CBZ/ZIP y extrae las imágenes
async function downloadAndExtract(comicData) {
  const id = makeId(comicData.title);
  const extractPath = path.join(CACHE_DIR, id);

  // Si ya está descargado y extraído, devolvemos las imágenes
  try {
    await fs.access(extractPath);
    const files = await fs.readdir(extractPath);
    return files.filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f)).sort();
  } catch {
    // Si no existe, continuamos para descargarlo
  }

  // Elegimos el enlace de descarga (priorizamos MediaFire)
  let downloadUrl = comicData.downloadLinks?.MEDIAFIRE || comicData.downloadLinks?.DOWNLOADNOW;
  if (!downloadUrl) throw new Error('No hay enlace de descarga disponible');

  // Si es de MediaFire, resolvemos el enlace directo
  if (downloadUrl.includes('mediafire.com')) {
    try {
      downloadUrl = await mfLink(downloadUrl);
    } catch (e) {
      console.error('Error resolviendo MediaFire:', e);
      throw new Error('No se pudo obtener el enlace directo de MediaFire');
    }
  }

  // Descargamos el archivo
  const res = await fetch(downloadUrl);
  if (!res.ok) throw new Error(`Error al descargar: ${res.status}`);
  const arrayBuffer = await res.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  // Extraemos el ZIP
  const zip = new AdmZip(buffer);
  await fs.mkdir(extractPath, { recursive: true });
  zip.extractAllTo(extractPath, true);

  // Devolvemos la lista de imágenes ordenadas
  const files = await fs.readdir(extractPath);
  return files.filter(f => /\.(jpg|jpeg|png|webp|gif)$/i.test(f)).sort();
}

export function createComicBooks() {
  function mapComic(c) {
    const id = makeId(c.title);
    comicsCache.set(id, c);
    return {
      source: 'comicbooks',
      id: id,
      title: c.title,
      altTitles: [],
      description: c.description || 'Sin descripción disponible.',
      languages: ['en'],
      cover: c.coverPage || null,
      authors: ['Desconocido'],
      artists: ['Desconocido'],
      status: 'Finalizado',
      type: 'cómic',
      demographic: null,
      genres: [],
      contentRating: 'safe',
      year: c.information?.Year || '',
      readingDir: 'ltr',
      lastChapter: null,
    };
  }

  async function list({ mode = 'latest', page = 1, q = '' }) {
    try {
      let result;
      if (q) result = await comicsApi.getComicsThroughSearch(q, page);
      else result = await comicsApi.getLatestComics(page);
      
      const items = Array.isArray(result) ? result.map(mapComic) : [];
      return { items, hasMore: items.length > 0 };
    } catch (error) {
      console.error('Error en ComicBooks API:', error);
      return { items: [], hasMore: false };
    }
  }

  async function series(id) {
    const cached = comicsCache.get(id);
    if (cached) return mapComic(cached);
    throw new Error('Cómic no encontrado. Búscalo de nuevo.');
  }

  async function chapters(id) {
    const cached = comicsCache.get(id);
    if (!cached) return [];
    return [{
      external: null, // null para que el lector lo abra internamente
      id: `internal-${id}`,
      number: '1',
      volume: null,
      title: 'Leer Cómic',
      lang: 'en',
      group: 'ComicBooks',
      date: new Date().toISOString(),
      pages: 0 
    }];
  }

  async function pages(chapterId) {
    const comicId = chapterId.replace('internal-', '');
    const cached = comicsCache.get(comicId);
    if (!cached) throw new Error('Cómic no encontrado en caché');

    // Esto descargará el archivo la primera vez, luego usará la caché local
    const imageFiles = await downloadAndExtract(cached);

    return {
      kind: 'images',
      pages: imageFiles.map((file, index) => ({
        // Esta ruta la crearemos en el Paso 4
        url: `/api/comicbooks/page/${comicId}/${index}` 
      })),
    };
  }

  return {
    id: 'comicbooks',
    name: 'ComicBooks (Lectura Interna)',
    description: 'Catálogo de cómics con descarga y lectura interna automática.',
    capabilities: { popular: false, latest: true, search: true, filters: false, updates: false },
    list,
    getFilters: async () => ({ tags: {}, type: [], status: [], demographic: [], contentRating: [], order: [] }),
    series,
    chapters,
    pages,
    updates: async () => [],
    report: () => {},
    imageHosts: [],
  };
}
