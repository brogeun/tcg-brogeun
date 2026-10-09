import { withAuth, jsonResponse } from '../../_shared/auth.js';
import { ensureCertificateTables, getRequest } from '../../_shared/certificates.js';

/** Read-only, owner-scoped progress endpoint. Polling never submits or registers a cert. */
export const onRequestGet = withAuth(async ({request,env,user}) => {
  if (!env.DB) return jsonResponse({ok:false,error:'database_unavailable'},503);
  const id=new URL(request.url).searchParams.get('id');
  if (!id || !/^[a-zA-Z0-9-]{10,80}$/.test(id)) return jsonResponse({ok:false,error:'invalid_id'},400);
  try {
    await ensureCertificateTables(env);
    const view=await getRequest(env,id,user.id);
    if (!view) return jsonResponse({ok:false,error:'not_found',message:'요청을 찾을 수 없습니다.'},404);
    return jsonResponse(view);
  } catch { return jsonResponse({ok:false,error:'status_unavailable',message:'진행 상태를 읽을 수 없습니다. 접수된 요청은 유지됩니다.'},503); }
});
