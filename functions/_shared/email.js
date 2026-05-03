/**
 * Resend 이메일 발송 헬퍼
 */

export async function sendEmail(env, { to, subject, html, text, from }) {
  if (!env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY env not set');
  }
  const fromAddr = from || 'TCG Hub <onboarding@resend.dev>';
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromAddr,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text,
    }),
  });
  const result = await r.json().catch(() => ({}));
  if (!r.ok) {
    throw new Error(`Resend API error ${r.status}: ${JSON.stringify(result)}`);
  }
  return result;
}

export function magicLinkEmail(loginUrl) {
  return {
    subject: 'TCG Hub 로그인 링크',
    text: `TCG Hub 로그인 링크입니다 (15분간 유효):\n\n${loginUrl}\n\n본인이 요청하지 않았다면 이 메일을 무시하세요.`,
    html: `
<!DOCTYPE html>
<html><body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #f9fafb; margin: 0; padding: 24px">
  <div style="max-width: 480px; margin: 0 auto; background: #fff; border: 1px solid #e5e7eb; border-radius: 14px; overflow: hidden">
    <div style="background: linear-gradient(135deg, #14b8a6, #0d9488); padding: 28px 24px; text-align: center; color: #fff">
      <div style="font-size: 22px; font-weight: 800; letter-spacing: -0.5px">🃏 TCG Hub</div>
      <div style="font-size: 13px; opacity: 0.9; margin-top: 4px">포켓몬 · 원피스 카드 시세 · 포트폴리오</div>
    </div>
    <div style="padding: 28px 24px">
      <h2 style="margin: 0 0 12px; color: #111; font-size: 18px">로그인 요청</h2>
      <p style="color: #4b5563; line-height: 1.65; margin: 0 0 20px">아래 버튼을 클릭하면 자동으로 로그인됩니다.</p>
      <p style="text-align: center; margin: 24px 0">
        <a href="${loginUrl}" style="display: inline-block; padding: 14px 32px; background: #111; color: #fff; text-decoration: none; border-radius: 10px; font-weight: 700; font-size: 15px">로그인하기 →</a>
      </p>
      <p style="color: #6b7280; font-size: 12px; line-height: 1.6; margin: 16px 0 0">
        이 링크는 <b>15분간</b> 유효하며, 한 번 사용되면 만료됩니다.
      </p>
      <p style="color: #6b7280; font-size: 12px; line-height: 1.6; margin: 8px 0 0">
        링크가 작동하지 않으면 아래 URL 을 복사해서 브라우저에 붙여넣어주세요:
      </p>
      <p style="font-size: 11px; color: #9ca3af; word-break: break-all; background: #f3f4f6; padding: 10px; border-radius: 6px; margin: 8px 0 0">
        ${loginUrl}
      </p>
    </div>
    <div style="background: #f9fafb; padding: 16px 24px; text-align: center; border-top: 1px solid #e5e7eb">
      <p style="color: #9ca3af; font-size: 11px; margin: 0; line-height: 1.6">
        본인이 요청하지 않았다면 이 메일을 무시하세요.<br>
        TCG Hub · tcghub.kr
      </p>
    </div>
  </div>
</body></html>`,
  };
}
