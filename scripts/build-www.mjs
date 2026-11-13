// Prepara la carpeta www/ que se empaqueta dentro del APK (modo "standalone", sin servidor).
// Uso: npm run build:www
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'www');
const nm = p => path.join(root, 'node_modules', p);

await fs.rm(out, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });

// 1) La interfaz (sin el service worker: dentro del APK no hace falta)
await fs.cp(path.join(root, 'public'), out, { recursive: true, filter: src => !src.endsWith(`${path.sep}sw.js`) });

// 2) Código compartido con el servidor (conector de MangaDex)
await fs.mkdir(path.join(out, 'shared', 'sources'), { recursive: true });
await fs.copyFile(path.join(root, 'src', 'util.js'), path.join(out, 'shared', 'util.js'));
await fs.copyFile(path.join(root, 'src', 'translate.js'), path.join(out, 'shared', 'translate.js'));
await fs.copyFile(path.join(root, 'src', 'xml.js'), path.join(out, 'shared', 'xml.js'));
for (const f of ['mangadex.js', 'archive.js', 'opds.js', 'mangaplus.js', 'peppercarrot.js']) await fs.copyFile(path.join(root, 'src', 'sources', f), path.join(out, 'shared', 'sources', f));

// 3) Librerías
await fs.mkdir(path.join(out, 'vendor'), { recursive: true });
const copies = [
  ['pdfjs-dist/build/pdf.min.mjs', 'pdf.mjs'],
  ['pdfjs-dist/build/pdf.worker.min.mjs', 'pdf.worker.mjs'],
  ['epubjs/dist/epub.min.js', 'epub.js'],
  ['jszip/dist/jszip.min.js', 'jszip.js'],
  ['@capacitor/core/dist/capacitor.js', 'capacitor.js'],
  ['node-unrar-js/esm/js/unrar.wasm', 'unrar.wasm'],
];
for (const [from, to] of copies) await fs.copyFile(nm(from), path.join(out, 'vendor', to));
await build({
  entryPoints: [path.join(root, 'scripts', 'unrar-entry.mjs')],
  bundle: true, format: 'esm', platform: 'browser', minify: true,
  external: ['fs', 'path', 'crypto'],
  outfile: path.join(out, 'vendor', 'unrar.mjs'),
  logLevel: 'warning',
});

// 4) Modo standalone + Capacitor
const apiOverride = process.env.MANGADEX_API ? `\nwindow.MANGADEX_API = ${JSON.stringify(process.env.MANGADEX_API)};\nwindow.MANGADEX_UPLOADS = ${JSON.stringify(process.env.MANGADEX_UPLOADS || process.env.MANGADEX_API)};\nwindow.ARCHIVE_BASE = ${JSON.stringify(process.env.ARCHIVE_BASE || 'https://archive.org')};\nwindow.IIIF_BASE = ${JSON.stringify(process.env.IIIF_BASE || 'https://iiif.archive.org')};${process.env.TRANSLATE_API ? `\nwindow.TRANSLATE_API = ${JSON.stringify(process.env.TRANSLATE_API)};` : ''}${process.env.MANGAPLUS_API ? `\nwindow.MANGAPLUS_API = ${JSON.stringify(process.env.MANGAPLUS_API)};` : ''}${process.env.PEPPER_BASE ? `\nwindow.PEPPER_BASE = ${JSON.stringify(process.env.PEPPER_BASE)};` : ''}` : '';
await fs.writeFile(path.join(out, 'config.js'), `// Generado por scripts/build-www.mjs\nwindow.APP_MODE = 'standalone';${apiOverride}\n`);
let html = await fs.readFile(path.join(out, 'index.html'), 'utf8');
html = html.replace('<script src="/config.js"></script>', '<script src="/vendor/capacitor.js"></script>\n  <script src="/config.js"></script>');
html = html.replace(/\s*<link rel="manifest"[^>]*>/, '');
await fs.writeFile(path.join(out, 'index.html'), html);

console.log('✔ www/ lista para el APK');
