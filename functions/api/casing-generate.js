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

// 카드 일러스트 연속 확장 — 카드는 그대로, 카드 밖으로 같은 일러스트가 자연스럽게 이어짐
// 핵심: 카드 + 외곽이 "하나의 큰 그림"처럼 보여야 함 (카드는 그 그림의 중앙 사각형 영역)
const CORE_INSTRUCTION = `Extend the artwork of this Pokemon trading card beyond its borders into a wider 4:3 horizontal canvas. The result must look like ONE unified painting where the card is the central rectangular focus, and the surrounding area is a natural continuation of the very same scene depicted inside the card.

ABSOLUTE RULES (must follow):
1. PRESERVE the card EXACTLY — every pixel, every character (Pokemon/creature), every text, every border, every holographic effect, every set symbol, every number must remain pixel-perfect identical to the input card. DO NOT redraw the card.
2. The card occupies the center of the output (vertical orientation), keeping its original aspect ratio (about 63:88).
3. EXTEND the same illustration outward from all four sides of the card. The background/environment/characters shown inside the card must continue seamlessly into the area outside the card edges as if the card is just a window cut out of a larger painting.
4. The extension must use the same art style, brush strokes, color palette, lighting, and level of detail as the card's own illustration. Goal: viewer can't tell where the card ends and the extension begins (except by the card's frame).
5. DO NOT add a PSA slab, do not add a label, do not add a barcode, do not add any frame around the card — only the card itself in the center, with the illustration extending outward into nature/scene.
6. DO NOT introduce new Pokemon characters that aren't on the card. The character on the card stays inside the card area; only the background extends.

CONTENT MATCHING (analyze first, then extend):
- Look at what's IN the card illustration: identify the environment (beach, forest, sky, volcano, city street, room interior, underwater, cave, etc.), the time of day, the weather, the specific background details visible behind the character.
- The extended area must show MORE OF THAT SAME ENVIRONMENT — same beach with same waves and sky, same forest with same trees, same city with same buildings, etc. Never invent a different environment.`;

const STYLE_PROMPTS = [
  {
    style: 'natural',
    label: '자연스러운 연장',
    prompt: CORE_INSTRUCTION + ' RENDERING: Faithfully match the card\'s own illustration style as closely as possible. The output should look like the original card artist painted the entire wider scene. This is the most natural and conservative extension.',
  },
  {
    style: 'cinematic',
    label: '시네마틱',
    prompt: CORE_INSTRUCTION + ' RENDERING: While still matching the card\'s scene and art style, give the extended area a slightly more cinematic feeling — atmospheric depth, soft volumetric light, gentle dramatic lighting, a wider sense of space. The card itself remains unchanged; only the surrounding extension takes on a more atmospheric quality.',
  },
  {
    style: 'dreamy',
    label: '드림',
    prompt: CORE_INSTRUCTION + ' RENDERING: Extend the scene in the card\'s style but with a slightly dreamlike softness in the outer areas — gentle bloom, soft particles, slightly blurred far edges, magical light hints. The core scene continues faithfully, but the edges fade with subtle dreamy atmosphere. The card itself is untouched and sharp.',
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
