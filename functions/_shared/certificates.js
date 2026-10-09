/** Free, operator-PC certificate lookup pipeline. No paid API and no CAPTCHA bypass.
 * All timestamps in this pipeline are milliseconds. Existing cert registered_at stays seconds.
 * Fetching cert data and claiming ownership of a physical slab are different operations.
 */
import { jsonResponse } from './auth.js';

export const ACTIVE_REQUEST_STATES = ['pending', 'processing', 'retry_wait'];
export const LEASE_MS = 120000;
// Successful lookup freshness only; this does not restrict submission frequency.
const CACHE_MS = 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const text = (value, max = 250) => String(value ?? '').trim().slice(0, max);
const numberOrNull = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replaceAll(',', ''));
  return Number.isSafeInteger(n) && n >= 0 ? n : null;
};
export const normalizeText = value => text(value, 2000).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
export function normalizeCert(value) {
  const s = String(value ?? '').trim().replace(/[ -]/g, '');
  // Preserve leading zeros. Never silently strip letters from an invalid input.
  return /^\d{6,12}$/.test(s) ? s : null;
}
export function parseGrade(value) {
  const raw = text(value);
  if (!raw || /\bauth(?:entic)?\b|altered|trimmed|qualifier|\((?:OC|ST|PD|OF|MK|MC)\)/i.test(raw)) return null;
  const numbers = raw.match(/\d+(?:\.\d+)?/g);
  if (!numbers || numbers.length !== 1) return null;
  const n = Number(numbers[0]);
  return Number.isFinite(n) && n >= 1 && n <= 10 && Number.isInteger(n * 2) ? n : null;
}
function isPsaApiCertSource(sourceUrl, certNumber) {
  // Require the adapter's exact cert URL, without credentials, ports or URL rewrites.
  return typeof certNumber === 'string' && /^\d{6,12}$/.test(certNumber)
    && sourceUrl === `https://api.psacard.com/publicapi/cert/GetByCertNumber/${certNumber}`;
}
export function normalizeRecord(record, provider, expectedCert) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('incomplete_record');
  const observed = normalizeCert(record.cert_number);
  if (!observed || observed !== expectedCert) throw new Error('cert_number_mismatch');
  const gradeText = text(record.grade_text);
  const grade = parseGrade(gradeText);
  if (grade === null) throw new Error('unsupported_grade');
  const subject = text(record.subject);
  const brand = text(record.brand);
  const cardNumber = text(record.card_number, 80);
  if (!subject || (!brand && !cardNumber)) throw new Error('incomplete_record');
  let source;
  try { source = new URL(record.source_url); } catch { throw new Error('invalid_source'); }
  const allowed = provider === 'psa' ? ['www.psacard.com', 'psacard.com'] : ['www.beckett.com', 'beckett.com'];
  const psaApiSource = provider === 'psa' && isPsaApiCertSource(record.source_url, expectedCert);
  if (source.protocol !== 'https:' || (!allowed.includes(source.hostname) && !psaApiSource) || source.username || source.password) throw new Error('invalid_source');
  if (provider === 'psa' && !psaApiSource && !source.pathname.startsWith('/cert')) throw new Error('invalid_source');
  if (provider === 'bgs' && !source.pathname.startsWith('/api/grading/lookup') && !source.pathname.startsWith('/grading/card-lookup')) throw new Error('invalid_source');
  const subgrades = {};
  for (const key of ['centering', 'corners', 'edges', 'surface', 'autograph']) {
    const v = record.subgrades?.[key];
    if (v !== null && v !== undefined && v !== '') subgrades[key] = parseGrade(v);
  }
  const label = text(record.label, 80).toLowerCase();
  if (provider === 'bgs' && grade === 10 && !['black', 'gold'].includes(label)) throw new Error('unknown_label');
  if (provider === 'bgs' && label === 'black' && (grade !== 10 || ['centering','corners','edges','surface'].some(k => subgrades[k] != null && subgrades[k] !== 10))) throw new Error('inconsistent_label');
  return {
    cert_number: observed, grade, grade_text: gradeText, subject, brand,
    year: text(record.year, 20), card_number: cardNumber, variety: text(record.variety),
    label, subgrades, pop_total: numberOrNull(record.pop_total),
    pop_higher: numberOrNull(record.pop_higher),
    pop_bl10: numberOrNull(record.pop_bl10), pop_gl10: numberOrNull(record.pop_gl10),
    pop_95: numberOrNull(record.pop_95), source_url: source.href,
  };
}

function numericToken(value) {
  const token = String(value).toLowerCase();
  // Set-prefixed numbers keep their printed zeroes: OP07-051 and OP07051 agree.
  return (/[a-z]/.test(token) ? token : token.replace(/\b0+(?=\d)/g, '')).replace(/[^a-z0-9]/g, '');
}
export function matchCard(record, card) {
  if (!card?.name || !record.subject || !record.card_number) return { ok: false, reason: 'card_metadata_incomplete' };
  const code = String(card.code || card.product_number || '');
  // Internal catalogue slugs (pkmn-tcg-123) are NOT printed card numbers.
  const printableCode = /^(?:pkmn|pokemon|onepiece)-/i.test(code) ? '' : code;
  const brackets = [...String(card.name).matchAll(/\[([^\]]+)\]/g)].map(m => m[1]).join(' ');
  const candidates = `${printableCode} ${brackets}`.match(/[A-Za-z]{1,6}\d{1,4}[-/]\d{1,4}|\b\d{1,4}(?:\/\d{1,4})?\b/g) || [];
  const target = numericToken(record.card_number);
  const numberMatch = candidates.some(c => numericToken(c) === target || (/^\d/.test(c) && numericToken(c.split('/')[0]) === target));
  if (!target || !numberMatch) return { ok: false, reason: 'card_number_mismatch' };
  const local = normalizeText(card.name);
  // PSA's Pokémon FA/ label is a naming prefix; preserve the remaining name.
  const psaPokemon = (/^https:\/\/(?:www\.)?psacard\.com\/cert(?:\/|$)/i.test(String(record.source_url || ''))
      || isPsaApiCertSource(record.source_url, record.cert_number))
    && /\bpokemon\b/i.test(String(record.brand || '')) && card.brand === 'pokemon';
  const subject = normalizeText(psaPokemon ? String(record.subject).replace(/^FA\//i, '') : record.subject);
  if (subject.length < 3 || !local.includes(subject)) return { ok: false, reason: 'card_subject_mismatch' };
  // Strong edition markers must not disappear into a generic name match.
  const variants = [
    ['masterball', /master\s*ball|マスターボール|마스터볼/i],
    ['reverse', /reverse|리버스/i],
    ['firstedition', /1st\s*edition|first\s*edition|초판/i],
    ['shadowless', /shadowless/i],
    ['blackrefractor', /black\s*refractor/i],
    ['goldrefractor', /gold\s*refractor/i],
  ];
  for (const [, re] of variants) {
    if (re.test(`${record.brand} ${record.variety}`) !== re.test(card.name)) return { ok: false, reason: 'card_variant_mismatch' };
  }
  // Contradictory explicit languages and release years are never ignored.
  const languages = [/japanese|日本語|일본어/i, /korean|한국어/i, /english|영어/i];
  const sourceLang = languages.findIndex(re => re.test(`${record.brand} ${record.variety}`));
  const localLang = languages.findIndex(re => re.test(card.name));
  if (sourceLang >= 0 && localLang >= 0 && sourceLang !== localLang) return { ok: false, reason: 'card_language_mismatch' };
  const localYear = String(card.name).match(/\b(?:19|20)\d{2}\b/)?.[0];
  if (localYear && /^\d{4}$/.test(record.year) && localYear !== record.year) return { ok: false, reason: 'card_year_mismatch' };
  return { ok: true, reason: 'number_subject_and_variant_checks' };
}

const readyDatabases = new WeakSet();
export async function ensureCertificateTables(env) {
  if (readyDatabases.has(env.DB)) return;
  // Deliberately versioned tables: no destructive replacement of old queue/cache data.
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS psa_certs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,cert_number TEXT NOT NULL UNIQUE,card_id TEXT NOT NULL,
      grade INTEGER NOT NULL,user_id INTEGER NOT NULL,holding_id INTEGER,spec_id TEXT,brand TEXT,year TEXT,
      subject TEXT,card_number TEXT,variety TEXT,category TEXT,registered_at INTEGER NOT NULL DEFAULT (unixepoch()),
      raw_payload TEXT,psa_total_pop INTEGER,psa_pop_higher INTEGER)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS bgs_certs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,cert_number TEXT NOT NULL UNIQUE,card_id TEXT NOT NULL,user_id INTEGER NOT NULL,
      final_grade TEXT,label TEXT,card_key TEXT,player_name TEXT,set_name TEXT,pop_total INTEGER,pop_bl10 INTEGER,
      pop_gl10 INTEGER,pop_95 INTEGER,registered_at INTEGER NOT NULL DEFAULT (unixepoch()),raw_payload TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cert_lookup_jobs (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, cert_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at INTEGER NOT NULL, lease_token TEXT, lease_until INTEGER,
      last_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(provider, cert_number))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_cert_jobs_ready ON cert_lookup_jobs(status,next_attempt_at,lease_until)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cert_lookup_cache (
      provider TEXT NOT NULL, cert_number TEXT NOT NULL, data TEXT NOT NULL, fetched_at INTEGER NOT NULL,
      PRIMARY KEY(provider,cert_number))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cert_registration_requests (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, provider TEXT NOT NULL, cert_number TEXT NOT NULL,
      card_id TEXT NOT NULL, holding_id INTEGER, card_meta TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', error TEXT, message TEXT,
      certificate_id INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      UNIQUE(user_id,provider,cert_number))`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_cert_requests_user ON cert_registration_requests(user_id,status)'),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS idx_cert_requests_number ON cert_registration_requests(provider,cert_number,status)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS cert_worker_state (
      name TEXT PRIMARY KEY, last_seen_at INTEGER, paused_until INTEGER NOT NULL DEFAULT 0, last_error TEXT)`),
  ]);
  const columns = await env.DB.prepare('PRAGMA table_info(psa_certs)').all();
  for (const column of ['psa_total_pop','psa_pop_higher']) {
    if (!(columns.results || []).some(c => c.name === column)) {
      try { await env.DB.prepare(`ALTER TABLE psa_certs ADD COLUMN ${column} INTEGER`).run(); }
      catch (error) {
        // A second cold isolate may have applied the same additive migration.
        const current = await env.DB.prepare('PRAGMA table_info(psa_certs)').all();
        if (!(current.results || []).some(c => c.name === column)) throw error;
      }
    }
  }
  readyDatabases.add(env.DB);
}

const MESSAGES = {
  pending: '접수되었습니다. PC 조회 프로그램이 순서대로 확인합니다. 화면을 닫아도 요청은 유지됩니다.',
  processing: '공식 등록 정보를 확인하고 있습니다.',
  retry_wait: '조회가 지연되고 있습니다. 요청은 저장되어 있으며 나중에 다시 확인합니다.',
  registered: '공식 등록 정보와 등급을 확인해 등록했습니다. 실물 진품 보증은 아닙니다.',
  not_found: '공식 조회에서 이 인증번호의 기록을 찾지 못했습니다. 가품 판정은 아닙니다.',
  needs_review: '자동 확인을 완료하지 못했습니다. 요청은 저장되어 있습니다. 관리자 확인이 필요합니다.',
  rejected: '현재 보유 카드에 이 인증번호를 연결할 수 없습니다.',
};
async function setRequestState(env, id, status, error = null, message = null) {
  await env.DB.prepare('UPDATE cert_registration_requests SET status=?, error=?, message=?, updated_at=? WHERE id=?')
    .bind(status, error, message || MESSAGES[status], Date.now(), id).run();
}
export function requestView(row, job = null) {
  let status = row.status;
  if (ACTIVE_REQUEST_STATES.includes(status) && job && ['pending','processing','retry_wait'].includes(job.status)) status = job.status;
  return {
    ok: status === 'registered', status, request_id: row.id, id: row.certificate_id || undefined,
    provider: row.provider, cert_number: row.cert_number, card_id: row.card_id, holding_id: row.holding_id,
    error: row.error || undefined, message: ACTIVE_REQUEST_STATES.includes(status) ? MESSAGES[status] : (row.message || MESSAGES[status]),
    retry_after_seconds: ACTIVE_REQUEST_STATES.includes(status) ? 10 : undefined,
    updated_at: row.updated_at,
  };
}
export async function lookupCardMeta(env, cardId, origin) {
  const target = new URL('/data/cards-meta-index.json', origin);
  const response = env.ASSETS ? await env.ASSETS.fetch(new Request(target)) : await fetch(target, { cf: { cacheTtl: 3600 } });
  if (!response.ok) return null;
  const map = await response.json();
  const card = map?.[cardId];
  if (!card?.name) return null;
  return { name: text(card.name, 1000), code: text(card.code, 100), brand: text(card.brand, 100) };
}
function certTable(provider) { return provider === 'psa' ? 'psa_certs' : 'bgs_certs'; }
export async function getRequest(env, id, userId) {
  const row = await env.DB.prepare('SELECT * FROM cert_registration_requests WHERE id=? AND user_id=?').bind(id, userId).first();
  if (!row) return null;
  const job = await env.DB.prepare('SELECT status,next_attempt_at FROM cert_lookup_jobs WHERE provider=? AND cert_number=?').bind(row.provider, row.cert_number).first();
  return requestView(row, job);
}

export async function submitCertificate({ request, env, user }, provider) {
  if (!env.DB) return jsonResponse({ ok: false, error: 'database_unavailable', message: '저장소를 사용할 수 없습니다.' }, 503);
  let body;
  try { body = await request.json(); } catch { return jsonResponse({ ok: false, error: 'bad_request', message: '올바른 요청이 필요합니다.' }, 400); }
  const certNumber = normalizeCert(body.cert_number);
  const cardId = String(body.card_id || '').trim();
  const holdingId = body.holding_id == null ? null : Number(body.holding_id);
  if (!certNumber || !/^\d+$/.test(cardId) || (holdingId !== null && (!Number.isSafeInteger(holdingId) || holdingId <= 0))) {
    return jsonResponse({ ok: false, error: 'bad_request', message: '카드와 인증번호를 확인해주세요. 인증번호는 숫자 6~12자리입니다.' }, 400);
  }
  await ensureCertificateTables(env);
  if (provider === 'psa' && holdingId !== null) {
    const holding = await env.DB.prepare('SELECT id,card_id,grade,qty FROM holdings WHERE id=? AND user_id=?').bind(holdingId, user.id).first();
    if (!holding || String(holding.card_id) !== cardId || !['psa9','psa10'].includes(holding.grade)) {
      return jsonResponse({ ok: false, error: 'holding_mismatch', message: '본인의 PSA 보유 카드만 연결할 수 있습니다.' }, 403);
    }
  }
  // Existing completed registration is idempotent only for this exact user/card/holding.
  const existing = await env.DB.prepare(`SELECT * FROM ${certTable(provider)} WHERE cert_number=?`).bind(certNumber).first();
  if (existing) {
    const same = String(existing.user_id) === String(user.id) && String(existing.card_id) === cardId && (provider !== 'psa' || String(existing.holding_id ?? '') === String(holdingId ?? ''));
    return jsonResponse(same ? { ok: true, status: 'registered', id: existing.id, cert: existing, message: MESSAGES.registered } :
      { ok: false, status: 'rejected', error: 'already_registered', message: '이미 다른 보유 항목에 등록된 인증번호입니다.' }, same ? 200 : 409);
  }
  const prior = await env.DB.prepare('SELECT * FROM cert_registration_requests WHERE user_id=? AND provider=? AND cert_number=?').bind(user.id, provider, certNumber).first();
  if (prior) {
    if (prior.card_id !== cardId || String(prior.holding_id ?? '') !== String(holdingId ?? '')) return jsonResponse({ ok: false, error: 'request_conflict', message: '같은 인증번호의 기존 요청을 먼저 확인해주세요.' }, 409);
    const view = await getRequest(env, prior.id, user.id);
    return jsonResponse(view, ACTIVE_REQUEST_STATES.includes(view.status) ? 202 : 200);
  }
  const now = Date.now();
  // PSA and BGS submissions have no per-user, per-minute, or per-cert count quota.
  // Duplicate lookups still share one job; ownership checks and source backoff remain.
  let meta;
  try { meta = await lookupCardMeta(env, cardId, new URL(request.url).origin); } catch { meta = null; }
  if (!meta) return jsonResponse({ ok: false, error: 'lookup_failed', message: '카드 정보를 읽을 수 없습니다. 아직 조회 요청을 생성하지 않았습니다.' }, 503);
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT OR IGNORE INTO cert_registration_requests
    (id,user_id,provider,cert_number,card_id,holding_id,card_meta,status,message,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`).bind(id,user.id,provider,certNumber,cardId,holdingId,JSON.stringify(meta),MESSAGES.pending,now,now).run();
  const row = await env.DB.prepare('SELECT * FROM cert_registration_requests WHERE user_id=? AND provider=? AND cert_number=?').bind(user.id,provider,certNumber).first();
  if (row.card_id !== cardId || String(row.holding_id ?? '') !== String(holdingId ?? '')) return jsonResponse({ok:false,error:'request_conflict',message:'동시에 다른 보유 항목으로 접수된 요청이 있습니다.'},409);
  const cache = await env.DB.prepare('SELECT * FROM cert_lookup_cache WHERE provider=? AND cert_number=? AND fetched_at>?').bind(provider,certNumber,now-CACHE_MS).first();
  if (cache) {
    try { await finalizeRequest(env, row, normalizeRecord(JSON.parse(cache.data), provider, certNumber)); }
    catch { await setRequestState(env, row.id, 'needs_review', 'registration_error'); }
  } else {
    await env.DB.prepare(`INSERT INTO cert_lookup_jobs (id,provider,cert_number,status,attempts,next_attempt_at,created_at,updated_at)
      VALUES (?,?,?,'pending',0,?,?,?) ON CONFLICT(provider,cert_number) DO UPDATE SET
      status=CASE WHEN cert_lookup_jobs.status IN ('complete','not_found') THEN 'pending' ELSE cert_lookup_jobs.status END,
      attempts=CASE WHEN cert_lookup_jobs.status IN ('complete','not_found') THEN 0 ELSE cert_lookup_jobs.attempts END,
      next_attempt_at=CASE WHEN cert_lookup_jobs.status IN ('complete','not_found') THEN excluded.next_attempt_at ELSE cert_lookup_jobs.next_attempt_at END,
      updated_at=excluded.updated_at`).bind(crypto.randomUUID(),provider,certNumber,now,now,now).run();
    const job = await env.DB.prepare('SELECT status,last_error FROM cert_lookup_jobs WHERE provider=? AND cert_number=?').bind(provider,certNumber).first();
    if (job?.status === 'needs_review') await setRequestState(env, row.id, 'needs_review', job.last_error);
  }
  const view = await getRequest(env,row.id,user.id);
  return jsonResponse(view, ACTIVE_REQUEST_STATES.includes(view.status) ? 202 : 200);
}

async function finalizeRequest(env, row, record) {
  const table = certTable(row.provider);
  const existing = await env.DB.prepare(`SELECT * FROM ${table} WHERE cert_number=?`).bind(row.cert_number).first();
  if (existing) {
    const same = String(existing.user_id) === String(row.user_id) && String(existing.card_id) === row.card_id && (row.provider !== 'psa' || String(existing.holding_id ?? '') === String(row.holding_id ?? ''));
    if (!same) { await setRequestState(env,row.id,'rejected','already_registered','이미 다른 보유 항목에 등록된 인증번호입니다.'); return; }
    await env.DB.prepare("UPDATE cert_registration_requests SET status='registered',certificate_id=?,error=NULL,message=?,updated_at=? WHERE id=?")
      .bind(existing.id,MESSAGES.registered,Date.now(),row.id).run();
    return;
  }
  const match = matchCard(record, JSON.parse(row.card_meta));
  if (!match.ok) { await setRequestState(env,row.id,'needs_review',match.reason,'공식 기록은 조회했지만 선택한 카드와의 일치를 확정하지 못했습니다. 관리자 확인이 필요합니다.'); return; }
  if (row.provider === 'psa' && ![9,10].includes(record.grade)) {
    await setRequestState(env,row.id,'needs_review','unsupported_grade',`공식 등급은 ${record.grade_text}입니다. 현재 보유 카드 등록은 PSA 9와 10만 지원합니다.`); return;
  }
  let holding = null;
  if (row.provider === 'psa' && row.holding_id != null) {
    holding = await env.DB.prepare('SELECT * FROM holdings WHERE id=? AND user_id=?').bind(row.holding_id,row.user_id).first();
    if (!holding || String(holding.card_id) !== row.card_id || !['psa9','psa10'].includes(holding.grade)) {
      await setRequestState(env,row.id,'rejected','holding_changed','조회 중 보유 카드가 변경되거나 삭제되어 연결하지 않았습니다.'); return;
    }
    if (Number(holding.qty) !== 1 && holding.grade !== `psa${record.grade}`) {
      await setRequestState(env,row.id,'needs_review','multiple_holding_grade','여러 장이 묶인 보유 항목은 자동 등급 변경이 불가능합니다. 항목 분리 후 관리자 확인이 필요합니다.'); return;
    }
  }
  const statements = [];
  if (row.provider === 'psa') {
    // Conditional INSERT and all following mutations are one D1 transaction.
    const condition = holding ? "EXISTS (SELECT 1 FROM holdings WHERE id=? AND user_id=? AND card_id=? AND grade=? AND qty=?)" : '1=1';
    const binds = [row.cert_number,row.card_id,record.grade,row.user_id,row.holding_id,record.brand,record.year,record.subject,record.card_number,record.variety,record.pop_total,record.pop_higher,JSON.stringify(record)];
    if (holding) binds.push(holding.id,row.user_id,row.card_id,holding.grade,holding.qty);
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO psa_certs
      (cert_number,card_id,grade,user_id,holding_id,brand,year,subject,card_number,variety,psa_total_pop,psa_pop_higher,raw_payload)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ${condition}`).bind(...binds));
    if (holding && Number(holding.qty) === 1) statements.push(env.DB.prepare(`UPDATE holdings SET grade=? WHERE id=? AND user_id=? AND card_id=? AND grade=? AND qty=1
      AND EXISTS (SELECT 1 FROM psa_certs WHERE cert_number=? AND user_id=? AND holding_id=? AND card_id=?)`)
      .bind(`psa${record.grade}`,holding.id,row.user_id,row.card_id,holding.grade,row.cert_number,row.user_id,holding.id,row.card_id));
  } else {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO bgs_certs
      (cert_number,card_id,user_id,final_grade,label,card_key,player_name,set_name,pop_total,pop_bl10,pop_gl10,pop_95,raw_payload)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(row.cert_number,row.card_id,row.user_id,record.grade_text,record.label,record.card_number,record.subject,record.brand,record.pop_total,record.pop_bl10,record.pop_gl10,record.pop_95,JSON.stringify(record)));
  }
  statements.push(env.DB.prepare(`UPDATE cert_registration_requests SET status='registered',error=NULL,message=?,updated_at=?,
    certificate_id=(SELECT id FROM ${table} WHERE cert_number=? AND user_id=? AND card_id=?)
    WHERE id=? AND EXISTS (SELECT 1 FROM ${table} WHERE cert_number=? AND user_id=? AND card_id=?${row.provider === 'psa' ? ' AND holding_id IS ?' : ''})`)
    .bind(MESSAGES.registered,Date.now(),row.cert_number,row.user_id,row.card_id,row.id,row.cert_number,row.user_id,row.card_id,...(row.provider==='psa'?[row.holding_id]:[])));
  await env.DB.batch(statements);
  const after = await env.DB.prepare('SELECT status FROM cert_registration_requests WHERE id=?').bind(row.id).first();
  if (after?.status !== 'registered') await setRequestState(env,row.id,'needs_review','registration_conflict');
}

export function isWorker(request, env) {
  const key = request.headers.get('x-psa-worker-key');
  return !!env.PSA_WORKER_KEY && !!key && key === env.PSA_WORKER_KEY;
}
export async function claimJob(env, now = Date.now()) {
  await ensureCertificateTables(env);
  // Finish durable cached results even if the previous worker/server died before finalization.
  const recovery = await env.DB.prepare(`SELECT DISTINCT j.id,j.provider,j.cert_number,c.data
    FROM cert_lookup_jobs j JOIN cert_lookup_cache c ON c.provider=j.provider AND c.cert_number=j.cert_number
    WHERE j.status='complete' AND EXISTS (SELECT 1 FROM cert_registration_requests r WHERE r.provider=j.provider
      AND r.cert_number=j.cert_number AND r.status IN ('pending','processing','retry_wait')) LIMIT 3`).all();
  for (const job of recovery.results || []) {
    try { await finalizeWaiting(env,job,normalizeRecord(JSON.parse(job.data),job.provider,job.cert_number)); } catch { /* keep the durable request for operator diagnosis */ }
  }
  await env.DB.prepare(`INSERT INTO cert_worker_state(name,last_seen_at) VALUES ('worker',?)
    ON CONFLICT(name) DO UPDATE SET last_seen_at=excluded.last_seen_at`).bind(now).run();
  // Worker death expires its lease. Expired leases also count toward the retry budget.
  await env.DB.prepare(`UPDATE cert_lookup_jobs SET status='needs_review',last_error='worker_interrupted',lease_token=NULL,lease_until=NULL,updated_at=?
    WHERE status='processing' AND lease_until<=? AND attempts>=?`).bind(now,now,MAX_ATTEMPTS).run();
  await env.DB.prepare(`UPDATE cert_registration_requests SET status='needs_review',error='worker_interrupted',message=?,updated_at=?
    WHERE status IN ('pending','processing','retry_wait') AND EXISTS (SELECT 1 FROM cert_lookup_jobs j WHERE j.provider=cert_registration_requests.provider
      AND j.cert_number=cert_registration_requests.cert_number AND j.status='needs_review')`).bind(MESSAGES.needs_review,now).run();
  const token = crypto.randomUUID();
  // Atomic claim: concurrent workers cannot own the same lease.
  return env.DB.prepare(`UPDATE cert_lookup_jobs SET status='processing',attempts=attempts+1,lease_token=?,lease_until=?,updated_at=?
    WHERE id=(SELECT j.id FROM cert_lookup_jobs j WHERE
      ((j.status IN ('pending','retry_wait') AND j.next_attempt_at<=?) OR (j.status='processing' AND j.lease_until<=?))
      AND j.attempts<? AND NOT EXISTS (SELECT 1 FROM cert_worker_state s WHERE s.name=j.provider AND s.paused_until>?)
      ORDER BY j.next_attempt_at,j.created_at LIMIT 1)
    RETURNING id,provider,cert_number,lease_token,attempts`).bind(token,now+LEASE_MS,now,now,now,MAX_ATTEMPTS,now).first();
}

export async function completeJob(env, body, now = Date.now()) {
  await ensureCertificateTables(env);
  if (!body || !['psa','bgs'].includes(body.provider) || !body.job_id || !body.lease_token) return { status: 400, data: { ok:false,error:'invalid_job' } };
  const job = await env.DB.prepare('SELECT * FROM cert_lookup_jobs WHERE id=?').bind(String(body.job_id)).first();
  if (!job || job.provider !== body.provider || job.cert_number !== body.cert_number) return { status:409,data:{ok:false,error:'job_mismatch'} };
  if (job.status === 'complete' && job.lease_token === body.lease_token) {
    // Recover registration completion after a crash between caching and finalization.
    const saved = await env.DB.prepare('SELECT data FROM cert_lookup_cache WHERE provider=? AND cert_number=?').bind(job.provider,job.cert_number).first();
    if (saved) await finalizeWaiting(env,job,JSON.parse(saved.data));
    return {status:200,data:{ok:true,already_completed:true}};
  }
  if (job.status !== 'processing' || job.lease_token !== body.lease_token || Number(job.lease_until) < now) return {status:409,data:{ok:false,error:'stale_lease'}};
  const outcome = body.outcome;
  if (!['success','not_found','temporary_error','blocked','parse_error'].includes(outcome)) return {status:400,data:{ok:false,error:'invalid_outcome'}};
  if (outcome === 'success') {
    let record;
    try { record = normalizeRecord(body.record,job.provider,job.cert_number); }
    catch (error) {
      return completeJob(env,{...body,outcome:'parse_error',record:undefined,error_code:error.message},now);
    }
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO cert_lookup_cache(provider,cert_number,data,fetched_at) VALUES (?,?,?,?)
        ON CONFLICT(provider,cert_number) DO UPDATE SET data=excluded.data,fetched_at=excluded.fetched_at`).bind(job.provider,job.cert_number,JSON.stringify(record),now),
      env.DB.prepare("UPDATE cert_lookup_jobs SET status='complete',last_error=NULL,lease_until=NULL,updated_at=? WHERE id=? AND lease_token=?").bind(now,job.id,body.lease_token),
    ]);
    await finalizeWaiting(env,job,record);
    return {status:200,data:{ok:true,status:'complete'}};
  }
  const errorCode = text(body.error_code,80).replace(/[^a-zA-Z0-9_:-]/g,'') || outcome;
  if (outcome === 'not_found') {
    // Do not populate a permanent negative cache.
    await env.DB.batch([
      env.DB.prepare("UPDATE cert_lookup_jobs SET status='not_found',last_error=?,lease_until=NULL,updated_at=? WHERE id=?").bind(errorCode,now,job.id),
      env.DB.prepare("UPDATE cert_registration_requests SET status='not_found',error='not_found',message=?,updated_at=? WHERE provider=? AND cert_number=? AND status IN ('pending','processing','retry_wait')").bind(MESSAGES.not_found,now,job.provider,job.cert_number),
    ]);
    return {status:200,data:{ok:true,status:'not_found'}};
  }
  const exhausted = job.attempts >= MAX_ATTEMPTS || outcome === 'parse_error';
  const status = exhausted ? 'needs_review' : 'retry_wait';
  const requestedDelay = Number(body.retry_after_seconds);
  const delay = Math.max(outcome==='blocked'?1800000:Math.min(7200000,300000*(2**Math.max(0,job.attempts-1))),
    Number.isFinite(requestedDelay) && requestedDelay>0 ? requestedDelay*1000 : 0);
  const statements = [
    env.DB.prepare('UPDATE cert_lookup_jobs SET status=?,last_error=?,next_attempt_at=?,lease_until=NULL,updated_at=? WHERE id=?').bind(status,errorCode,now+delay,now,job.id),
    env.DB.prepare("UPDATE cert_registration_requests SET status=?,error=?,message=?,updated_at=? WHERE provider=? AND cert_number=? AND status IN ('pending','processing','retry_wait')").bind(status,errorCode,MESSAGES[status],now,job.provider,job.cert_number),
  ];
  if (outcome==='blocked') statements.push(env.DB.prepare(`INSERT INTO cert_worker_state(name,paused_until,last_error) VALUES (?,?,?)
    ON CONFLICT(name) DO UPDATE SET paused_until=MAX(paused_until,excluded.paused_until),last_error=excluded.last_error`).bind(job.provider,now+delay,errorCode));
  await env.DB.batch(statements);
  return {status:200,data:{ok:true,status,retry_after_seconds:Math.ceil(delay/1000)}};
}
async function finalizeWaiting(env,job,record) {
  const requests = await env.DB.prepare("SELECT * FROM cert_registration_requests WHERE provider=? AND cert_number=? AND status IN ('pending','processing','retry_wait') ORDER BY created_at,id").bind(job.provider,job.cert_number).all();
  for (const row of requests.results || []) {
    try { await finalizeRequest(env,row,record); }
    catch { await setRequestState(env,row.id,'needs_review','registration_error','조회는 완료했지만 저장을 마치지 못했습니다. 관리자 확인이 필요합니다.'); }
  }
}
