// functions/api/img.js
// 외부 이미지 (특히 SNKRDUNK CDN) 프록시 — referrer/CORS 우회
// 사용: /api/img?u=https%3A%2F%2Fsnkrdunk.com%2Fimg%2F...

const ALLOW_HOSTS = [
  "snkrdunk.com",
  "www.snkrdunk.com",
  "static.snkrdunk.com",
  "img.snkrdunk.com",
  "image.snkrdunk.com",
  "media.snkrdunk.com",
  "cdn.snkrdunk.com",
  "snkr-dunk.imgix.net",
];

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  const target = url.searchParams.get("u");
  if (!target) return new Response("missing u", { status: 400 });

  let parsed;
  try { parsed = new URL(target); }
  catch { return new Response("invalid url", { status: 400 }); }

  // 화이트리스트 호스트만 허용
  const host = parsed.hostname.toLowerCase();
  const allowed = ALLOW_HOSTS.some(h => host === h || host.endsWith("." + h));
  if (!allowed) return new Response("host not allowed", { status: 403 });

  try {
    const res = await fetch(parsed.toString(), {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8",
        "Accept-Language": "ja,en;q=0.8",
        "Referer": "https://snkrdunk.com/",
      },
      redirect: "follow",
    });
    if (!res.ok) return new Response(`upstream ${res.status}`, { status: 502 });

    const ct = res.headers.get("content-type") || "image/jpeg";
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      status: 200,
      headers: {
        "content-type": ct,
        "cache-control": "public, max-age=2592000, s-maxage=2592000, immutable",
        "access-control-allow-origin": "*",
      },
    });
  } catch (e) {
    return new Response("fetch error: " + (e?.message || e), { status: 502 });
  }
}
