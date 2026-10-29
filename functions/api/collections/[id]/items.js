import {route,respond,meta,LIMITS,readJson,collectionId,revision,cardKeys,versionMatches,registry,selectCollection,rowRecord,notFound,fail,operation,mutateCollection,detail} from '../../../_shared/collections.js';

export const onRequestPut=route(async context=>{
  const id=collectionId(context.params.id),body=await readJson(context.request),expected=revision(body.expectedRevision);
  const add=cardKeys(body.addCardKeys??[],LIMITS.mutationCards),remove=cardKeys(body.removeCardKeys??[],LIMITS.mutationCards);
  if(!add.length&&!remove.length)fail(400,'bad_request','추가하거나 제거할 카드를 선택해 주세요.');
  if(add.length+remove.length>LIMITS.mutationCards)fail(413,'too_large',`한 번에 ${LIMITS.mutationCards}종까지 수정할 수 있습니다.`);
  const removals=new Set(remove);if(add.some(key=>removals.has(key)))fail(400,'bad_request','같은 카드를 동시에 추가하고 제거할 수 없습니다.');
  versionMatches(body.catalogVersion,context.catalog);
  await registry(context,add);
  // Removed keys may have been retired; existing snapshots remain removable.
  const row=await selectCollection(context,id);if(!row)notFound();
  const current=rowRecord(row),next=current.cardKeys.filter(key=>!removals.has(key));const seen=new Set(next);
  for(const key of add)if(!seen.has(key)){seen.add(key);next.push(key);}
  if(next.length>LIMITS.cards)fail(413,'too_large',`컬렉션에는 ${LIMITS.cards}종까지 넣을 수 있습니다.`);
  const op=await operation('items',{expectedRevision:expected,addCardKeys:add,removeCardKeys:remove,catalogVersion:body.catalogVersion,mutationId:body.mutationId});
  const changed=await mutateCollection(context,row,expected,op,{items_json:JSON.stringify(next)});
  if(changed.row.deleted_at)notFound();
  return respond({...meta(context),replayed:changed.replayed,acceptedRevision:changed.acceptedRevision,collection:await detail(context,changed.row)});
},{write:true});
