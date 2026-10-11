import {entity} from './i18n.mjs';
import {requirementsMet,evolutionOptions} from './core.mjs';
import {rareNestInfo} from './rare-encounters.mjs';
const methodName={field:'야생 서식 구역',tree:'나무 흔들기',nest:'둥지 살펴보기',fishing:'낚시터',fossil:'화석 복원',gift:'연구대 만남',dojo:'도장 만남',boss:'성역 도전'};
// Tracking uses the actual action object, not an invented spawn coordinate.
export function trackedHabitatGoal(g,id,visited=new Set()){
 if(visited.has(id))return null;visited.add(id);const species=g.byId.get(id),region=g.biomeById.get(g.save.region);if(!species||!region)return null;
 const entries=[...region.spawnTable,...region.specialEncounters].filter(e=>e.speciesId===id);
 if(!entries.length&&species.evolvesFrom){const parent=g.byId.get(species.evolvesFrom),e=parent.evolutions.find(e=>e.to===id),owned=g.save.collection.find(p=>p.id===parent.id);const condition=e?.minLevel?'LV '+e.minLevel:entity('items',e?.item||'link-cable');if(owned)return {id:'habitat-evolve:'+id,kind:'evolve',uid:owned.uid,to:id,name:parent.name+' → '+species.name+' 진화',description:'보유 친구 LV '+owned.level+' · 진화 조건: '+condition+' · 파티에서 진화를 선택하세요.',point:null,ready:evolutionOptions(owned,parent,g.save).some(option=>option.to===id)};const goal=trackedHabitatGoal(g,parent.id,visited);return goal?{...goal,id:'habitat-parent:'+id,name:parent.name+'를 찾아 '+species.name+'로 진화',description:goal.description+' · 진화 조건: '+condition}:null;}
 const eligible=e=>requirementsMet(e.requirements||{},g.save)&&(!e.time||e.time==='any'||e.time===(g.save.worldTime>=6&&g.save.worldTime<19?'day':'night'))&&(!e.weather||e.weather==='any'||e.weather===g.save.weather);
 const entry=entries.find(eligible)||entries[0];if(!entry)return null;
 const current=g.world.interactions||[],actions=current.filter(i=>i.entry?.speciesId===id||i.acquisition?.speciesId===id||entry.method==='fishing'&&i.kind==='fishing'||['fossil','gift','dojo'].includes(entry.method)&&i.kind==='research');
 // An authored entry has a stable action position across camera/nearby changes.
 let point,area,action=actions[0],pocket=g.compositions.regions[g.save.region].ecologyPockets.find(p=>p.speciesIds.includes(id)&&p.method===entry.method);
 if(action)point={x:action.x,z:action.z,precise:true};else if(pocket){point={x:pocket.center[0],z:pocket.center[1]};area={center:[...pocket.center],radius:[...pocket.radius]};}else{const binding=g.compositions.regions[g.save.region].specialBindings.find(b=>b.speciesId===id);if(binding)point={x:binding.position[0],z:binding.position[1],precise:true};}
 const missing=[];if(!requirementsMet(entry.requirements||{},g.save))missing.push(g.requirementText?.(entry.requirements)||'수집·아이템·보스 조건을 먼저 충족하세요');if(entry.time&&entry.time!=='any')missing.push((entry.time==='night'?'밤':'낮')+'에 출현');if(entry.weather&&entry.weather!=='any')missing.push(entity('weather',entry.weather)+' 날씨');if(entry.method==='fishing'&&!g.save.inventory['fishing-rod'])missing.push('가방에 낚싯대가 필요해요');const rare=rareNestInfo(g.save,entry);if(rare?.remaining)missing.push('탐험 '+rare.remaining+'초 뒤 다시 탐색');
 return {id:'habitat:'+id,kind:'habitat',name:'서식지 추적 · '+species.name,region:g.save.region,point,habitatArea:area,ready:eligible(entry)&&!rare?.remaining&&!(entry.method==='fishing'&&!g.save.inventory['fishing-rod']),description:(methodName[entry.method]||'특별한 만남')+' · '+(action?'지도에 표시한 실제 대상에 가까이 가세요.':area?'지도에 표시한 서식 범위에서 찾아보세요.':species.habitatHint)+(missing.length?' · '+missing.join(' · '):'')};
}
