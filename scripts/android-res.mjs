// Copia el icono, la pantalla de inicio y los colores de la marca al proyecto Android generado por Capacitor.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const res = path.join(root, 'android', 'app', 'src', 'main', 'res');
await fs.cp(path.join(root, 'android-res'), res, { recursive: true, force: true });

// Número de versión a partir de la compilación de GitHub (permite instalar encima de la anterior).
// versionCode = minutos desde 2026: siempre sube, venga de cualquier flujo de GitHub.
const run = Number(process.env.GITHUB_RUN_NUMBER || 1);
const code = Math.max(1, Math.floor((Date.now() - Date.UTC(2026, 0, 1)) / 60000));
const gradle = path.join(root, 'android', 'app', 'build.gradle');
let g = await fs.readFile(gradle, 'utf8');
g = g.replace(/versionCode \d+/, `versionCode ${code}`).replace(/versionName "[^"]*"/, `versionName "1.0.${run}"`);
await fs.writeFile(gradle, g);
// Permitir servidores http:// de la red de casa (Komga, Kavita, Calibre-Web en tu PC).
const manifest = path.join(root, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
let m = await fs.readFile(manifest, 'utf8');
if (!/usesCleartextTraffic/.test(m)) m = m.replace(/<application\b/, '<application android:usesCleartextTraffic="true"');
await fs.writeFile(manifest, m);
console.log(`✔ Recursos de Android copiados (versión 1.0.${run})`);
