/**
 * POST /api/bgs/cert
 * Body: { cert_number, card_id }
 *   ↳ Beckett 내부 lookup API 호출 → 카드 매칭 검증 → D1 저장
 *   ↳ 응답에 공식 POP (블랙라벨10 = fgB100, 골드라벨10 = fg100) 포함 → 카드 상세에 표시
 *
 * 주의: Beckett 은 공식 API 가 없어 card-lookup 페이지의 내부 엔드포인트를 사용.
 *       구조 변경 시 깨질 수 있으므로 성공 응답은 무조건 D1 캐싱 (기존 데이터 보존).
 */
import { withAuth, jsonResponse, badRequest, serverError } from '../../_shared/auth.js';
import { matchCard } from '../../_shared/certificates.js';

const BECKETT_LOOKUP = 'https://beckett.com/api/grading/lookup';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const lookupUnavailable = () => jsonResponse({
  ok: false, error: 'bgs_lookup_unavailable',
  message: 'Beckett 조회 서비스를 일시적으로 사용할 수 없습니다. 잠시 후 다시 시도해주세요.',
}, 503);

function populationOrNull(value) {
  if (typeof value === 'string') {
    const raw = value.trim();
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(raw)) return null;
    value = Number(raw.replaceAll(',', ''));
  }
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}


/** 우리 DB 카드 메타 조회 — psa/cert.js 와 동일한 폴백 체인 (간소판) */
async function lookupOurCard(env, cardId, origin) {
  const baseURL = origin || 'https://tcghub.kr';
  // 0) cards-meta-index.json
  try {
    const r0 = await fetch(`${baseURL}/data/cards-meta-index.json`, { cf: { cacheTtl: 3600 } });
    if (r0.ok) {
      const data = await r0.json();
      const c = data?.[cardId] || data?.[String(cardId)];
      if (c && c.name) return { name: c.name, code: c.code, brand: c.brand };
    }
  } catch {}
  // 1) all-cards.json
  try {
    const r = await fetch(`${baseURL}/data/all-cards.json`, { cf: { cacheTtl: 3600 } });
    if (r.ok) {
      const data = await r.json();
      const items = data.details || data.cards || [];
      const found = items.find(c => String(c.id) === String(cardId));
      if (found) return { name: found.name, code: found.productNumber || found.code, brand: found.brand };
    }
  } catch {}
  // 2) history 폴백
  try {
    const r = await fetch(`${baseURL}/data/history/${cardId}.json`, { cf: { cacheTtl: 3600 } });
    if (r.ok) {
      const data = await r.json();
      if (data && (data.name || data.product_name)) {
        return { name: data.name || data.product_name, code: data.product_number || data.code, brand: data.brand };
      }
    }
  } catch {}
  return null;
}

/** Beckett 카드 vs 우리 카드 매칭 검증 */
function verifyCardMatch(bgs, ourCard) {
  if (!ourCard || !ourCard.name) {
    return { ok: false, reason: 'DB 카드 정보 lookup 실패', hard: true };
  }
  // Printed number, complete subject and edition checks must all agree.
  // Missing codes or a shared name alone never establish a card's identity.
  return matchCard({
    subject: bgs.player_name,
    card_number: bgs.card_key,
    brand: bgs.set_name || '',
    year: String(bgs.year || ''),
    variety: bgs.variety || '',
    source_url: BECKETT_LOOKUP,
  }, ourCard);
}

export const onRequestPost = withAuth(async ({ request, env, user }) => {
  if (!env.DB) return serverError('D1 not bound');

  let body;
  try { body = await request.json(); } catch { return badRequest('JSON body 가 필요합니다'); }

  const cert_number = String(body.cert_number || '').replace(/\D/g, '');
  const card_id = String(body.card_id || '').trim();
  if (!cert_number || cert_number.length < 6) return badRequest('Cert# 가 잘못되었습니다 (숫자 6자리 이상)');
  if (!card_id || !/^\d+$/.test(card_id)) return badRequest('card_id 가 필요합니다');

  // 중복 체크
  const existing = await env.DB.prepare(
    'SELECT id, user_id FROM bgs_certs WHERE cert_number = ?'
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

  // Beckett lookup 호출
  let bgs;
  try {
    const r = await fetch(`${BECKETT_LOOKUP}?category=BGS&serialNumber=${cert_number}`, {
      headers: {
        'user-agent': UA,
        'accept': 'application/json',
        'referer': 'https://www.beckett.com/grading/card-lookup',
      },
    });
    // Redirects to maintenance/login pages can return 200 HTML, not cert data.
    const finalUrl = new URL(r.url);
    const contentType = r.headers.get('content-type') || '';
    if (!r.ok || finalUrl.protocol !== 'https:' || finalUrl.username || finalUrl.password
        || !['beckett.com', 'www.beckett.com'].includes(finalUrl.hostname)
        || finalUrl.pathname !== '/api/grading/lookup'
        || !/^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/i.test(contentType)) {
      return lookupUnavailable();
    }
    bgs = await r.json();
    if (!bgs || typeof bgs !== 'object' || Array.isArray(bgs)) return lookupUnavailable();
  } catch {
    return lookupUnavailable();
  }

  if (Object.hasOwn(bgs, 'item_id') && String(bgs.item_id) !== cert_number) {
    return jsonResponse({
      ok: false, error: 'cert_number_mismatch',
      message: 'Beckett 응답의 인증번호가 요청한 번호와 다릅니다. 등록하지 않았습니다.',
    }, 422);
  }

  // 유효성 — final_grade 가 없으면 미등록 cert
  if (!bgs || !bgs.final_grade || bgs.final_grade === '0.0') {
    return jsonResponse({
      ok: false, error: 'not_found',
      message: 'Beckett 에 등록되지 않은 Cert# 이거나 BGS 슬랩이 아닙니다',
    }, 404);
  }

  // 카드 매칭 검증
  const reqUrl = new URL(request.url);
  const ourCard = await lookupOurCard(env, card_id, `${reqUrl.protocol}//${reqUrl.host}`);
  const match = verifyCardMatch(bgs, ourCard);
  if (!match.ok) {
    if (match.hard) {
      return jsonResponse({
        ok: false, error: 'lookup_failed',
        message: `⚠️ 카드 메타 정보를 확인할 수 없습니다 (card_id=${card_id}). 잠시 후 다시 시도해주세요.`,
      }, 503);
    }
    if (match.reason === 'card_metadata_incomplete') {
      return jsonResponse({
        ok: false, error: 'card_metadata_incomplete',
        message: '카드 번호 등 인증에 필요한 정보가 부족합니다. 잠시 후 다시 시도해주세요.',
      }, 503);
    }
    return jsonResponse({
      ok: false, error: 'card_mismatch',
      message: `❌ 이 Cert# 는 다른 카드입니다.\nBeckett 등록 카드: ${bgs.player_name || '?'} [${bgs.card_key || '?'}]\n(${bgs.set_name || ''})`,
    }, 422);
  }

  // POP must be a complete non-negative safe integer; unknown values stay null.
  const pop_total = populationOrNull(bgs.pop_report ?? bgs.non_bccg_card_total);
  const pop_bl10 = populationOrNull(bgs.fgB100);
  const pop_gl10 = populationOrNull(bgs.fg100);
  const pop_95 = populationOrNull(bgs.fg95);
  const population_verified = [pop_total, pop_bl10, pop_gl10, pop_95].every(v => v !== null);

  try {
    const result = await env.DB.prepare(
      `INSERT INTO bgs_certs (cert_number, card_id, user_id, final_grade, label,
                              card_key, player_name, set_name,
                              pop_total, pop_bl10, pop_gl10, pop_95, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      cert_number, card_id, user.id,
      bgs.final_grade || null, bgs.label || null,
      bgs.card_key || null, bgs.player_name || null, bgs.set_name || null,
      pop_total, pop_bl10, pop_gl10, pop_95,
      JSON.stringify(bgs),
    ).run();

    return jsonResponse({
      ok: true,
      id: result.meta?.last_row_id,
      population_verified,
      message: population_verified
        ? `✅ 인증 완료 — BGS POP 반영 (블랙라벨10: ${pop_bl10} · 골드라벨10: ${pop_gl10})`
        : '카드 정보가 일치하여 등록했습니다. POP 정보는 일부 확인되지 않았습니다.',
      cert: {
        cert_number,
        final_grade: bgs.final_grade,
        label: bgs.label,
        player_name: bgs.player_name,
        card_key: bgs.card_key,
        pop: { total: pop_total, bl10: pop_bl10, gl10: pop_gl10, g95: pop_95 },
      },
    });
  } catch (e) {
    return serverError(`DB 저장 실패: ${e.message || e}`);
  }
});
