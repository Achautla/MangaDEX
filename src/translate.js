// Traducción automática de sinopsis al español con MyMemory (gratis, sin clave).
// Límite gratuito: 5,000 caracteres al día; con un correo en Ajustes, 50,000.
// Cada sinopsis se traduce una sola vez y se guarda.

const hash = s => { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36) + s.length; };

// Palabras muy frecuentes del español: si abundan, el texto ya está en español.
const ES_WORDS = /\b(el|la|los|las|de|del|que|y|en|un|una|por|con|para|su|sus|es|se|al|lo|como|más|pero|sobre|este|esta)\b/gi;
export function looksSpanish(text) {
  const words = (text.match(/\p{L}+/gu) || []).length;
  if (words < 4) return false;
  return (text.match(ES_WORDS) || []).length / words > 0.18 || /[ñ¿¡]/.test(text);
}

// Divide en trozos de hasta ~450 caracteres respetando oraciones.
function chunks(text, max = 450) {
  const out = [];
  for (const para of text.split(/\n+/)) {
    let cur = '';
    for (const sent of para.match(/[^.!?]+[.!?]*\s*/g) || [para]) {
      if ((cur + sent).length > max && cur) { out.push(cur.trim()); cur = ''; }
      if (sent.length > max) { for (let i = 0; i < sent.length; i += max) out.push(sent.slice(i, i + max)); continue; }
      cur += sent;
    }
    if (cur.trim()) out.push(cur.trim());
    out.push('\n');
  }
  out.pop();
  return out;
}

export function createTranslator({ fetch: http = fetch, email = () => '', cache, base = 'https://api.mymemory.translated.net' }) {
  async function translate(text, from = 'autodetect') {
    text = String(text || '').trim();
    if (!text) return { text: '', translated: false };
    if (from === 'es' || (from === 'autodetect' && looksSpanish(text))) return { text, translated: false, lang: 'es' };
    const key = hash(text);
    const hit = await cache.get(key);
    if (hit) return hit;
    const parts = chunks(text.slice(0, 4000));
    const out = [];
    let detected = from === 'autodetect' ? null : from;
    for (const p of parts) {
      if (p === '\n') { out.push('\n'); continue; }
      const u = new URL(`${base}/get`);
      u.searchParams.set('q', p);
      u.searchParams.set('langpair', `${from === 'autodetect' ? 'autodetect' : from}|es`);
      const mail = email(); if (mail) u.searchParams.set('de', mail);
      let json;
      try {
        const res = await http(u.toString(), { headers: { Accept: 'application/json', 'User-Agent': 'LectorPersonal/1.0 (uso personal)' } });
        json = await res.json();
      } catch { return { text, translated: false, error: 'Sin conexión con el traductor' }; }
      if (json.quotaFinished || json.responseStatus === 429) return { text, translated: false, error: 'Se agotó el límite diario de traducciones gratuitas' };
      if (json.responseStatus !== 200 && json.responseStatus !== '200') return { text, translated: false, error: json.responseDetails || 'No se pudo traducir' };
      detected ||= json.responseData?.detectedLanguage || null;
      if (detected && /^es/i.test(detected)) return { text, translated: false, lang: 'es' };
      out.push(json.responseData?.translatedText || p);
    }
    const result = { text: out.join(' ').replace(/ ?\n ?/g, '\n\n').replace(/\n{3,}/g, '\n\n').trim(), translated: true, from: detected };
    await cache.set(key, result);
    return result;
  }
  return { translate };
}
