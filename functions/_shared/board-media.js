// Public board display copies keep image bytes outside JSON. Originals stay in KV.
export const BOARD_TYPES = new Set(['events', 'etc', 'cardshow', 'grading', 'news']);
const imagePattern = () => /data:image\/(png|jpe?g|gif|webp|avif);base64,([a-z0-9+/]+={0,2})/gi;

export async function mediaVersion(source) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export function boardImages(value) {
  return [...String(value || '').matchAll(imagePattern())];
}

export async function boardDisplayItems(items, type) {
  const versions = new Map();
  const result = [];
  for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
    const item = items[itemIndex];
    if (!item || typeof item !== 'object') { result.push(item); continue; }
    let display = item;
    for (const field of ['image', 'content']) {
      if (typeof item[field] !== 'string') continue;
      const matches = boardImages(item[field]);
      if (!matches.length) continue;
      const parts = [];
      let offset = 0;
      for (let n = 0; n < matches.length; n++) {
        const match = matches[n], source = match[0];
        if (!versions.has(source)) versions.set(source, await mediaVersion(source));
        const query = new URLSearchParams({type, item: String(itemIndex), field, n: String(n), v: versions.get(source)});
        parts.push(item[field].slice(offset, match.index), '/api/admin-media?' + query);
        offset = match.index + source.length;
      }
      parts.push(item[field].slice(offset));
      if (display === item) display = {...item, _displayOnly: true};
      display[field] = parts.join('');
    }
    result.push(display);
  }
  return result;
}
