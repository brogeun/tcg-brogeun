/**
 * TCG Casing — fal.ai Nano Banana Pro (Gemini 3 Pro Image) 로 카드 확장 아트 생성
 *
 * 모델: fal-ai/nano-banana-pro/edit ($0.15/장 — Gemini 2.5 Flash 의 4배지만 prompt 준수도 우수)
 * 특징: semantic editing without masks, 캐릭터 일관성 + 카드 디테일 보존 강화
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

// 카드 일러스트 연속 확장 — 카드 위주 (80%+), 외곽은 좁은 띠
// CRITICAL: 캐릭터(포켓몬)는 카드 안에만 — 카드 경계 밖으로 절대 escape 금지
const CORE_INSTRUCTION = `Take this Pokemon trading card and place it in the center of a slightly larger canvas, then add a narrow extension band around the card edges showing more of the same background environment depicted INSIDE the card.

ABSOLUTE RULES (must all be followed):
1. PRESERVE the card EXACTLY as the input image — every single pixel, the Pokemon character, all text, all numbers, all set symbols, all holographic effects, the card's outer border line, the entire card frame must remain pixel-perfect identical to the input. DO NOT redraw, do not reinterpret, do not change pose, do not change the holographic pattern.
2. CHARACTER STAYS INSIDE THE CARD: The Pokemon/character on the card must remain ENTIRELY WITHIN the rectangular card border. The character must NEVER extend, overlap, or escape beyond the card's edge into the extension area. Treat the card border as a HARD CLIP MASK for the character.
3. The card's outer rectangular border must remain visible as a clear, sharp boundary line between the card itself and the extension area outside.
4. The card occupies roughly 80-85% of the output canvas (in its original 63:88 vertical aspect ratio).
5. Around the card, add ONLY a narrow extension band (about 8-12% of canvas on each side) showing MORE BACKGROUND ENVIRONMENT — sky, clouds, terrain, water, etc. — but NEVER any characters or Pokemon. Just the environment.
6. SEAMLESS CONTINUITY of BACKGROUND ONLY: whatever environmental elements (clouds, mountains, ocean, trees, walls) are visible at the very edge of the card's illustration must continue smoothly into the extension band. Match art style, color palette, lighting.
7. NO PSA slab, NO label, NO barcode, NO frame decoration. Just the original card + narrow environment extension.

ENVIRONMENT (analyze first):
- Identify the background environment shown on the card behind the character (e.g., sky with clouds, beach with ocean, forest, volcanic landscape, city street, indoor room).
- The extension shows MORE of that exact same environment continuing outward — same sky, same ocean, same trees. No new content, just more of what's already there.

OUTPUT: Portrait orientation, close to the card's own 63:88 aspect ratio. The card is the hero in the center. The extension is a thin scenic frame.`;

const STYLE_PROMPTS = [
  {
    style: 'faithful',
    label: '원본 충실',
    prompt: CORE_INSTRUCTION + ' RENDERING: Match the card\'s own illustration style as faithfully as possible. The narrow extension band should look like a direct continuation by the same artist — same brushwork, same texture, same level of detail. The viewer should barely notice the extension exists.',
  },
  {
    style: 'soft',
    label: '부드러운 톤',
    prompt: CORE_INSTRUCTION + ' RENDERING: Match the card\'s illustration style, but in the narrow extension band soften the colors slightly and add gentle atmospheric depth. The extension is still clearly the same scene, just rendered with a touch more softness and warmth than the card itself.',
  },
  {
    style: 'glow',
    label: '글로우',
    prompt: CORE_INSTRUCTION + ' RENDERING: Match the card\'s illustration style. In the narrow extension band, add subtle magical particles, soft light bloom, or gentle ambient glow that matches the card\'s element (fire = warm embers, water = soft caustics, electric = tiny sparks, grass = pollen/petals, etc.). Very subtle — the scene continuity must still be primary.',
  },
];

// fal.ai Nano Banana Pro (Gemini 3 Pro Image) 호출
async function callFalGemini({ apiKey, imageUrl, prompt, seed }) {
  const endpoint = 'https://fal.run/fal-ai/nano-banana-pro/edit';
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
        image_urls: [imageUrl],  // Nano Banana Pro 는 배열로 받음
        aspect_ratio: 'auto',    // 입력 카드 비율 따름 — '3:4' 강제 시 카드가 가로로 늘어나는 문제 회피
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
    provider: 'fal-ai/nano-banana-pro/edit',
    elapsedMs: Date.now() - startMs,
  });
}
