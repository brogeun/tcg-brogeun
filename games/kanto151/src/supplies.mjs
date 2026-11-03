import {t,addMessages} from './i18n.mjs';
import {beginnerSurvivalRemaining} from './survival-rules.mjs';
addMessages({
 'supply.beginnerActive':{ko:'첫 탐험 보호 · 앞으로 {minutes}분 {seconds}초 동안 허기·갈증 소모가 절반, 고갈 피해가 ¼로 줄어요. 메뉴를 닫고 탐험한 누적 10분 뒤 끝나요.',en:'First expedition assistance · {minutes}m {seconds}s left: hunger/thirst drain is halved and depletion damage is quartered. It ends after 10 minutes of active exploration.'},
 'supply.beginnerEnded':{ko:'첫 탐험 보호가 끝났어요. 이제 허기·갈증 소모와 고갈 피해가 정상 적용돼요. 출발 전 음식과 물통을 확인하세요.',en:'First expedition assistance has ended. Normal hunger/thirst drain and depletion damage now apply. Check food and water before heading out.'},
 'supply.waterGoal':{ko:'보급 준비 · {name} 찾아가기',en:'Prepare supplies · Visit {name}'},
 'supply.firstWater':{ko:'첫 보급 · {name}에서 물 마시기',en:'First refill · Drink at {name}'},
 'supply.waterGuide':{ko:'수원까지 안내',en:'Guide me to water'},
 'supply.waterGuideHint':{ko:'식수대에서 직접 마시거나 물통을 채우세요. 가방의 물통은 현장에서 바로 사용할 수 있어요.',en:'Drink directly or refill your canteen at the water station. You can also use canteen charges from your bag.'},
 'supply.waterGuided':{ko:'가까운 이용 가능한 수원을 목표로 정했어요',en:'An available water station is now your objective'}
});
import {BASE_LAYOUT} from './base-layout.mjs';
// Balancing values use active exploration seconds, never wall-clock time.
export const SUPPLY_RULES=Object.freeze({appleChance:.30,treeRespawn:180,canteenCapacity:2,canteenRecovery:40,appleRecovery:25,rationRecovery:35,fieldBerryRecovery:12,fieldBerryChance:.35,beginnerFoodGrace:600,campAidMinimum:3,campAidCooldown:300,directWaterRecovery:100,campFoodLimit:2,campRefill:480,inputGuardMs:350});
export const WATER_SOURCES=Object.freeze([
 {id:'verdant-spring',region:'verdant',name:'새싹 캠프 식수대',x:BASE_LAYOUT.points.drink[0],z:BASE_LAYOUT.points.drink[1]},
 {id:'waterside-spring',region:'waterside',name:'물빛 해안 식수대',x:-18,z:16},
 {id:'highlands-spring',region:'highlands',name:'화석길 바위샘',x:-29,z:-18,shortcut:'highlands-fossilbreak',condition:'바위깨기로 금 간 화석길을 열면 이용할 수 있어요'}
]);
// Reuse these authored tree models; Pokémon encounter trees remain separate.
export const APPLE_TREES=Object.freeze([
 {id:'verdant-apple-1',region:'verdant',prop:9},{id:'verdant-apple-2',region:'verdant',prop:11},{id:'verdant-apple-3',region:'verdant',prop:14},
 {id:'waterside-apple-1',region:'waterside',prop:10},{id:'waterside-apple-2',region:'waterside',prop:12},{id:'waterside-apple-3',region:'waterside',prop:15}
]);
export function ensureSupplies(save){const n=save.survival,legacy=n.provisions===undefined;
 if(legacy)n.provisions={version:1,capacity:SUPPLY_RULES.canteenCapacity,trees:{},sources:{'verdant-spring':{discovered:true,unlocked:true}},rationReadyAt:(save.playTime||0)+SUPPLY_RULES.campRefill};
 const p=n.provisions;if(p&&p.aidReadyAt===undefined)p.aidReadyAt=Math.max(0,save.playTime||0);if(!p||p.version!==1||!Number.isInteger(p.capacity)||p.capacity<1||p.capacity>20||!Number.isFinite(p.rationReadyAt)||p.rationReadyAt<0||!Number.isFinite(p.aidReadyAt)||p.aidReadyAt<0||!p.trees||typeof p.trees!=='object'||Array.isArray(p.trees)||!p.sources||typeof p.sources!=='object'||Array.isArray(p.sources))throw Error('Invalid provisions record.');
 for(const [key,value] of Object.entries(p.trees))if(!APPLE_TREES.some(t=>t.id===key)||!value||!Number.isFinite(value.readyAt)||value.readyAt<0||!Number.isSafeInteger(value.attempts)||value.attempts<1)throw Error('Invalid apple tree record.');
 for(const [key,value] of Object.entries(p.sources))if(!WATER_SOURCES.some(s=>s.id===key)||!value||typeof value.discovered!=='boolean'||typeof value.unlocked!=='boolean'||(value.unlocked&&!value.discovered))throw Error('Invalid water source record.');
 for(const id of ['apple','ration','canteen']){if(save.inventory[id]===undefined)save.inventory[id]=legacy?(id==='ration'?SUPPLY_RULES.campFoodLimit:id==='canteen'?p.capacity:0):0;const value=save.inventory[id];if(!Number.isSafeInteger(value)||value<0||(id==='canteen'&&value>p.capacity))throw Error('Invalid portable provisions.');}
 return save;
}
export const foodCount=s=>(s.inventory.apple||0)+(s.inventory.ration||0);
export const treeWait=(s,id)=>Math.max(0,Math.ceil((s.survival.provisions.trees[id]?.readyAt||0)-s.playTime));
export function harvestApple(save,id,random=Math.random){if(!APPLE_TREES.some(t=>t.id===id)||treeWait(save,id))return null;const p=save.survival.provisions,previous=p.trees[id];p.trees[id]={readyAt:save.playTime+SUPPLY_RULES.treeRespawn,attempts:(previous?.attempts||0)+1};const success=random()<SUPPLY_RULES.appleChance;if(success)save.inventory.apple++;return {success};}
export function rationReason(save){if(foodCount(save)>=SUPPLY_RULES.campFoodLimit)return t('supply.rationFull',{limit:SUPPLY_RULES.campFoodLimit});const wait=Math.ceil(save.survival.provisions.rationReadyAt-save.playTime);return wait>0?t('supply.rationWait',{wait}):'';}
export function claimRations(save){if(rationReason(save))return 0;const count=SUPPLY_RULES.campFoodLimit-foodCount(save);save.inventory.ration+=count;save.survival.provisions.rationReadyAt=save.playTime+SUPPLY_RULES.campRefill;return count;}
export const sourceReady=(save,source)=>!!source&&(!source.shortcut||!!save.survival.provisions.sources[source.id]?.unlocked);
export function observeSources(save,position){let changed=false;for(const source of WATER_SOURCES){if(source.region!==save.region)continue;const p=save.survival.provisions,state=p.sources[source.id],near=Math.hypot(position.x-source.x,position.z-source.z)<=8,opened=!!(source.shortcut&&save.expedition?.shortcuts?.includes(source.shortcut));if((near||opened)&&(!state?.discovered||(!state.unlocked&&(!source.shortcut||opened)))){p.sources[source.id]={discovered:true,unlocked:!source.shortcut||opened};changed=true;}}return changed;}
export function useSupply(save,id){if(!['apple','ration','canteen'].includes(id)||!save.inventory[id])return false;const key=id==='canteen'?'thirst':'hunger';if(save.survival[key]>=100)return false;const amount=id==='canteen'?SUPPLY_RULES.canteenRecovery:id==='apple'?SUPPLY_RULES.appleRecovery:SUPPLY_RULES.rationRecovery;save.inventory[id]--;save.survival[key]=Math.min(100,save.survival[key]+amount);return true;}
export function refillCanteen(save){const capacity=save.survival.provisions.capacity;if(save.inventory.canteen>=capacity)return false;save.inventory.canteen=capacity;(save.flags??={})['water-supply-learned']=true;return true;}
export function sourceList(game){const g=game,queue=[[g.save.region,0]],hops=new Map();while(queue.length){const [id,n]=queue.shift();if(hops.has(id))continue;hops.set(id,n);for(const next of g.biomeById.get(id)?.connections||[])queue.push([next,n+1]);}return WATER_SOURCES.filter(s=>g.save.survival.provisions.sources[s.id]?.discovered).sort((a,b)=>(Number(!sourceReady(g.save,a))-Number(!sourceReady(g.save,b)))||(hops.get(a.region)??99)-(hops.get(b.region)??99)||(a.region===g.save.region?Math.hypot(a.x-g.player.model.position.x,a.z-g.player.model.position.z)-Math.hypot(b.x-g.player.model.position.x,b.z-g.player.model.position.z):a.id.localeCompare(b.id)));}
export const sourceName=source=>t('supply.source.'+source.id);
export function supplyAdvice(game){const s=game.save,source=sourceList(game).find(x=>sourceReady(s,x)),supply=t('supply.inventory',{water:s.inventory.canteen,capacity:s.survival.provisions.capacity,food:foodCount(s)});return supply+(source?(source.region===s.region?t('supply.nearSource',{name:sourceName(source),distance:Math.round(Math.hypot(source.x-game.player.model.position.x,source.z-game.player.model.position.z))}):t('supply.returnSource',{name:sourceName(source),region:game.biomeById.get(source.region).name})):t('supply.noSource'));}

export function campAid(save){const p=save.survival.provisions;if(save.inventory['poke-ball']>=SUPPLY_RULES.campAidMinimum||save.playTime<p.aidReadyAt)return 0;const amount=SUPPLY_RULES.campAidMinimum-save.inventory['poke-ball'];save.inventory['poke-ball']+=amount;p.aidReadyAt=save.playTime+SUPPLY_RULES.campAidCooldown;return amount;}
export function campAidText(save){const wait=Math.max(0,Math.ceil(save.survival.provisions.aidReadyAt-save.playTime));return wait?t('supply.aidWait',{wait}):t('supply.aidReady',{minimum:SUPPLY_RULES.campAidMinimum,cooldown:SUPPLY_RULES.campAidCooldown});}
export const shouldDropFood=(save,random=Math.random)=>save.playTime<SUPPLY_RULES.beginnerFoodGrace||random()<SUPPLY_RULES.fieldBerryChance;

export function survivalAssistanceText(save){const left=Math.ceil(beginnerSurvivalRemaining(save));return left?t('supply.beginnerActive',{minutes:Math.floor(left/60),seconds:left%60}):t('supply.beginnerEnded');}
// Only guide to sources already discovered and usable under existing shortcut rules.
export function waterSourceGoal(game){if(!game?.save?.survival?.provisions||!game.biomeById||!game.player?.model?.position)return null;const save=game.save,learning=!save.flags?.['water-supply-learned']&&beginnerSurvivalRemaining(save)>0;if(!learning&&save.survival.thirst>=85&&save.inventory.canteen>=save.survival.provisions.capacity)return null;const source=sourceList(game).find(s=>sourceReady(game.save,s));if(!source)return null;const here=source.region===game.save.region,point=here?{x:source.x,z:source.z}:game.expedition?.routeExit(source.region)?.position;if(!here&&!point)return null;return {id:'supply:water:'+source.id,kind:'supply',sourceId:source.id,region:source.region,point,here,ready:true,required:0,additional:0,name:t(learning?'supply.firstWater':'supply.waterGoal',{name:sourceName(source)}),description:t('supply.waterGuideHint')+' '+supplyAdvice(game),benefit:t('supply.waterGuideHint'),urgent:game.save.survival.thirst<20||(game.save.survival.thirst<40&&!game.save.inventory.canteen)};}
