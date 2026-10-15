import {uid,storeSave,requirementsMet} from './core.mjs';
import {migrateFiveSave} from './save-migration.mjs';
import {checkpointKey,makeInitialCheckpoint} from './checkpoints.mjs';

const preservedFlags=['generalArchivedOwner','journeyArchivedOwner','suppliesArchiveReady','resumeWritesBlocked','partnerChanging'];
const rememberFlags=g=>preservedFlags.map(key=>({key,present:Object.hasOwn(g,key),value:g[key]}));
const restoreFlags=(g,flags)=>{for(const {key,present,value} of flags)if(present)g[key]=value;else delete g[key];};
const asError=error=>error instanceof Error?error:new Error(String(error));

function preloadIds(game,save){
 const partner=save.collection.find(p=>p.uid===save.party[0]),time=save.worldTime>=6&&save.worldTime<19?'day':'night';
 const entries=game.biomeById.get(save.region).spawnTable.filter(e=>e.method==='field'&&requirementsMet(e.requirements,save)&&(!e.time||e.time==='any'||e.time===time)&&(!e.weather||e.weather==='any'||e.weather===save.weather));
 return [...new Set([partner.id,...entries.map(e=>e.speciesId).slice(0,12)])];
}

function resetSelections(game){
 game.runeSequence=[];game.moveChoice=null;game.deferredMovePrompts=new Set();game.pendingCompletion=false;
 game.moveManagerUid=null;game.campSelection=null;game.selectedInteraction=null;
 if(game.expedition)game.expedition.selectedLandmark=null;
 if(game.ui){game.ui.campChoice=null;game.ui.partyDetailUid=null;}
}

async function rebuildPrevious(game,before){
 // Region entry registers sightings and rewards. Rebuild against a disposable copy.
 game.save=structuredClone(before.snapshot);game.checkpoint=before.checkpoint;
 if(before.phase==='playing'&&before.save.starter){
  await game.enterRegion(game.save.region,[...before.snapshot.position]);
  if(!game.player)throw Error('기존 탐험의 친구를 다시 불러오지 못했어요.');
 }else{
  game.phase='loading';
  await game.world.build(game.biomeById.get(game.homeRegion||game.biomes[0].id));
  await game.loadShowcase();
  if(before.phase==='starter')game.focusStarter(before.starterId);
 }
 game.save=before.save;game.checkpoint=before.checkpoint;
 if(game.player){
  const p=before.save.collection.find(p=>p.uid===game.player.pokemon.uid);
  if(!p)throw Error('기존 탐험의 친구 기록을 연결하지 못했어요.');
  game.player.pokemon=p;game.player.species=game.byId.get(p.id);game.player.level=p.level;
  game.player.hp=p.hp;game.player.status=p.status;
 }
 game.activeMoves=before.activeMoves;game.cooldowns=before.cooldowns;game.basicCooldown=before.basicCooldown;
 game.spawnIndex=before.spawnIndex;game.autosave=before.autosave;
 if(game.expedition)Object.assign(game.expedition,before.expedition);
 game.phase=before.phase;
}

// The existing resume save is replaced only after the new region and recovery copy are ready.
export async function applyImportedSave(game,input){
 if(game.importApplying||game.transitioning||game.partnerChanging||game.restoring||game.survivalDying||game.checkpointWriting)return {ok:false,error:Error('진행 중인 동작이 끝난 뒤 다시 가져오세요.'),recovered:true};
 const flags=rememberFlags(game);game.importApplying=true;game.partnerChanging=true;
 let before,storage,newKey,keyAttempted=false,regionAttempted=false;
 try{
  const candidate=migrateFiveSave(input,game.compositions);
  if(!candidate.starter)throw Error('함께 탐험할 첫 친구가 없는 기록이에요.');
  storage=game.storage||globalThis.localStorage;
  for(let attempt=0;attempt<8;attempt++){
   candidate.checkpointId=uid();newKey=checkpointKey(candidate);
   if(storage.getItem(newKey)===null)break;
   newKey=null;
  }
  if(!newKey)throw Error('새 복귀 기록을 준비하지 못했어요. 다시 시도해 주세요.');
  makeInitialCheckpoint({save:candidate,compositions:game.compositions,byId:game.byId,biomeById:game.biomeById});
  game.syncPlayer?.();
  if(game.player){const p=game.fieldAction?.start||game.player.model.position;game.save.position=[p.x,p.z];}
  before={save:game.save,snapshot:structuredClone(game.save),checkpoint:game.checkpoint,phase:game.phase,starterId:game.starterId,
   activeMoves:game.activeMoves,cooldowns:game.cooldowns?[...game.cooldowns]:game.cooldowns,basicCooldown:game.basicCooldown,spawnIndex:game.spawnIndex,autosave:game.autosave,
   expedition:game.expedition?{timer:game.expedition.timer,previousWeather:game.expedition.previousWeather,selectedLandmark:game.expedition.selectedLandmark}:null};
  if(game.resources?.preload)await game.resources.preload(preloadIds(game,candidate));
  game.save=candidate;game.player=null;regionAttempted=true;
  await game.enterRegion(candidate.region,candidate.position);
  if(!game.player)throw Error('가져온 탐험의 친구를 불러오지 못했어요.');
  game.syncPlayer?.();game.save.position=[game.player.model.position.x,game.player.model.position.z];
  const prepared=makeInitialCheckpoint(game),{save:recoverySave,...record}=prepared;
  keyAttempted=true;storage.setItem(newKey,JSON.stringify(record));
  // localStorage.setItem is atomic per key. Keep this primary write last.
  storeSave(game.save,storage);
  game.checkpoint=prepared;game.resumeWritesBlocked=false;resetSelections(game);
  return {ok:true,error:null,recovered:true};
 }catch(error){
  if(keyAttempted){try{storage.removeItem(newKey);}catch{}}
  let recovered=true,recoveryError;
  if(regionAttempted){
   try{await rebuildPrevious(game,before);}catch(failure){recovered=false;recoveryError=asError(failure);game.save=before.save;game.checkpoint=before.checkpoint;game.player=null;game.phase='import-recovery-error';}
  }
  restoreFlags(game,flags);
  return {ok:false,error:asError(error),recovered,...(recoveryError?{recoveryError}:{})};
 }finally{
  game.importApplying=false;
  const partner=flags.find(f=>f.key==='partnerChanging');if(partner.present)game.partnerChanging=partner.value;else delete game.partnerChanging;
 }
}
