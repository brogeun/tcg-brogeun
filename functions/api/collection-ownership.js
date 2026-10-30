import {route,respond,meta,LIMITS,readJson,cardKeys,revision,versionMatches,registry,ownership,operation,replay,conflict,fail,now} from '../_shared/collections.js';

export const onRequestGet=route(async context=>{
  const raw=new URL(context.request.url).searchParams.get('cardKeys');
  const keys=cardKeys(raw===null||raw===''?[]:raw.split(','),LIMITS.ownershipCards),cards=await registry(context,keys);
  return respond({...meta(context),ownership:await ownership(context,keys,cards)});
});
export const onRequestPut=route(async context=>{
  const body=await readJson(context.request),[key]=cardKeys([body.cardKey],1),expected=revision(body.expectedRevision,true);
  if(typeof body.manualOwned!=='boolean')fail(400,'bad_request','보유 표시는 참 또는 거짓이어야 합니다.');
  versionMatches(body.catalogVersion,context.catalog);const cards=await registry(context,[key]);
  const op=await operation('ownership',{cardKey:key,manualOwned:body.manualOwned,expectedRevision:expected,catalogVersion:body.catalogVersion,mutationId:body.mutationId});
  const scope=`ownership:${key}`,prior=await replay(context,scope,op);
  if(prior)return respond({...meta(context),replayed:true,acceptedRevision:prior.accepted_revision,ownership:await ownership(context,[key],cards)});
  const db=context.env.DB,timestamp=now(),owner=context.user.id;
  const guard=expected===0
    ? db.prepare('INSERT INTO collection_mutations (user_id,scope_id,request_id,request_hash,accepted_revision,created_at) SELECT ?,?,?,?,1,? WHERE NOT EXISTS(SELECT 1 FROM user_card_states WHERE user_id=? AND card_key=?) ON CONFLICT(user_id,scope_id,request_id) DO NOTHING').bind(owner,scope,op.id,op.hash,timestamp,owner,key)
    : db.prepare('INSERT INTO collection_mutations (user_id,scope_id,request_id,request_hash,accepted_revision,created_at) SELECT user_id,?,?,?,revision+1,? FROM user_card_states WHERE user_id=? AND card_key=? AND revision=? ON CONFLICT(user_id,scope_id,request_id) DO NOTHING').bind(scope,op.id,op.hash,timestamp,owner,key,expected);
  const write=expected===0
    ? db.prepare('INSERT INTO user_card_states (user_id,card_key,manual_owned,revision,updated_at) SELECT ?,?,?,1,? WHERE EXISTS(SELECT 1 FROM collection_mutations WHERE user_id=? AND scope_id=? AND request_id=? AND request_hash=? AND accepted_revision=1) ON CONFLICT(user_id,card_key) DO NOTHING').bind(owner,key,body.manualOwned?1:0,timestamp,owner,scope,op.id,op.hash)
    : db.prepare('UPDATE user_card_states SET manual_owned=?,revision=revision+1,updated_at=? WHERE user_id=? AND card_key=? AND revision=? AND EXISTS(SELECT 1 FROM collection_mutations WHERE user_id=? AND scope_id=? AND request_id=? AND request_hash=? AND accepted_revision=?)').bind(body.manualOwned?1:0,timestamp,owner,key,expected,owner,scope,op.id,op.hash,expected+1);
  const results=await db.batch([guard,write]);
  if(results[1]?.meta?.changes!==1){const retry=await replay(context,scope,op);if(retry)return respond({...meta(context),replayed:true,acceptedRevision:retry.accepted_revision,ownership:await ownership(context,[key],cards)});conflict();}
  return respond({...meta(context),replayed:false,acceptedRevision:expected+1,ownership:await ownership(context,[key],cards)});
},{write:true});
