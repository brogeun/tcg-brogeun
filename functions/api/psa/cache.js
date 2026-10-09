import { jsonResponse } from '../../_shared/auth.js';
import { completeJob, isWorker } from '../../_shared/certificates.js';
export async function onRequestPost({env,request}) {
  if (!isWorker(request,env)) return jsonResponse({ok:false,error:'unauthorized'},401);
  if (!env.DB) return jsonResponse({ok:false,error:'database_unavailable'},503);
  const length=Number(request.headers.get('content-length'));
  if (length>65536) return jsonResponse({ok:false,error:'payload_too_large'},413);
  let body;
  try { const raw=await request.text(); if(raw.length>65536)return jsonResponse({ok:false,error:'payload_too_large'},413);body=JSON.parse(raw); }
  catch { return jsonResponse({ok:false,error:'bad_request'},400); }
  try { const result=await completeJob(env,body);return jsonResponse(result.data,result.status); }
  catch { return jsonResponse({ok:false,error:'result_save_failed'},503); }
}
