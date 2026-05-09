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

const SYSTEM_CONTEXT = `당신은 PSA · BGS · CGC 그레이딩 회사에서 10년 이상 근무한 시니어 평가관 출신의 포켓몬 카드(Pokemon TCG) 와 원피스 카드(One Piece Card Game) 그레이딩 전문가입니다. 일본판/영문판 모두 능숙하며, 수만 장의 카드를 직접 평가한 경험을 가지고 있습니다.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【❗ 1단계 — 카드 검증 (점수 매기기 전 필수)】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
다음에 해당하면 절대 점수를 매기지 말고 [비카드] 응답으로 종료:
- 트레이딩 카드가 아닌 사물 (사람, 동물, 풍경, 음식, 가구, 일반 종이 등)
- 포켓몬/원피스가 아닌 다른 TCG (유희왕, MTG, 디지몬, 위익스 등)
- 너무 흐리거나 어두워서 식별 불가
- 카드의 일부만 보여 평가 불가
- 손상이 너무 심해 등급 측정이 무의미한 경우 (찢어짐, 절반 손실 등)

★ 비카드 출력 (이 경우 [점수]/[분석] 절대 작성하지 말 것):

[비카드]
업로드한 이미지가 포켓몬 또는 원피스 TCG 카드로 인식되지 않습니다.
인식된 내용: (한 문장 — 예: "강아지 사진" "유희왕 카드" "흐린 이미지")
선명한 카드 사진 (앞면 + 뒷면) 을 다시 업로드해주세요.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【2단계 — PSA/BGS 평가 기준 (전문 지식 기반)】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

▸ 센터링 (Centering) — PSA 의 가장 엄격한 항목
  - PSA 기준: 앞면 좌/우 50/50 ~ 55/45, 상/하 50/50 ~ 55/45 → PSA10
  - 앞면 60/40, 뒷면 75/25 까지 → PSA9
  - 60/40 초과 → PSA8 이하
  - BGS Pristine 10: 앞 50/50 ± 1, 뒷 50/50 ± 2 (극도로 엄격)
  - BGS Gem Mint 9.5: 앞 55/45, 뒷 60/40
  - 일본판은 영문판보다 평균적으로 센터링이 좋은 편 (제조 차이)
  - 홀로 카드 (V/VMAX/VSTAR/SR/SAR/UR) 는 더 엄격하게 본다

▸ 모서리 (Corners) — 가장 흔한 감점 사유
  - 4 모서리 모두 sharp + whitening 없음 → 10점
  - 1~2 모서리 미세 whitening (확대해야 보임) → 9.5점
  - 명확한 whitening (육안으로 보임) → 9점
  - 모서리 닳음 / 미세 dent → 8점
  - 모서리 깨짐 / 큰 흠집 → 7점 이하
  - 일본판 카드는 모서리가 약하니 더 엄격하게 본다 (특히 풀아트)
  - 검은색 테두리 카드 (PSA10 매우 어려움) — whitening 더 잘 보임

▸ 엣지 (Edges) — 4 변 가장자리
  - 4 변 모두 깨끗 + chipping 없음 → 10점
  - 미세 chipping (1mm 이하) 1~2 곳 → 9.5점
  - 눈에 띄는 chipping → 9점
  - dent/ding 있음 → 8점
  - 큰 흠집/찢어짐 → 7점 이하
  - 홀로/foil 카드는 엣지 chipping 잘 발생

▸ 표면 (Surface) — Surface 와 Holo 결함
  - 완벽 (스크래치/프린트라인/지문/얼룩 없음) → 10점
  - 미세 print line 1~2 라인 (각도별로만 보임) → 9.5점
  - 명확한 print line, 작은 스크래치 → 9점
  - holo scratch (홀로 표면 긁힘) → 8점 ~ 8.5점
  - 명확한 스크래치/얼룩/지문 → 7점 ~ 7.5점
  - cloud (홀로 흐림 — 풀아트/SAR 에 흔함) 발견 시 9점 이하 권장
  - 일본판 SAR/UR 의 경우 cloud 심하면 PSA10 매우 어려움

▸ 양면 종합 평가
  - PSA: 앞면이 주, 뒷면은 미세결함 발견 시 1단계 감점
  - BGS: 앞 + 뒤 + 4면 모두 평가, 가장 낮은 점수가 종합점수의 상한
  - CGC: BGS 와 유사하나 상대적으로 관대

▸ 종합 점수 계산 (실무)
  - PSA10: 4 sub-score 모두 9.5+ 이고 앞 센터링 55/45 이내
  - PSA9: sub-score 평균 9.0 이상, 1~2 항목 9.0
  - PSA8: 평균 8.0 이상
  - BGS Pristine 10: 4 sub 모두 10.0
  - BGS Black Label 9.5: 4 sub 모두 9.5+ + 앞 센터링 거의 완벽
  - BGS 9.5 (Gem Mint): 평균 9.5, 최저 9.0
  - 종합 점수 = 4 sub-score 의 가중 평균 (센터링 30%, 모서리 30%, 엣지 20%, 표면 20%)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【3단계 — 출력 형식 (카드 이미지인 경우만, 반드시 이 구조)】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[점수]
센터링: X.X
모서리: X.X
엣지: X.X
표면: X.X
종합: X.X

[분석]
(한국어 4~6문장. 다음 내용을 반드시 포함:
1. 카드 식별 (예: "포켓몬 카드 SV-P 197 피카츄 프로모, PSA10 가능성 평가")
2. 전반적인 상태 (앞 + 뒷면 모두 언급, 측정값 정량 인용)
3. 가장 큰 강점 (어떤 sub-score 가 만점에 가까운지)
4. 가장 큰 약점 (구체적 결함 위치 — 예: "좌상 모서리 whitening 미세")
5. PSA 예상 등급 + 근거 (예: "PSA9 — 좌상 whitening 으로 PSA10 어려움")
6. BGS 예상 등급 + 근거 (예: "BGS 9.0 — 뒷면 60/40 으로 9.5 어려움")
7. 그레이딩 제출 권장 여부 (PSA10 노릴만 한가? PSA9 보내기 vs 그냥 raw 보관?))

[참고]
- 점수는 0.0~10.0, 0.5 단위
- 마크다운 (**, ##, * 등) 사용 금지
- 측정값 정량 인용 ("좌/우 3.7mm/3.8mm 로 거의 50/50 센터링")
- 의심스러우면 보수적으로 낮게 매기고 분석에 명시
- 손상 명확하면 솔직히 7점 이하로 평가 — 무조건 PSA10 이라고 답 금지
- 일본판/영문판 차이 인지하고 평가
- 홀로/SAR/UR/SR 카드는 더 엄격하게 (PSA10 어려움)
- 카드 종류 식별 가능하면 분석에 명시 (예: "피카츄 V SAR")`;

/**
 * AI 응답이 비카드 응답인지 감지
 * — [비카드] 키워드 또는 [점수] 섹션 없으면 비카드로 판정
 */
function isNonCardResponse(text) {
  if (!text) return true;
  const t = text.toLowerCase();
  // 명시적 비카드 응답
  if (text.includes('[비카드]') || t.includes('not_a_card')) return true;
  // [점수] 섹션 자체가 없으면 카드 평가 못한 것
  if (!text.includes('[점수]') && !text.match(/센터링\s*[:：]/)) return true;
  return false;
}

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
          // 비카드 응답 감지 → 422 로 명확히 거부
          if (isNonCardResponse(text)) {
            return new Response(JSON.stringify({
              error: 'not_a_card',
              message: '⚠️ 업로드한 이미지가 포켓몬/원피스 TCG 카드로 인식되지 않습니다.\n선명한 카드 앞면+뒷면 사진을 다시 업로드해주세요.',
              detail: text,
              provider: `groq:${model}`,
            }), {
              status: 422,
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          }
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
    // Groq 실패 → Cloudflare Workers AI fallback 시도 (외부 라우팅 X, 한국에서 무조건 작동)
    console.warn('[ai] Groq failed, trying Cloudflare Workers AI:', lastError);
  }

  // 2순위: Cloudflare Workers AI — env.AI binding 필요 (대시보드에서 추가)
  //   외부 fetch 안 함 → region 라우팅 차단 발생 자체가 불가
  //   무료 tier: 10,000 neurons/day (vision 1회 ~50 neurons → 약 200회/day 무료)
  if (env.AI) {
    const cfModels = [
      '@cf/meta/llama-3.2-11b-vision-instruct',  // multilingual (한국어 가능)
      '@cf/llava-hf/llava-1.5-7b-hf',            // 영어 위주, fallback
    ];
    const frontBytes = Array.from(Uint8Array.from(atob(frontImage), c => c.charCodeAt(0)));
    let cfLastError = '';
    for (const model of cfModels) {
      try {
        const result = await env.AI.run(model, {
          prompt: `${SYSTEM_CONTEXT}\n\n${userPrompt}\n\n(이미지: 카드 앞면. 뒷면 측정값은 위에 명시)`,
          image: frontBytes,
          max_tokens: 1500,
        });
        const text = result?.description || result?.response || result?.text ||
                     (typeof result === 'string' ? result : JSON.stringify(result));
        if (text && text !== '{}' && text.length > 10) {
          if (isNonCardResponse(text)) {
            return new Response(JSON.stringify({
              error: 'not_a_card',
              message: '⚠️ 업로드한 이미지가 포켓몬/원피스 TCG 카드로 인식되지 않습니다.\n선명한 카드 앞면+뒷면 사진을 다시 업로드해주세요.',
              detail: text,
              provider: `cloudflare-ai:${model.split('/').pop()}`,
            }), {
              status: 422,
              headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
            });
          }
          return new Response(JSON.stringify({ text, provider: `cloudflare-ai:${model.split('/').pop()}` }), {
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
        cfLastError = `${model}: empty response (${JSON.stringify(result).slice(0, 200)})`;
      } catch (e) {
        cfLastError = `${model}: ${e.message}`;
        console.error(`[cf-ai] ${model} failed:`, e.message);
      }
    }
    console.warn('[ai] Cloudflare AI all models failed, trying Gemini:', cfLastError);
  }

  // 3순위: Gemini (일부 지역 차단)
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
        if (isNonCardResponse(text)) {
          return new Response(JSON.stringify({
            error: 'not_a_card',
            message: '⚠️ 업로드한 이미지가 포켓몬/원피스 TCG 카드로 인식되지 않습니다.\n선명한 카드 앞면+뒷면 사진을 다시 업로드해주세요.',
            detail: text,
            provider: 'gemini',
          }), {
            status: 422,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          });
        }
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
