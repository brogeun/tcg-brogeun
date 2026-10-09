import { jsonResponse } from '../../_shared/auth.js';
import { claimJob, isWorker } from '../../_shared/certificates.js';
export async function onRequestPost({env,request}) {
  if (!isWorker(request,env)) return jsonResponse({ok:false,error:'unauthorized'},401);
  if (!env.DB) return jsonResponse({ok:false,error:'database_unavailable'},503);
  let body; try { body=await request.json(); } catch { return jsonResponse({ok:false,error:'bad_request'},400); }
  if (body.worker_version!==2) return jsonResponse({ok:false,error:'worker_update_required',message:'PC 조회 프로그램을 v2로 업데이트해주세요.'},426);
  try {
    const job=await claimJob(env);
    if (job) job.lookup_url=job.provider==='psa' ? 'https://www.psacard.com/cert/'+job.cert_number : 'https://www.beckett.com/api/grading/lookup?category=BGS&serialNumber='+job.cert_number;
    return jsonResponse({ok:true,version:2,jobs:job?[job]:[],retry_after_seconds:20});
  } catch { return jsonResponse({ok:false,error:'queue_unavailable'},503); }
}
export async function onRequestGet({env,request}) {
  if (!isWorker(request,env)) return jsonResponse({ok:false,error:'unauthorized'},401);
  return jsonResponse({ok:false,certs:[],error:'worker_update_required',message:'PC 조회 프로그램 v2가 필요합니다.'},426);
}
