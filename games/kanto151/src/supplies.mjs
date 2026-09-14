// Balancing values use active exploration seconds, never wall-clock time.
export const SUPPLY_RULES=Object.freeze({appleChance:.30,treeRespawn:180,canteenCapacity:2,canteenRecovery:40,appleRecovery:25,rationRecovery:35,fieldBerryRecovery:42,directWaterRecovery:100,campFoodLimit:2,campRefill:480,inputGuardMs:350});
export const WATER_SOURCES=Object.freeze([
 {id:'verdant-spring',region:'verdant',name:'새싹 캠프 식수대',x:0,z:14},
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
 const p=n.provisions;if(!p||p.version!==1||!Number.isInteger(p.capacity)||p.capacity<1||p.capacity>20||!Number.isFinite(p.rationReadyAt)||p.rationReadyAt<0||!p.trees||typeof p.trees!=='object'||Array.isArray(p.trees)||!p.sources||typeof p.sources!=='object'||Array.isArray(p.sources))throw Error('Invalid provisions record.');
 for(const [key,value] of Object.entries(p.trees))if(!APPLE_TREES.some(t=>t.id===key)||!value||!Number.isFinite(value.readyAt)||value.readyAt<0||!Number.isSafeInteger(value.attempts)||value.attempts<1)throw Error('Invalid apple tree record.');
 for(const [key,value] of Object.entries(p.sources))if(!WATER_SOURCES.some(s=>s.id===key)||!value||typeof value.discovered!=='boolean'||typeof value.unlocked!=='boolean'||(value.unlocked&&!value.discovered))throw Error('Invalid water source record.');
 for(const id of ['apple','ration','canteen']){if(save.inventory[id]===undefined)save.inventory[id]=legacy?(id==='ration'?SUPPLY_RULES.campFoodLimit:id==='canteen'?p.capacity:0):0;const value=save.inventory[id];if(!Number.isSafeInteger(value)||value<0||(id==='canteen'&&value>p.capacity))throw Error('Invalid portable provisions.');}
 return save;
}
export const foodCount=s=>(s.inventory.apple||0)+(s.inventory.ration||0);
export const treeWait=(s,id)=>Math.max(0,Math.ceil((s.survival.provisions.trees[id]?.readyAt||0)-s.playTime));
export function harvestApple(save,id,random=Math.random){if(!APPLE_TREES.some(t=>t.id===id)||treeWait(save,id))return null;const p=save.survival.provisions,previous=p.trees[id];p.trees[id]={readyAt:save.playTime+SUPPLY_RULES.treeRespawn,attempts:(previous?.attempts||0)+1};const success=random()<SUPPLY_RULES.appleChance;if(success)save.inventory.apple++;return {success};}
export function rationReason(save){if(foodCount(save)>=SUPPLY_RULES.campFoodLimit)return `휴대 식량이 ${SUPPLY_RULES.campFoodLimit}개 이상이에요`;const wait=Math.ceil(save.survival.provisions.rationReadyAt-save.playTime);return wait>0?`탐험 시간 ${wait}초 뒤 보충 가능`:'';}
export function claimRations(save){if(rationReason(save))return 0;const count=SUPPLY_RULES.campFoodLimit-foodCount(save);save.inventory.ration+=count;save.survival.provisions.rationReadyAt=save.playTime+SUPPLY_RULES.campRefill;return count;}
export const sourceReady=(save,source)=>!!source&&(!source.shortcut||!!save.survival.provisions.sources[source.id]?.unlocked);
export function observeSources(save,position){let changed=false;for(const source of WATER_SOURCES){if(source.region!==save.region)continue;const p=save.survival.provisions,state=p.sources[source.id],near=Math.hypot(position.x-source.x,position.z-source.z)<=8,opened=!!(source.shortcut&&save.expedition?.shortcuts?.includes(source.shortcut));if((near||opened)&&(!state?.discovered||(!state.unlocked&&(!source.shortcut||opened)))){p.sources[source.id]={discovered:true,unlocked:!source.shortcut||opened};changed=true;}}return changed;}
export function useSupply(save,id){if(!['apple','ration','canteen'].includes(id)||!save.inventory[id])return false;const key=id==='canteen'?'thirst':'hunger';if(save.survival[key]>=100)return false;const amount=id==='canteen'?SUPPLY_RULES.canteenRecovery:id==='apple'?SUPPLY_RULES.appleRecovery:SUPPLY_RULES.rationRecovery;save.inventory[id]--;save.survival[key]=Math.min(100,save.survival[key]+amount);return true;}
export function refillCanteen(save){const capacity=save.survival.provisions.capacity;if(save.inventory.canteen>=capacity)return false;save.inventory.canteen=capacity;return true;}
export function sourceList(game){const g=game,queue=[[g.save.region,0]],hops=new Map();while(queue.length){const [id,n]=queue.shift();if(hops.has(id))continue;hops.set(id,n);for(const next of g.biomeById.get(id)?.connections||[])queue.push([next,n+1]);}return WATER_SOURCES.filter(s=>g.save.survival.provisions.sources[s.id]?.discovered).sort((a,b)=>(Number(!sourceReady(g.save,a))-Number(!sourceReady(g.save,b)))||(hops.get(a.region)??99)-(hops.get(b.region)??99)||(a.region===g.save.region?Math.hypot(a.x-g.player.model.position.x,a.z-g.player.model.position.z)-Math.hypot(b.x-g.player.model.position.x,b.z-g.player.model.position.z):a.id.localeCompare(b.id)));}
export function supplyAdvice(game){const s=game.save,source=sourceList(game).find(x=>sourceReady(s,x)),supply=`물통 ${s.inventory.canteen}/${s.survival.provisions.capacity}회 · 휴대 식량 ${foodCount(s)}개`;return supply+(source?` · ${source.region===s.region?'가까운 발견 수원: ':'돌아갈 수원: '}${source.name}${source.region===s.region?' 약 '+Math.round(Math.hypot(source.x-game.player.model.position.x,source.z-game.player.model.position.z))+'m':' ('+game.biomeById.get(source.region).name+')'}`:' · 이용 가능한 발견 수원이 없어요. 시작 캠프로 돌아가세요');}
