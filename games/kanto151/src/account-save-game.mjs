import {SAVE_KEY,LEGACY_SAVE_KEY,parseSave} from './core.mjs';
import {migrateFiveSave} from './save-migration.mjs';
import {checkpointKey,validateRecord,makeInitialCheckpoint} from './checkpoints.mjs';

const serialRecord=record=>{if(!record)return null;const {save,...stored}=record;return JSON.stringify(stored);};
const context=(game,save)=>({save,compositions:game.compositions,byId:game.byId,biomeById:game.biomeById});

export function validateAccountGameBundle(bundle,game){
 if(bundle?.schema!==1||typeof bundle.save!=='string'||!(bundle.checkpoint===null||typeof bundle.checkpoint==='string'))throw Error('지원하지 않는 계정 기록이에요.');
 const save=migrateFiveSave(bundle.save,game.compositions);
 if(!save.starter||!save.collection.length||!save.party.length)throw Error('첫 친구가 없는 빈 기록은 계정에 저장할 수 없어요.');
 if(save.collection.some(p=>!game.byId.has(p.id)))throw Error('확인할 수 없는 친구가 포함된 기록이에요.');
 const checkpoint=bundle.checkpoint===null?null:validateRecord(bundle.checkpoint,context(game,save));
 return {save,checkpoint};
}

export function readAccountGameBundle(game){
 if(!game.save.starter)return null;
 const save=JSON.stringify(game.save),stored=game.storage.getItem(checkpointKey(game.save));
 const checkpoint=stored??serialRecord(game.checkpoint);
 const bundle={schema:1,save,checkpoint};
 validateAccountGameBundle(bundle,game);
 return bundle;
}

// Archive only game-owned keys; never inspect the HUB's login/session storage.
export function archiveAccountGameOriginal(game){
 const storage=game.storage,keys=new Set([SAVE_KEY,SAVE_KEY+':backup',LEGACY_SAVE_KEY,LEGACY_SAVE_KEY+':backup',checkpointKey(game.save)]);
 for(let i=0;i<(storage.length||0);i++){const key=storage.key(i);if(key?.startsWith(SAVE_KEY+':checkpoint:')||key?.startsWith(LEGACY_SAVE_KEY+':checkpoint:'))keys.add(key);}
 const original=Object.fromEntries([...keys].map(key=>[key,storage.getItem(key)]));
 const tag='tcghub:kanto151:account-original:'+Date.now()+':'+crypto.randomUUID();
 storage.setItem(tag,JSON.stringify({format:'kanto151-account-original',createdAt:new Date().toISOString(),keys:original,liveSave:JSON.stringify(game.save),checkpoint:serialRecord(game.checkpoint)}));
 return tag;
}

// The title has no live player to mutate. Validate and back up before any replacement,
// then write the main key last; a failed write rolls back the touched keys and memory.
export function applyAccountGameBundle(game,bundle){
 if(game.phase!=='title'||game.transitioning||game.importApplying||game.accountSaveApplying)throw Error('첫 화면에서 계정 기록을 불러와 주세요. 현재 탐험은 먼저 저장해 주세요.');
 const accepted=validateAccountGameBundle(bundle,game),nextContext=context(game,accepted.save);
 const checkpoint=accepted.checkpoint||makeInitialCheckpoint(nextContext),key=checkpointKey(accepted.save),storage=game.storage;
 const changes=[[key,serialRecord(checkpoint)],[SAVE_KEY,JSON.stringify(accepted.save)]],previous=changes.map(([k])=>[k,storage.getItem(k)]);
 archiveAccountGameOriginal(game);
 game.accountSaveApplying=true;
 try{
  for(const [k,value] of changes)storage.setItem(k,value);
 }catch(error){
  let failed=false;
  for(const [k,value] of previous){try{if(value===null)storage.removeItem(k);else storage.setItem(k,value);}catch{failed=true;}}
  if(failed)throw Error('기기 저장 공간을 확인해 주세요. 원본 백업은 보관했으며 자동 계정 저장을 중단했어요.');
  throw error;
 }finally{game.accountSaveApplying=false;}
 game.save=accepted.save;game.checkpoint=checkpoint;game.resumeWritesBlocked=false;
 // The region/player will be built by the usual Continue action, with no capture or rewards here.
 if(game.expedition){game.expedition.timer=0;game.expedition.previousWeather=game.save.weather;game.expedition.selectedLandmark=null;}
 return readAccountGameBundle(game);
}

export function accountBundleSummary(bundle,game){
 if(!bundle)return {empty:true};
 try{
  const save=parseSave(bundle.save),partner=save.collection.find(p=>p.uid===save.party[0]);
  return {empty:false,caught:Object.values(save.dex).filter(d=>d.caught).length,count:save.collection.length,partner:game.byId.get(partner?.id)?.name||'탐험 친구',level:partner?.level||0,minutes:Math.floor(save.playTime/60),savedAt:save.savedAt,region:game.biomeById.get(save.region)?.name||save.region};
 }catch{return {empty:false,invalid:true};}
}
