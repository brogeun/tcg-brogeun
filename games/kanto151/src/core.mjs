import {ensureSupplies,SUPPLY_RULES} from './supplies.mjs';
export const SAVE_VERSION = 3;
export const SAVE_KEY = 'tcghub:kanto151:v3';
export const LEGACY_SAVE_KEY = 'tcghub:kanto151:v2';
export const TYPE_COLORS = {normal:'#dbd9ba',fire:'#ff845b',water:'#63cfff',electric:'#ffe478',grass:'#a0db6b',ice:'#adf7f4',fighting:'#ff9b80',poison:'#d799ff',ground:'#dbc190',flying:'#b8c5ff',psychic:'#ff95c7',bug:'#c2d76c',rock:'#d8bc94',ghost:'#b7a4ef',dragon:'#a197ff',dark:'#a4979a',steel:'#c7e1e1',fairy:'#ffb8e5'};
export const BALLS = {'poke-ball':{name:'Poké Ball',multiplier:1,price:35,color:0xf46159},'great-ball':{name:'Great Ball',multiplier:1.6,price:95,color:0x5a9fff},'ultra-ball':{name:'Ultra Ball',multiplier:2.3,price:180,color:0xffca59}};
export const ITEMS = {apple:{name:'사과',portable:true,description:`허기 ${SUPPLY_RULES.appleRecovery} 회복 · 나무 채집 성공 시 1개`},ration:{name:'기본 식량',portable:true,description:`허기 ${SUPPLY_RULES.rationRecovery} 회복 · 캠프 제한 보급`},canteen:{name:'물통',portable:true,description:`1회분으로 갈증 ${SUPPLY_RULES.canteenRecovery} 회복 · 수원에서 충전`},potion:{name:'Potion',price:30,description:'Restores 60 HP.'},revive:{name:'Revive',price:90,description:'Revives your whole party at half HP.'},'rare-candy':{name:'Rare Candy',price:180,description:'Raises a partner by one level.'},'fire-stone':{name:'Fire Stone',price:400},'water-stone':{name:'Water Stone',price:400},'thunder-stone':{name:'Thunder Stone',price:400},'leaf-stone':{name:'Leaf Stone',price:400},'moon-stone':{name:'Moon Stone',price:400},'link-cable':{name:'Link Cable',price:450},'fishing-rod':{name:'Fishing Rod',price:150},'helix-fossil':{name:'Helix Fossil',price:600},'dome-fossil':{name:'Dome Fossil',price:600},'old-amber':{name:'Old Amber',price:800},'poke-flute':{name:'Poké Flute',price:450}};
export const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export const BALL_SUPPLY_RULES=Object.freeze({start:12,startGreat:0,restMinimum:3,cacheBalls:1,cacheRespawn:300,landmarkBalls:1,streakEvery:5,streakBalls:1,researchGreat:2,milestoneGreatSmall:1,milestoneGreat:2,milestoneUltra:1});
export const SURVIVAL_RATES=Object.freeze({multiplier:1.75,hunger:Object.freeze({idle:.055,moving:.095}),thirst:Object.freeze({idle:.085,moving:.14}),warning:20,saveMinimum:25,depletionDamageFraction:.08});
export function advanceSurvival(save,dt,moving=false){const needs=save.survival;if(!needs||!Number.isFinite(dt)||dt<=0)return;for(const key of ['hunger','thirst'])needs[key]=clamp(needs[key]-dt*SURVIVAL_RATES[key][moving?'moving':'idle']*SURVIVAL_RATES.multiplier,0,100);}
export function eatFoodDrop(save,id){const needs=save.survival,index=needs.drops.findIndex(drop=>drop.id===id);if(index<0||needs.hunger>=100)return false;needs.drops.splice(index,1);needs.hunger=clamp(needs.hunger+SUPPLY_RULES.fieldBerryRecovery,0,100);return true;}
export function drinkWater(save){const needs=save.survival;if(needs.thirst>=100)return false;needs.thirst=clamp(needs.thirst+SUPPLY_RULES.directWaterRecovery,0,100);return true;}
export const uid=()=>globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
export const nice=s=>String(s??'').replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase());
export function newSave(){return ensureSupplies({version:SAVE_VERSION,starter:null,party:[],collection:[],dex:{},inventory:{'poke-ball':BALL_SUPPLY_RULES.start,'great-ball':BALL_SUPPLY_RULES.startGreat,potion:8,revive:3,'fishing-rod':1},coins:300,region:'camp',position:[0,10],discovered:['camp'],bosses:[],flags:{},quests:{},survival:{hunger:100,thirst:100,drops:[]},settings:{volume:.4,quality:'auto',camera:1,motion:true,shake:.65,vibration:false,locale:'ko-KR'},playTime:0,worldTime:9,weather:'clear',savedAt:null});}
export function maxHP(species,level){return Math.floor((2*species.baseStats.hp*level)/100)+level+18;}
export function makePokemon(species,level=5,shiny=false){const p={uid:uid(),id:species.id,level,exp:0,shiny,friendship:20,hp:maxHP(species,level),status:null};return p;}
export function registerSeen(save,id,shiny=false){const d=save.dex[id]??={seen:false,caught:false,shinySeen:false,shinyCaught:false};d.seen=true;if(shiny)d.shinySeen=true;return d;}
export function registerCaught(save,pokemon){const entry=registerSeen(save,pokemon.id,pokemon.shiny),fresh=!entry.caught;entry.caught=true;if(pokemon.shiny)entry.shinyCaught=true;save.collection.push(pokemon);if(save.party.length<6)save.party.push(pokemon.uid);save.coins+=fresh?100:20;return fresh;}
export function caughtCount(save){return Object.values(save.dex).filter(d=>d.caught).length;}
export function expNeeded(level){return 30+level*15;}
export function awardExp(p,species,amount){let levels=0;p.exp+=Math.round(amount);p.friendship=clamp(p.friendship+3,0,255);while(p.exp>=expNeeded(p.level)&&p.level<100){p.exp-=expNeeded(p.level);p.level++;levels++;p.hp=maxHP(species,p.level);}return levels;}
export function evolutionOptions(p,species,save){return (species.evolutions||[]).filter(e=>{
 const required=e.item||(e.trigger==='trade'?'link-cable':null);
 return (!e.minLevel||p.level>=e.minLevel)&&(!required||save.inventory[required]>0)&&(!e.minHappiness||p.friendship>=e.minHappiness);
});}
export function evolve(save,p,species,evolution,byId){if(!evolutionOptions(p,species,save).includes(evolution))throw Error('Evolution requirements are not met.');const next=byId.get(evolution.to);if(!next)throw Error('Unknown evolution.');const item=evolution.item||(evolution.trigger==='trade'?'link-cable':null);if(item)save.inventory[item]--;p.id=next.id;p.hp=maxHP(next,p.level);registerSeen(save,p.id,p.shiny).caught=true;if(p.shiny)save.dex[p.id].shinyCaught=true;return next;}
export function captureChance(species,hp,max,ball='poke-ball',status=null){if(!Number.isFinite(max)||max<=0)throw Error('Invalid capture target HP.');const health=(3*max-2*clamp(hp,0,max))/(3*max),ailment=['sleep','freeze'].includes(status)?2:['paralysis','poison','burn','stun'].includes(status)?1.5:1;return clamp((species.captureRate/255)*health*(BALLS[ball]?.multiplier??1)*ailment+.035,.035,.98);}
export function damageFormula(attacker,defender,move,chart={},random=Math.random){const a=attacker.species,d=defender.species,special=move.damageClass==='special';const attack=a.baseStats[special?'specialAttack':'attack'],defense=d.baseStats[special?'specialDefense':'defense'];const actualPower=move.engine?.power??move.power??0;if(actualPower<=0)return {damage:0,effectiveness:1};const base=(((2*attacker.level/5+2)*Math.max(0,move.engine?.power??move.power??0)*attack/Math.max(20,defense))/50)+3;let effectiveness=1;for(const t of d.types)effectiveness*=chart[move.type]?.[t]??1;const stab=a.types.includes(move.type)?1.3:1;return {damage:effectiveness===0?0:Math.max(1,Math.round(base*effectiveness*stab*(.9+random()*.2))),effectiveness};}
export function requirementsMet(req={},save){if(typeof req==='string')return !!save.flags[req];if(Array.isArray(req))return req.every(r=>requirementsMet(r,save));return (!req.caughtCount||caughtCount(save)>=req.caughtCount)&&(!req.item||save.inventory[req.item]>0)&&(!req.bosses||req.bosses.every(id=>save.bosses.includes(id)))&&(!req.flag||save.flags[req.flag])&&(!req.time||req.time===(save.worldTime>=6&&save.worldTime<19?'day':'night'))&&(!req.weather||save.weather===req.weather);}
export function serialize(save){return JSON.stringify({...save,version:SAVE_VERSION,savedAt:new Date().toISOString()});}
export function parseSave(text){const s=JSON.parse(text);if(!s||typeof s!=='object'||s.version>SAVE_VERSION||!Array.isArray(s.collection)||!Array.isArray(s.party)||!s.dex)throw Error('This is not a supported Kanto 151 save.');
 const base=newSave(),out={...base,...s,version:SAVE_VERSION,settings:{...base.settings,...s.settings},flags:{...s.flags},inventory:{...s.inventory},survival:{...base.survival,...s.survival}};
 if(s.survival?.provisions===undefined)delete out.survival.provisions;ensureSupplies(out);
 if(out.expedition?.rareNests!==undefined){const r=out.expedition.rareNests;if(!r||typeof r!=='object'||Array.isArray(r)||Object.keys(r).length>4||Object.entries(r).some(([k,v])=>! /^(verdant:(1|25)|waterside:7|highlands:4)$/.test(k)||!v||!Number.isFinite(v.readyAt)||v.readyAt<0||!Number.isInteger(v.misses)||v.misses<0||v.misses>4))throw Error('Invalid rare habitat record.');}
 if(s.collection.length>20000)throw Error('Save collection is too large.');
 if(out.starter!==null&&![1,4,7,25].includes(out.starter))throw Error('Invalid starter record.');if(out.starter!==null&&!out.party.length)throw Error('The expedition has no active party.');const ids=new Set();for(const p of out.collection){if(!Number.isInteger(p.id)||p.id<1||p.id>151||!Number.isInteger(p.level)||p.level<1||p.level>100||!Number.isFinite(p.hp)||p.hp<0||!Number.isFinite(p.exp)||p.exp<0||typeof p.uid!=='string'||!/^[A-Za-z0-9_.-]{1,80}$/.test(p.uid)||ids.has(p.uid))throw Error('Save contains invalid Pokémon.');ids.add(p.uid);}
 for(const p of out.collection){const fields=['moveIds','knownMoveIds','pendingMoveIds'];if(fields.every(k=>p[k]===undefined))continue;const valid=(a,max)=>Array.isArray(a)&&a.length<=max&&new Set(a).size===a.length&&a.every(id=>Number.isInteger(id)&&id>0&&id<=1000);if(!valid(p.moveIds,4)||!p.moveIds.length||!valid(p.knownMoveIds,1000)||!valid(p.pendingMoveIds,1000)||p.moveIds.some(id=>!p.knownMoveIds.includes(id))||p.pendingMoveIds.some(id=>!p.knownMoveIds.includes(id)||p.moveIds.includes(id)))throw Error('Invalid saved move choices.');}
 for(const p of out.collection){if(p.cooldowns!==undefined&&(typeof p.cooldowns!=='object'||p.cooldowns===null||Array.isArray(p.cooldowns)||Object.entries(p.cooldowns).some(([id,v])=>!/^\d+$/.test(id)||+id<1||+id>1000||!Number.isFinite(v)||v<0||v>120)))throw Error('Invalid saved cooldowns.');if(p.basicCooldown!==undefined&&(!Number.isFinite(p.basicCooldown)||p.basicCooldown<0||p.basicCooldown>120))throw Error('Invalid basic cooldown.');}
 if(out.party.length>6||new Set(out.party).size!==out.party.length||out.party.some(id=>!ids.has(id)))throw Error('Save party references missing or repeated Pokémon.');
 for(const [id,d] of Object.entries(out.dex))if(!Number.isInteger(Number(id))||+id<1||+id>151||!d||typeof d.caught!=='boolean')throw Error('Invalid Pokédex record.');
 for(const [key,n] of Object.entries(out.inventory))if(!Number.isFinite(n)||n<0)throw Error(`Invalid inventory: ${key}`);
 if(!Number.isFinite(out.survival.hunger)||out.survival.hunger<0||out.survival.hunger>100||!Number.isFinite(out.survival.thirst)||out.survival.thirst<0||out.survival.thirst>100||!Array.isArray(out.survival.drops)||out.survival.drops.length>24)throw Error('Invalid survival state.');
 const dropIds=new Set();for(const drop of out.survival.drops){if(!drop||typeof drop.id!=='string'||!/^[A-Za-z0-9_.-]{1,80}$/.test(drop.id)||dropIds.has(drop.id)||typeof drop.region!=='string'||!['verdant','waterside','highlands','caldera','complex'].includes(drop.region)||![drop.x,drop.z,drop.createdAt].every(Number.isFinite)||Math.abs(drop.x)>70||Math.abs(drop.z)>70||drop.createdAt<0)throw Error('Invalid food drop.');dropIds.add(drop.id);}
 if(!Number.isFinite(out.coins)||out.coins<0||!Number.isFinite(out.worldTime)||out.worldTime<0||out.worldTime>=24)throw Error('Invalid progression state.');
 if(!Array.isArray(out.position)||out.position.length!==2||out.position.some(v=>!Number.isFinite(v)||Math.abs(v)>70))throw Error('Invalid saved position.');
 if(!['camp','grassland','forest','lake','coast','mountain','cave','wetland','powerplant','ruins','safari','volcano','frozen','laboratory','verdant','waterside','highlands','caldera','complex'].includes(out.region))throw Error('Invalid saved region.');
 if(!Number.isFinite(out.settings.volume)||out.settings.volume<0||out.settings.volume>1||!['auto','high','low'].includes(out.settings.quality))throw Error('Invalid settings.');
 if(typeof out.settings.motion!=='boolean'||!Number.isFinite(out.settings.camera)||out.settings.camera<.2||out.settings.camera>3)throw Error('Invalid camera settings.');
 if(!Array.isArray(out.bosses)||out.bosses.some(id=>![144,145,146,150,151].includes(id))||!Array.isArray(out.discovered)||out.discovered.some(id=>typeof id!=='string'))throw Error('Invalid exploration records.');
 if(out.collection.some(p=>typeof p.shiny!=='boolean'))throw Error('Invalid shiny identity.');
 // A Pokémon already owned in an older save is registered even when its evolution entry was omitted.
 for(const p of out.collection){const d=out.dex[p.id]??={seen:false,caught:false,shinySeen:false,shinyCaught:false};d.seen=true;d.caught=true;if(p.shiny){d.shinySeen=true;d.shinyCaught=true;}if(d.shinyCaught)d.shinySeen=true;}
 for(const d of Object.values(out.dex))if((d.shinyCaught&&!d.caught)||(d.caught&&!d.seen))throw Error('Inconsistent Pokédex states.');
 if(!['ko-KR','en-US'].includes(out.settings.locale))out.settings.locale='ko-KR';out.settings.shake=clamp(Number(out.settings.shake)||0,0,1);
 return out;
}
export function storeSave(save,storage=globalThis.localStorage){const text=serialize(save);parseSave(text);const old=storage.getItem(SAVE_KEY);if(old){try{parseSave(old);storage.setItem(SAVE_KEY+':backup',old);}catch{}}storage.setItem(SAVE_KEY,text);save.savedAt=JSON.parse(text).savedAt;return text;}
export function loadSave(storage=globalThis.localStorage){for(const key of [SAVE_KEY,SAVE_KEY+':backup',LEGACY_SAVE_KEY,LEGACY_SAVE_KEY+':backup']){const raw=storage.getItem(key);if(raw){try{return parseSave(raw);}catch{}}}return null;}
export function usableMoves(species,level,movesById){if(species.id===25&&level>=40)return [84,98,85,344].map(id=>movesById.get(id)).filter(Boolean);let moves=species.learnset.filter(m=>m.method==='level-up'&&m.level<=level).map(m=>movesById.get(m.moveId)).filter(Boolean);const attack=moves.filter(m=>m.power>0);const same=attack.filter(m=>species.types.includes(m.type));const signature=movesById.get(species.signatureMoveId);let picked=[attack[0],same.at(-1),signature&&level>=15?signature:attack.at(-1),moves.filter(m=>!m.power).at(-1)].filter(Boolean);picked=[...new Map(picked.map(m=>[m.id,m])).values()];for(const m of [...attack].reverse())if(!picked.includes(m)&&picked.length<4)picked.push(m);if(!picked.length){const tackle=movesById.get(33);if(tackle)picked.push(tackle);}return picked.slice(0,4);}


// The automatic set is used only for a newly acquired partner or an old save.
export function learnableMoveIds(species,level,movesById){
 const ids=species.learnset.filter(m=>m.method==='level-up'&&m.level<=level).map(m=>m.moveId);
 if(level>=15)ids.push(species.signatureMoveId);
 ids.push(...usableMoves(species,level,movesById).map(m=>m.id));
 return [...new Set(ids)].filter(id=>movesById.has(id));
}
export function ensureMoveState(p,species,movesById){
 if(!Array.isArray(p.moveIds)){
  p.moveIds=usableMoves(species,p.level,movesById).map(m=>m.id);
  p.knownMoveIds=learnableMoveIds(species,p.level,movesById);
  p.pendingMoveIds=[];
 }else if([...p.moveIds,...p.knownMoveIds,...p.pendingMoveIds].some(id=>!movesById.has(id))){
  p.moveIds=p.moveIds.filter(id=>movesById.has(id));
  if(!p.moveIds.length)p.moveIds=usableMoves(species,p.level,movesById).map(m=>m.id);
  p.knownMoveIds=[...new Set([...p.knownMoveIds.filter(id=>movesById.has(id)),...p.moveIds])];
  p.pendingMoveIds=p.pendingMoveIds.filter(id=>movesById.has(id)&&!p.moveIds.includes(id));
 }
 return p;
}
export function pokemonMoves(p,species,movesById){ensureMoveState(p,species,movesById);return p.moveIds.map(id=>movesById.get(id)).filter(Boolean);}
export function unlockMoveChoices(p,species,movesById){
 ensureMoveState(p,species,movesById);
 const fresh=learnableMoveIds(species,p.level,movesById).filter(id=>!p.knownMoveIds.includes(id));
 p.knownMoveIds.push(...fresh);p.pendingMoveIds.push(...fresh.filter(id=>!p.moveIds.includes(id)));
 return fresh;
}
export function decideMove(p,moveId,slot=null){
 if(!p.knownMoveIds?.includes(moveId)||p.moveIds.includes(moveId))return false;
 if(slot!==null){
  if(!Number.isInteger(slot)||slot<0||slot>Math.min(3,p.moveIds.length))return false;
  p.moveIds[slot]=moveId;
 }
 p.pendingMoveIds=p.pendingMoveIds.filter(id=>id!==moveId);
 return true;
}
