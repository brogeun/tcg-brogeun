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
const vintageImagePacks = new Map();
const VINTAGE_PACK_MAX_BYTES = 8 * 1024 * 1024;
const VINTAGE_CACHE_MAX_BYTES = 20 * 1024 * 1024;

async function vintageImagePack(context, target, setCode, bucket) {
  const key = target.pathname;
  const saved = vintageImagePacks.get(key);
  if (saved && saved.expires > Date.now()) return saved.promise;
  if (saved) vintageImagePacks.delete(key);
  while (vintageImagePacks.size >= 4) vintageImagePacks.delete(vintageImagePacks.keys().next().value);
  const entry = {expires:Date.now()+60000,bytes:0};
  entry.promise = (async () => {
    const response = context.env.ASSETS
      ? await context.env.ASSETS.fetch(new Request(target))
      : await fetch(target, {cf:{cacheTtl:86400}});
    if (response.status === 404 || response.ok && !/\bapplication\/json\b/i.test(response.headers.get('Content-Type') || '')) return null;
    if (!response.ok) throw Error('Vintage image pack unavailable');
    if (Number(response.headers.get('Content-Length') || 0) > VINTAGE_PACK_MAX_BYTES) {
      await response.body?.cancel();
      throw Error('Vintage image pack exceeds its runtime budget');
    }
    const reader = response.body?.getReader();
    if (!reader) throw Error('Vintage image pack body missing');
    const decoder = new TextDecoder();
    let text='',bytes=0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > VINTAGE_PACK_MAX_BYTES) {
        await reader.cancel();
        throw Error('Vintage image pack exceeds its runtime budget');
      }
      text += decoder.decode(chunk.value,{stream:true});
    }
    text += decoder.decode();
    const pack = JSON.parse(text);
    if (pack.schemaVersion !== 2 || pack.bucketSize !== 64 || pack.setCode !== setCode || pack.bucket !== bucket ||
        !pack.files || typeof pack.files !== 'object' || Array.isArray(pack.files)) throw Error('Invalid vintage image pack identity');
    entry.bytes=bytes;entry.expires=Date.now()+3600000;
    let total=[...vintageImagePacks.values()].reduce((sum,item)=>sum+item.bytes,0);
    for (const [oldKey,old] of vintageImagePacks) {
      if (total <= VINTAGE_CACHE_MAX_BYTES) break;
      vintageImagePacks.delete(oldKey);total-=old.bytes;
    }
    return pack;
  })().catch(error => {
    if (vintageImagePacks.get(key) === entry) vintageImagePacks.delete(key);
    throw error;
  });
  vintageImagePacks.set(key,entry);
  return entry.promise;
}

export async function onRequest(context) {
  const url = new URL(context.request.url);

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
