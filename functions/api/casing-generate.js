/**
 * TCG Casing — fal.ai Flux Pro Fill 로 카드 outpainting (확장 아트)
 *
 * 인증: X-Admin-Password 헤더
 *
 * 입력 (POST JSON):
 *   {
 *     cardImageUrl: string,      // 원본 카드 이미지 URL (DB)
 *     cardName?: string,         // 카드 이름 (프롬프트 강화용)
 *     imageDataUrl: string,      // Frontend canvas — 카드를 4:3 캔버스 중앙에 배치한 data URL
 *     maskDataUrl: string,       // Frontend canvas — outpaint mask (white=fill, black=keep)
 *     canvasWidth?: number,      // 캔버스 너비 (default 1536)
 *     canvasHeight?: number,     // 캔버스 높이 (default 1152)
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

// 모든 응답은 status 200 — Cloudflare 502/504 overlay 회피. 실제 status 는 _httpStatus 필드.
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

// 3가지 스타일 — outpainting 전용 프롬프트
// Fill 모델은 mask 가 흰색인 영역만 채우므로, 카드 자체 보존은 자동
const STYLE_PROMPTS = [
  {
    style: 'cinematic',
    label: '시네마틱',
    prompt: 'Dramatic cinematic extended artwork around the trading card. The art outside the card seamlessly continues from the card illustration with epic atmosphere, dynamic lighting, atmospheric perspective and depth. Vibrant colors matching the original artwork. Highly detailed digital painting style.',
  },
  {
    style: 'illustration',
    label: '일러스트',
    prompt: 'Hand-painted illustration extending naturally from the card edges. The art outside the card continues the original character and scene with matching brushwork, colors, and artistic style. Soft painterly textures, fantasy art style, the entire extended scene looks like one cohesive illustration painted by the same artist.',
  },
  {
    style: 'abstract',
    label: '추상',
    prompt: 'Atmospheric abstract background extending from the trading card. The area around the card features soft glowing gradients, magical light particles, mystical aura, ambient color washes that complement the card. Ethereal, dreamy, with a sense of depth and energy radiating from the card.',
  },
];

// (fal.ai storage 우회 — 대부분 fal.ai 모델이 data URL 을 image_url 로 직접 받음)
// 만약 결과가 안 나오면 R2 / 다른 임시 호스팅으로 전환 필요

// fal.ai Flux Pro Fill 호출 — image + mask + prompt → outpainted image
async function callFalFluxFill({ apiKey, imageUrl, maskUrl, prompt, seed }) {
  // Flux Pro v1 Fill (FLUX.1 Fill) — outpainting/inpainting 전용, $0.05/장
  const endpoint = 'https://fal.run/fal-ai/flux-pro/v1/fill';

  const controller = new AbortController();
  const tid = setTimeout(() => controller.abort(), 90000); // 90s (Fill 은 좀 느릴 수 있음)

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
        image_url: imageUrl,
        mask_url: maskUrl,
        num_images: 1,
        guidance_scale: 30,         // Fill 모델은 guidance 높게 (Flux 권장값)
        num_inference_steps: 28,
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

  const { cardName = '', imageDataUrl, maskDataUrl } = body || {};
  if (!imageDataUrl || !maskDataUrl) {
    return json({ ok: false, error: 'imageDataUrl 과 maskDataUrl 필수 (Frontend canvas 결과)' }, 400);
  }

  // data URL 을 image_url 로 직접 전달 (대부분 fal.ai 모델 지원)
  const imageUrl = imageDataUrl;
  const maskUrl = maskDataUrl;

  // ── 프롬프트 prefix ──
  const namePrefix = cardName
    ? `Trading card "${cardName}" in the center. `
    : 'Trading card game in the center. ';

  // ── 3개 시안 병렬 생성 ──
  const seedBase = Date.now() % 1000000;
  const tasks = STYLE_PROMPTS.map((s, idx) =>
    callFalFluxFill({
      apiKey: env.FAL_API_KEY,
      imageUrl,
      maskUrl,
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
      uploadedImageUrl: imageUrl,
      uploadedMaskUrl: maskUrl,
    }, 502);
  }

  return json({
    ok: true,
    variants: successes.map(r => ({ url: r.url, seed: r.seed, style: r.style, label: r.label })),
    failed: failures.length,
    failures: failures.length ? failures.map(f => ({ style: f.style, error: f.error })) : undefined,
    provider: 'fal-ai/flux-pro/v1/fill',
    elapsedMs: Date.now() - startMs,
  });
}
