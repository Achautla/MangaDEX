// Lector de XML mínimo (sin dependencias) para feeds Atom/OPDS. Funciona igual en Node y en el teléfono.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export const decodeEntities = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
  if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  return ENT[e.toLowerCase()] ?? m;
});

function parseAttrs(str) {
  const out = {};
  for (const m of str.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    out[m[1]] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

// Devuelve un árbol { name, local, attrs, children, text }.
export function parseXml(xml) {
  const root = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(xml))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].name === m[2]) { stack.length = i; break; }
    } else if (m[3]) {
      const node = { name: m[3], local: m[3].split(':').pop(), attrs: parseAttrs(m[4] || ''), children: [], text: '' };
      top.children.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6]) top.text += decodeEntities(m[6]);
  }
  return root;
}

export const kids = (n, local) => (n?.children || []).filter(c => c.local === local);
export const kid = (n, local) => kids(n, local)[0];
export const textOf = n => (n ? (n.text + n.children.map(textOf).join('')).trim() : '');
// Atributo ignorando prefijos (p. ej. "pse:count" → "count")
export const attr = (n, local) => {
  if (!n) return undefined;
  for (const [k, v] of Object.entries(n.attrs)) if (k === local || k.split(':').pop() === local) return v;
  return undefined;
};
