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

/** D1 테이블 보장 — 캐시(영구) + 대기열(pending) */
async function ensureTables(env) {
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS psa_cert_cache (cert_number TEXT PRIMARY KEY, data TEXT, fetched_at INTEGER)'
  ).run();
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS psa_cert_pending (cert_number TEXT PRIMARY KEY, card_id TEXT, requested_at INTEGER)'
  ).run();
}

/** 캐시에서 cert 조회 (없으면 null) */
async function getCachedCert(env, certNumber) {
  const row = await env.DB.prepare(
    'SELECT data FROM psa_cert_cache WHERE cert_number = ?'
  ).bind(certNumber).first();
  if (row && row.data) {
    try { return JSON.parse(row.data); } catch (e) { /* 손상 캐시 무시 */ }
  }
  return null;
}

/** 대기열 등록 — 가정용 PC 워커가 PSA 페이지를 받아 캐시를 채운다 */
async function queueCert(env, certNumber, cardId) {
  await env.DB.prepare(
    'INSERT OR IGNORE INTO psa_cert_pending (cert_number, card_id, requested_at) VALUES (?, ?, ?)'
  ).bind(certNumber, cardId, Date.now()).run();
}

// 보유 카드 grade ↔ PSA Grade 매핑
const GRADE_MAP = { psa10: 10, psa9: 9 };

/** 문자열 정규화 (대소문자 무시 + 공백/특수문자 제거) */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** PSA 응답 카드 vs 우리 카드 메타 매칭 */
function verifyCardMatch(psaCert, ourCard) {
  // 우리 DB 에 카드 정보가 없으면 → 거부 (카드 매칭 불가능)
  // POP 데이터 무결성 보호 — 다른 카드 cert# 를 임의로 연결하는 악용 차단
  if (!ourCard || !ourCard.name) {
    return {
      ok: false,
      reason: 'DB 카드 정보 lookup 실패',
      hard: true, // 호출자가 별도 메시지 처리 (사용자한테 다시 시도 유도)
    };
  }

  // 1) Card number 매칭 — PSA 의 CardNumber 가 우리 code 안에 포함되는지
  const psaNum = String(psaCert.CardNumber || psaCert.cardNumber || '').trim();
  if (psaNum) {
    // code 가 엉뚱한 슬러그(예: "pkmn-tcg-40")인 카드가 있어 name 의 번호([S10b 074/071])도 함께 대조
    const ourCode = [ourCard.code, ourCard.product_number, ourCard.name].filter(Boolean).join(' ');
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
    // 1) 전체 포함 매칭 (정규화 후)
    const fullMatch = ourName.includes(psaSubject) || psaSubject.includes(ourName);
    // 2) 토큰 매칭 — 원본에서 단어 단위로 쪼개서 4글자 이상 1개라도 매칭
    const psaWords = String(psaCert.Subject || '').split(/[\s.,/\\\-_()]+/)
      .filter(w => w.length >= 4).map(w => w.toLowerCase());
    const tokenMatch = psaWords.some(w => ourName.includes(w));
    if (!fullMatch && !tokenMatch) {
      return {
        ok: false,
        reason: `카드 이름 불일치 (PSA: ${psaCert.Subject} vs 보유: ${ourCard.name})`,
        debug: { psaSubject, ourName, psaWords },
      };
    }
  }

  return { ok: true };
}

/** 우리 DB 카드 메타 조회 — cards-detail.json → all-cards.json → SNKRDUNK API 폴백
 *  반환: { name, code, brand, source } | null
 *  실패 시 debugTrail 에 각 단계 결과 누적 (디버깅용)
 */
async function lookupOurCard(env, cardId, origin, debugTrail) {
  const baseURL = origin || 'https://tcghub.kr';
  // 0) cards-meta-index.json — 사전 생성된 전체 카드 메타 인덱스 (가장 정확/빠름)
  try {
    const r0 = await fetch(`${baseURL}/data/cards-meta-index.json`, { cf: { cacheTtl: 3600 } });
    if (r0.ok) {
      const data = await r0.json();
      const c = data?.[cardId] || data?.[String(cardId)];
      if (c && c.name) return { name: c.name, code: c.code, brand: c.brand, source: 'meta-index' };
      debugTrail?.push(`[0]meta-index: 200 OK, ${cardId} not in index`);
    } else {
      debugTrail?.push(`[0]meta-index: status ${r0.status}`);
    }
  } catch (e) { debugTrail?.push(`[0]meta-index: err ${e.message}`); }

  // 1) cards-detail (TOP10 위주, 풍부한 메타)
  try {
    const r1 = await fetch(`${baseURL}/data/cards-detail.json`, { cf: { cacheTtl: 3600 } });
    if (r1.ok) {
      const data = await r1.json();
      const c = data?.cards?.[cardId];
      if (c) return { name: c.name, code: c.product_number || c.code, brand: c.brand, source: 'cards-detail' };
      debugTrail?.push(`[1]cards-detail: 200 OK, card_id ${cardId} not in detail.cards`);
    } else {
      debugTrail?.push(`[1]cards-detail: status ${r1.status}`);
    }
  } catch (e) { debugTrail?.push(`[1]cards-detail: err ${e.message}`); }

  // 2) all-cards 폴백
  try {
    const r2 = await fetch(`${baseURL}/data/all-cards.json`, { cf: { cacheTtl: 3600 } });
    if (r2.ok) {
      const data = await r2.json();
      const items = data.details || data.cards || data.items || [];
      const found = items.find(c => String(c.id || c.product_id) === String(cardId));
      if (found) return {
        name: found.name, code: found.productNumber || found.product_number || found.code,
        brand: found.brand, source: 'all-cards',
      };
      debugTrail?.push(`[2]all-cards: 200 OK (${items.length} items), id ${cardId} not found`);
    } else {
      debugTrail?.push(`[2]all-cards: status ${r2.status}`);
    }
  } catch (e) { debugTrail?.push(`[2]all-cards: err ${e.message}`); }

  // 3) SNKRDUNK API 직접 폴백 — 다양한 엔드포인트/UA 시도
  const snkrUA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';
  for (const ep of [
    `https://snkrdunk.com/v1/apparels/${cardId}`,
    `https://snkrdunk.com/api/v1/apparels/${cardId}`,
    `https://snkrdunk.com/v2/apparels/${cardId}`,
  ]) {
    try {
      const r = await fetch(ep, {
        headers: { 'accept': 'application/json', 'user-agent': snkrUA, 'accept-language': 'ja,en;q=0.9' },
        cf: { cacheTtl: 3600 },
      });
      if (r.ok) {
        const data = await r.json();
        const a = data?.apparel || data?.data?.apparel || data?.product || data;
        if (a && (a.name || a.title)) {
          debugTrail?.push(`[3]SNKRDUNK ${ep} OK`);
          return {
            name: a.name || a.title,
            code: a.productNumber || a.product_number || a.code || a.modelNumber,
            brand: a.brand || (String(a.name || a.title).toUpperCase().includes('ONE PIECE') ? 'onepiece' : 'pokemon'),
            source: 'snkrdunk-api',
          };
        }
        debugTrail?.push(`[3]SNKRDUNK ${ep} 200 but no name field, keys: ${Object.keys(data || {}).slice(0, 5).join(',')}`);
      } else {
        debugTrail?.push(`[3]SNKRDUNK ${ep} status ${r.status}`);
      }
    } catch (e) { debugTrail?.push(`[3]SNKRDUNK ${ep} err ${e.message}`); }
  }

  // 4) data/history/{id}.json 폴백
  try {
    const r4 = await fetch(`${baseURL}/data/history/${cardId}.json`, { cf: { cacheTtl: 3600 } });
    if (r4.ok) {
      const data = await r4.json();
      if (data && (data.name || data.product_name)) {
        return {
          name: data.name || data.product_name,
          code: data.product_number || data.code,
          brand: data.brand, source: 'history',
        };
      }
      debugTrail?.push(`[4]history: 200 OK, no name field, keys: ${Object.keys(data || {}).slice(0, 5).join(',')}`);
    } else {
      debugTrail?.push(`[4]history: status ${r4.status}`);
    }
  } catch (e) { debugTrail?.push(`[4]history: err ${e.message}`); }

  return null;
}

export const onRequestPost = withAuth(async ({ request, env, user }) => {
  if (!env.DB) return serverError('D1 not bound');

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

  // D1 캐시 확인 → 없으면 대기열 등록 후 "조회 중"(pending) 반환.
  // 가정용 PC 워커가 PSA 페이지를 받아 캐시를 채우면, 재요청 시 캐시 적중 → 검증 진행.
  await ensureTables(env);
  const cert = await getCachedCert(env, cert_number);
  if (!cert) {
    await queueCert(env, cert_number, card_id);
    return jsonResponse({
      ok: false,
      status: 'pending',
      message: 'PSA 정보를 받아오는 중이에요. 잠시 후 자동으로 확인됩니다.',
    }, 202);
  }

  if (cert.notFound) {
    return jsonResponse({ ok: false, error: 'not_found', message: 'PSA 에 등록되지 않은 Cert# 입니다' }, 404);
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
  const debugTrail = [];
  const ourCard = await lookupOurCard(env, card_id, `${reqUrl.protocol}//${reqUrl.host}`, debugTrail);
  const match = verifyCardMatch(cert, ourCard);
  if (!match.ok) {
    // hard fail (DB lookup 실패) — 카드 메타 못 찾으면 매칭 불가능
    if (match.hard) {
      return jsonResponse({
        ok: false,
        error: 'lookup_failed',
        message: `⚠️ 카드 메타 정보를 확인할 수 없습니다 (card_id=${card_id}).\nPSA 정보: ${cert.Subject || '?'} (#${cert.CardNumber || ''}) Grade ${cert.CardGrade || ''}\n잠시 후 다시 시도하거나 관리자에게 문의해주세요.`,
        psa_card: {
          subject: cert.Subject,
          card_number: cert.CardNumber,
          brand: cert.Brand,
          year: cert.Year,
        },
        debug_trail: debugTrail, // 어디서 실패했는지 — 콘솔/네트워크 탭에서 확인 가능
      }, 503);
    }
    // 카드 불일치
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
  // PSA 진짜 POP 추출 — cert API 응답에 포함된 필드들
  // 응답 형식 추정: TotalPopulation, PopulationHigher (필드명 다양 가능)
  const psaTotalPop = parseInt(
    cert.TotalPopulation ?? cert.totalPopulation ??
    cert.Population ?? cert.population ?? cert.TotalPop ?? 0
  ) || null;
  const psaPopHigher = parseInt(
    cert.PopulationHigher ?? cert.populationHigher ??
    cert.PopHigher ?? cert.popHigher ?? 0
  );

  try {
    const result = await env.DB.prepare(
      `INSERT INTO psa_certs (cert_number, card_id, grade, user_id, holding_id,
                              spec_id, brand, year, subject, card_number, variety, category,
                              psa_total_pop, psa_pop_higher, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      psaTotalPop,
      psaPopHigher,
      JSON.stringify(cert),
    ).run();

    return jsonResponse({
      ok: true,
      id: result.meta?.last_row_id,
      message: psaTotalPop
        ? `✅ 인증 완료 — PSA POP ${psaTotalPop.toLocaleString()} 반영`
        : '✅ 인증 완료 — POP 정보는 PSA 응답에서 받지 못함',
      cert: {
        cert_number,
        grade: psaGradeNum,
        subject: cert.Subject,
        card_number: cert.CardNumber,
        psa_total_pop: psaTotalPop,
        psa_pop_higher: psaPopHigher,
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
