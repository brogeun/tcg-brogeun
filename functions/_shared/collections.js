import { verifyJwt, sha256Hex } from './jwt.js';

// Private collection state is deliberately independent of the asset ledger.
export const LIMITS = Object.freeze({ collections:50, cards:5000, mutationCards:100, ownershipCards:100, bodyBytes:262144 });
export const CARD_KEY = /^cp1_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const GAMES = new Set(['pokemon','onepiece','riftbound','chiikawa']);
const LANGUAGES = new Set(['ja','en','zh-CN','ko']);
const YES = value => value === true || value === '1' || value === 'true';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const schemaReady = new WeakMap();
const shardCache = new Map();

// Keep this additive definition identical to functions/_schema/collections.sql.
export const COLLECTION_SCHEMA = `
CREATE TABLE IF NOT EXISTS collections (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 60),
  description TEXT NOT NULL DEFAULT '' CHECK(length(description) <= 500),
  items_json TEXT NOT NULL CHECK(CASE WHEN json_valid(items_json) THEN json_type(items_json)='array' AND json_array_length(items_json)<=5000 ELSE 0 END),
  snapshot_json TEXT NOT NULL CHECK(CASE WHEN json_valid(snapshot_json) THEN json_type(snapshot_json)='object' ELSE 0 END),
  catalog_version TEXT NOT NULL,
  create_hash TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>=1),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY(user_id,id)
);
CREATE INDEX IF NOT EXISTS idx_collections_owner ON collections(user_id,deleted_at,updated_at,id);
CREATE TABLE IF NOT EXISTS user_card_states (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  card_key TEXT NOT NULL CHECK(length(card_key)=40 AND substr(card_key,1,4)='cp1_'),
  manual_owned INTEGER NOT NULL CHECK(typeof(manual_owned)='integer' AND manual_owned IN(0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK(typeof(revision)='integer' AND revision>=1),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id,card_key)
);
CREATE TABLE IF NOT EXISTS collection_mutations (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  accepted_revision INTEGER NOT NULL CHECK(typeof(accepted_revision)='integer' AND accepted_revision>=1),
  created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,scope_id,request_id)
);
`;

export class CollectionError extends Error {
  constructor(status, code, message) { super(message); this.status=status; this.code=code; }
}
export const fail = (status, code, message) => { throw new CollectionError(status,code,message); };
export function respond(data, status=200) {
  return new Response(JSON.stringify(data), { status, headers:{
    'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store',
    'X-Content-Type-Options':'nosniff', 'Vary':'Cookie, X-Collection-Account'
  }});
}
function unavailable() { return respond({ok:false,error:'unavailable',message:'컬렉션을 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'},503); }
function isRevision(value, zero=false) { return Number.isSafeInteger(value) && value >= (zero?0:1) && value < Number.MAX_SAFE_INTEGER; }
export function revision(value, zero=false) {
  if (!isRevision(value,zero)) fail(400,'bad_request','수정 순서 번호가 올바르지 않습니다.');
  return value;
}
export function collectionId(value) {
  if (typeof value!=='string' || !UUID.test(value)) fail(400,'bad_request','컬렉션 식별자가 올바르지 않습니다.');
  return value;
}
function text(value,max,label,empty=false) {
  if (typeof value!=='string' || /[\u0000-\u001f\u007f]/.test(value)) fail(400,'bad_request',`${label}을 확인해 주세요.`);
  const clean=value.trim();
  if ((!empty&&!clean) || [...clean].length>max) fail(400,'bad_request',`${label}은 ${max}자 이내로 입력해 주세요.`);
  return clean;
}
export const title = value => text(value,60,'컬렉션 이름');
export const description = value => text(value,500,'설명',true);
export function cardKeys(value, max=LIMITS.cards) {
  if (!Array.isArray(value)) fail(400,'bad_request','카드 목록이 필요합니다.');
  if (value.length>max) fail(413,'too_large',`카드는 한 번에 ${max}종까지 처리할 수 있습니다.`);
  if (value.some(key=>typeof key!=='string'||!CARD_KEY.test(key))) fail(400,'bad_request','카드 식별자가 올바르지 않습니다.');
  if (new Set(value).size!==value.length) fail(400,'bad_request','카드 목록에 같은 카드가 중복됐습니다.');
  return [...value];
}
export function versionMatches(input, catalog) {
  if (typeof input!=='string' || input!==catalog.version) fail(409,'catalog_changed','카드 정보가 갱신됐습니다. 새로 불러온 뒤 다시 시도해 주세요.');
}
export async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('Content-Type')||'')) fail(415,'unsupported_media_type','JSON 형식이 필요합니다.');
  const length=request.headers.get('Content-Length');
  if (length!==null && (!/^\d+$/.test(length)||Number(length)>LIMITS.bodyBytes)) fail(413,'too_large','요청 크기가 허용 범위를 초과했습니다.');
  if (!request.body) fail(400,'bad_request','요청 내용이 필요합니다.');
  const reader=request.body.getReader(), chunks=[]; let size=0;
  try {
    for (;;) { const {value,done}=await reader.read(); if(done)break; size+=value.byteLength; if(size>LIMITS.bodyBytes){await reader.cancel(); fail(413,'too_large','요청 크기가 허용 범위를 초과했습니다.');} chunks.push(value); }
    const bytes=new Uint8Array(size); let offset=0; for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    let data; try { data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { fail(400,'bad_request','JSON 요청을 읽을 수 없습니다.'); }
    if(!object(data)) fail(400,'bad_request','JSON 객체가 필요합니다.');
    return data;
  } finally { reader.releaseLock(); }
}

async function authenticate(request,env) {
  if (!env?.DB || typeof env.DB.prepare!=='function' || !env.JWT_SECRET) fail(503,'unavailable','컬렉션 계정 연결을 사용할 수 없습니다.');
  const token=(request.headers.get('Cookie')||'').match(/(?:^|;\s*)session=([^;]+)/)?.[1];
  const payload=await verifyJwt(token,env.JWT_SECRET);
  if (!payload || typeof payload.sub!=='string' || !payload.sub) fail(401,'unauthorized','로그인이 필요합니다.');
  // Distinguish a failed DB query (503) from a genuinely absent account (401).
  const user=await env.DB.prepare('SELECT id, email FROM users WHERE id = ?').bind(payload.sub).first();
  if (!user || user.id!==payload.sub) fail(401,'unauthorized','로그인이 필요합니다.');
  const account=request.headers.get('X-Collection-Account');
  if(!account) fail(400,'account_required','로그인 계정을 다시 확인해 주세요.');
  if(account!==user.id) fail(409,'account_changed','로그인 계정이 바뀌었습니다. 화면을 다시 불러와 주세요.');
  return user;
}
async function ensureSchema(env) {
  if(env.COLLECTIONS_LAZY_SCHEMA==='0'||env.COLLECTIONS_LAZY_SCHEMA==='false'||env.COLLECTIONS_LAZY_SCHEMA===false) return;
  if(typeof env.DB.batch!=='function') fail(503,'unavailable','컬렉션 저장을 사용할 수 없습니다.');
  let promise=schemaReady.get(env.DB);
  if(!promise){promise=env.DB.batch(COLLECTION_SCHEMA.split(';').map(s=>s.trim()).filter(Boolean).map(sql=>env.DB.prepare(sql)));schemaReady.set(env.DB,promise);}
  try{await promise;}catch(error){schemaReady.delete(env.DB);throw error;}
}

async function staticJson(context,path,maxBytes) {
  const target=new URL(path,new URL(context.request.url).origin);
  // Never forward Cookie, Authorization, or any incoming request headers.
  const request=new Request(target.href,{method:'GET',redirect:'manual',headers:{'Accept':'application/json','Cache-Control':'no-cache'}});
  const response=context.env.ASSETS?.fetch ? await context.env.ASSETS.fetch(request) : await fetch(request);
  if(!response.ok || response.status>=300 || !/^application\/json(?:\s*;|$)/i.test(response.headers.get('Content-Type')||'')) fail(503,'catalog_unavailable','카드 정보를 불러오지 못했습니다.');
  if(response.url && new URL(response.url).origin!==target.origin) fail(503,'catalog_unavailable','카드 정보를 불러오지 못했습니다.');
  const declared=response.headers.get('Content-Length');
  if(declared && (!/^\d+$/.test(declared)||Number(declared)>maxBytes)) fail(503,'catalog_unavailable','카드 정보 크기를 확인할 수 없습니다.');
  const reader=response.body?.getReader(); if(!reader) fail(503,'catalog_unavailable','카드 정보를 불러오지 못했습니다.');
  let size=0;const chunks=[];
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes){await reader.cancel();fail(503,'catalog_unavailable','카드 정보 크기를 확인할 수 없습니다.');}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
    let data;try{data=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}catch{fail(503,'catalog_unavailable','카드 정보를 읽을 수 없습니다.');}
    if(!object(data))fail(503,'catalog_unavailable','카드 정보를 읽을 수 없습니다.');return data;
  }finally{reader.releaseLock();}
}
async function catalogFor(context) {
  // Ordinary private requests need a version/read-only flag, not the several-MB
  // public artist/character discovery graph. Missing manifest fails closed.
  const catalog=await staticJson(context,'/data/collections/manifest.json',16384);
  if(catalog.schemaVersion!==1 || typeof catalog.version!=='string' || !/^[A-Za-z0-9_.-]{1,120}$/.test(catalog.version))fail(503,'catalog_unavailable','카드 정보 버전을 확인할 수 없습니다.');
  if(catalog.readOnly!==undefined&&typeof catalog.readOnly!=='boolean')fail(503,'catalog_unavailable','카드 정보 상태를 확인할 수 없습니다.');
  const origin=new URL(context.request.url).origin;
  for(const [key,entry] of shardCache)if(entry.origin===origin&&entry.assets===context.env.ASSETS&&entry.version!==catalog.version)shardCache.delete(key);
  return catalog;
}
export async function snapshotCatalog(context) {
  const catalog=await staticJson(context,'/data/collections/catalog.json',8*1024*1024);
  if(catalog.schemaVersion!==1||catalog.version!==context.catalog.version||(catalog.readOnly===true)!==(context.catalog.readOnly===true)||(catalog.readOnly!==undefined&&typeof catalog.readOnly!=='boolean'))fail(503,'catalog_unavailable','카드 정보가 갱신 중입니다. 잠시 후 다시 시도해 주세요.');
  return catalog;
}
async function shardFor(context,catalog,nibble) {
  const origin=new URL(context.request.url).origin,cacheKey=`${origin}:${catalog.version}:${nibble}`;
  // ASSETS binding instances are not shared between environments in this cache.
  let cached=shardCache.get(cacheKey);
  if(cached && cached.assets===context.env.ASSETS && cached.expires>Date.now())return cached.value;
  const data=await staticJson(context,`/data/collections/keys/${nibble}.json`,16*1024*1024);
  if(data.version!==catalog.version||!object(data.cards))fail(503,'catalog_unavailable','카드 정보가 갱신 중입니다. 잠시 후 다시 시도해 주세요.');
  if(shardCache.size>=16)shardCache.delete(shardCache.keys().next().value);
  shardCache.set(cacheKey,{origin,version:catalog.version,assets:context.env.ASSETS,value:data.cards,expires:Date.now()+60000});
  return data.cards;
}
export async function registry(context,keys,{allowMissing=false}={}) {
  const groups=new Map(); for(const key of keys){const nibble=key[4];if(!groups.has(nibble))groups.set(nibble,[]);groups.get(nibble).push(key);}
  const result=new Map(),entries=[...groups];
  // At most four cold asset reads concurrently, and at most sixteen overall.
  for(let i=0;i<entries.length;i+=4){await Promise.all(entries.slice(i,i+4).map(async([nibble,ids])=>{
    const cards=await shardFor(context,context.catalog,nibble);
    for(const key of ids){
      const card=Object.hasOwn(cards,key)?cards[key]:null;
      if(!object(card)||!GAMES.has(card.game)||!LANGUAGES.has(card.language)||typeof card.sourceKey!=='string'||!card.sourceKey){if(allowMissing){result.set(key,null);continue;}fail(400,'unknown_card','등록되지 않은 카드가 포함돼 있습니다.');}
      result.set(key,card);
    }
  }));}
  return result;
}
export function snapshot(input={kind:'manual'}) {
  if(!object(input)||!['manual','artist','character'].includes(input.kind))fail(400,'bad_request','컬렉션 유형이 올바르지 않습니다.');
  const allowed=new Set(['kind','game','language']);if(input.kind==='artist')allowed.add('artistId');if(input.kind==='character')for(const k of ['characterId','includeMega','includeEvolution'])allowed.add(k);
  if(Object.keys(input).some(k=>!allowed.has(k)))fail(400,'bad_request','컬렉션 범위를 확인해 주세요.');
  const result={kind:input.kind};
  for(const name of ['game','language'])if(input[name]!==undefined){if(!(name==='game'?GAMES:LANGUAGES).has(input[name]))fail(400,'bad_request','게임 또는 언어가 올바르지 않습니다.');result[name]=input[name];}
  if(input.kind==='artist')result.artistId=text(input.artistId,200,'작가 식별자');
  if(input.kind==='character'){
    result.characterId=text(input.characterId,200,'캐릭터 식별자');
    for(const name of ['includeMega','includeEvolution']){if(input[name]!==undefined&&typeof input[name]!=='boolean')fail(400,'bad_request','캐릭터 포함 범위를 확인해 주세요.');result[name]=input[name]===true;}
  }
  return result;
}
export function validateSnapshotScope(scope,keys,cards,catalog) {
  for(const key of keys){const card=cards.get(key);if((scope.game&&card.game!==scope.game)||(scope.language&&card.language!==scope.language))fail(400,'scope_mismatch','선택한 게임·언어와 다른 카드가 포함돼 있습니다.');}
  if(scope.kind==='manual')return;
  // Unmerged source-only metadata must never inflate a character's physical
  // printing denominator, even if a bad group accidentally includes that key.
  if(scope.kind==='character'&&keys.some(key=>cards.get(key).sourceOnly===true))fail(400,'scope_mismatch','캐릭터 모음에 포함할 수 없는 출처 전용 카드입니다.');
  const groups=scope.kind==='artist'?catalog.artists:catalog.characters;
  const group=Array.isArray(groups)?groups.find(row=>row?.id===(scope.artistId||scope.characterId)):null;
  if(!group || !Array.isArray(group.cardIds))fail(400,'scope_mismatch','확인되지 않은 작가 또는 캐릭터입니다.');
  const allowed=new Set();
  if(scope.kind==='artist')for(const key of group.cardIds)allowed.add(key);
  else {
    const family=scope.includeEvolution ? (group.evolutionIds||group.familyIds||[group.id]) : [group.id];
    if(!Array.isArray(family))fail(503,'catalog_unavailable','캐릭터 정보를 확인할 수 없습니다.');
    for(const id of new Set([group.id,...family])){
      const member=catalog.characters.find(row=>row?.id===id&&row.game===group.game);
      if(!member||!Array.isArray(member.cardIds))continue;
      const mega=new Set(member.megaCardIds||[]);
      for(const key of member.cardIds)if(scope.includeMega||!mega.has(key))allowed.add(key);
    }
  }
  if(keys.some(key=>!allowed.has(key)))fail(400,'scope_mismatch','선택한 작가·캐릭터 범위 밖의 카드가 포함돼 있습니다.');
}
export async function ownership(context,keys,cards) {
  const result=Object.create(null);for(const key of keys)result[key]={manualOwned:false,holdingOwned:false,owned:false,revision:0};
  if(!keys.length)return result;
  // A bounded index read per account, not one DB read per card/collection.
  const states=await context.env.DB.prepare('SELECT card_key, manual_owned, revision FROM user_card_states WHERE user_id = ?').bind(context.user.id).all();
  for(const state of states.results||[])if(Object.hasOwn(result,state.card_key)){if(!isRevision(state.revision))fail(503,'unavailable','보유 표시를 확인할 수 없습니다.');result[state.card_key].manualOwned=state.manual_owned===1;result[state.card_key].revision=state.revision;}
  const holdings=await context.env.DB.prepare("SELECT card_id FROM holdings WHERE user_id = ? AND qty > 0 AND grade IN ('raw','psa9','psa10')").bind(context.user.id).all();
  const marketIds=new Set((holdings.results||[]).map(row=>String(row.card_id)));
  for(const key of keys){const card=cards.get(key),state=result[key];state.holdingOwned=!!card && card.sourceOnly!==true && card.marketVerified===true && /^\d+$/.test(String(card.marketId||'')) && marketIds.has(String(card.marketId));state.owned=state.manualOwned||state.holdingOwned;}
  return result;
}
export function rowRecord(row) {
  if(!row || !isRevision(row.revision) || !UUID.test(row.id) || typeof row.title!=='string')fail(503,'unavailable','컬렉션 기록을 확인할 수 없습니다.');
  let keys,scope;try{keys=cardKeys(JSON.parse(row.items_json));scope=snapshot(JSON.parse(row.snapshot_json));}catch{fail(503,'unavailable','컬렉션 기록을 확인할 수 없습니다.');}
  return {id:row.id,title:row.title,description:row.description,revision:row.revision,itemCount:keys.length,createdAt:row.created_at,updatedAt:row.updated_at,snapshot:scope,sourceCatalogVersion:row.catalog_version,cardKeys:keys};
}
export function selectCollection(context,id) {
  return context.env.DB.prepare('SELECT * FROM collections WHERE user_id = ? AND id = ?').bind(context.user.id,id).first();
}
export async function detail(context,row) {
  const record=rowRecord(row),cards=await registry(context,record.cardKeys,{allowMissing:true});
  const states=await ownership(context,record.cardKeys,cards);
  return {...record,ownedCount:Object.values(states).filter(s=>s.owned).length,ownership:states};
}
export async function receipt(context,scope,id) {
  return context.env.DB.prepare('SELECT request_hash, accepted_revision FROM collection_mutations WHERE user_id = ? AND scope_id = ? AND request_id = ?').bind(context.user.id,scope,id).first();
}
export async function operation(type,input) {
  if(input.mutationId!==undefined&&(typeof input.mutationId!=='string'||!UUID.test(input.mutationId)))fail(400,'bad_request','수정 요청 식별자가 올바르지 않습니다.');
  const payload={...input};delete payload.mutationId;const hash=await sha256Hex(JSON.stringify([type,payload]));
  return {id:input.mutationId||hash,hash};
}
export async function replay(context,scope,op) {
  const existing=await receipt(context,scope,op.id);
  if(existing && existing.request_hash!==op.hash)fail(409,'idempotency_conflict','이미 다른 내용으로 사용된 수정 요청입니다.');
  return existing;
}
export function meta(context) { return {ok:true,accountId:context.user.id,catalogVersion:context.catalog.version}; }
export function now() { return new Date().toISOString(); }
export function notFound() { fail(404,'not_found','컬렉션을 찾을 수 없습니다.'); }
export function conflict() { fail(409,'conflict','다른 곳에서 컬렉션을 수정했습니다. 새로 불러온 뒤 다시 시도해 주세요.'); }
export async function mutateCollection(context,row,expected,op,changes) {
  const scope=`collection:${row.id}`,prior=await replay(context,scope,op);if(prior)return {replayed:true,acceptedRevision:prior.accepted_revision,row:await selectCollection(context,row.id)};
  if(row.deleted_at || row.revision!==expected)conflict();
  const timestamp=now(),db=context.env.DB;
  const results=await db.batch([
    db.prepare('INSERT INTO collection_mutations (user_id,scope_id,request_id,request_hash,accepted_revision,created_at) SELECT user_id,?, ?, ?,revision+1,? FROM collections WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL ON CONFLICT(user_id,scope_id,request_id) DO NOTHING').bind(scope,op.id,op.hash,timestamp,context.user.id,row.id,expected),
    db.prepare('UPDATE collections SET title=?,description=?,items_json=?,snapshot_json=?,catalog_version=?,updated_at=?,deleted_at=?,revision=revision+1 WHERE user_id=? AND id=? AND revision=? AND deleted_at IS NULL AND EXISTS(SELECT 1 FROM collection_mutations WHERE user_id=? AND scope_id=? AND request_id=? AND request_hash=? AND accepted_revision=?)').bind(changes.title??row.title,changes.description??row.description,changes.items_json??row.items_json,changes.snapshot_json??row.snapshot_json,changes.catalog_version??row.catalog_version,timestamp,changes.deleted_at??null,context.user.id,row.id,expected,context.user.id,scope,op.id,op.hash,expected+1)
  ]);
  if(results[1]?.meta?.changes!==1){const retry=await replay(context,scope,op);if(retry)return {replayed:true,acceptedRevision:retry.accepted_revision,row:await selectCollection(context,row.id)};conflict();}
  return {replayed:false,acceptedRevision:expected+1,row:await selectCollection(context,row.id)};
}

export function route(handler,{write=false}={}) {
  return async context=>{
    try{
      if(context.env?.COLLECTIONS_ENABLED==='0'||context.env?.COLLECTIONS_ENABLED==='false')fail(503,'disabled','컬렉션을 준비 중입니다.');
      if(write){const origin=context.request.headers.get('Origin');if(!origin||origin!==new URL(context.request.url).origin||context.request.headers.get('Sec-Fetch-Site')==='cross-site')fail(403,'forbidden','같은 사이트에서만 수정할 수 있습니다.');if(YES(context.env?.COLLECTIONS_READ_ONLY))fail(503,'read_only','현재 컬렉션은 조회만 할 수 있습니다.');}
      const user=await authenticate(context.request,context.env);
      await ensureSchema(context.env);
      const catalog=await catalogFor(context);
      if(write&&catalog.readOnly===true)fail(503,'read_only','현재 컬렉션은 조회만 할 수 있습니다.');
      return await handler({...context,user,catalog});
    }catch(error){if(error instanceof CollectionError)return respond({ok:false,error:error.code,message:error.message},error.status);return unavailable();}
  };
}
