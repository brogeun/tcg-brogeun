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
 *     provider: 'fal-ai/flux-pro/kontext',
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
// Flux Pro Kontext 는 이미지를 reference 로 받아 텍스트 가이드대로 변형/확장
const STYLE_PROMPTS = [
  {
    style: 'cinematic',
    label: '시네마틱',
    prompt: 'Extend this trading card artwork outward into a wider cinematic scene. Keep the original character and central composition intact in the center, but extend the background and environment naturally to all sides with dramatic atmosphere, depth, and matching lighting. The extended areas should feel like a natural continuation of the existing art.',
  },
  {
    style: 'illustration',
    label: '일러스트',
    prompt: 'Extend this trading card artwork outward as a polished hand-drawn illustration. Maintain the original character and artwork style perfectly in the center, and extend the surrounding environment seamlessly with matching colors, brushwork, and details. The extension should look like it was painted by the same artist.',
  },
  {
    style: 'abstract',
    label: '추상',
    prompt: 'Extend this trading card artwork outward with an atmospheric abstract background. Keep the central character and original artwork unchanged, surrounded by soft gradients, magical light particles, and ambient color washes that complement and frame the original art without competing with it.',
  },
];

// fal.ai 호출 — 1개 시안 생성 (Flux Pro Kontext, image-aware)
async function callFalFluxPro({ apiKey, imageUrl, prompt, seed }) {
  // Flux Pro Kontext — 이미지+텍스트 → 이미지 (image-aware editing/extension)
  // $0.04/장, 동기 endpoint (보통 8~20초)
  const endpoint = 'https://fal.run/fal-ai/flux-pro/kontext';

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
        image_url: imageUrl,  // reference 카드 이미지
        aspect_ratio: '4:3',   // 백판 형태 (가로형)
        num_images: 1,
        guidance_scale: 3.5,
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

  const { cardImageUrl, cardName = '' } = body || {};
  if (!cardImageUrl) {
    return json({ ok: false, error: 'cardImageUrl 필수 (카드를 먼저 선택하세요)' }, 400);
  }
  // URL 형식 간단 검증 (Kontext 는 public URL 필요)
  if (!/^https?:\/\//i.test(cardImageUrl)) {
    return json({ ok: false, error: 'cardImageUrl must be http(s) public URL' }, 400);
  }

  // 카드 이름 prefix (없으면 일반 묘사) — 각 스타일 프롬프트에 합성
  const namePrefix = cardName
    ? `Trading card "${cardName}". `
    : 'Trading card game artwork. ';

  // 3개 시안 병렬 생성 (3가지 고정 스타일)
  const seedBase = Date.now() % 1000000;
  const tasks = STYLE_PROMPTS.map((s, idx) =>
    callFalFluxPro({
      apiKey: env.FAL_API_KEY,
      imageUrl: cardImageUrl,
      prompt: namePrefix + s.prompt,
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
    provider: 'fal-ai/flux-pro/kontext',
    elapsedMs: Date.now() - startMs,
  });
}
