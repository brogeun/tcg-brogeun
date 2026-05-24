/**
 * TCG Casing — fal.ai Flux Pro 로 카드 확장 아트 (extended art) 시안 3개 생성
 *
 * 인증: X-Admin-Password 헤더 (기존 admin API 와 동일 패턴)
 *   admin 만 사용 가능 — 일반 사용자/공개 차단
 *
 * 입력 (POST JSON):
 *   {
 *     cardImageUrl: string,   // 카드 이미지 URL (DB 의 공식 이미지 또는 사용자 업로드)
 *     cardName?: string,      // 카드 이름 (프롬프트 강화용)
 *     prompt?: string,        // 커스텀 프롬프트 (없으면 기본 outpainting 프롬프트)
 *     style?: string,         // 스타일 힌트 (cinematic/illustration/abstract 등)
 *   }
 *
 * 출력:
 *   {
 *     ok: true,
 *     variants: [{ url: string, seed: number, style: string }, ...],  // 3개
 *     provider: 'fal-ai/flux-pro-1.1-ultra',
 *     elapsedMs: number,
 *   }
 *
 * 환경 변수:
 *   env.FAL_API_KEY      — fal.ai API key (Secret)
 *   env.ADMIN_PASSWORD   — admin 인증 비밀번호 (기존)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Password',
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS_HEADERS,
    },
  });

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// 3가지 스타일 — 각각 다른 분위기의 확장 아트 시안 생성
const STYLE_PROMPTS = [
  {
    style: 'cinematic',
    label: '시네마틱',
    suffix: 'in a dramatic cinematic composition with depth and atmosphere, extending the original card artwork into a wider epic scene with matching color palette and lighting',
  },
  {
    style: 'illustration',
    label: '일러스트',
    suffix: 'as a polished hand-drawn illustration extending naturally beyond the card borders, maintaining the original artwork style and details in the center, with the extended areas seamlessly continuing the scene',
  },
  {
    style: 'abstract',
    label: '추상',
    suffix: 'with the central card artwork surrounded by an abstract atmospheric background of soft gradients, magical particles, and ambient color that complements the original art',
  },
];

// fal.ai 호출 — 1개 시안 생성
async function callFalFluxPro({ apiKey, imageUrl, prompt, seed }) {
  // Flux Pro 1.1 Ultra — 가장 새롭고 품질 우수, $0.05/장
  // 동기 endpoint (queue 안 씀 — 보통 8~15초 안에 응답)
  const endpoint = 'https://fal.run/fal-ai/flux-pro/v1.1-ultra';

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 60000); // 60s

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
        // Flux Pro 1.1 Ultra 는 image_url 안 받음 (텍스트→이미지)
        // 카드 일러스트는 prompt 로 reference (Kontext 시리즈와 달리)
        aspect_ratio: '4:3',  // 백판 형태에 가까운 가로형
        num_images: 1,
        enable_safety_checker: true,
        output_format: 'jpeg',
        safety_tolerance: '5',
        seed,
      }),
    });
    clearTimeout(tid);

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch {
      return { ok: false, error: `fal.ai invalid JSON: ${text.slice(0, 200)}`, status: resp.status };
    }
    if (!resp.ok) {
      return { ok: false, error: data.detail || data.error || JSON.stringify(data).slice(0, 300), status: resp.status };
    }
    const url = data.images?.[0]?.url;
    if (!url) {
      return { ok: false, error: `no image in response: ${JSON.stringify(data).slice(0, 200)}`, status: 200 };
    }
    return { ok: true, url, seed };
  } catch (e) {
    clearTimeout(tid);
    return { ok: false, error: e.message || String(e), status: 0 };
  }
}

export async function onRequestPost({ request, env }) {
  const startMs = Date.now();

  // ── 인증 (admin 비밀번호) ──
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

  // ── 환경 변수 체크 ──
  if (!env.FAL_API_KEY) {
    return json({ ok: false, error: 'FAL_API_KEY env 미설정 — Cloudflare Pages Settings 에서 추가하세요' }, 500);
  }

  // ── 입력 파싱 ──
  let body;
  try { body = await request.json(); }
  catch { return json({ ok: false, error: 'invalid JSON body' }, 400); }

  const { cardImageUrl, cardName = '', prompt: userPrompt, style: forceStyle } = body || {};
  if (!cardImageUrl) {
    return json({ ok: false, error: 'cardImageUrl required' }, 400);
  }

  // ── 프롬프트 구성 ──
  // 카드 이미지 자체를 fal.ai 에 직접 reference 하기 어려우므로 (Flux Pro 1.1 Ultra 는 텍스트→이미지)
  // 카드 이름과 일반적 TCG 카드 일러스트 스타일을 텍스트로 묘사
  const basePrompt = userPrompt
    || `Trading card game extended art, ${cardName ? `featuring ${cardName}, ` : ''}vibrant detailed character illustration, high quality digital art, extends naturally with matching style`;

  // 스타일 3종 (forceStyle 지정 시 그것만 3번)
  const stylesToUse = forceStyle
    ? STYLE_PROMPTS.filter(s => s.style === forceStyle).concat(STYLE_PROMPTS).slice(0, 3)
    : STYLE_PROMPTS;

  // 3개 시안 병렬 생성
  const seedBase = Date.now() % 1000000;
  const tasks = stylesToUse.map((s, idx) =>
    callFalFluxPro({
      apiKey: env.FAL_API_KEY,
      imageUrl: cardImageUrl,
      prompt: `${basePrompt}, ${s.suffix}`,
      seed: seedBase + idx * 1000,
    }).then(r => ({ ...r, style: s.style, label: s.label }))
  );

  const results = await Promise.all(tasks);

  // 적어도 1개라도 성공하면 부분 결과 반환
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
    provider: 'fal-ai/flux-pro-1.1-ultra',
    elapsedMs: Date.now() - startMs,
  });
}
