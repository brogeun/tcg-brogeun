/**
 * TCG Hub Service Worker
 *
 * 캐시 전략:
 *  - HTML / 정적 자산  : network-first / stale-while-revalidate
 *  - /data/*.json     : stale-while-revalidate (캐시 먼저 → 최신 받아 갱신)
 *  - /api/*           : network-only (실시간 인증/저장 데이터)
 *  - 이미지           : 개수 상한을 둔 cache-first
 */

const CACHE_VERSION = 'tcghub-bounded-cache-20261113-v1';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const IMAGE_CACHE = `${CACHE_VERSION}-images`;
const CACHE_LIMITS = {[STATIC_CACHE]:192, [DATA_CACHE]:256, [IMAGE_CACHE]:512};
const cacheWrites = new Map();

// Only the public static JSON timestamp is ignored. Release versions and all
// other parameters remain distinct, and network requests keep the original URL.
function publicCacheKey(req) {
  const url = new URL(req.url);
  if (url.origin === location.origin && url.pathname.startsWith('/data/') &&
      url.pathname.endsWith('.json') && url.searchParams.has('t')) {
    url.searchParams.delete('t');
    // This is a cache key only. Do not copy a navigation-only request mode
    // into the Request constructor; the real fetch still uses req unchanged.
    return new Request(url.href, {headers:req.headers});
  }
  return req;
}

async function trimCache(cache, maximum) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - maximum))) await cache.delete(key);
}

function storePublicResponse(cacheName, cache, key, response, event) {
  let state = cacheWrites.get(cacheName);
  if (!state) { state = {pending:Promise.resolve(), writes:0}; cacheWrites.set(cacheName, state); }
  const copy = response.clone();
  state.pending = state.pending.catch(() => {}).then(async () => {
    await cache.put(key, copy);
    // Scan in batches rather than walking hundreds of image keys on every put.
    // The temporary overshoot is at most fifteen successful writes.
    if (++state.writes === 1 || state.writes % 16 === 0) await trimCache(cache, CACHE_LIMITS[cacheName]);
  }).catch(() => {}); // A full/unavailable cache must never break the network result.
  event?.waitUntil?.(state.pending);
  return state.pending;
}

// 설치 시 미리 캐시할 핵심 자산 (오프라인 진입점)
const CORE_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// 설치 — 핵심 자산 미리 캐시
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(STATIC_CACHE)
      .then(cache => cache.addAll(CORE_ASSETS).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

// 활성화 — 옛날 캐시 청소
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(k => k.startsWith('tcghub-') && !Object.hasOwn(CACHE_LIMITS, k))
        .map(k => caches.delete(k))
    )).then(() => Promise.all(Object.entries(CACHE_LIMITS).map(async ([name, maximum]) => {
      await trimCache(await caches.open(name), maximum);
    }))).then(() => self.clients.claim())
  );
});

// 캐시 전략 분기
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Game modules must come from the same release, not stale-while-revalidate mixtures.
  if (url.origin === location.origin && (url.pathname.startsWith('/games/volleyball/') || url.pathname.startsWith('/games/kanto151/'))) {
    event.respondWith(networkFirst(req, STATIC_CACHE, event));
    return;
  }

  // Korean promo quotes and full histories revalidate together after daily publication.
  if (url.origin === location.origin && (url.pathname.startsWith('/data/korean-promos') || ['/assets/korean-promos.js', '/assets/korean-promos.css'].includes(url.pathname))) {
    event.respondWith(networkFirst(req, url.pathname.startsWith('/data/') ? DATA_CACHE : STATIC_CACHE, event));
    return;
  }

  // /api/* — 항상 네트워크 (인증/실시간 데이터)
  if (url.pathname.startsWith('/api/')) {
    return; // 기본 fetch 사용
  }

  // These URLs contain a digest of the complete shard body. Reusing the exact
  // bytes cannot mix releases, and avoids downloading every search row again.
  if (url.origin === location.origin && /^\/data\/search-index-ja\/part-\d{4}-[a-f0-9]{20}\.json$/.test(url.pathname)) {
    event.respondWith(cacheFirst(req, DATA_CACHE, event));
    return;
  }

  // Set metadata has at most 16 immutable packs; its mutable manifest must
  // refresh before selecting the exact pack for this catalogue release.
  if (url.origin === location.origin && /^\/data\/japanese-set-metadata\/bucket-\d{2}-[a-f0-9]{20}\.json$/.test(url.pathname)) {
    event.respondWith(req.cache === 'reload' ? networkFirst(req, DATA_CACHE, event) : cacheFirst(req, DATA_CACHE, event));
    return;
  }
  if (url.origin === location.origin && url.pathname === '/data/japanese-set-metadata.json') {
    event.respondWith(networkFirst(req, DATA_CACHE, event));
    return;
  }

  if (url.origin === location.origin && ['/assets/app-route-loader.js','/assets/portfolio-screen.js','/assets/portfolio-screen.css','/assets/portfolio-summary-client.js','/assets/card-thumbnails.js'].includes(url.pathname)) {
    event.respondWith(networkFirst(req, STATIC_CACHE, event));
    return;
  }

  // Search snapshots are regenerated from the exact daily deployment data.
  // Revalidate the worker and its matching decoder together on every release.
  if (url.origin === location.origin && (url.pathname === '/data/search-index-ja.json' || url.pathname.startsWith('/data/search-index-ja/') || ['/assets/card-search-client.js', '/assets/card-search-worker.js', '/assets/card-search-engine.js', '/assets/search-modal.js'].includes(url.pathname))) {
    event.respondWith(networkFirst(req, url.pathname.startsWith('/data/') ? DATA_CACHE : STATIC_CACHE, event));
    return;
  }

  // Keep collection registry shards and their decoder on the same reviewed release.
  // Private /api routes above remain network-only and never enter Cache Storage.
  if (url.origin === location.origin && (url.pathname.startsWith('/data/collections/') || ['/assets/collections.js', '/assets/collections.css', '/assets/collection-catalog-codec.js', '/assets/card-rarity-filters.js', '/assets/card-rarity-filters.css'].includes(url.pathname))) {
    event.respondWith(networkFirst(req, url.pathname.startsWith('/data/') ? DATA_CACHE : STATIC_CACHE, event));
    return;
  }

  // Reference prices retain provider timestamps; prefer current snapshots to stale SW copies.
  const referenceData = ['/data/us-market.json', '/data/yuyutei-market.json', '/data/mercari-references.json', '/data/snkrdunk-games.json', '/data/tcg-card-info.json', '/data/reference-market-health.json', '/data/cards-meta-index.json', '/data/contained-printing-reviews.json'].includes(url.pathname)
    || ['/data/us-market/', '/data/yuyutei-market/', '/data/snkrdunk-games/', '/data/cards-meta-index/', '/data/tcg-card-info/'].some(prefix => url.pathname.startsWith(prefix))
    || /^\/data\/price-(weiss_schwarz|union_arena|dragon_ball_fusion_world|yugioh|digimon)-(card|box)\.json$/.test(url.pathname);
  if (url.origin === location.origin && referenceData) {
    event.respondWith(networkFirst(req, DATA_CACHE, event));
    return;
  }
  if (url.origin === location.origin && ['/assets/tcg-card-info.js', '/assets/tcg-card-info.css', '/assets/tcg-search-aliases.js', '/assets/card-price-fallback.js', '/assets/contained-card-prices.js', '/assets/game-registry.js', '/assets/market-references.js', '/assets/market-references.css', '/assets/english-catalog.js', '/assets/chinese-catalog.js'].includes(url.pathname)) {
    event.respondWith(networkFirst(req, STATIC_CACHE, event));
    return;
  }

  // Chinese daily FX snapshots must not use an older cached rate.
  if (url.origin === location.origin && url.pathname === '/data/fx-rates.json') {
    event.respondWith(networkFirst(req, DATA_CACHE, event));
    return;
  }

  // Keep the card index display and its verified results from the same current release.
  if (url.origin === location.origin && ['/assets/market-price-index.js', '/assets/market-price-index.css'].includes(url.pathname)) {
    event.respondWith(networkFirst(req, STATIC_CACHE, event));
    return;
  }
  if (url.origin === location.origin && ['/data/market-price-index.json', '/data/market-price-index-validation.json', '/data/market-price-index-independent-verification.json'].includes(url.pathname)) {
    event.respondWith(networkFirst(req, DATA_CACHE, event));
    return;
  }

  // Card names and catalogue modules must use the same current release.
  if (url.origin === location.origin && ['/assets/card-catalog-repairs.js', '/assets/japanese-card-names.js', '/assets/japanese-set-artwork.js', '/assets/japanese-catalog.js', '/assets/app-route-loader.js', '/assets/search-modal.js', '/assets/contained-card-match.js', '/assets/contained-card-market.js', '/assets/price-expanded.js', '/assets/price-expanded.css'].includes(url.pathname)) {
    event.respondWith(networkFirst(req, STATIC_CACHE, event));
    return;
  }

  // /data/*.json — stale-while-revalidate
  // Search labels and printing identities form one current catalogue release.
  if (url.origin === location.origin && (['/data/english-set-images.json', '/data/onepiece-official-search.json', '/data/onepiece-reviewed-promo-links.json', '/data/onepiece-reviewed-fallback-links.json', '/data/onepiece-official-manifest.json', '/data/contained-card-market-links.json', '/data/onepiece-card-overrides.json', '/data/card-catalog-repairs.json', '/data/japanese-catalog.json', '/data/japanese-card-names-ko.json', '/data/chinese-sets/CN-30TH.json'].includes(url.pathname) || url.pathname.startsWith('/data/cards-by-set/'))) {
    event.respondWith(networkFirst(req, DATA_CACHE, event));
    return;
  }
  if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE, event));
    return;
  }

  // 외부 이미지 CDN — cache-first
  if (
    url.hostname.includes('cdn.snkrdunk.com') ||
    url.hostname.includes('assets.snkrdunk.com') ||
    url.pathname.startsWith('/images/')
  ) {
    event.respondWith(cacheFirst(req, IMAGE_CACHE, event));
    return;
  }

  // HTML (라우팅 path) — network-first (항상 최신 받기)
  // 정적 자산 (.js, .css, 폰트) — stale-while-revalidate (빠른 로드)
  if (url.origin === location.origin) {
    const isHtml = url.pathname === '/' || url.pathname.endsWith('.html') ||
                   (!url.pathname.includes('.') && !url.pathname.startsWith('/data/') && !url.pathname.startsWith('/api/'));
    if (isHtml) {
      event.respondWith(networkFirst(req, STATIC_CACHE, event));
    } else {
      event.respondWith(staleWhileRevalidate(req, STATIC_CACHE, event));
    }
    return;
  }

  // 외부 CDN (Chart.js, Quill 등) — cache-first
  if (
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('cdn.jsdelivr.net')
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE, event));
    return;
  }
});

async function staleWhileRevalidate(req, cacheName, event) {
  const cache = await caches.open(cacheName);
  const key = publicCacheKey(req), cached = await cache.match(key);
  const networkPromise = fetch(req).then(res => {
    if (res && res.ok) storePublicResponse(cacheName, cache, key, res, event);
    return res;
  }).catch(() => null);
  event?.waitUntil?.(networkPromise.then(() => {}));
  return cached || (await networkPromise) || new Response('Offline', { status: 503 });
}

async function networkFirst(req, cacheName, event) {
  const cache = await caches.open(cacheName);
  const key = publicCacheKey(req);
  try {
    // The shared picker also loads the versioned manufacturer rarity index.
    const freshRarity = ['/assets/card-rarity-filters.js','/assets/card-rarity-filters.css','/assets/english-catalog.js','/assets/chinese-catalog.js','/assets/tcg-card-info.js','/data/chinese-sets/CN-30TH.json','/data/tcg-card-info/weiss_schwarz/32641ea2ce38d16d.json'].includes(new URL(req.url).pathname);
    const res = await fetch(req, freshRarity ? {cache:'no-cache'} : undefined);
    if (res && res.ok) storePublicResponse(cacheName, cache, key, res, event);
    return res;
  } catch {
    const cached = await cache.match(key);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function cacheFirst(req, cacheName, event) {
  const cache = await caches.open(cacheName);
  const key = publicCacheKey(req), cached = await cache.match(key);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) storePublicResponse(cacheName, cache, key, res, event);
    return res;
  } catch {
    return new Response('Offline', { status: 503 });
  }
}

// 메시지 핸들러 — 캐시 강제 비우기 (디버그용)
self.addEventListener('message', event => {
  if (event.data?.type === 'CLEAR_CACHE') {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
  }
});

