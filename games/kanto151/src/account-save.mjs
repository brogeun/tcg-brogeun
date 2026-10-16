// Account saves are opt-in for an existing device. This module never writes the
// game's primary, legacy, checkpoint, or recovery keys.
export const ACCOUNT_SAVE_META_KEY='kanto151:account-save:v1';
export const ACCOUNT_SAVE_BACKUP_PREFIX=ACCOUNT_SAVE_META_KEY+':backup:';
const MAX_BUNDLE_CHARS=2*1024*1024;
const copyBundle=bundle=>bundle?{schema:1,save:bundle.save,checkpoint:bundle.checkpoint}:null;
const copyRecord=record=>record?{revision:record.revision,updatedAt:record.updatedAt,bundle:copyBundle(record.bundle)}:null;
const equalBundle=(left,right)=>left===right||!!left&&!!right&&left.save===right.save&&left.checkpoint===right.checkpoint;
const accountId=user=>{const value=user?.id;if((typeof value!=='string'&&typeof value!=='number')||!String(value).length||String(value).length>200)throw failure('invalid-account','계정 정보를 확인하지 못했어요.');return String(value);};
const failure=(code,message,extra={})=>Object.assign(new Error(message),{code,...extra});
const saveIdentity=bundle=>{try{const save=JSON.parse(bundle?.save);return JSON.stringify([save.collection?.[0]?.uid??null,save.checkpointId??null]);}catch{return null;}};

export function hasAccountSaveProgress(bundle){
 try{const save=JSON.parse(bundle?.save);return !!save&&typeof save==='object'&&!Array.isArray(save)&&!!save.starter&&Array.isArray(save.collection)&&save.collection.length>0;}catch{return false;}
}

export function validateAccountSaveBundle(bundle){
 if(!bundle||bundle.schema!==1||typeof bundle.save!=='string'||(bundle.checkpoint!==null&&typeof bundle.checkpoint!=='string')||bundle.save.length+(bundle.checkpoint?.length||0)>MAX_BUNDLE_CHARS)throw failure('invalid-bundle','저장 기록의 형식을 확인하지 못했어요.');
 if(!hasAccountSaveProgress(bundle))throw failure('empty-save','포켓몬이 없는 빈 기록은 계정에 올릴 수 없어요.');
 if(bundle.checkpoint!==null){try{const value=JSON.parse(bundle.checkpoint);if(!value||typeof value!=='object'||Array.isArray(value))throw Error();}catch{throw failure('invalid-bundle','저장대 기록의 형식을 확인하지 못했어요.');}}
 return true;
}

export function accountSaveFingerprint(bundle){
 if(!bundle)return null;
 const text=JSON.stringify(copyBundle(bundle));let first=2166136261,second=5381;
 for(let i=0;i<text.length;i++){const n=text.charCodeAt(i);first=Math.imul(first^n,16777619);second=Math.imul(second,33)^n;}
 return `${text.length}:${(first>>>0).toString(16)}:${(second>>>0).toString(16)}`;
}

// The account header is only an expected identity, never authentication. The
// server must compare it with its authenticated session before reading/writing.
export function createAccountSaveTransport({fetchImpl=globalThis.fetch,baseUrl='',timeoutMs=8000}={}){
 if(typeof fetchImpl!=='function')throw Error('fetch is required');
 const request=async(path,{method='GET',body,userId,signal}={})=>{
  const abort=new AbortController(),abortFromCaller=()=>abort.abort(signal?.reason);
  if(signal?.aborted)abortFromCaller();else signal?.addEventListener('abort',abortFromCaller,{once:true});
  const timer=setTimeout(()=>abort.abort(failure('timeout','계정 저장 응답이 늦어지고 있어요.')),Math.max(1,timeoutMs));
  try{
   const headers={Accept:'application/json'};if(body)headers['Content-Type']='application/json';if(userId!==undefined)headers['X-Kanto151-Account']=String(userId);
   const response=await fetchImpl(baseUrl+path,{method,headers,credentials:'same-origin',cache:'no-store',signal:abort.signal,...(body?{body:JSON.stringify(body)}:{})});
   let data;try{data=await response.json();}catch{throw failure('invalid-response','계정 저장 서버의 응답을 읽지 못했어요.');}
   if(response.status===409)throw failure(data?.error==='account-changed'?'account-changed':'conflict','다른 기기 또는 계정의 기록이 바뀌었어요.',{record:data?.record??null});
   if(response.status===401)throw failure('signed-out','카카오 로그인을 다시 확인해 주세요.');
   if(!response.ok||data?.ok!==true)throw failure(data?.error||'request-failed','계정 저장에 연결하지 못했어요.');
   return data;
  }catch(error){if(abort.signal.aborted&&!signal?.aborted)throw failure('timeout','계정 저장 응답이 늦어지고 있어요.');throw error;}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abortFromCaller);}
 };
 return {
  async getUser(options){return (await request('/api/auth/me',options)).user??null;},
  async getRecord(options){return (await request('/api/games/kanto151-save',options)).record??null;},
  async putRecord({bundle,expectedRevision,...options}){return (await request('/api/games/kanto151-save',{...options,method:'PUT',body:{expectedRevision,bundle}})).record;},
 };
}

export class AccountSaveController{
 constructor({transport,storage,validateBundle,onChange=()=>{},debounceMs=900,now=()=>Date.now()}={}){
  if(!transport||!storage)throw Error('transport and storage are required');
  this.transport=transport;this.storage=storage;this.validateBundle=validateBundle;this.onChange=onChange;this.debounceMs=debounceMs;this.now=now;
  this._status='local';this._reason='not-checked';this._user=null;this._record=null;this._local=null;this._error=null;this._pending=false;this._writeAllowed=false;this._bound=false;this._acceptedIdentity=null;this._lastSuccessfulAt=null;this._epoch=0;this._abort=new AbortController();this._timer=null;this._run=null;this._applying=false;this._disposed=false;this._backupSequence=0;
  this._meta={schema:1,ownerUserId:null,accounts:{}};
  try{const raw=storage.getItem(ACCOUNT_SAVE_META_KEY);if(raw!==null){const parsed=JSON.parse(raw);if(parsed?.schema!==1||(parsed.ownerUserId!==null&&typeof parsed.ownerUserId!=='string')||!parsed.accounts||typeof parsed.accounts!=='object'||Array.isArray(parsed.accounts))throw Error('invalid account metadata');this._meta=parsed;}}catch(error){this._metadataError=error;}
 }
 get snapshot(){return {status:this._status,reason:this._reason,user:this._user?{...this._user}:null,record:copyRecord(this._record),localBundle:copyBundle(this._local),revision:this._record?.revision??0,pending:this._pending,lastSuccessfulAt:this._lastSuccessfulAt,canUpload:!!this._user&&!!this._local&&['link-required','conflict','synced'].includes(this._status),canUseCloud:!!this._user&&!!this._record&&['cloud-available','conflict','synced'].includes(this._status),error:this._error?{code:this._error.code||'failed',message:this._error.message}:null};}
 _emit(status,reason,error=null){if(status)this._status=status;if(reason!==undefined)this._reason=reason;this._error=error;try{this.onChange(this.snapshot);}catch{}return this.snapshot;}
 _validate(bundle){validateAccountSaveBundle(bundle);if(this.validateBundle?.(copyBundle(bundle))===false)throw failure('invalid-bundle','저장 기록을 확인하지 못했어요.');return copyBundle(bundle);}
 _validateRecord(record){if(record===null)return null;if(!record||!Number.isSafeInteger(record.revision)||record.revision<1||typeof record.updatedAt!=='string'||!record.updatedAt.length||record.updatedAt.length>100)throw failure('invalid-record','계정 저장 기록을 확인하지 못했어요.');return {revision:record.revision,updatedAt:record.updatedAt,bundle:this._validate(record.bundle)};}
 _current(epoch){return !this._disposed&&epoch===this._epoch;}
 _clearTimer(){if(this._timer!==null){clearTimeout(this._timer);this._timer=null;}}
 _stop(){this._clearTimer();this._writeAllowed=false;this._bound=false;}
 _remember(record,local=this._local){
  const id=accountId(this._user),next={schema:1,ownerUserId:id,accounts:{...this._meta.accounts,[id]:{revision:record.revision,fingerprint:accountSaveFingerprint(record.bundle),localFingerprint:accountSaveFingerprint(local),updatedAt:record.updatedAt}}};
  try{this.storage.setItem(ACCOUNT_SAVE_META_KEY,JSON.stringify(next));this._meta=next;}catch(error){throw failure('metadata-unavailable','계정 저장 연결 정보를 이 기기에 남기지 못했어요.',{cause:error});}
 }
 _backup(reason,bundle=this._local){
  const createdAt=this.now(),key=ACCOUNT_SAVE_BACKUP_PREFIX+createdAt+':'+(++this._backupSequence);
  const value=JSON.stringify({schema:1,createdAt,reason,userId:this._user?accountId(this._user):null,bundle:copyBundle(bundle),cloudRecord:copyRecord(this._record),association:this._meta});
  // Never reuse an existing backup, even with a fixed clock or another tab.
  let unique=key;while(this.storage.getItem(unique)!==null)unique=key+':'+(++this._backupSequence);
  this.storage.setItem(unique,value);if(this.storage.getItem(unique)!==value)throw failure('backup-failed','원래 기록의 안전 복사본을 만들지 못했어요.');return unique;
 }
 async init(localBundle=null){return this.refresh(localBundle);}
 async refresh(localBundle=this._local){
  if(this._disposed)return this.snapshot;
  if(this._applying)return this._emit(null,'apply-in-progress');
  this._abort.abort();this._abort=new AbortController();const epoch=++this._epoch;this._stop();this._pending=false;this._record=null;this._user=null;this._lastSuccessfulAt=null;
  try{this._local=localBundle===null?null:this._validate(localBundle);}catch(error){return this._emit('error','invalid-local',error);}
  if(this._metadataError)return this._emit('error','metadata-unavailable',this._metadataError);
  this._emit('checking','checking-account');
  try{
   const user=await this.transport.getUser({signal:this._abort.signal});if(!this._current(epoch))return this.snapshot;
   if(!user)return this._emit('local','signed-out');
   const id=accountId(user);this._user={...user};
   const record=this._validateRecord(await this.transport.getRecord({userId:id,signal:this._abort.signal}));if(!this._current(epoch))return this.snapshot;this._record=record;
   if(!record)return this._emit(this._local?'link-required':'local',this._local?'first-link':'empty-account');
   if(!this._local)return this._emit('cloud-available','empty-local');
   if(this._meta.ownerUserId&&this._meta.ownerUserId!==id)return this._emit('conflict','different-account');
   if(!equalBundle(this._local,record.bundle))return this._emit('conflict','different-progress');
   this._remember(record);this._bound=true;this._writeAllowed=true;this._acceptedIdentity=saveIdentity(this._local);this._lastSuccessfulAt=record.updatedAt;return this._emit('synced','same-progress');
  }catch(error){if(!this._current(epoch))return this.snapshot;this._stop();return this._emit(error.code==='account-changed'||error.code==='metadata-unavailable'||error.code?.startsWith('invalid')||error.code==='empty-save'?'error':'offline',error.code||'connection-failed',error);}
 }
 onStored(bundle){
  if(this._disposed||this._applying)return false;
  if(bundle===null){this._local=null;this._pending=false;this._stop();this._emit(this._record?'cloud-available':'local','empty-local');return false;}
  try{this._local=this._validate(bundle);}catch(error){this._stop();this._emit('error','invalid-local',error);return false;}
  this._pending=!equalBundle(this._local,this._record?.bundle);
  if(this._writeAllowed&&this._acceptedIdentity!==null&&saveIdentity(this._local)!==this._acceptedIdentity){this._stop();this._emit(this._record?'conflict':'link-required','different-expedition');return false;}
  if(!this._writeAllowed){
   if(this._user&&['local','cloud-available'].includes(this._status))this._emit(this._record?'conflict':'link-required',this._record?'different-progress':'first-link');
   else this._emit();return false;
  }
  try{if(this._bound&&this._record)this._remember(this._record);}catch(error){this._stop();this._emit('error','metadata-unavailable',error);return false;}
  this._emit(this._run?'syncing':'synced',this._pending?'pending':'up-to-date');if(this._pending)this._schedule();return true;
 }
 suspend(error){
  if(this._disposed)return this.snapshot;
  this._stop();
  return this._emit('error','invalid-local',error instanceof Error?error:failure('invalid-local',String(error||'이 기기의 저장 기록을 확인하지 못했어요.')));
 }
 _schedule(){this._clearTimer();this._timer=setTimeout(()=>{this._timer=null;void this.flush();},Math.max(0,this.debounceMs));}
 async _ensureSameAccount(epoch){
  const expected=accountId(this._user),user=await this.transport.getUser({signal:this._abort.signal});
  if(!this._current(epoch))throw failure('cancelled','계정 저장 확인을 취소했어요.');
  if(!user||accountId(user)!==expected)throw failure('account-changed','로그인 계정이 바뀌었어요. 기록을 다시 확인해 주세요.');return expected;
 }
 async useLocal(){
  if(this._disposed||!this.snapshot.canUpload||this._run||this._applying)return this.snapshot;
  try{this._validate(this._local);this._backup(this._record?'choose-local':'first-link');}
  catch(error){this._stop();return this._emit('error','backup-failed',error);}
  this._writeAllowed=true;this._bound=false;this._acceptedIdentity=saveIdentity(this._local);this._pending=!equalBundle(this._local,this._record?.bundle);
  if(!this._pending){try{this._remember(this._record);this._bound=true;return this._emit('synced','same-progress');}catch(error){this._stop();return this._emit('error','metadata-unavailable',error);}}
  return this.flush();
 }
 async useCloud({apply}={}){
  if(this._disposed||!this.snapshot.canUseCloud||this._run||this._applying)return this.snapshot;
  if(typeof apply!=='function')throw Error('apply is required');
  const epoch=this._epoch;this._stop();this._applying=true;this._emit('syncing','loading-cloud');
  try{
   const id=await this._ensureSameAccount(epoch);if(!this._current(epoch))return this.snapshot;
   const record=this._validateRecord(await this.transport.getRecord({userId:id,signal:this._abort.signal}));if(!this._current(epoch))return this.snapshot;
   if(!record)throw failure('cloud-missing','계정 기록이 변경되었어요. 다시 확인해 주세요.');this._record=record;
   this._backup('choose-cloud');
   const result=await apply(copyBundle(record.bundle),{user:{...this._user},record:copyRecord(record),signal:this._abort.signal});if(!this._current(epoch))return this.snapshot;
   // An adapter may return the exact migrated bytes actually stored locally.
   this._local=this._validate(result===undefined?record.bundle:result);this._record=record;this._remember(record);this._bound=true;this._writeAllowed=true;this._acceptedIdentity=saveIdentity(this._local);this._pending=false;this._lastSuccessfulAt=record.updatedAt;
   // Loading may migrate a legacy save/checkpoint. Keep those local bytes; a
   // later normal game save will upload them without rewriting during startup.
   return this._emit('synced','cloud-loaded');
  }catch(error){if(!this._current(epoch))return this.snapshot;this._stop();return this._emit('error',error.code||'cloud-apply-failed',error);}
  finally{this._applying=false;}
 }
 async flush(){
  this._clearTimer();if(this._run)return this._run;
  if(this._disposed||!this._writeAllowed||!this._pending||!this._local)return this.snapshot;
  const epoch=this._epoch;
  const run=this._uploadLoop(epoch);this._run=run;
  try{return await run;}finally{if(this._run===run)this._run=null;}
 }
 async _uploadLoop(epoch){
  while(this._current(epoch)&&this._writeAllowed&&this._pending&&this._local){
   const bundle=copyBundle(this._local),expectedRevision=this._record?.revision??0;this._emit('syncing','uploading');
   try{
    const id=await this._ensureSameAccount(epoch);if(!this._current(epoch)||!this._writeAllowed)return this.snapshot;
    const record=this._validateRecord(await this.transport.putRecord({userId:id,expectedRevision,bundle,signal:this._abort.signal}));if(!this._current(epoch))return this.snapshot;
    if(!record||record.revision<=expectedRevision||!equalBundle(record.bundle,bundle))throw failure('invalid-record','계정 저장 결과를 확인하지 못했어요.');
    this._record=record;this._lastSuccessfulAt=record.updatedAt;this._pending=!equalBundle(this._local,record.bundle);
    if(!this._writeAllowed)return this._emit(this._local?'conflict':'cloud-available',this._reason);
    this._remember(record);this._bound=true;this._emit(this._pending?'syncing':'synced',this._pending?'pending':'saved');
   }catch(error){
    if(!this._current(epoch))return this.snapshot;
    this._stop();this._pending=!equalBundle(this._local,this._record?.bundle);
    if(error.code==='conflict'){
     // Show the new remote version for explicit choice, but do not accept it as
     // our write base. A later autosave must never retry over this conflict.
     try{this._record=this._validateRecord(error.record);if(!this._record)throw failure('invalid-record','변경된 계정 기록을 확인하지 못했어요.');}catch(invalid){return this._emit('error','invalid-record',invalid);}
     return this._emit('conflict','remote-changed',error);
    }
    return this._emit(error.code==='account-changed'||error.code==='metadata-unavailable'||error.code?.startsWith('invalid')||error.code==='empty-save'?'error':'offline',error.code||'connection-failed',error);
   }
  }
  return this.snapshot;
 }
 dispose(){if(this._disposed)return;this._disposed=true;this._epoch++;this._abort.abort();this._stop();}
}
