import {route,respond,meta,LIMITS,readJson,collectionId,title,description,cardKeys,snapshot,snapshotCatalog,versionMatches,registry,validateSnapshotScope,detail,rowRecord,ownership,selectCollection,fail,now} from '../../_shared/collections.js';
import {sha256Hex} from '../../_shared/jwt.js';

export const onRequestGet=route(async context=>{
  const query=new URL(context.request.url).searchParams;
  const rawLimit=query.get('limit')??'50',rawCursor=query.get('cursor')??'0';
  if(!/^\d{1,2}$/.test(rawLimit)||!/^\d{1,8}$/.test(rawCursor))fail(400,'bad_request','페이지 요청을 확인해 주세요.');
  const limit=Number(rawLimit),offset=Number(rawCursor);
  if(limit<1||limit>LIMITS.collections)fail(400,'bad_request','페이지 크기를 확인해 주세요.');
  const data=await context.env.DB.prepare('SELECT * FROM collections WHERE user_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id LIMIT ? OFFSET ?').bind(context.user.id,limit+1,offset).all();
  const rows=(data.results||[]),more=rows.length>limit,records=rows.slice(0,limit).map(rowRecord);
  const keys=[...new Set(records.flatMap(row=>row.cardKeys))];
  const cards=await registry(context,keys,{allowMissing:true}),states=await ownership(context,keys,cards);
  const collections=records.map(row=>{const {cardKeys:keys,...summary}=row;return {...summary,ownedCount:keys.filter(key=>states[key]?.owned).length};});
  return respond({...meta(context),collections,nextCursor:more?String(offset+limit):null});
});

export const onRequestPost=route(async context=>{
  const body=await readJson(context.request),id=collectionId(body.id),name=title(body.title),desc=description(body.description??'');
  const keys=cardKeys(body.cardKeys??[]),scope=snapshot(body.snapshot);
  versionMatches(body.catalogVersion,context.catalog);
  const cards=await registry(context,keys),scopeCatalog=scope.kind==='manual'?context.catalog:await snapshotCatalog(context);
  validateSnapshotScope(scope,keys,cards,scopeCatalog);
  const hash=await sha256Hex(JSON.stringify({id,title:name,description:desc,cardKeys:keys,snapshot:scope,catalogVersion:body.catalogVersion}));
  let row=await selectCollection(context,id);
  if(row){if(row.deleted_at||row.create_hash!==hash)fail(409,'idempotency_conflict','이미 사용된 컬렉션 식별자입니다.');return respond({...meta(context),replayed:true,collection:await detail(context,row)});}
  const timestamp=now();
  const result=await context.env.DB.prepare('INSERT INTO collections (user_id,id,title,description,items_json,snapshot_json,catalog_version,create_hash,revision,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,1,?,? WHERE (SELECT COUNT(*) FROM collections WHERE user_id=? AND deleted_at IS NULL) < ? ON CONFLICT(user_id,id) DO NOTHING').bind(context.user.id,id,name,desc,JSON.stringify(keys),JSON.stringify(scope),context.catalog.version,hash,timestamp,timestamp,context.user.id,LIMITS.collections).run();
  row=await selectCollection(context,id);
  if(!row)fail(413,'collection_limit',`컬렉션은 ${LIMITS.collections}개까지 만들 수 있습니다.`);
  if(row.create_hash!==hash||row.deleted_at)fail(409,'idempotency_conflict','이미 다른 내용으로 만든 컬렉션입니다.');
  return respond({...meta(context),replayed:result.meta?.changes!==1,collection:await detail(context,row)},result.meta?.changes===1?201:200);
},{write:true});
