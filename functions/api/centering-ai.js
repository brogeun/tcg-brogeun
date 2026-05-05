/**
 * Cloudflare Pages Function — Gemini Vision proxy
 * 포켓몬/원피스 카드 그레이딩 전 자가진단 AI
 * 사용자 카드 이미지 (앞+뒤) + 측정값 → Gemini 2.5 Flash → 한국어 분석
 * env.GEMINI_API_KEY 필요
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

// CORS preflight
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// 다른 메서드 — 405
export async function onRequest({ request }) {
  if (request.method === 'POST') return; // onRequestPost 가 처리
  if (request.method === 'OPTIONS') return; // onRequestOptions 가 처리
  return new Response('Method Not Allowed', {
    status: 405,
    headers: { ...CORS_HEADERS, Allow: 'POST, OPTIONS' },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.GEMINI_API_KEY) {
    return new Response(JSON.stringify({ error: 'GEMINI_API_KEY not configured' }), {
      status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  }

  let body;
  try { body = await request.json(); }
  catch { return new Response('invalid json', { status: 400 }); }

  const { frontImage, backImage, frontMetrics, backMetrics } = body;
  if (!frontImage || !backImage) {
    return new Response('frontImage and backImage required', { status: 400 });
  }

  const fmt = (m) => {
    if (!m) return '측정값 없음';
    return `좌/우 ${m.lMm}mm / ${m.rMm}mm (${m.lPct}/${m.rPct}%) · 상/하 ${m.tMm}mm / ${m.bMm}mm (${m.tPct}/${m.bPct}%) · 추정 PSA ${m.grades?.psa || '?'} / BGS ${m.grades?.bgs || '?'}`;
  };

  const systemContext = `당신은 포켓몬 카드(Pokemon TCG) 와 원피스 카드(One Piece Card Game) 의 PSA·BGS 그레이딩 전문 어시스턴트입니다.
사용자가 그레이딩 회사로 카드를 보내기 전에 받을 점수를 자가진단할 수 있도록 돕는 도구입니다.

평가 기준 (PSA/BGS 공식 기준):
- Centering (센터링): 50/50 = 완벽, 55/45 까지 PSA10 / BGS Pristine 가능
- Corners (모서리): whitening (테두리 흰색 노출), 닳음, 둥글어짐 체크
- Edges (엣지): chipping (작은 결손), dents (눌림) 체크
- Surface (표면): scratches (긁힘), print lines (인쇄선), holo scratch (홀로 긁힘), staining
- 양면 모두 평가 — 뒷면도 그레이딩 점수에 영향

답변 형식 (한국어로만, 마크다운 X, 350자 이내):
1. 센터링 평가 (앞/뒤 종합)
2. 모서리·엣지 상태 — 의심되는 부분 구체적 위치
3. 표면 — 스크래치/print line 의심 부분
4. 종합 PSA10 가능성 (%) + 가장 큰 약점 1가지
5. 권장 사항 (그레이딩 보낼지 / 보류할지)`;

  const userPrompt = `[앞면 측정값]
${fmt(frontMetrics)}

[뒷면 측정값]
${fmt(backMetrics)}

위 두 이미지 (앞/뒤) 를 분석하여 평가해주세요.`;

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${env.GEMINI_API_KEY}`;

  const payload = {
    systemInstruction: { parts: [{ text: systemContext }] },
    contents: [{
      parts: [
        { text: userPrompt },
        { inline_data: { mime_type: 'image/jpeg', data: frontImage } },
        { inline_data: { mime_type: 'image/jpeg', data: backImage } },
      ],
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 800,
    },
  };

  try {
    const r = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const txt = await r.text();
      return new Response(JSON.stringify({ error: `Gemini ${r.status}`, detail: txt.slice(0, 500) }), {
        status: r.status, headers: { 'Content-Type': 'application/json' },
      });
    }
    const d = await r.json();
    const text = d?.candidates?.[0]?.content?.parts?.[0]?.text || '(빈 응답)';
    return new Response(JSON.stringify({ text }), {
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
}
