import { withAuth, jsonResponse } from '../../_shared/auth.js';
import { submitCertificate, ensureCertificateTables } from '../../_shared/certificates.js';
export const onRequestPost = withAuth(async context => {
  try { return await submitCertificate(context, 'psa'); }
  catch { return jsonResponse({ok:false,error:'registration_unavailable',message:'접수 처리에 실패했습니다. 잠시 후 다시 시도해주세요.'},503); }
});
export const onRequestGet = withAuth(async ({env,user}) => {
  if (!env.DB) return jsonResponse({ok:false,error:'database_unavailable'},503);
  try {
    await ensureCertificateTables(env);
    const res=await env.DB.prepare('SELECT id,cert_number,card_id,grade,holding_id,subject,card_number,registered_at FROM psa_certs WHERE user_id=? ORDER BY registered_at DESC').bind(user.id).all();
    return jsonResponse({ok:true,certs:res.results||[]});
  } catch { return jsonResponse({ok:false,error:'lookup_failed',message:'등록 목록을 읽을 수 없습니다.'},503); }
});
