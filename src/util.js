// Utilidades compartidas: caché con caducidad, limitador de peticiones y orden natural.

export class TTLCache {
  constructor(max = 500) { this.max = max; this.map = new Map(); }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.exp < Date.now()) { this.map.delete(key); return undefined; }
    // refresca posición (LRU)
    this.map.delete(key); this.map.set(key, hit);
    return hit.value;
  }
  set(key, value, ttlMs) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: Date.now() + ttlMs });
    return value;
  }
  delete(key) { this.map.delete(key); }
}

// Limitador: separa las peticiones al menos `minIntervalMs` y, opcionalmente,
// no deja pasar más de `maxPerWindow` en `windowMs` (ventana deslizante).
export class RateLimiter {
  constructor({ minIntervalMs = 0, maxPerWindow = Infinity, windowMs = 60000 } = {}) {
    Object.assign(this, { minIntervalMs, maxPerWindow, windowMs });
    this.last = 0; this.stamps = []; this.chain = Promise.resolve();
  }
  schedule(fn) {
    const run = this.chain.then(async () => {
      for (;;) {
        const now = Date.now();
        this.stamps = this.stamps.filter(t => now - t < this.windowMs);
        let wait = Math.max(0, this.last + this.minIntervalMs - now);
        if (this.stamps.length >= this.maxPerWindow) {
          wait = Math.max(wait, this.stamps[0] + this.windowMs - now);
        }
        if (wait <= 0) break;
        await sleep(wait);
      }
      this.last = Date.now(); this.stamps.push(this.last);
    });
    this.chain = run.catch(() => {});
    return run.then(fn);
  }
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));

const collator = new Intl.Collator('es', { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b);

export const IMAGE_RE = /\.(jpe?g|png|webp|gif|avif|bmp)$/i;

export const b64url = {
  enc: s => Buffer.from(s, 'utf8').toString('base64url'),
  dec: s => Buffer.from(s, 'base64url').toString('utf8'),
};

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
