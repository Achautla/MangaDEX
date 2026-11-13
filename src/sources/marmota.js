// src/sources/marmota.js
import { load } from 'cheerio'; // Necesitaremos instalar 'cheerio' para parsear HTML

const BASE_URL = 'https://marmota.me';

// Caché simple en memoria para no re-extraer datos constantemente
const cache = new Map();

async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
  });
  if (!res.ok) throw new Error(`Error al obtener ${url}: ${res.status}`);
  return await res.text();
}

export function createMarmota() {
  /**
   * Lista los cómics de la página principal o de una búsqueda.
   * Tu app llamará a esta función con mode: 'latest' o mode: 'search'
   */
  async function list({ mode = 'latest', page = 1, q = '' }) {
    // NOTA: Esta es una implementación básica para la página principal.
    // Para la búsqueda o paginación, habría que ajustar la URL.
    const url = q ? `${BASE_URL}/?s=${encodeURIComponent(q)}` : BASE_URL;
    const html = await fetchHTML(url);
    const $ = load(html);
    const items = [];

    // Buscamos los enlaces a cómics. El patrón es /comic/...
    $('a[href*="/comic/"]').each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      // Evitamos duplicados y enlaces que no son de series
      if (items.some(it => it.id === href) || href.includes('/comic/') === false) return;

      const title = $el.text().trim() || $el.attr('title');
      // La portada suele estar en una etiqueta img dentro del enlace
      const imgSrc = $el.find('img').attr('src');

      if (title && href && imgSrc) {
        // Generamos un ID único a partir de la URL
        const id = href.replace(BASE_URL, '').replace(/^\/|\/$/g, '');
        items.push({
          source: 'marmota',
          id: id,
          title: title,
          cover: imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`,
          // ... otros campos que espera tu app (type, description, etc.)
          type: 'cómic',
          readingDir: 'ltr',
        });
      }
    });

    // Limitar a 30 resultados y simular paginación
    return { items: items.slice(0, 30), hasMore: items.length > 30 };
  }

  /**
   * Obtiene los detalles de un cómic específico (sinopsis, etc.)
   */
  async function series(id) {
    const url = `${BASE_URL}/${id}`;
    const html = await fetchHTML(url);
    const $ = load(html);
    // Extraer la sinopsis (esto es un ejemplo, habría que inspeccionar el HTML real)
    const description = $('.description, .sinopsis, .summary').first().text().trim() || 'Sin descripción.';
    // ... extraer otros campos (autores, etc.)
    return {
      source: 'marmota',
      id: id,
      title: $('h1').first().text().trim(),
      description: description,
      // ...
    };
  }

  /**
   * Obtiene la lista de capítulos de un cómic.
   */
  async function chapters(id) {
    const url = `${BASE_URL}/${id}`;
    const html = await fetchHTML(url);
    const $ = load(html);
    const chapters = [];

    // Buscamos enlaces a capítulos. El patrón es /comic/serie/capitulo/
    $(`a[href^="/comic/${id}/"]`).each((i, el) => {
      const $el = $(el);
      const href = $el.attr('href');
      const title = $el.text().trim();
      // El número de capítulo suele estar en el texto o en la URL
      const numberMatch = title.match(/\d+/);
      const number = numberMatch ? numberMatch[0] : '';

      if (href && number) {
        chapters.push({
          external: null, // null para que se abra en el lector interno
          id: href, // Usamos la URL como ID único
          number: number,
          title: title,
          lang: 'es',
          group: 'Marmota',
          pages: 0, // Se llenará en la función pages()
        });
      }
    });

    // Ordenar por número de capítulo
    return chapters.sort((a, b) => Number(a.number) - Number(b.number));
  }

  /**
   * Obtiene las URLs de las imágenes de un capítulo.
   */
  async function pages(chapterId) {
    // chapterId es la URL completa del capítulo (ej. /comic/batman-bad-seeds-2026/21-catwoman-92-tie-in/)
    const url = chapterId.startsWith('http') ? chapterId : `${BASE_URL}${chapterId}`;
    const html = await fetchHTML(url);
    const $ = load(html);
    const images = [];

    // Buscamos todas las imágenes dentro del contenedor del lector.
    // Esto es lo que necesitamos inspeccionar del HTML real de marmota.me.
    // Como suposición, buscaremos imágenes dentro de un contenedor con clase 'reader' o similar.
    $('.reader img, .comic-reader img, .entry-content img').each((i, el) => {
      let src = $(el).attr('src');
      if (src && !src.includes('logo') && !src.includes('avatar')) {
        // Asegurarnos de que la URL sea absoluta
        if (!src.startsWith('http')) {
          src = `${BASE_URL}${src}`;
        }
        images.push({ url: src });
      }
    });

    if (images.length === 0) {
      throw new Error('No se encontraron imágenes en este capítulo. Es posible que el sitio haya cambiado su estructura.');
    }

    return {
      kind: 'images',
      pages: images,
    };
  }

  return {
    id: 'marmota',
    name: 'Marmota Comics',
    description: 'Cómics en español desde marmota.me.',
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
