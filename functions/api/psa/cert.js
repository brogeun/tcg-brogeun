/**
 * POST /api/psa/cert
 * Body: { cert_number, card_id, holding_id?, expected_grade }
 *   ↳ PSA Public API 호출 → 카드 검증 → DB 저장
 *
 * 검증 단계:
 *   1) cert# 가 PSA 에 존재 (404 → "유효하지 않은 Cert#")
 *   2) PSA Grade === holdings.grade (PSA10 vs psa10) 일치
 *   3) PSA Subject / CardNumber 가 우리 카드 메타와 매칭
 */
import { withAuth, jsonResponse, badRequest, serverError } from '../../_shared/auth.js';

const PSA_API_BASE = 'https://api.psacard.com/publicapi';

// 보유 카드 grade ↔ PSA Grade 매핑
const GRADE_MAP = { psa10: 10, psa9: 9 };

/** 문자열 정규화 (대소문자 무시 + 공백/특수문자 제거) */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** PSA 응답 카드 vs 우리 카드 메타 매칭 */
function verifyCardMatch(psaCert, ourCard) {
  if (!ourCard || !ourCard.name) return { ok: false, reason: '우리 DB 에 카드 정보가 없습니다' };

  // 1) Card number 매칭 — PSA 의 CardNumber 가 우리 code 안에 포함되는지
  const psaNum = String(psaCert.CardNumber || psaCert.cardNumber || '').trim();
  if (psaNum) {
    const ourCode = String(ourCard.code || ourCard.product_number || '');
    const numStripped = psaNum.replace(/^0+/, ''); // "007" → "7"
    const codeNorm = ourCode.replace(/\s+/g, '').toLowerCase();
    const numMatch = codeNorm.includes(numStripped.toLowerCase()) ||
                     codeNorm.endsWith(numStripped.toLowerCase()) ||
                     codeNorm.includes(`${numStripped.toLowerCase()}/`);
    if (!numMatch) {
      return {
        ok: false,
        reason: `카드 번호 불일치 (PSA: ${psaNum} vs 보유: ${ourCode})`,
        debug: { psaNum, ourCode },
      };
    }
  }

  // 2) Subject 매칭 — PSA Subject 가 우리 카드 이름 안에 포함되는지 (대소문자/공백 무시)
  const psaSubject = norm(psaCert.Subject || psaCert.subject);
  const ourName = norm(ourCard.name);
  if (psaSubject && ourName) {
    // 핵심 단어 1개라도 매칭되면 OK (Pikachu, Charizard 등)
    const subjectTokens = psaSubject.split(/(?<=[a-z])(?=[A-Z])/).filter(t => t.length >= 4);
    const hasToken = subjectTokens.some(t => ourName.includes(t.toLowerCase()));
    const fullMatch = ourName.includes(psaSubject) || psaSubject.includes(ourName.slice(0, 8));
    if (!hasToken && !fullMatch) {
      return {
        ok: false,
        reason: `카드 이름 불일치 (PSA: ${psaCert.Subject} vs 보유: ${ourCard.name})`,
        debug: { psaSubject, ourName },
      };
    }
  }

  return { ok: true };
}

/** 우리 DB 카드 메타 조회 — cards-detail.json + all-cards.json fallback */
async function lookupOurCard(env, cardId, origin) {
  const baseURL = origin || 'https://tcghub.kr';
  // 1) cards-detail (TOP10 위주, 풍부한 메타)
  try {
    const r1 = await fetch(`${baseURL}/data/cards-detail.json`, { cf: { cacheTtl: 3600 } });
    if (r1.ok) {
      const data = await r1.json();
      const c = data?.cards?.[cardId];
      if (c) return { name: c.name, code: c.product_number || c.code, brand: c.brand };
    }
  } catch (e) { console.error('cards-detail fetch fail', e); }
  // 2) all-cards 폴백
  try {
    const r2 = await fetch(`${baseURL}/data/all-cards.json`, { cf: { cacheTtl: 3600 } });
    if (r2.ok) {
      const data = await r2.json();
      const items = data.details || data.cards || data.items || [];
      const found = items.find(c => String(c.id || c.product_id) === String(cardId));
      if (found) return {
        name: found.name,
        code: found.productNumber || found.product_number || found.code,
        brand: found.brand,
      };
    }
  } catch (e) { console.error('all-cards fetch fail', e); }
  return null;
}

export const onRequestPost = withAuth(async ({ request, env, user }) => {
  if (!env.DB) return serverError('D1 not bound');
  if (!env.PSA_API_KEY) return serverError('PSA_API_KEY 가 설정되지 않았습니다');

  let body;
  try { body = await request.json(); } catch { return badRequest('JSON body 가 필요합니다'); }

  const cert_number = String(body.cert_number || '').replace(/\D/g, '');
  const card_id = String(body.card_id || '').trim();
  const holding_id = body.holding_id ? parseInt(body.holding_id) : null;
  const expected_grade = String(body.expected_grade || '').toLowerCase();

  if (!cert_number || cert_number.length < 6) return badRequest('Cert# 가 잘못되었습니다 (숫자 6~10자리)');
  if (!card_id || !/^\d+$/.test(card_id)) return badRequest('card_id 가 필요합니다');
  if (!GRADE_MAP[expected_grade]) return badRequest('PSA10 / PSA9 카드만 등록 가능합니다');

  // 중복 체크
  const existing = await env.DB.prepare(
    'SELECT id, user_id, card_id, grade FROM psa_certs WHERE cert_number = ?'
  ).bind(cert_number).first();
  if (existing) {
    return jsonResponse({
      ok: false,
      error: 'already_registered',
      message: existing.user_id === user.id
        ? '이미 등록된 Cert# 입니다'
        : '이 Cert# 는 다른 사용자가 이미 등록했습니다',
    }, 409);
  }

  // PSA Public API 호출
  let psaResp;
  try {
    const r = await fetch(`${PSA_API_BASE}/cert/GetByCertNumber/${cert_number}`, {
      headers: { 'authorization': `bearer ${env.PSA_API_KEY}` },
    });
    if (r.status === 404) {
      return jsonResponse({ ok: false, error: 'not_found', message: 'PSA 에 등록되지 않은 Cert# 입니다' }, 404);
    }
    if (!r.ok) {
      const txt = await r.text();
      return serverError(`PSA API 오류 (${r.status}): ${txt.slice(0, 200)}`);
    }
    psaResp = await r.json();
  } catch (e) {
    return serverError(`PSA API 호출 실패: ${e.message || e}`);
  }

  // PSA API 응답 — { PSACert: { CertNumber, SpecID, Brand, Year, Subject, CardNumber, VarietyPedigree, CardGrade, ... } }
  const cert = psaResp?.PSACert || psaResp?.psaCert || psaResp;
  if (!cert) {
    return jsonResponse({ ok: false, error: 'invalid_response', message: 'PSA 응답이 비어있습니다' }, 502);
  }

  // Grade 검증
  const psaGradeRaw = cert.CardGrade || cert.cardGrade || cert.Grade || cert.grade || '';
  const psaGradeNum = parseInt(String(psaGradeRaw).match(/\d+/)?.[0] || 0);
  const expectedGradeNum = GRADE_MAP[expected_grade];
  if (psaGradeNum !== expectedGradeNum) {
    return jsonResponse({
      ok: false,
      error: 'grade_mismatch',
      message: `등급 불일치 — PSA: ${psaGradeRaw} / 보유: ${expected_grade.toUpperCase()}`,
      psa_grade: psaGradeRaw,
    }, 422);
  }

  // 카드 매칭 검증
  const reqUrl = new URL(request.url);
  const ourCard = await lookupOurCard(env, card_id, `${reqUrl.protocol}//${reqUrl.host}`);
  const match = verifyCardMatch(cert, ourCard);
  if (!match.ok) {
    return jsonResponse({
      ok: false,
      error: 'card_mismatch',
      message: `❌ 이 Cert# 는 다른 카드입니다.\nPSA 등록 카드: ${cert.Subject || '?'} (${cert.Brand || ''} ${cert.Year || ''} #${cert.CardNumber || ''})\n사유: ${match.reason}`,
      psa_card: {
        subject: cert.Subject,
        card_number: cert.CardNumber,
        brand: cert.Brand,
        year: cert.Year,
        variety: cert.VarietyPedigree,
      },
    }, 422);
  }

  // 저장
  try {
    const result = await env.DB.prepare(
      `INSERT INTO psa_certs (cert_number, card_id, grade, user_id, holding_id,
                              spec_id, brand, year, subject, card_number, variety, category, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      cert_number,
      card_id,
      psaGradeNum,
      user.id,
      holding_id,
      cert.SpecID || cert.specID || null,
      cert.Brand || null,
      cert.Year || null,
      cert.Subject || null,
      cert.CardNumber || null,
      cert.VarietyPedigree || cert.Variety || null,
      cert.Category || null,
      JSON.stringify(cert),
    ).run();

    return jsonResponse({
      ok: true,
      id: result.meta?.last_row_id,
      message: '✅ 인증 완료 — POP 카운트에 반영되었습니다',
      cert: {
        cert_number,
        grade: psaGradeNum,
        subject: cert.Subject,
        card_number: cert.CardNumber,
      },
    });
  } catch (e) {
    return serverError(`저장 실패: ${e.message || e}`);
  }
});

/**
 * GET /api/psa/cert
 * → 본인이 등록한 cert 목록
 */
export const onRequestGet = withAuth(async ({ env, user }) => {
  if (!env.DB) return serverError('D1 not bound');
  try {
    const res = await env.DB.prepare(
      `SELECT id, cert_number, card_id, grade, holding_id, subject, card_number, registered_at
       FROM psa_certs WHERE user_id = ? ORDER BY registered_at DESC`
    ).bind(user.id).all();
    return jsonResponse({ ok: true, certs: res.results || [] });
  } catch (e) {
    return serverError(`조회 실패: ${e.message || e}`);
  }
});
