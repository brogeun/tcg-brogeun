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

const SYSTEM_CONTEXT = `당신은 포켓몬 카드(Pokemon TCG) 와 원피스 카드(One Piece Card Game) 의 PSA · BGS 그레이딩 전문 어시스턴트입니다.
사용자가 그레이딩 회사로 카드를 보내기 전에 받을 점수를 정확히 자가진단할 수 있도록 돕는 도구입니다.

【평가 기준 (PSA/BGS 공식)】
- 센터링 (Centering): 50/50 = 완벽 (10점). 55/45 까지 PSA10/BGS Pristine 가능 (9.5점). 60/40 = PSA9/BGS9 (8점). 65/35 이상 = 7점 이하.
- 모서리 (Corners): whitening (테두리 흰색 노출), 닳음, 휨 체크. 4 모서리 모두 깨끗하고 날카로우면 10점. 흰색 노출 있으면 8~9점. 닳음 보이면 7점 이하.
- 엣지 (Edges): chipping (가장자리 깨짐), dents (눌림) 체크. 4 변 모두 깨끗하면 10점. 미세 chipping 9점. 눈에 띄는 ding/dent 8점 이하.
- 표면 (Surface): scratches (긁힘), print lines (인쇄선), holo scratch (홀로 긁힘), staining (얼룩) 체크. 완벽한 표면 10점. 미세 print line 9~9.5점. holo scratch 또는 긁힘 8점 이하.
- 양면 평가: 앞면뿐 아니라 뒷면도 점수에 영향 (BGS 는 4면 다 보고, PSA 는 종합 판단).

【출력 형식 — 반드시 정확히 이 구조로, 한국어로만】

[점수]
센터링: X.X
모서리: X.X
엣지: X.X
표면: X.X
종합: X.X

[분석]
(여기에 자세한 한국어 분석을 4~6문장 작성하세요. 다음 내용을 반드시 포함:
1. 전반적인 카드 상태 (앞·뒷면 모두 언급)
2. 가장 큰 강점 (어떤 항목이 만점에 가까운지)
3. 가장 큰 약점 (어떤 결함이 보이는지 — 없으면 "결함 없음")
4. PSA 예상 등급 (PSA 10 Gem Mint / PSA 9 Mint / PSA 8 NM-MT 등) 과 그 근거
5. BGS 예상 등급 (Black Label 9.5+ / Pristine 10 / Gem Mint 9.5 / NM-MT+ 8.5 등)
6. 실제 그레이딩 제출 권장 여부 + 권장 사항 (예: 슬리브 사용, 운송 중 보호 등))

[참고]
- 점수는 0.0~10.0 범위, 0.5 단위로 작성
- 분석에 마크다운(**, ##, * 등) 사용 금지, 일반 한국어 문장만
- 측정값 (좌/우 mm 등) 이 주어지면 분석에 정량적으로 반영
- 사용자가 보내는 [앞면 측정값] [뒷면 측정값] 정보를 점수 산정에 활용`;

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
    // Groq 현재 vision 모델 (2025년 5월 기준 — llama-3.2 vision preview 는 deprecated)
    const groqModels = [
      'meta-llama/llama-4-scout-17b-16e-instruct',
      'meta-llama/llama-4-maverick-17b-128e-instruct',
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
            temperature: 0.3, max_tokens: 1500,
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
        lastError = `${model}: ${r.status} ${txt.slice(0, 800)}`;
        console.error(`[groq] ${model} failed:`, r.status, txt.slice(0, 800));
        // 401 = key 문제 (다른 모델도 동일) → 즉시 중단
        // 403 = 모델별 권한 다를 수 있으니 다음 모델 시도 (계속)
        if (r.status === 401) break;
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
          generationConfig: { temperature: 0.3, maxOutputTokens: 1500 },
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
