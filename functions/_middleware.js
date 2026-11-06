/**
 * Cloudflare Pages middleware — robots.txt 강제 응답
 * (정적 파일 + _redirects SPA fallback 이 가로채는 문제 해결)
 *
 * ※ sitemap.xml 가로채기는 제거됨 (2026-06-11)
 *   → functions/sitemap.xml.js 가 카드 2.4만 페이지 전체를 동적 생성하므로
 *     미들웨어가 가로채면 안 됨. /sitemap.xml 요청은 context.next() 로 통과.
 */

const ROBOTS_TXT = `# TCG Hub robots.txt

User-agent: *
Allow: /

Disallow: /api/
Disallow: /admin/

Sitemap: https://tcghub.kr/sitemap.xml

Crawl-delay: 1
`;

// One visible card still returns one original image. Only the worker reads its
// small static pack; shared promises avoid repeatedly fetching/parsing a pack
// when a lazy grid requests several neighboring cards at the same time.
const staticAssetPacks = new Map();
const STATIC_PACK_MAX_BYTES = 8 * 1024 * 1024;
const STATIC_CACHE_MAX_BYTES = 20 * 1024 * 1024;
const staticAssetLoads = new Map();
let staticAssetLoadTail = Promise.resolve();
// Read the current deployment identity without retaining a mutable manifest.
// Pack caches only contain immutable, content-addressed deployment namespaces.
const CARD_HISTORY_MANIFEST = '/data/card-history-packs-v1/manifest.json';

async function readStaticJSON(context, target, maxBytes = STATIC_PACK_MAX_BYTES, mutable = false) {
  const request = new Request(target, mutable ? {headers:{'Cache-Control':'no-cache'}} : undefined);
  const response = context.env.ASSETS
    ? await context.env.ASSETS.fetch(request)
    : await fetch(request, {cf:{cacheTtl:mutable ? 0 : 86400}});
  if (response.status === 404 || response.ok && !/\bapplication\/json\b/i.test(response.headers.get('Content-Type') || '')) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw Error('Static pack unavailable');
  if (Number(response.headers.get('Content-Length') || 0) > maxBytes) {
    await response.body?.cancel();
    throw Error('Static pack exceeds its runtime budget');
  }
  const reader = response.body?.getReader();
  if (!reader) throw Error('Static pack body missing');
  const decoder = new TextDecoder();
  let text='',bytes=0;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw Error('Static pack exceeds its runtime budget');
    }
    text += decoder.decode(chunk.value,{stream:true});
  }
  text += decoder.decode();
  return {data:JSON.parse(text),bytes};
}

async function staticAssetPack(context, target, validate) {
  const key = target.pathname;
  const saved = staticAssetPacks.get(key);
  if (saved && saved.expires > Date.now()) return saved.promise;
  if (saved) staticAssetPacks.delete(key);
  if (staticAssetLoads.has(key)) return staticAssetLoads.get(key).promise;
  // Cache hits stay concurrent. Queue cold fetch/parse work so independent
  // history and image requests cannot multiply the transient pack memory.
  const previous = staticAssetLoadTail;
  let release;
  staticAssetLoadTail = new Promise(resolve => { release = resolve; });
  const entry = {expires:Date.now()+60000,bytes:0};
  entry.promise = (async () => {
    await previous;
    try {
    const result = await readStaticJSON(context, target);
    if (!result) return null;
    const {data:pack,bytes} = result;
    validate(pack);
    entry.bytes=bytes;entry.expires=Date.now()+3600000;
    while (staticAssetPacks.size >= 4) staticAssetPacks.delete(staticAssetPacks.keys().next().value);
    staticAssetPacks.set(key,entry);
    let total=[...staticAssetPacks.values()].reduce((sum,item)=>sum+item.bytes,0);
    for (const [oldKey,old] of staticAssetPacks) {
      if (total <= STATIC_CACHE_MAX_BYTES) break;
      staticAssetPacks.delete(oldKey);total-=old.bytes;
    }
    return pack;
    } finally {
      release();
    }
  })().catch(error => {
    if (staticAssetPacks.get(key) === entry) staticAssetPacks.delete(key);
    throw error;
  }).finally(() => {
    if (staticAssetLoads.get(key) === entry) staticAssetLoads.delete(key);
  });
  staticAssetLoads.set(key,entry);
  return entry.promise;
}

function vintageImagePack(context, target, setCode, bucket) {
  return staticAssetPack(context, target, pack => {
    if (pack.schemaVersion !== 2 || pack.bucketSize !== 64 || pack.setCode !== setCode || pack.bucket !== bucket ||
        !pack.files || typeof pack.files !== 'object' || Array.isArray(pack.files)) throw Error('Invalid vintage image pack identity');
  });
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

  if (url.pathname.startsWith('/data/history/')) {
    const match = url.pathname.match(/^\/data\/history\/([1-9][0-9]{0,19})\.json$/);
    if (!match) return new Response('Not found', {status:404});
    if (!['GET','HEAD'].includes(context.request.method)) return new Response('Method not allowed', {status:405,headers:{Allow:'GET, HEAD'}});
    const file = match[1] + '.json';
    const bucket = (BigInt(match[1]) / 64n).toString();
    let target;
    const originalStaticFile = async () => {
      const response = await context.next();
      // An absent history must not turn an SPA fallback into JSON price data.
      if (response.ok && !/\bapplication\/json\b/i.test(response.headers.get('Content-Type') || '')) return new Response('Not found', {status:404});
      return response;
    };
    try {
      const manifestURL = new URL(CARD_HISTORY_MANIFEST, url);
      // ASSETS is bound to this deployment. The network fallback also needs a
      // fresh lookup so an earlier deployment's cached manifest cannot linger.
      if (!context.env.ASSETS) manifestURL.searchParams.set('v',Date.now()+'-'+Math.random());
      const current = await readStaticJSON(context, manifestURL, 4096, true);
      if (!current) return await originalStaticFile();
      const manifest = current.data;
      if (manifest.schemaVersion !== 1 || manifest.bucketSize !== 64 ||
          !/^[0-9a-f]{64}$/.test(manifest.generation || '')) throw Error('Invalid history manifest');
      target = new URL('/data/card-history-packs-v1/'+manifest.generation+'/'+bucket+'.json', url);
      const pack = await staticAssetPack(context, target, pack => {
        if (pack.schemaVersion !== 1 || pack.bucketSize !== 64 || pack.bucket !== bucket ||
            !pack.files || typeof pack.files !== 'object' || Array.isArray(pack.files) ||
            !Array.isArray(pack.unpacked) || new Set(pack.unpacked).size !== pack.unpacked.length ||
            !pack.unpacked.every(name => /^[1-9][0-9]{0,19}\.json$/.test(name) &&
              (BigInt(name.slice(0,-5))/64n).toString() === bucket && !Object.hasOwn(pack.files,name))) throw Error('Invalid history pack identity');
      });
      if (!pack || pack.unpacked.includes(file)) return await originalStaticFile();
      if (!Object.hasOwn(pack.files,file)) return new Response('Not found', {status:404});
      const record = pack.files[file];
      if (!record || typeof record.body !== 'string' || !Number.isInteger(record.bytes) ||
          record.bytes <= 0 || record.bytes > STATIC_PACK_MAX_BYTES || !/^[0-9a-f]{64}$/.test(record.sha256 || '')) throw Error('Invalid history record');
      const body = new TextEncoder().encode(record.body);
      if (body.byteLength !== record.bytes) throw Error('History byte count mismatch');
      const fingerprint = [...new Uint8Array(await crypto.subtle.digest('SHA-256',body))].map(byte => byte.toString(16).padStart(2,'0')).join('');
      if (fingerprint !== record.sha256) throw Error('History fingerprint mismatch');
      const headers = {'Content-Type':'application/json; charset=utf-8','Content-Length':String(body.byteLength),
        'Cache-Control':'public, max-age=300, must-revalidate','X-Content-Type-Options':'nosniff','ETag':'"'+fingerprint+'"'};
      const matches = (context.request.headers.get('If-None-Match') || '').split(',').some(value =>
        value.trim() === '*' || value.trim().replace(/^W\//,'') === headers.ETag);
      if (matches) return new Response(null,{status:304,headers});
      return new Response(context.request.method === 'HEAD' ? null : body,{headers});
    } catch {
      if (target) staticAssetPacks.delete(target.pathname);
      return new Response('History unavailable',{status:503,headers:{'Cache-Control':'no-store'}});
    }
  }

  if (url.pathname.startsWith('/images/pokemon-vintage/') || url.pathname.startsWith('/images/pokemon-contained/')) {
    const contents = url.pathname.match(/^\/images\/pokemon-contained\/([a-z0-9-]+\.(webp|jpg|png))$/);
    const match = url.pathname.match(/^\/images\/pokemon-vintage\/([A-Za-z0-9+_-]+)\/((?:tcg-([1-9][0-9]{0,8})|pooka-ja-[a-z0-9-]+)\.(webp|jpg|png))$/);
    if (!match && !contents) return new Response('Not found',{status:404});
    if (!['GET','HEAD'].includes(context.request.method)) return new Response('Method not allowed',{status:405,headers:{Allow:'GET, HEAD'}});
    const setCode = contents ? 'reviewed-contents' : match[1];
    const file = contents ? contents[1] : match[2];
    const sourceId = contents ? null : match[3];
    const extension = contents ? contents[2] : match[4];
    const bucket = contents ? 'originals' : sourceId ? String(Math.floor(Number(sourceId)/64)) : 'pooka';
    const target = new URL('/data/pokemon-vintage-packs-v2/'+setCode+'/'+bucket+'.json',url);
    try {
      const pack = await vintageImagePack(context,target,setCode,bucket);
      if (!pack) return context.next(); // Retain older unpacked publication paths.
      if (!Object.hasOwn(pack.files,file)) return new Response('Not found',{status:404});
      const image = pack.files[file];
      const type = {webp:'image/webp',jpg:'image/jpeg',png:'image/png'}[extension];
      if (!image || image.contentType !== type || !/^[0-9a-f]{64}$/.test(image.sha256 || '') ||
          !Number.isInteger(image.bytes) || image.bytes <= 0 || image.bytes > 3000000 || typeof image.data !== 'string' ||
          image.data.length !== Math.ceil(image.bytes/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw Error('Invalid vintage artwork record');
      const headers = {'Content-Type':type,'Content-Length':String(image.bytes),'Cache-Control':'public, max-age=86400',
        ETag:'"'+image.sha256+'"','X-Content-Type-Options':'nosniff'};
      if (context.request.headers.get('If-None-Match') === headers.ETag) return new Response(null,{status:304,headers});
      if (context.request.method === 'HEAD') return new Response(null,{headers});
      const binary = atob(image.data);
      if (binary.length !== image.bytes) throw Error('Vintage artwork byte count mismatch');
      const body = new Uint8Array(binary.length);
      for (let index=0;index<binary.length;index++) body[index]=binary.charCodeAt(index);
      return new Response(body,{headers});
    } catch {
      return new Response('Image unavailable',{status:503});
    }
  }

  // The static /index.html rewrite canonicalizes this legacy destination to
  // /. Serve the app here so old Card Info links keep their intended route.
  if (/^\/cardinfo\/?$/.test(url.pathname)) {
    if (!['GET','HEAD'].includes(context.request.method)) return new Response('Method not allowed', {status:405,headers:{Allow:'GET, HEAD'}});
    const target = new URL('/', url);
    target.search = url.search;
    try {
      const response = context.env.ASSETS
        ? await context.env.ASSETS.fetch(new Request(target))
        : await fetch(target);
      if (!response.ok || !/\btext\/html\b/i.test(response.headers.get('Content-Type') || '')) return new Response('Page unavailable', {status:503});
      return new Response(context.request.method === 'HEAD' ? null : response.body, {status:200,headers:response.headers});
    } catch {
      return new Response('Page unavailable', {status:503});
    }
  }

  // Serve the original set URLs from packed static assets. This keeps every
  // card and old client URL while avoiding Pages' per-deployment file limit.
  if (url.pathname.startsWith('/data/tcg-card-info/')) {
    if (/^\/data\/tcg-card-info\/[a-z_]+\/public-[0-9]{4,6}\.json$/.test(url.pathname)) return context.next();
    const match = url.pathname.match(/^\/data\/tcg-card-info\/([a-z_]+)\/([0-9a-f]{16}(?:-part[0-9]{2,6})?\.json)$/);
    if (!match) return new Response('Not found', {status:404});
    if (!['GET','HEAD'].includes(context.request.method)) return new Response('Method not allowed', {status:405,headers:{Allow:'GET, HEAD'}});
    const [,game,file] = match;
    const target = new URL('/data/tcg-card-info-packs/'+game+'/'+file.slice(0,1)+'.json', url);
    try {
      const response = context.env.ASSETS
        ? await context.env.ASSETS.fetch(new Request(target))
        : await fetch(target, {cf:{cacheTtl:3600}});
      // Other existing publication paths retain their unpacked static files.
      if (response.status === 404) return context.next();
      if (!response.ok) return new Response('Card data unavailable', {status:503});
      if (!/\bapplication\/json\b/i.test(response.headers.get('Content-Type') || '')) return context.next();
      const pack = await response.json();
      // A legacy SPA fallback is not a pack and must never masquerade as JSON.
      if (pack.schemaVersion !== 1 || pack.game !== game || !pack.files || typeof pack.files !== 'object') return new Response('Card data unavailable', {status:503});
      if (!Object.hasOwn(pack.files, file) || typeof pack.files[file] !== 'string') return context.next();
      return new Response(context.request.method === 'HEAD' ? null : pack.files[file], {
        headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff'},
      });
    } catch {
      return new Response('Card data unavailable', {status:503});
    }
  }

  if (url.pathname === '/robots.txt') {
    return new Response(ROBOTS_TXT, {
      status: 200,
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'public, max-age=3600',
      },
    });
  }

  // 다른 요청은 그대로 통과 (/sitemap.xml 포함 — functions/sitemap.xml.js 가 처리)
  return context.next();
}
