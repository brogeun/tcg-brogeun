// Standalone raster-only proxy: no deploy-whitelist dependency changes.
const ALLOWED_HOSTS = new Set(['stockx-360.imgix.net', 'imgs-snkrdunk.imgix.net', 'snkrdunk.com', 'cdn.snkrdunk.com', 'stockx.imgix.net', 'tcghub.kr', 'cdn.jsdelivr.net', 'raw.githubusercontent.com']);
const REFERER = 'https://tcghub.kr/';
const CACHE_CONTROL = 'public, max-age=86400, immutable';

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const TIMEOUT_MS = 10000;
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function failure(status) {
  return new Response('Image unavailable', { status, headers: {
    'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff',
  } });
}

function allowed(url) {
  return url.protocol === 'https:' && !url.username && !url.password &&
    (!url.port || url.port === '443') && ALLOWED_HOSTS.has(url.hostname.toLowerCase());
}

function ascii(bytes, start, end) {
  return String.fromCharCode(...bytes.subarray(start, end));
}

function matchesRaster(bytes, mime) {
  if (mime === 'image/png') return bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((v,i) => bytes[i] === v);
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (mime === 'image/gif') return bytes.length >= 6 && ['GIF87a','GIF89a'].includes(ascii(bytes,0,6));
  if (mime === 'image/webp') return bytes.length >= 12 && ascii(bytes,0,4) === 'RIFF' && ascii(bytes,8,12) === 'WEBP';
  if (mime === 'image/avif') {
    if (bytes.length < 16 || ascii(bytes,4,8) !== 'ftyp') return false;
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    if (size < 16 || size > bytes.length || size > 4096) return false;
    if (['avif','avis'].includes(ascii(bytes,8,12))) return true;
    for (let i=16; i+4<=size; i+=4) if (['avif','avis'].includes(ascii(bytes,i,i+4))) return true;
  }
  return false;
}

async function cancel(response) {
  try { await response.body?.cancel(); } catch { /* Best effort release. */ }
}

async function boundedBytes(response) {
  const declared = response.headers.get('Content-Length');
  if (declared && Number(declared) > MAX_BYTES) { await cancel(response); throw new Error('size'); }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('body');
  const chunks = []; let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BYTES) { await reader.cancel(); throw new Error('size'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

async function proxyImage(request, parameter) {
  if (request.method !== 'GET') return failure(405);
  const target = new URL(request.url).searchParams.get(parameter);
  if (!target) return failure(400);
  let current;
  try { current = new URL(target); } catch { return failure(400); }
  if (!allowed(current)) return failure(403);
  current.hash = '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let redirects = 0;
    while (true) {
      const upstream = await fetch(current.href, {
        redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tcghub/1.0)',
          'Accept': 'image/avif,image/webp,image/png,image/jpeg,image/gif',
          'Accept-Language': 'ja,en;q=0.8', 'Referer': REFERER },
      });
      if (REDIRECTS.has(upstream.status)) {
        const location = upstream.headers.get('Location');
        await cancel(upstream);
        if (!location || redirects >= MAX_REDIRECTS) return failure(502);
        const next = new URL(location, current);
        if (!allowed(next)) return failure(502);
        next.hash = ''; current = next; redirects++; continue;
      }
      if (!upstream.ok) { await cancel(upstream); return failure(502); }
      const mime = (upstream.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
      if (!MIME_TYPES.has(mime)) { await cancel(upstream); return failure(502); }
      const bytes = await boundedBytes(upstream);
      if (!matchesRaster(bytes, mime)) return failure(502);
      return new Response(bytes, { headers: { 'Content-Type': mime,
        'Cache-Control': CACHE_CONTROL, 'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff' } });
    }
  } catch { return failure(502); }
  finally { clearTimeout(timer); controller.abort(); }
}

export async function onRequestGet({ request }) { return proxyImage(request, 'url'); }
