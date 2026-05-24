/**
 * TCG Casing — fal.ai Gemini 2.5 Flash Image Edit (Nano Banana) 로 카드 확장 아트 생성
 *
 * 모델: fal-ai/gemini-25-flash-image/edit ($0.039/장)
 * 특징: mask 불필요 — Gemini 가 자연어 prompt 만으로 카드 보존 + 외곽 확장 알아서 처리
 *
 * 인증: X-Admin-Password 헤더
 *
 * 입력 (POST JSON):
 *   {
 *     cardImageUrl: string,   // 카드 이미지 URL (public, imgix 큰 사이즈 권장)
 *     cardName?: string,      // 카드 이름 (prompt 강화용)
 *   }
 *
 * 출력:
 *   { ok, variants: [{url, style, label, seed}], provider, elapsedMs, failures? }
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
};

// 모든 응답은 status 200 — Cloudflare 502/504 overlay 회피
const json = (obj, _httpStatus = 200) =>
  new Response(JSON.stringify(obj.ok === false ? { ...obj, _httpStatus: obj._httpStatus || _httpStatus } : obj), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// 3가지 스타일 — Gemini 에게 카드 일러스트를 먼저 분석한 뒤 그 환경/장면에 맞게 확장하도록 명시
// 절대 일반적인 풍경 그리지 말 것 — 카드별 맞춤 (불 카드 = 화염, 물 카드 = 바다, 우주 카드 = 우주 ...)
const ANALYZE_INSTRUCTION = `STEP 1 — ANALYZE the card's actual artwork carefully: identify the character/Pokemon/creature, the environment shown (beach/forest/cave/sky/space/volcano/city/underwater/etc.), the dominant colors, lighting, mood, and any specific objects or background elements visible on the card. STEP 2 — Place the card UNCHANGED in the center of a wider horizontal scene (4:3). Preserve every pixel of the card itself — all text, borders, holographic effects, character details, numbers, set symbols must remain exactly as shown. STEP 3 — Extend the artwork outward from the card edges so the same environment, characters, atmosphere and color palette identified in step 1 continue naturally into the surrounding area. The card should look like a window into a larger scene of the SAME environment depicted on the card.`;

const STYLE_PROMPTS = [
  {
    style: 'cinematic',
    label: '시네마틱',
    prompt: ANALYZE_INSTRUCTION + ' STYLE: Render the extended background in a dramatic cinematic style — epic wide composition, atmospheric depth, dynamic lighting (golden hour / dramatic shadows / volumetric light as appropriate to the card scene), heightened color contrast. Make it look like a movie poster shot of the environment shown on the card, with the card itself acting as the focal artifact in the center.',
  },
  {
    style: 'illustration',
    label: '일러스트',
    prompt: ANALYZE_INSTRUCTION + ' STYLE: Render the extension as a polished hand-painted illustration that perfectly matches the card\'s own art style — same brushwork, same level of detail, same lighting treatment, same color palette. The whole composition should look like the original card artist painted the entire wider scene and the card is just a cropped section of it.',
  },
  {
    style: 'abstract',
    label: '추상',
    prompt: ANALYZE_INSTRUCTION + ' STYLE: Around the card, instead of a literal landscape, create an atmospheric abstract aura that REFERENCES the card\'s environment and color palette — for a fire card use glowing embers and warm light particles, for a water card use soft caustics and aqua gradients, for an electric card use lightning sparks and neon glow, for a grass card use floating petals and sun rays, etc. The abstract elements should clearly relate to the card\'s element/theme while keeping the background dreamy and out-of-focus so the card remains the hero.',
  },
];

// fal.ai Gemini 2.5 Flash Image Edit 호출
async function callFalGemini({ apiKey, imageUrl, prompt, seed }) {
  const endpoint = 'https://fal.run/fal-ai/gemini-25-flash-image/edit';
  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 90000);

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Key ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
      body: JSON.stringify({
        prompt,
        image_urls: [imageUrl],  // Gemini 는 배열로 받음
        aspect_ratio: '4:3',     // 백판 형태 (가로 4:3)
        num_images: 1,
        output_format: 'jpeg',
        safety_tolerance: '5',
        seed,
      }),
    });
    clearTimeout(tid);

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return { ok: false, error: `fal.ai invalid JSON (HTTP ${resp.status}): ${text.slice(0, 400)}`, status: resp.status };
    }

    const stringifyErr = (v) => {
      if (v == null) return null;
      if (typeof v === 'string') return v;
      if (Array.isArray(v)) return v.map(stringifyErr).filter(Boolean).join(' | ');
      if (typeof v === 'object') {
        if (v.msg) return `${v.msg}${v.loc ? ` @ ${(Array.isArray(v.loc) ? v.loc.join('.') : v.loc)}` : ''}`;
        return JSON.stringify(v).slice(0, 400);
      }
      return String(v);
    };
    if (!resp.ok) {
      const errMsg = stringifyErr(data.detail) || stringifyErr(data.error) || stringifyErr(data.message) || JSON.stringify(data).slice(0, 400);
      return { ok: false, error: `HTTP ${resp.status}: ${errMsg}`, status: resp.status };
    }
    const url = data.images?.[0]?.url;
    if (!url) {
      return { ok: false, error: `no image in response: ${JSON.stringify(data).slice(0, 400)}`, status: 200 };
    }
    return { ok: true, url, seed };
  } catch (e) {
    clearTimeout(tid);
    return { ok: false, error: e.message || String(e), status: 0 };
  }
}

export async function onRequestPost({ request, env }) {
  const startMs = Date.now();

  // ── 인증 ──
  let auth = request.headers.get('X-Admin-Password') || '';
  try {
    const decoded = decodeURIComponent(escape(atob(auth)));
    if (decoded) auth = decoded;
  } catch {}
  if (!env.ADMIN_PASSWORD) {
    return json({ ok: false, error: 'ADMIN_PASSWORD env 미설정' }, 500);
  }
  if (!auth || auth !== env.ADMIN_PASSWORD) {
    return json({ ok: false, error: '관리자 비밀번호 필요' }, 401);
  }
  if (!env.FAL_API_KEY) {
    return json({ ok: false, error: 'FAL_API_KEY env 미설정' }, 500);
  }

  // ── 입력 파싱 ──
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid JSON body' }, 400); }

  const { cardImageUrl, cardName = '' } = body || {};
  if (!cardImageUrl) {
    return json({ ok: false, error: 'cardImageUrl 필수 (카드를 먼저 선택하세요)' }, 400);
  }
  if (!/^https?:\/\//i.test(cardImageUrl)) {
    return json({ ok: false, error: 'cardImageUrl 은 public http(s) URL 이어야 합니다' }, 400);
  }

  // ── 카드 이름 prefix ──
  const namePrefix = cardName
    ? `The trading card shown is "${cardName}". `
    : '';

  // ── 3개 시안 병렬 생성 ──
  const seedBase = Date.now() % 1000000;
  const tasks = STYLE_PROMPTS.map((s, idx) =>
    callFalGemini({
      apiKey: env.FAL_API_KEY,
      imageUrl: cardImageUrl,
      prompt: namePrefix + s.prompt,
      seed: seedBase + idx * 1000,
    }).then(r => ({ ...r, style: s.style, label: s.label }))
  );

  const results = await Promise.all(tasks);
  const successes = results.filter(r => r.ok);
  const failures = results.filter(r => !r.ok);

  if (successes.length === 0) {
    return json({
      ok: false,
      error: 'all variants failed',
      failures: failures.map(f => ({ style: f.style, error: f.error, status: f.status })),
      elapsedMs: Date.now() - startMs,
    }, 502);
  }

  return json({
    ok: true,
    variants: successes.map(r => ({ url: r.url, seed: r.seed, style: r.style, label: r.label })),
    failed: failures.length,
    failures: failures.length ? failures.map(f => ({ style: f.style, error: f.error })) : undefined,
    provider: 'fal-ai/gemini-25-flash-image/edit',
    elapsedMs: Date.now() - startMs,
  });
}
