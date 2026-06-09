/**
 * TCG Hub Service Worker
 *
 * 캐시 전략:
 *  - HTML / 정적 자산  : stale-while-revalidate (빠른 로드 + 백그라운드 업데이트)
 *  - /data/*.json     : stale-while-revalidate (캐시 먼저 → 최신 받아 갱신)
 *  - /api/*           : network-only (실시간 인증/저장 데이터)
 *  - 외부 이미지 CDN  : cache-first (한 번 받은 이미지는 영구 캐시)
 */

const CACHE_VERSION = 'tcghub-v4-googlefix';
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const DATA_CACHE = `${CACHE_VERSION}-data`;
const IMAGE_CACHE = `${CACHE_VERSION}-images`;

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
        .filter(k => !k.startsWith(CACHE_VERSION))
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// 캐시 전략 분기
self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // /api/* — 항상 네트워크 (인증/실시간 데이터)
  if (url.pathname.startsWith('/api/')) {
    return; // 기본 fetch 사용
  }

  // /data/*.json — stale-while-revalidate
  if (url.pathname.startsWith('/data/') && url.pathname.endsWith('.json')) {
    event.respondWith(staleWhileRevalidate(req, DATA_CACHE));
    return;
  }

  // 외부 이미지 CDN — cache-first
  if (
    url.hostname.includes('cdn.snkrdunk.com') ||
    url.hostname.includes('assets.snkrdunk.com') ||
    url.pathname.startsWith('/images/')
  ) {
    event.respondWith(cacheFirst(req, IMAGE_CACHE));
    return;
  }

  // HTML (라우팅 path) — network-first (항상 최신 받기)
  // 정적 자산 (.js, .css, 폰트) — stale-while-revalidate (빠른 로드)
  if (url.origin === location.origin) {
    const isHtml = url.pathname === '/' || url.pathname.endsWith('.html') ||
                   (!url.pathname.includes('.') && !url.pathname.startsWith('/data/') && !url.pathname.startsWith('/api/'));
    if (isHtml) {
      event.respondWith(networkFirst(req, STATIC_CACHE));
    } else {
      event.respondWith(staleWhileRevalidate(req, STATIC_CACHE));
    }
    return;
  }

  // 외부 CDN (Chart.js, Quill 등) — cache-first
  if (
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('cdn.jsdelivr.net')
  ) {
    event.respondWith(cacheFirst(req, STATIC_CACHE));
    return;
  }
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const networkPromise = fetch(req).then(res => {
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);
  return cached || (await networkPromise) || new Response('Offline', { status: 503 });
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    const cached = await cache.match(req);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
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
