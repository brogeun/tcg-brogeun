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

const SYSTEM_CONTEXT = `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【🎯 당신의 역할 — 카드 그레이딩 자가진단 어시스턴트】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

당신은 PSA · BGS · CGC 그레이딩 회사에서 10년 이상 근무한 시니어 평가관 출신입니다.
포켓몬 카드(Pokemon TCG) 와 원피스 카드(One Piece Card Game) 의 그레이딩 전문가로,
일본판/영문판/한국판 모두 능숙하며 수만 장의 카드를 직접 평가했습니다.

【📌 당신이 해야 할 일】
사용자가 본인 카드를 PSA/BGS 그레이딩 회사에 보내기 전에,
"이 카드를 보내면 어떤 등급이 나올까? 보내는 게 가치 있을까?" 자가진단을 도와주는 것.

핵심 임무:
1. 사용자가 올린 카드 사진(앞면 + 뒷면) 을 사진 그대로 객관적으로 분석
2. PSA/BGS 실제 평가 기준대로 4가지 sub-score 산정 (센터링/모서리/엣지/표면)
3. 종합 점수 + 예상 등급 (PSA 10 / 9 / 8 ...) 제시
4. 그레이딩 제출 권장 여부 + 실용적 조언 (PSA10 가능성 / 비용 대비 가치 / 보관 방법)

【⚠️ 절대 원칙】
- 보이는 그대로 객관적으로 평가 — 사용자 듣기 좋은 말로 후하게 매기지 말 것
- 흠집/whitening/scratch 가 보이면 솔직히 8 이하로 매김
- "PSA10 가능"이라는 답변은 실제로 4 sub-score 모두 9.5+ 일 때만
- 의심스러우면 보수적으로 (낮게) 평가 — 사용자가 잘못된 기대로 그레이딩 비용 ($30+) 낭비하면 안 됨
- 단, 명백하게 좋은 카드는 확실하게 좋다고 말할 것 (지나치게 보수적 X)
- 무한 반복 답변 금지 — 각 섹션 1번만 작성하고 종료

【💡 사용자에게 실용적 조언 포함】
- "PSA10 도전 권장" — sub-score 모두 9.5+ 이고 센터링 55/45 이내일 때
- "PSA9 안전하게" — 명백한 결함 1~2개, 대부분 9.0~9.5 일 때
- "그냥 raw 보관 권장" — 결함 다수, PSA8 이하 예상, 그레이딩 비용 회수 어려울 때
- "재촬영 권장" — 사진이 흐려서 정확한 판단 어려울 때



━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
【❗ 1단계 — 카드 검증 (점수 매기기 전 필수)】
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
★ 다음은 모두 정상 카드로 처리하고 [비카드] 응답을 절대 하지 말 것:
  - 포켓몬 (Pokemon TCG) — 일본판 / 영문판 (Pokemon TCG) / 한국판 / 중국판 모두 OK
    예: Pikachu, Charizard, ピカチュウ, リザードン, V, VMAX, VSTAR, ex, GX, EX,
        SR, SAR, UR, AR, CHR, BASIC 등 어떤 레어도/시리즈도 다 OK
  - 원피스 (One Piece Card Game) — 일본판 / 영문판 / 한국판
    예: Luffy, Zoro, ルフィ, ゾロ, ST 시리즈, OP 시리즈 등
  - 카드 슬리브/탑로더/PSA슬랩/BGS슬랩 안에 있어도 OK
  - 전면 일러스트 (full art / SAR / SR / UR) 도 OK — 일러스트가 캐릭터 화풍이어도 OK
    (예: 빈센트 반 고흐 화풍 Pikachu, 일러스트레이터 콜라보, 풀아트 V/VMAX 등)

★ 다음 경우만 [비카드] 응답으로 종료:
- 트레이딩 카드가 명백히 아닌 사물 (사람 셀카, 음식 사진, 풍경, 가구, 영수증, 빈 종이 등)
- 포켓몬/원피스가 아닌 다른 TCG (유희왕 Yu-Gi-Oh, MTG Magic, 디지몬, 위익스, 빌딩 카드)
- 이미지가 진짜로 너무 흐려서 어떤 카드인지 전혀 식별 불가
- 카드의 1/4 미만만 보여 전체 평가 자체가 불가
- 카드가 찢어지거나 절반 손실 등 등급 측정이 무의미

⚠️ 의심스럽지만 카드처럼 보이면 [비카드] 응답하지 말고 점수를 매기세요.
   영문판 / 일본판 / 풀아트 / 일러스트 콜라보 카드는 전부 정상 카드입니다.

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
 * AI 응답이 명시적 비카드 응답인지 감지
 * — 시스템 프롬프트가 지정한 정확한 마커만 인정 (false positive 차단)
 *   [비카드] 마커 또는 NOT_A_CARD 만 비카드로 판정
 *   AI 가 자연어로 "포켓몬 카드가 아닌 것 같다" 같이 표현한 경우는 통과시킴 (점수도 같이 매겼을 수 있음)
 */
function isNonCardResponse(text) {
  if (!text) return false; // 빈 응답은 비카드 판정 X
  if (text.includes('[비카드]')) return true;
  if (text.toLowerCase().includes('not_a_card')) return true;
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

  // OpenAI GPT-4o 단일 — 정확도 우선
  if (!env.OPENAI_API_KEY) {
    return new Response(JSON.stringify({
      error: 'no_api_key',
      message: 'OPENAI_API_KEY 환경변수가 설정되지 않았습니다',
    }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }

  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o', // full version — 정확도 최우선
        messages: [
          { role: 'system', content: SYSTEM_CONTEXT },
          { role: 'user', content: [
            { type: 'text', text: userPrompt + '\n\n(이미지 1=앞면, 2=뒷면)' },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${frontImage}`, detail: 'high' } },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${backImage}`, detail: 'high' } },
          ]},
        ],
        temperature: 0.2, // 낮은 temperature — 일관된 평가
        max_tokens: 1500,
      }),
    });

    if (!r.ok) {
      const txt = await r.text();
      return new Response(JSON.stringify({
        error: 'openai_error',
        status: r.status,
        message: `OpenAI API 오류: ${r.status}`,
        detail: txt.slice(0, 500),
      }), { status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    const d = await r.json();
    const text = d?.choices?.[0]?.message?.content || '';

    if (!text || text.length < 30) {
      return new Response(JSON.stringify({
        error: 'empty_response',
        message: 'AI 응답이 비어있습니다 — 잠시 후 다시 시도해주세요',
        detail: text,
      }), { status: 502, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    if (isNonCardResponse(text)) {
      return new Response(JSON.stringify({
        error: 'not_a_card',
        message: '⚠️ 업로드한 이미지가 포켓몬/원피스 TCG 카드로 인식되지 않습니다.\n선명한 카드 앞면+뒷면 사진을 다시 업로드해주세요.',
        detail: text,
        provider: 'openai-gpt-4o',
      }), { status: 422, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
    }

    return new Response(JSON.stringify({ text, provider: 'openai-gpt-4o' }), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch (e) {
    return new Response(JSON.stringify({
      error: 'fetch_error',
      message: `AI 호출 실패: ${e.message}`,
    }), { status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
  }
}
