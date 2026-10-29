import {route,respond,meta,readJson,collectionId,revision,title,description,selectCollection,notFound,detail,operation,mutateCollection,fail,now} from '../../_shared/collections.js';

export const onRequestGet=route(async context=>{
  const id=collectionId(context.params.id),row=await selectCollection(context,id);
  if(!row||row.deleted_at)notFound();
  return respond({...meta(context),collection:await detail(context,row)});
});
export const onRequestPatch=route(async context=>{
  const id=collectionId(context.params.id),body=await readJson(context.request),expected=revision(body.expectedRevision);
  if(body.title===undefined&&body.description===undefined)fail(400,'bad_request','수정할 이름 또는 설명이 필요합니다.');
  const changes={};if(body.title!==undefined)changes.title=title(body.title);if(body.description!==undefined)changes.description=description(body.description);
  const op=await operation('rename',{expectedRevision:expected,...changes,mutationId:body.mutationId});
  const row=await selectCollection(context,id);if(!row)notFound();
  const changed=await mutateCollection(context,row,expected,op,changes);
  if(changed.row.deleted_at)notFound();
  return respond({...meta(context),replayed:changed.replayed,acceptedRevision:changed.acceptedRevision,collection:await detail(context,changed.row)});
},{write:true});
export const onRequestDelete=route(async context=>{
  const id=collectionId(context.params.id),body=await readJson(context.request),expected=revision(body.expectedRevision);
  const op=await operation('delete',{expectedRevision:expected,mutationId:body.mutationId});
  const row=await selectCollection(context,id);if(!row)notFound();
  const changed=await mutateCollection(context,row,expected,op,{deleted_at:now(),items_json:'[]'});
  return respond({...meta(context),deleted:true,id,revision:changed.row.revision,replayed:changed.replayed,acceptedRevision:changed.acceptedRevision});
},{write:true});
