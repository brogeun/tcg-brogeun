/**
 * Cloudflare Pages Function — Groq Llama Vision (또는 Gemini fallback)
 * 포켓몬/원피스 카드 그레이딩 전 자가진단 AI
 *
 * 우선순위:
 *   1. GROQ_API_KEY (Groq Llama 3.2 Vision — 무료, 한국 IP 지원, 빠름)
 *   2. GEMINI_API_KEY (Gemini 2.5 Flash — 무료, 일부 지역 차단)
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function onRequest({ request }) {
  if (request.method === 'POST' || request.method === 'OPTIONS') return;
  return new Response('Method Not Allowed', {
    status: 405, headers: { ...CORS_HEADERS, Allow: 'POST, OPTIONS' },
  });
}

const SYSTEM_CONTEXT = `당신은 포켓몬 카드(Pokemon TCG) 와 원피스 카드(One Piece Card Game) 의 PSA·BGS 그레이딩 전문 어시스턴트입니다.
사용자가 그레이딩 회사로 카드를 보내기 전에 받을 점수를 자가진단할 수 있도록 돕는 도구입니다.

평가 기준 (PSA/BGS 공식):
- Centering: 50/50 = 완벽, 55/45 까지 PSA10 / BGS Pristine 가능
- Corners: whitening (테두리 흰색 노출), 닳음 체크
- Edges: chipping, dents 체크
- Surface: scratches, print lines, holo scratch, staining
- 양면 모두 평가 (뒷면도 점수에 영향)

답변 형식 (한국어로만, 마크다운 X, 350자 이내):
1. 센터링 평가
2. 모서리·엣지 상태
3. 표면 상태
4. 종합 PSA10 가능성 (%) + 가장 큰 약점
5. 권장 사항`;

function fmtMetrics(m) {
  if (!m) return '측정값 없음';
  return `좌/우 ${m.lMm}mm/${m.rMm}mm (${m.lPct}/${m.rPct}%) · 상/하 ${m.tMm}mm/${m.bMm}mm (${m.tPct}/${m.bPct}%) · 추정 PSA ${m.grades?.psa || '?'} / BGS ${m.grades?.bgs || '?'}`;
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); }
  catch { return new Response('invalid json', { status: 400, headers: CORS_HEADERS }); }

  const { frontImage, backImage, frontMetrics, backMetrics } = body;
  if (!frontImage || !backImage) {
    return new Response(JSON.stringify({ error: 'frontImage and backImage required' }), {
      status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  const userPrompt = `[앞면 측정값]\n${fmtMetrics(frontMetrics)}\n\n[뒷면 측정값]\n${fmtMetrics(backMetrics)}\n\n위 두 이미지 (앞/뒤) 를 분석해주세요.`;

  // 1순위: Groq (무료, 한국 IP 지원)
  if (env.GROQ_API_KEY) {
    // Groq 모델 — 여러 vision 모델 시도 (deprecated 대비)
    const groqModels = [
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
      'llama-3.2-90b-vision-preview',
      'llama-3.2-11b-vision-preview',
    ];
    let lastError = '';
    for (const model of groqModels) {
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${env.GROQ_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [
              { role: 'system', content: SYSTEM_CONTEXT },
              { role: 'user', content: [
                { type: 'text', text: userPrompt + '\n\n(이미지 1=앞면, 2=뒷면)' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frontImage}` } },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${backImage}` } },
              ]},
            ],
            temperature: 0.3, max_tokens: 800,
          }),
        });
        if (r.ok) {
          const d = await r.json();
          const text = d?.choices?.[0]?.message?.content || '(빈 응답)';
          return new Response(JSON.stringify({ text, provider: `groq:${model}` }), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
        const txt = await r.text();
        lastError = `${model}: ${r.status} ${txt.slice(0, 200)}`;
        // 401/403 = key 문제 → 더 시도해도 의미없음
        if (r.status === 401 || r.status === 403) break;
      } catch (e) {
        lastError = `${model}: ${e.message}`;
      }
    }
    // Groq 실패 → 에러 그대로 반환 (Gemini fallback X, 디버깅 위해)
    return new Response(JSON.stringify({ error: 'Groq all models failed', detail: lastError }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  // 2순위: Gemini (일부 지역 차단)
  if (env.GEMINI_API_KEY) {
    try {
      const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;
      const r = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM_CONTEXT }] },
          contents: [{ parts: [
            { text: userPrompt },
            { inline_data: { mime_type: 'image/jpeg', data: frontImage } },
            { inline_data: { mime_type: 'image/jpeg', data: backImage } },
          ]}],
          generationConfig: { temperature: 0.3, maxOutputTokens: 800 },
        }),
      });
      if (r.ok) {
        const d = await r.json();
        const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || '(빈 응답)';
        return new Response(JSON.stringify({ text, provider: 'gemini' }), {
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      } else {
        const txt = await r.text();
        return new Response(JSON.stringify({ error: `Gemini ${r.status}`, detail: txt.slice(0, 500) }), {
          status: r.status, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
        });
      }
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), {
        status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }
  }

  return new Response(JSON.stringify({ error: 'GROQ_API_KEY or GEMINI_API_KEY required' }), {
    status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}
