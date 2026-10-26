import {getCurrentUser,jsonResponse} from '../../_shared/auth.js';
import {readBoundedJson,recordFromRow,validateSaveBundle} from '../../_shared/kanto151-save.js';

const unavailable = () => jsonResponse({ok:false,error:'unavailable',message:'계정 저장을 연결하지 못했어요. 기기의 기존 기록은 그대로 유지됩니다.'},503);
const selectRecord = (db,userId) => db.prepare('SELECT revision, updated_at, bundle_json FROM kanto151_saves WHERE user_id = ?').bind(userId).first();

async function authenticate(request,env) {
  if (!env?.JWT_SECRET || !env.DB || typeof env.DB.prepare !== 'function') return {response:unavailable()};
  const user = await getCurrentUser(request,env);
  if (!user || typeof user.id !== 'string' || !user.id) return {response:jsonResponse({ok:false,error:'unauthorized',message:'로그인이 필요합니다.'},401)};
  const expectedAccount = request.headers.get('X-Kanto151-Account');
  if (!expectedAccount) return {response:jsonResponse({ok:false,error:'account-required',message:'저장할 로그인 계정을 다시 확인해 주세요.'},400)};
  if (expectedAccount !== user.id) return {response:jsonResponse({ok:false,error:'account-changed',message:'로그인 계정이 바뀌었어요. 기존 기록을 유지하고 다시 연결해 주세요.'},409)};
  return {user};
}

export async function onRequestGet({request,env}) {
  const auth = await authenticate(request,env);
  if (auth.response) return auth.response;
  try {
    const record = recordFromRow(await selectRecord(env.DB,auth.user.id));
    return jsonResponse({ok:true,record});
  } catch { return unavailable(); }
}

export async function onRequestPut({request,env}) {
  const origin = request.headers.get('Origin');
  // Browsers/WebViews send Origin on credentialed JSON writes. Require the
  // exact game origin; native app requests must use the same hosted game API.
  if (!origin || origin !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') return jsonResponse({ok:false,error:'forbidden',message:'같은 사이트에서만 저장할 수 있습니다.'},403);
  const auth = await authenticate(request,env);
  if (auth.response) return auth.response;
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type') || '')) return jsonResponse({ok:false,error:'unsupported_media_type',message:'JSON 형식이 필요합니다.'},415);
  const input = await readBoundedJson(request);
  if (input.status) return jsonResponse({ok:false,error:input.status === 413 ? 'too_large' : 'bad_request',message:input.status === 413 ? '저장 기록이 2MB를 초과합니다.' : '저장 요청을 읽을 수 없습니다.'},input.status);
  const {expectedRevision,bundle:rawBundle} = input.body || {};
  let bundle;
  try {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision === Number.MAX_SAFE_INTEGER) throw new Error('저장 순서 번호가 올바르지 않습니다.');
    bundle = validateSaveBundle(rawBundle);
  } catch (error) { return jsonResponse({ok:false,error:'bad_request',message:error.message},400); }
  const db = env.DB,userId = auth.user.id,updatedAt = new Date().toISOString(),serialized = JSON.stringify(bundle);
  try {
    let written;
    if (expectedRevision === 0) {
      const result = await db.prepare('INSERT INTO kanto151_saves (user_id, revision, updated_at, bundle_json) VALUES (?, 1, ?, ?) ON CONFLICT(user_id) DO NOTHING').bind(userId,updatedAt,serialized).run();
      written = result.meta?.changes === 1;
    } else {
      if (typeof db.batch !== 'function') return unavailable();
      // D1 batch is transactional. A stale request cannot update a row or make
      // a backup of a newer revision. Retain every previous accepted revision.
      const results = await db.batch([
        db.prepare('INSERT OR IGNORE INTO kanto151_save_backups (user_id, revision, updated_at, bundle_json) SELECT user_id, revision, updated_at, bundle_json FROM kanto151_saves WHERE user_id = ? AND revision = ?').bind(userId,expectedRevision),
        db.prepare('UPDATE kanto151_saves SET revision = revision + 1, updated_at = ?, bundle_json = ? WHERE user_id = ? AND revision = ?').bind(updatedAt,serialized,userId,expectedRevision),
      ]);
      written = results[1]?.meta?.changes === 1;
    }
    if (!written) return jsonResponse({ok:false,error:'conflict',record:recordFromRow(await selectRecord(db,userId))},409);
    return jsonResponse({ok:true,record:{revision:expectedRevision + 1,updatedAt,bundle}});
  } catch { return unavailable(); }
}
