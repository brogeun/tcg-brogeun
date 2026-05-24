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
const CORE_INSTRUCTION = `Take this Pokemon trading card and ADD a narrow extension border around it where the card's illustration continues naturally outward. The card itself MUST DOMINATE the output (about 80% of the frame). The extension is just a thin decorative band around the card edges, NOT a wide landscape.

ABSOLUTE RULES:
1. PRESERVE the card EXACTLY — every pixel, every character (Pokemon/creature), every text, every border line, every holographic effect, every set symbol, every number must remain pixel-perfect identical. DO NOT redraw or modify the card in any way.
2. The card stays in its ORIGINAL aspect ratio (63:88 vertical) and occupies roughly 80-85% of the output canvas.
3. Around the card, add ONLY a NARROW extension band (about 10-12% of the canvas width on each side, 6-8% on top/bottom) — NOT a wide landscape, NOT an open sky, NOT a huge environment. Think of it as the card slightly zoomed out, showing just a little more of the scene that's already inside the card.
4. SEAMLESS CONTINUITY — whatever is at the edges of the card's illustration must continue smoothly into the narrow extension band. Same art style, same brushwork, same colors, same lighting. The card's frame line (the actual card border) should still be visible as the boundary between card and extension.
5. NO PSA slab, NO label, NO barcode, NO frame around the card. Just the card + small illustration extension.
6. NO new characters. The Pokemon on the card stays inside the card. Only the environment extends slightly outward.

CONTENT (analyze the card first):
- Identify what's inside the card's illustration — the character pose, the immediate background (a few meters around the character), specific objects, colors, lighting.
- The extension must show MORE OF EXACTLY THAT scene, just slightly wider — same beach with the same waves, same forest with the same trees right next to the ones visible, same room with the same wall pattern, etc.

OUTPUT FORMAT: Portrait orientation (taller than wide), close to the card's own aspect ratio. The card fills most of the image, with only a narrow scene extension around it.`;

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
        image_urls: [imageUrl],  // Gemini 는 배열로 받음
        aspect_ratio: '3:4',     // 세로형 — 카드 비율(63:88)과 가까움. 카드가 화면 대부분 차지
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
