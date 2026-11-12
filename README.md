# MangaDex — lector de cómics, manhwa y manga (uso personal)

App web que corre en tu computadora y se usa desde el navegador de la PC o del celular (se puede instalar como app).

**Fuentes incluidas**

- **MangaDex (español):** catálogo en línea filtrado a capítulos en español latinoamericano y de España. Tiene búsqueda, populares, recientes y filtros por género, tema, tipo (manga, manhwa o manhua), estado, demografía y clasificación.
- **Mis archivos:** tu carpeta con CBZ, CBR, ZIP, RAR, PDF, EPUB o carpetas de imágenes. Si tus archivos traen `ComicInfo.xml`, la app lee de ahí el título, los géneros y la sinopsis.

**Lector**

- Modos: página de derecha a izquierda (manga), de izquierda a derecha (cómic) y vertical continuo (webtoon), además de doble página y ajuste al alto o al ancho.
- Cada serie recuerda su modo y se guarda la página en la que vas.
- Al terminar un capítulo puedes pasar directo al siguiente.
- Navegas con toques, deslizando el dedo o con el teclado.

**Además:**

- Pantalla de bienvenida para crear tu perfil: nombre, avatar o foto, idioma y tema.
- Tema claro por defecto; el oscuro (o el automático) se elige en Ajustes.
- Biblioteca con categorías y la sección “Continuar leyendo”.
- Novedades de tus series e historial de lectura.
- **Descargas:** un capítulo, varios o la colección completa (ver abajo).

## Requisitos

- [Node.js](https://nodejs.org) 18 o más reciente (recomendado: 20 o 22 LTS).

## Instalación

```bash
cd lector-manga
npm install
npm start
```

La consola muestra dos direcciones:

```
En esta PC:      http://localhost:3000
En tu celular:   http://192.168.1.50:3000
```

Para leer en el celular, conéctalo a la **misma red Wi-Fi** que la PC y abre la segunda dirección. Para instalarla como app:

- En Chrome (Android): menú ⋮ → **Agregar a la pantalla principal**.
- En Safari (iPhone): Compartir → **Agregar a inicio**.

En Windows también puedes darle doble clic a `iniciar.bat`.

> La primera vez, Windows puede preguntar si permites que Node.js use la red. Acepta en **redes privadas**; si no, el celular no podrá conectarse.

## Tu carpeta de archivos

Por defecto la app lee la carpeta `biblioteca/`, dentro del proyecto. Pon **una subcarpeta por serie**:

```
biblioteca/
├── One Punch Man/
│   ├── Tomo 01.cbz
│   └── Tomo 02.cbz
├── Solo Leveling/
│   ├── Cap 001.cbr
│   └── Cap 002/         ← también vale una carpeta con imágenes
│       ├── 01.jpg
│       └── 02.jpg
└── Una novela.epub      ← archivo suelto = serie de un solo tomo
```

Después de copiar archivos nuevos, ve a **Ajustes → Volver a escanear**.

Si quieres usar otra carpeta, copia `config.example.json` como `config.json` y edítalo:

```json
{
  "port": 3000,
  "libraryDir": "D:/Comics",
  "imageCacheMB": 1024
}
```

## Descargas

En la ficha de una serie, pulsa **Descargar**. Ahí eliges qué capítulos (todos, los no leídos, los siguientes 5 o los que marques) y dónde guardarlos:

| Destino | Qué hace | Para qué sirve |
|---|---|---|
| **En la computadora** | Guarda cada capítulo como un archivo CBZ en `datos/descargas/`. | Leer sin internet desde cualquier dispositivo conectado a tu PC. Exportar un capítulo (CBZ) o la colección completa (ZIP) para abrirla en cualquier lector. |
| **En este dispositivo** | Guarda las páginas en el almacenamiento del navegador del teléfono o de la PC. | Leer con la computadora apagada o fuera de casa. |

En la pestaña **Descargas** ves el progreso y lo que tienes guardado en cada lugar, y desde ahí exportas o borras.

### Leer en el celular con la computadora apagada

Por seguridad, el navegador solo deja guardar páginas e instalar la app de verdad (como APK) si la dirección es **segura**: `https://` o `localhost`. Tu PC en casa usa `http://192.168.x.x`, así que necesitas una de estas dos opciones.

**Opción A, rápida (Chrome en Android):**

1. Abre `chrome://flags/#unsafely-treat-insecure-origin-as-secure`.
2. Actívalo y escribe la dirección de tu PC, por ejemplo `http://192.168.1.50:3000`.
3. Reinicia Chrome.
4. Abre la app y en el menú ⋮ elige **Instalar app**. Chrome genera un APK instalado (WebAPK) con el icono de MangaDex.

**Opción B, desde cualquier lugar (Tailscale, gratuito):**

1. Instala [Tailscale](https://tailscale.com) en tu PC y en tu teléfono, con la misma cuenta.
2. En el panel de Tailscale, activa **MagicDNS** y **HTTPS Certificates**.
3. En la PC ejecuta `tailscale serve --bg 3000`.
4. Abre en el teléfono la dirección `https://…ts.net` que te muestra el comando. Funciona también fuera de casa, con certificado válido, y la app se instala.

Si usas la app desde la misma PC con `http://localhost:3000`, el guardado en el dispositivo funciona sin hacer nada.

## Ajustes útiles

- **Tema:** claro (predeterminado), oscuro o automático. El fondo del lector puede seguir el tema o fijarse en negro o blanco.
- **Idioma:** español latino, de España o ambos.
- **Clasificación:** el contenido erótico y para adultos está oculto por defecto.
- **Modo de lectura por tipo:** por ejemplo, manga de derecha a izquierda y manhwa en vertical.
- **Ahorro de datos:** usa las imágenes comprimidas de MangaDex.

## Cómo está hecho

```
server.js                 Servidor Express: rutas /api/*, proxy y caché de imágenes
src/sources/mangadex.js   Conector de MangaDex (API v5, límite de ~5 peticiones/seg)
src/sources/local.js      Conector de tu carpeta (escaneo, ComicInfo.xml)
src/archive.js            Lectura de CBZ/ZIP, CBR/RAR y carpetas de imágenes
src/store.js              Biblioteca, progreso, historial y ajustes en datos/db.json
public/                   Interfaz (HTML, CSS y JavaScript sin compilación)
public/reader.js          El lector (imágenes, PDF con pdf.js, EPUB con epub.js)
public/offline.js         Guardado en el dispositivo (Cache Storage)
public/sw.js              Service worker: app sin conexión
src/downloads.js          Cola de descargas a CBZ en la computadora
public/brand/             Logo, isotipo y portada
```

Todas las fuentes cumplen la misma interfaz: `list`, `getFilters`, `series`, `chapters` y `pages`. Para agregar otra (por ejemplo, un servidor Komga o Kavita propio):

1. Crea `src/sources/otra.js` con esas cinco funciones. Debe devolver los mismos objetos `serie` y `capítulo` que `mangadex.js`.
2. Regístrala en `server.js`, en `const sources = { mangadex, local, otra }`.
3. Si sirve imágenes desde otro dominio, agrégalo a `mangadexImageHosts` o crea su propia ruta de proxy.

La interfaz la detecta sola: aparece como otra pestaña en **Explorar**.

## Problemas comunes

| Síntoma | Solución |
|---|---|
| “MangaDex está limitando las peticiones” | Espera un minuto. MangaDex limita a unas 5 peticiones por segundo por conexión. |
| El celular no abre la página | Revisa que esté en el mismo Wi-Fi y que el firewall de Windows permita Node.js en redes privadas. |
| Un CBR no abre | Algunos RAR5 con contraseña o dañados no se pueden leer. Conviértelo a CBZ (por ejemplo, con 7-Zip). |
| No aparece una serie de MangaDex | Solo se muestran series con capítulos en los idiomas que marcaste en Ajustes. |
| “Guardar en este dispositivo” aparece desactivado | La dirección no es segura. Sigue la opción A o B de la sección “Leer en el celular con la computadora apagada”. |
| Las imágenes ocupan mucho espacio | Ajustes → **Vaciar caché**, o baja `imageCacheMB` en `config.json`. |

Los datos se guardan en la carpeta `datos/`: perfil, biblioteca, progreso, caché y descargas. Para respaldarlos, copia toda esa carpeta.

> El nombre y el logo “MangaDex” coinciden con los del sitio mangadex.org. Para uso personal no hay problema; si algún día publicas o compartes la app, conviene cambiarles el nombre.
