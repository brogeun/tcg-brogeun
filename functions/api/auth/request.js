/**
 * POST /api/auth/request
 * Body: { email }
 * → magic link 생성 + Resend 로 메일 발송
 */
import { sendEmail, magicLinkEmail } from '../../_shared/email.js';
import { randomToken } from '../../_shared/jwt.js';
import { jsonResponse, badRequest, serverError } from '../../_shared/auth.js';

export async function onRequestPost({ request, env }) {
  if (!env.DB) return serverError('D1 database not bound (DB)');
  if (!env.RESEND_API_KEY) return serverError('RESEND_API_KEY not set');
  if (!env.APP_URL) return serverError('APP_URL not set');

  let body;
  try {
    body = await request.json();
  } catch {
    return badRequest('JSON body 가 필요합니다');
  }

  const email = (body?.email || '').trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return badRequest('올바른 이메일을 입력해주세요');
  }

  // 너무 잦은 요청 방지 — 같은 이메일로 1분 내 5회 초과 시 차단
  // expires_at = 생성시각 + 15분. 1분 내 생성된 토큰의 expires_at 는 14분 후보다 미래.
  const cutoff = Math.floor(Date.now() / 1000) + 14 * 60;
  const recent = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM magic_tokens WHERE email = ? AND expires_at > ?'
  ).bind(email, cutoff).first();
  if (recent && recent.n >= 5) {
    return jsonResponse({
      ok: false,
      error: 'rate_limit',
      message: '잠시 후 다시 시도해주세요 (1분당 최대 5회)',
    }, 429);
  }

  const token = randomToken(32);
  const expiresAt = Math.floor(Date.now() / 1000) + 15 * 60; // 15분

  try {
    await env.DB.prepare(
      'INSERT INTO magic_tokens (token, email, expires_at, used) VALUES (?, ?, ?, 0)'
    ).bind(token, email, expiresAt).run();
  } catch (e) {
    return serverError(`DB 저장 실패: ${e.message || e}`);
  }

  const loginUrl = `${env.APP_URL.replace(/\/$/, '')}/api/auth/verify?token=${token}`;
  const mail = magicLinkEmail(loginUrl);

  try {
    await sendEmail(env, { to: email, ...mail });
  } catch (e) {
    return serverError(`메일 발송 실패: ${e.message || e}`);
  }

  return jsonResponse({
    ok: true,
    message: '로그인 링크를 메일로 보냈습니다. 메일함을 확인해주세요 (스팸함 포함).',
  });
}
