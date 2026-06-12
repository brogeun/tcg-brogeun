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

const BECKETT_LOOKUP = 'https://beckett.com/api/grading/lookup';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

/** 문자열 정규화 (대소문자 무시 + 영숫자만) */
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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
      if (c && c.name) return { name: c.name, code: c.code };
    }
  } catch {}
  // 1) all-cards.json
  try {
    const r = await fetch(`${baseURL}/data/all-cards.json`, { cf: { cacheTtl: 3600 } });
    if (r.ok) {
      const data = await r.json();
      const items = data.details || data.cards || [];
      const found = items.find(c => String(c.id) === String(cardId));
      if (found) return { name: found.name, code: found.productNumber || found.code };
    }
  } catch {}
  // 2) history 폴백
  try {
    const r = await fetch(`${baseURL}/data/history/${cardId}.json`, { cf: { cacheTtl: 3600 } });
    if (r.ok) {
      const data = await r.json();
      if (data && (data.name || data.product_name)) {
        return { name: data.name || data.product_name, code: data.product_number || data.code };
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
  // 1) card_key 매칭 — "OP07051" vs 우리 code "OP07-051" (영숫자 정규화 후 포함 비교)
  const bKey = norm(bgs.card_key);
  if (bKey) {
    const ourCode = norm(ourCard.code);
    const ourName = norm(ourCard.name);
    if (ourCode.includes(bKey) || bKey.includes(ourCode) || ourName.includes(bKey)) {
      return { ok: true };
    }
  }
  // 2) player_name 토큰 매칭 — 4글자 이상 단어 1개라도 우리 이름에 포함
  const words = String(bgs.player_name || '').split(/[\s.,/\\\-_()]+/)
    .filter(w => w.length >= 4).map(w => w.toLowerCase());
  const ourNameLower = String(ourCard.name || '').toLowerCase();
  if (words.length && words.some(w => ourNameLower.includes(w))) {
    return { ok: true };
  }
  return {
    ok: false,
    reason: `카드 불일치 (Beckett: ${bgs.player_name || '?'} [${bgs.card_key || '?'}] vs 보유: ${ourCard.name})`,
  };
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
    if (!r.ok) {
      return serverError(`Beckett 조회 실패 (${r.status}) — 잠시 후 다시 시도해주세요`);
    }
    bgs = await r.json();
  } catch (e) {
    return serverError(`Beckett 호출 실패: ${e.message || e}`);
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
    return jsonResponse({
      ok: false, error: 'card_mismatch',
      message: `❌ 이 Cert# 는 다른 카드입니다.\nBeckett 등록 카드: ${bgs.player_name || '?'} [${bgs.card_key || '?'}]\n(${bgs.set_name || ''})`,
    }, 422);
  }

  // POP 파싱 — 문자열로 옴 ("362", 0)
  const toInt = v => { const n = parseInt(v); return Number.isFinite(n) ? n : null; };
  const pop_total = toInt(bgs.pop_report ?? bgs.non_bccg_card_total);
  const pop_bl10 = toInt(bgs.fgB100);
  const pop_gl10 = toInt(bgs.fg100);
  const pop_95 = toInt(bgs.fg95);

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
      message: `✅ 인증 완료 — BGS POP 반영 (블랙라벨10: ${pop_bl10 ?? '?'} · 골드라벨10: ${pop_gl10 ?? '?'})`,
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
