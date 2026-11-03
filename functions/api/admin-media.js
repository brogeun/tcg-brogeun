import { BOARD_TYPES, boardImages, mediaVersion } from '../_shared/board-media.js';

const failure = status => new Response(null, {status, headers: {'Cache-Control': 'no-store'}});

export async function onRequestGet(context) {
  const {request, env} = context;
  const url = new URL(request.url), type = url.searchParams.get('type');
  const itemIndex = url.searchParams.get('item'), field = url.searchParams.get('field');
  const imageIndex = url.searchParams.get('n'), version = url.searchParams.get('v');
  if (!BOARD_TYPES.has(type) || !/^(0|[1-9]\d{0,2})$/.test(itemIndex || '') ||
      !['image', 'content'].includes(field) || !/^(0|[1-9]\d{0,3})$/.test(imageIndex || '') ||
      !/^[a-f0-9]{64}$/.test(version || '')) return failure(400);
  if (!env.ADMIN_KV) return failure(503);
  // Canonical URLs bound cache cardinality and ignore incidental query ordering.
  const canonical = new URL('/api/admin-media', url.origin);
  canonical.search = new URLSearchParams({type, item: itemIndex, field, n: imageIndex, v: version});
  const cacheKey = new Request(canonical.href);
  const cache = globalThis.caches?.default;
  try {
    const cached = await cache?.match(cacheKey);
    if (cached) return cached;
  } catch {}
  try {
    const items = await env.ADMIN_KV.get('admin_' + type, 'json');
    const source = Array.isArray(items) ? items[Number(itemIndex)]?.[field] : null;
    const match = typeof source === 'string' ? boardImages(source)[Number(imageIndex)] : null;
    // An edit/reorder must never serve a different image under an old version URL.
    if (!match || await mediaVersion(match[0]) !== version) return failure(404);
    const binary = atob(match[2]);
    const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
    const mime = match[1].toLowerCase().replace('jpg', 'jpeg');
    const response = new Response(bytes, {headers: {
      'Content-Type': 'image/' + mime,
      'Content-Length': String(bytes.byteLength),
      'Cache-Control': 'public, max-age=86400, immutable',
      'X-Content-Type-Options': 'nosniff',
      'ETag': '"' + version + '"',
    }});
    if (cache) {
      const pending = cache.put(cacheKey, response.clone()).catch(() => {});
      if (context.waitUntil) context.waitUntil(pending);
      else await pending;
    }
    return response;
  } catch { return failure(500); }
}
