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

// PSA 슬랩 케이싱 시트 — 'Extended Art' 배경 + 사용자가 카드/라벨 합성할 흰 빈 공간
// (사용자 직접 작성 prompt 영문 변환 + PSA 슬랩 표준 비율 명시)
const CORE_INSTRUCTION = `Generate an "Extended Art" background sheet based on the illustration of this Pokemon trading card. The output will be printed as a sheet that wraps around a PSA-graded slab — the user will physically place the actual card slab on top of the white areas after printing.

1. BACKGROUND EXTENSION
   - Keep the card's original illustration style, art technique, color palette, brushwork, and atmosphere completely intact.
   - Extend the artwork naturally outward into the surrounding case area so the entire image looks like one cohesive painting that continues beyond the card's borders.
   - Match every detail of the card's art style: same brush strokes, same lighting direction, same color mood, same level of detail. The result should look like the original card artist painted the whole wider scene.

2. EMPTY WHITE SPACES FOR PHYSICAL COMPOSITING (CRITICAL)
   The user will physically place the actual PSA slab on top of this printed sheet. So you must leave TWO clean rectangular WHITE (#FFFFFF) areas where the slab will be placed:

   (a) PSA GRADING LABEL area — top center
       · Position: starts at ~6% from the top of the canvas
       · Size: ~95% width × ~18% height (horizontal rectangle, almost full width)
       · Color: pure white #FFFFFF, NO artwork, NO text, NO decoration inside
       · Sharp clean rectangular edges

   (b) CARD BODY area — center
       · Position: starts at ~26% from the top of the canvas (right below the label area, with small gap)
       · Size: ~71% width × ~74% height (vertical rectangle, slightly narrower than label)
       · Color: pure white #FFFFFF, NO artwork, NO text, NO decoration inside
       · Sharp clean rectangular edges
       · Centered horizontally

3. RATIO AND POSITIONING
   - Overall canvas: portrait orientation, 3:4 ratio (matching standard PSA slab dimensions 92mm × 122mm).
   - The two white rectangles must be positioned and sized PRECISELY as described above.
   - The Extended Art background fills ALL areas OUTSIDE the two white rectangles (i.e., the borders around them, the small gap between label and card area).

4. ABSOLUTELY FORBIDDEN
   - NO Pokemon character, NO creature, NO trainer, NO humanoid figure anywhere in the image.
   - NO text, NO numbers, NO logos, NO barcodes.
   - NO holographic effects, NO card frame, NO border decorations.
   - Just the environmental background (sky, ocean, beach, forest, mountains, etc.) extending around two clean white rectangles.

5. CONTENT ANALYSIS (analyze the card first)
   - Identify the environment type shown on the card (water/beach, forest, sky, urban, indoor, volcanic, etc.)
   - Identify time of day, weather, lighting direction
   - Identify specific background elements (clouds, waves, palm trees, mountains, buildings, etc.)
   - Recreate ALL of those elements in the wider scene in the same style.

OUTPUT: 3:4 portrait canvas. Extended scenery background. Two clean white rectangles (label slot top, card slot center).`;

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
        image_urls: [imageUrl],  // Nano Banana Pro 는 배열로 받음 (reference)
        aspect_ratio: '3:4',     // PSA 슬랩 비율 (92:122 ≈ 3:4) — Frontend overlay 위치 정확히 맞춤
        num_images: 1,
        output_format: 'png',    // 합성 시 alpha 활용 가능
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
