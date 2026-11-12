// Apertura de CBZ/ZIP, CBR/RAR y carpetas de imágenes, con caché de los últimos archivos abiertos.
import fs from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { createExtractorFromData } from 'node-unrar-js';
import { naturalCompare, IMAGE_RE } from './util.js';

const open = new Map(); // abs -> Promise<{names, read}>
const MAX_OPEN = 4;

async function detect(abs, kind) {
  if (kind === 'folder') return 'folder';
  const fh = await fs.open(abs, 'r');
  try {
    const buf = Buffer.alloc(4);
    await fh.read(buf, 0, 4, 0);
    if (buf.toString('latin1', 0, 4) === 'Rar!') return 'rar'; // CBZ mal nombrados
    if (buf[0] === 0x50 && buf[1] === 0x4b) return 'zip';
  } finally { await fh.close(); }
  return kind;
}

async function load(abs, kind) {
  const real = await detect(abs, kind);
  if (real === 'folder') {
    const names = (await fs.readdir(abs)).filter(n => IMAGE_RE.test(n)).sort(naturalCompare);
    return { names, read: i => fs.readFile(path.join(abs, names[i])) };
  }
  if (real === 'zip') {
    const zip = new AdmZip(abs);
    const entries = zip.getEntries()
      .filter(e => !e.isDirectory && IMAGE_RE.test(e.entryName) && !/(^|\/)(__MACOSX|\.)/.test(e.entryName))
      .sort((a, b) => naturalCompare(a.entryName, b.entryName));
    return { names: entries.map(e => e.entryName), read: async i => entries[i].getData() };
  }
  if (real === 'rar') {
    const data = await fs.readFile(abs);
    const extractor = await createExtractorFromData({ data: Uint8Array.from(data).buffer });
    const list = [...extractor.getFileList().fileHeaders]
      .filter(h => !h.flags.directory && IMAGE_RE.test(h.name))
      .map(h => h.name).sort(naturalCompare);
    // Se extrae todo una vez: los RAR no permiten acceso aleatorio barato.
    const extracted = await createExtractorFromData({ data: Uint8Array.from(data).buffer });
    const files = new Map();
    for (const f of extracted.extract({ files: list }).files) files.set(f.fileHeader.name, Buffer.from(f.extraction));
    return { names: list, read: async i => files.get(list[i]) };
  }
  throw new Error('Formato no soportado');
}

export function openArchive(abs, kind) {
  if (open.has(abs)) {
    const p = open.get(abs); open.delete(abs); open.set(abs, p); return p;
  }
  if (open.size >= MAX_OPEN) open.delete(open.keys().next().value);
  const p = load(abs, kind).catch(e => { open.delete(abs); throw e; });
  open.set(abs, p);
  return p;
}

// Lee ComicInfo.xml (formato ComicRack) y lo devuelve como objeto plano.
export async function readComicInfo(abs, kind) {
  const real = await detect(abs, kind);
  let xml = null;
  if (real === 'zip') {
    const zip = new AdmZip(abs);
    const e = zip.getEntries().find(e => /(^|\/)comicinfo\.xml$/i.test(e.entryName));
    if (e) xml = e.getData().toString('utf8');
  } else if (real === 'rar') {
    const data = await fs.readFile(abs);
    const ex = await createExtractorFromData({ data: Uint8Array.from(data).buffer });
    const name = [...ex.getFileList().fileHeaders].map(h => h.name).find(n => /(^|\/)comicinfo\.xml$/i.test(n));
    if (name) {
      const ex2 = await createExtractorFromData({ data: Uint8Array.from(data).buffer });
      const [f] = [...ex2.extract({ files: [name] }).files];
      if (f) xml = Buffer.from(f.extraction).toString('utf8');
    }
  }
  if (!xml) return null;
  const out = {};
  for (const m of xml.matchAll(/<(\w+)>([^<]*)<\/\1>/g)) out[m[1]] = decode(m[2].trim());
  return out;
}

const decode = s => s
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
