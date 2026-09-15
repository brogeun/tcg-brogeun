import {recommendObjective} from './objectives.mjs';
import {beginFieldAction} from './field-actions.mjs';
import {caughtCount,BALL_SUPPLY_RULES,requirementsMet} from './core.mjs';
import {t,addMessages,currentLocale,entity} from './i18n.mjs';
import {THREE} from './world.mjs';
export const MILESTONES=[5,10,20,30,50,75,100,125,150,151];
const copy={
 'exp.fieldWorking':{en:'{skill} · working',ko:'{skill} · 작업 중'},'exp.fieldInterrupt':{en:'Move to cancel safely.',ko:'이동 입력으로 안전하게 중단할 수 있어요.'},'exp.fieldCancelled':{en:'Field action cancelled safely.',ko:'탐험 동작을 안전하게 중단했어요.'},'exp.fieldCleared':{en:'The passage is open. Walk through freely.',ko:'통행로가 열려 있어요. 걸어서 지나가세요.'},'exp.fieldArrived':{en:'Arrived safely',ko:'안전하게 도착했어요'},'exp.fieldUnsafe':{en:'The route is not safe to use here.',ko:'지금 위치에서는 안전하게 사용할 수 없어요.'},
 'exp.labDoor':{en:'Research laboratory access',ko:'생명 연구실 출입문'},'exp.labPending':{en:'Interior reconstruction is pending.',ko:'내부 구획을 복구하는 중입니다.'},'exp.labOpen':{en:'Access granted. Follow the corridor.',ko:'출입이 허가되었어요. 회랑을 따라 들어가세요.'},
 'exp.fiveOpening':{en:'Explore the meadow ahead, then follow the trail to the Elderroot Tree. The camp offers healing, supplies and research.',ko:'가방에 기본 식량 2개와 물통 2회분을 준비했어요. 파란 물방울 식수대에서 물통을 채운 뒤, 초원과 큰 나무를 탐험하세요. 화산·연구단지에는 수원이 없어요.'},
 'exp.bridge':{en:'Bridge',ko:'다리'},'exp.surf':{en:'Water traversal',ko:'수상 이동'},
 'exp.walkGoal':{en:'Walk toward goal',ko:'목표를 향해 이동'},
 'interaction.restTrail':{en:'Rest at the trail camp',ko:'탐험 쉼터에서 휴식'},'interaction.followTrail':{en:'Follow the trail',ko:'탐험로 따라가기'},'interaction.fishing':{en:'Cast your fishing rod',ko:'낚싯대 던지기'},'interaction.dig':{en:'Excavate the fossil bed',ko:'화석 지층 발굴'},'interaction.pickup':{en:'Collect field supplies',ko:'탐험 보급품 줍기'},'boss.sanctuary':{en:'Sanctuary encounter',ko:'성역의 기척'},
 'exp.next':{en:'Next expedition goal',ko:'다음 탐험 목표'},'exp.landmark':{en:'Landmark discovered',ko:'명소 발견'},
 'exp.reward':{en:'+{balls} Poké Balls · +{funds} research funds',ko:'몬스터볼 +{balls} · 연구 자금 +{funds}'},
 'exp.milestone':{en:'Pokédex milestone · {count} species',ko:'도감 연구 달성 · {count}종'},
 'exp.nextMilestone':{en:'Next reward: {count} / {goal} species',ko:'다음 보상: {count} / {goal}종'},
 'exp.capability':{en:'Permanent field skill unlocked',ko:'영구 탐험 능력 해금'},
 'exp.capabilityReason':{en:'Catch {count} species or befriend {family}',ko:'{count}종 포획 또는 {family} 계열과 동료 되기'},
 'exp.routeOpened':{en:'A new route is open',ko:'새로운 탐험로가 열렸어요'},
 'exp.permit':{en:'Register {count} species ({now} now)',ko:'도감 {count}종 등록 (현재 {now}종)'},
 'exp.alternate':{en:'Or: {count} species + {landmarks} landmarks + {skill}',ko:'또는 {count}종 + 명소 {landmarks}곳 + {skill}'},
 'exp.openHint':{en:'The route is open. Follow the exit marker or use the map.',ko:'열린 길이에요. 출구 표식을 따라가거나 지도를 이용하세요.'},
 'exp.connectedVia':{en:'First discover a connecting region: {regions}',ko:'연결된 지역을 먼저 발견하세요: {regions}'},
 'exp.connected':{en:'Discover a connected region first',ko:'먼저 연결된 지역을 발견하세요'},
 'exp.habitat':{en:'Habitat target · {pokemon}',ko:'서식지 추적 · {pokemon}'},
 'exp.habitatRegion':{en:'Search {region}. Exact rare locations stay hidden.',ko:'{region}에서 찾아보세요. 희귀 포켓몬의 정확한 위치는 탐험으로 알아내세요.'},
 'exp.track':{en:'Track habitat on map',ko:'지도에서 서식지 추적'},'exp.trackLandmark':{en:'Track this landmark',ko:'이 명소를 목표로 지정'},
 'exp.clearTrack':{en:'Clear habitat target',ko:'서식지 추적 해제'},'exp.mapLocal':{en:'Local field map',ko:'현재 지역 지도'},
 'exp.mapLegend':{en:'▲ You · ◆ Objective · ○ Landmark · + Rest · 💧 Drink · ● Food · ↗ Exit',ko:'▲ 현재 위치 · ◆ 목표 · ○ 명소 · + 휴식 · 💧 식수 · ● 음식 · ↗ 출구'},
 'survival.drinkSpot':{en:'Drink clean water',ko:'깨끗한 물 마시기'},'survival.eatDrop':{en:'Eat field berry',ko:'떨어진 열매 먹기'},
 'survival.drunk':{en:'Thirst restored',ko:'갈증이 해소됐어요'},'survival.waterFull':{en:'Not thirsty right now',ko:'지금은 목마르지 않아요'},
 'survival.ate':{en:'Hunger restored',ko:'배고픔이 줄었어요'},'survival.foodFull':{en:'Already full; the berry stays here',ko:'배가 불러 열매를 그대로 두었어요'},
 'interaction.shakeTree':{en:'Shake tree',ko:'나무 흔들기'},'interaction.inspectNest':{en:'Inspect nest',ko:'둥지 살펴보기'},
 'survival.lowHint':{en:'Eat berries left by defeated wild Pokémon (E), or drink at the blue water barrel (E). Empty gauges drain HP and return all progress to your last checkpoint.',ko:'야생 포켓몬이 떨어뜨린 열매를 E로 먹거나, 파란 식수통에서 E로 물을 마시세요. 0이 되면 체력이 줄고, 사망하면 마지막 저장대 기록으로 돌아가요.'},
 'survival.low':{en:'Your partner needs food or water',ko:'파트너에게 먹을 것과 물이 필요해요'},
 'survival.hunger':{en:'Hunger',ko:'허기'},'survival.thirst':{en:'Thirst',ko:'갈증'},
 'survival.mapWater':{en:'Clean water',ko:'마실 수 있는 물'},'survival.mapFood':{en:'Field berry',ko:'먹을 수 있는 열매'},
 'survival.waterMap':{en:'Clean water',ko:'마실 수 있는 물'},'survival.foodMap':{en:'Field berry',ko:'먹을 수 있는 열매'},
 'exp.fog':{en:'Explore to reveal landmarks and sanctuaries.',ko:'주변을 탐험하면 명소와 성역이 지도에 표시돼요.'},
 'exp.safe':{en:'Travel to rest point',ko:'쉼터로 빠른 이동'},'exp.visit':{en:'Follow expedition route',ko:'탐험로로 이동'},
 'exp.unseen':{en:'Uncharted',ko:'미발견'},'exp.current':{en:'You are here',ko:'현재 위치'},'exp.discovered':{en:'Discovered',ko:'발견 완료'},'exp.open':{en:'Route open',ko:'진입 가능'},
 'exp.landmarkProgress':{en:'Landmarks {done} / {total}',ko:'명소 {done} / {total}'},
 'exp.localResearch':{en:'Local research {percent}% · {unknown} species to discover',ko:'지역 연구 {percent}% · 아직 못 잡은 포켓몬 {unknown}종'},
 'exp.researchTask':{en:'Habitat study: catch 3 different local species ({done}/3)',ko:'서식지 연구: 이 지역에서 서로 다른 3종 포획 ({done}/3)'},
 'exp.researchDone':{en:'Habitat study complete',ko:'서식지 연구 완료'},
 'exp.streak':{en:'Capture streak ×{count}',ko:'연속 포획 ×{count}'},
 'exp.shortcut':{en:'Shortcut opened',ko:'지름길 개방'},'exp.shortcutUse':{en:'Use {skill} · {name}',ko:'{skill} 사용 · {name}'},
 'exp.needSkill':{en:'Requires {skill}',ko:'{skill} 능력이 필요해요'},
 'exp.weather':{en:'The weather is changing',ko:'날씨가 바뀌고 있어요'},
 'exp.weatherHint':{en:'New habitat opportunities may be active. Check the journal.',ko:'지금 만날 수 있는 포켓몬이 달라졌어요. 도감의 서식 조건을 확인하세요.'},
 'exp.rare':{en:'An unusual presence in this region',ko:'이 지역에서 특별한 기척이 느껴져요'},
 'exp.rareHint':{en:'Explore the nests and habitat pockets; listen for a shimmer.',ko:'둥지와 주변 서식지를 둘러보세요. 반짝임의 소리에도 귀 기울여 보세요.'},
 'exp.board':{en:'Expedition route board',ko:'탐험 안내판'},
 'exp.distance':{en:'{name} · {distance} m',ko:'{name} · {distance}m'},
 'exp.nextRoute':{en:'Next route: {region}',ko:'다음 탐험로: {region}'},
 'tutorial.move':{en:'WASD to move. Right-click the ground to walk there.',ko:'WASD로 이동하세요. 땅을 마우스 오른쪽 버튼으로 누르면 그곳으로 걸어가요.'},
 'tutorial.camera':{en:'Drag the world to rotate your view; wheel to zoom.',ko:'화면을 드래그해 둘러보세요. 휠로 거리를 조절해요.'},
 'tutorial.dodge':{en:'Space to dodge an incoming attack. Watch the recovery ring.',ko:'스페이스로 공격을 피하세요. 회피가 준비될 때까지 잠깐 기다려요.'},
 'tutorial.target':{en:'Press Q to lock on to a nearby wild Pokémon.',ko:'Q를 눌러 가까운 야생 포켓몬을 목표로 정하세요.'},
 'tutorial.basic':{en:'Click the wild Pokémon for a basic attack. Get close enough to connect.',ko:'야생 포켓몬을 클릭해 기본 공격을 해보세요. 몸이 닿을 만큼 가까이 가야 해요.'},
 'tutorial.skill':{en:'Use 1–4 for a skill. Different types have different effects.',ko:'1~4로 기술을 사용하세요. 타입마다 공격의 모양과 효과가 달라요.'},
 'tutorial.capture':{en:'Weaken a wild Pokémon, then press R to throw. Avoid fainting it.',ko:'야생 포켓몬의 체력을 낮춘 뒤 R로 볼을 던지세요. 쓰러뜨리기 전에 포획해요.'},
 'tutorial.dex':{en:'Press J to see your new Pokédex page and habitat clues.',ko:'J를 눌러 새로 등록한 도감과 서식지 힌트를 확인하세요.'},
 'tutorial.landmark':{en:'Follow the ◆ marker to your first landmark and exploration reward.',ko:'◆ 목표를 따라 첫 명소를 찾아 탐험 보상을 받으세요.'},
 'tutorial.map':{en:'Open M for your position, exits, habitat tracking and route requirements.',ko:'M을 눌러 현재 위치·출구·서식지·지역 해금 조건을 확인하세요.'},
 'tutorial.track':{en:'Select an unknown species in the Pokédex and track its habitat.',ko:'도감에서 아직 잡지 못한 포켓몬을 골라 서식지를 추적하세요.'},
 'tutorial.complete':{en:'You are ready to explore. Keep an eye on the next milestone.',ko:'탐험 준비가 끝났어요. 다음 도감 보상을 목표로 자유롭게 떠나보세요.'},
 'ui.critical':{en:'CRITICAL',ko:'급소'},'ui.effective':{en:'Super effective',ko:'효과가 굉장해요'},'ui.resisted':{en:'Not very effective',ko:'효과가 약해요'},'ui.immune':{en:'No effect',ko:'효과 없음'},
 'ui.ready':{en:'Ready',ko:'준비'},'ui.status':{en:'{pokemon} · {status}',ko:'{pokemon} · {status}'},
 'ui.arrival':{en:'REGION DISCOVERED',ko:'새로운 지역 발견'},'ui.language':{en:'Language',ko:'언어'}
};
addMessages(copy);
export const worldText=value=>value?.[currentLocale()]||value?.['en-US']||'';
export function explorationState(save){save.expedition??={};const e=save.expedition;for(const k of ['landmarks','exits','safePoints','capabilities','claimedMilestones','openedRoutes','shortcuts'])if(!Array.isArray(e[k]))e[k]=[];e.research??={};e.activeGoals??={};e.tutorial??={};e.tokens??=0;e.streak??=0;return e;}
export class Expedition{
 constructor(game,compositions){this.game=game;this.compositions=compositions;this.timer=0;this.previousWeather=null;this.rootById=new Map();for(const s of game.species){let root=s;while(root.evolvesFrom&&game.byId.has(root.evolvesFrom))root=game.byId.get(root.evolvesFrom);this.rootById.set(s.id,root.id);}for(const r of Object.values(compositions.regions))for(const l of r.landmarks)addMessages({[l.nameKey]:{ko:l.name['ko-KR'],en:l.name['en-US']},[l.descriptionKey]:{ko:l.description['ko-KR'],en:l.description['en-US']}});}
 get state(){return explorationState(this.game.save);}
 get region(){return this.compositions.regions[this.game.save.region];}
 mark(key){this.state.tutorial[key]=true;}
 has(skill){return this.state.capabilities.includes(skill);}
 capabilityInfo(id){const cap=this.compositions.fieldCapabilities.find(c=>c.id===id);if(!cap)return null;const g=this.game,count=caughtCount(g.save),learned=this.has(id),family=cap.grant.caughtAnyFamilyRootIds.map(id=>g.byId.get(id)?.name).filter(Boolean).join('·'),name=worldText(cap.name),required=cap.grant.orCaughtCount,ko=currentLocale()==='ko-KR';return {id,name,learned,count,required,description:worldText(cap.description),requirement:ko?`${family} 계열 중 1종 포획 또는 도감 ${required}종 등록 (현재 ${count}종)`:`Catch a ${family} family member or register ${required} species (now ${count})`,usage:ko?'조건을 채우면 자동 해금돼요. 기술머신 소비·전투 기술 장착 없이 대상 가까이에서 E 또는 행동 버튼을 누르세요.':'Unlocks automatically. No TM or battle move slot required: approach the obstacle and use E or the action button.'};}

 regionRequirement(id){const g=this.game,b=g.biomeById.get(id),count=b?.requirements.caughtCount||0,skill={lake:'surf',coast:'surf',mountain:'rock-smash',cave:'flash',wetland:'surf',powerplant:'strength',ruins:'flash',safari:'cut',volcano:'rock-smash',frozen:'climb',laboratory:'strength'}[id];return {count,alternativeCount:Math.ceil(count*.85),landmarks:count>50?8:count>15?4:2,skill};}
 permit(id){const g=this.game,b=g.biomeById.get(id);if(!b)return false;if(g.save.discovered.includes(id)||requirementsMet(b.requirements,g.save))return true;const r=this.regionRequirement(id);return r.skill&&caughtCount(g.save)>=r.alternativeCount&&this.state.landmarks.length>=r.landmarks&&this.has(r.skill);}
 requirementText(id){const r=this.regionRequirement(id),g=this.game;if(g.canTravel(id))return t('exp.openHint');if(!g.save.discovered.includes(id)&&!g.biomes.some(b=>g.save.discovered.includes(b.id)&&b.connections.includes(id)))return t('exp.connectedVia',{regions:g.biomes.filter(b=>b.connections.includes(id)).map(b=>b.name).join(' / ')});if(!r.count)return t('exp.connected');const basic=t('exp.permit',{count:r.count,now:caughtCount(g.save)});const cap=this.compositions.fieldCapabilities.find(c=>c.id===r.skill);return basic+(cap?' · '+t('exp.alternate',{count:r.alternativeCount,landmarks:r.landmarks,skill:worldText(cap.name)}):'');}
 entered(){this.previousWeather=this.game.save.weather;this.timer=0;this.refreshUnlocks(true);this.game.world.orbit.yaw=.35;const safe=this.region.safePoint;if(!this.state.safePoints.includes(safe.id)&&this.game.save.discovered.includes(this.region.id))this.state.safePoints.push(safe.id);}
 refreshUnlocks(quiet=false){const g=this.game,e=this.state,count=caughtCount(g.save),caughtRoots=new Set(Object.entries(g.save.dex).filter(([,d])=>d.caught).map(([id])=>this.rootById.get(+id)));
  for(const cap of this.compositions.fieldCapabilities)if(!e.capabilities.includes(cap.id)&&(count>=cap.grant.orCaughtCount||cap.grant.caughtAnyFamilyRootIds.some(id=>caughtRoots.has(id)))){e.capabilities.push(cap.id);if(!quiet){g.notify(t('exp.capability'),worldText(cap.name)+' · '+worldText(cap.description)+' '+(currentLocale()==='ko-KR'?'대상 가까이에서 E / 행동 버튼':'Use E / action near the obstacle'));g.audio.play('level');}}
  const pending=MILESTONES.filter(n=>count>=n&&!e.claimedMilestones.includes(n));for(const n of pending){e.claimedMilestones.push(n);g.save.inventory['great-ball']=(g.save.inventory['great-ball']||0)+(n>=20?BALL_SUPPLY_RULES.milestoneGreat:BALL_SUPPLY_RULES.milestoneGreatSmall);g.save.inventory['ultra-ball']=(g.save.inventory['ultra-ball']||0)+(n>=50?BALL_SUPPLY_RULES.milestoneUltra:0);g.save.inventory['rare-candy']=(g.save.inventory['rare-candy']||0)+1;g.save.coins+=100+n*8;}
  if(pending.length){g.notify(t('exp.milestone',{count:pending.at(-1)}),entity('items',pending.at(-1)>=50?'ultra-ball':'great-ball')+' + '+entity('items','rare-candy'));g.audio.play('register');}
  for(const b of g.biomes)if(this.permit(b.id)&&!e.openedRoutes.includes(b.id)){e.openedRoutes.push(b.id);if(!quiet&&!g.save.discovered.includes(b.id)){g.notify(t('exp.routeOpened'),b.name);g.audio.play('level');g.emit('routeUnlocked',b);}}
 }
 captured(id){const e=this.state,g=this.game;e.streak++;this.mark('capture');if(g.save.playTime<600&&g.player&&g.save.collection.length<=4){g.player.hp=Math.min(g.player.maxHp,g.player.hp+Math.ceil(g.player.maxHp*.35));g.syncPlayer();}const research=e.research[g.save.region]??={caught:[],done:false};if(!research.caught.includes(id))research.caught.push(id);if(research.caught.length>=3&&!research.done){research.done=true;e.tokens+=2;g.save.inventory['great-ball']=(g.save.inventory['great-ball']||0)+BALL_SUPPLY_RULES.researchGreat;g.notify(t('exp.researchDone'),entity('items','great-ball')+' +'+BALL_SUPPLY_RULES.researchGreat);}if(e.streak%BALL_SUPPLY_RULES.streakEvery===0){g.save.inventory['poke-ball']+=BALL_SUPPLY_RULES.streakBalls;g.notify(t('exp.streak',{count:e.streak}),t('exp.reward',{balls:BALL_SUPPLY_RULES.streakBalls,funds:0}));}this.refreshUnlocks();}
 trackSpecies(id){this.state.habitatTarget=id;this.selectedLandmark=null;this.mark('track');const regions=this.habitatRegions(id);this.game.notify(t('exp.habitat',{pokemon:this.game.byId.get(id).name}),t('exp.habitatRegion',{region:regions.map(b=>b.name).join(' / ')}));this.game.openPanel('map');this.game.persist();}
 habitatRegions(id,visited=new Set()){if(visited.has(id))return [];visited.add(id);const direct=this.game.biomes.filter(b=>b.spawnTable.some(s=>s.speciesId===id)||b.specialEncounters.some(s=>s.speciesId===id));if(direct.length)return direct;const from=this.game.byId.get(id)?.evolvesFrom;return from?this.habitatRegions(from,visited):[];}
 objective(){const g=this.game,e=this.state;if(e.habitatTarget&&g.save.dex[e.habitatTarget]?.caught)e.habitatTarget=null;if(e.habitatTarget){const regions=this.habitatRegions(e.habitatTarget),here=regions.some(b=>b.id===g.save.region);if(!here){const destination=regions.find(b=>g.canTravel(b.id))||regions[0],exit=this.routeExit(destination?.id);if(exit)return {name:t('exp.habitat',{pokemon:g.byId.get(e.habitatTarget).name}),description:t('exp.habitatRegion',{region:regions.map(b=>b.name).join(' / ')}),point:exit.position,region:destination?.id};}else return {name:t('exp.habitat',{pokemon:g.byId.get(e.habitatTarget).name}),description:g.byId.get(e.habitatTarget).habitatHint,point:null};}
  if(this.selectedLandmark){const l=this.region.landmarks.find(l=>l.id===this.selectedLandmark&&!e.landmarks.includes(l.id));if(l)return {id:l.id,name:worldText(l.name),description:worldText(l.description),point:l.interactionPosition||l.position};this.selectedLandmark=null;}return recommendObjective(g);
 }
 routeExit(destination){if(!destination)return null;const queue=[[this.game.save.region]],seen=new Set();while(queue.length){const route=queue.shift(),last=route.at(-1);if(last===destination)return this.region.entrances.find(e=>e.to===route[1]);if(seen.has(last))continue;seen.add(last);for(const id of this.game.biomeById.get(last).connections)queue.push([...route,id]);}return null;}
 distance(p){return this.game.player?Math.hypot(p.x-this.game.player.model.position.x,p.z-this.game.player.model.position.z):0;}
 discover(l){if(this.state.landmarks.includes(l.id))return;this.state.landmarks.push(l.id);this.state.tokens++;this.mark('landmark');const g=this.game;g.save.inventory['poke-ball']+=BALL_SUPPLY_RULES.landmarkBalls;g.save.coins+=120;g.notify(t('exp.landmark'),worldText(l.name)+' · '+t('exp.reward',{balls:BALL_SUPPLY_RULES.landmarkBalls,funds:120}));g.audio.play('register');g.world.ring(new THREE.Vector3(l.position.x,g.world.height(l.position.x,l.position.z),l.position.z),0xd9e9a6,4,1.2);this.refreshUnlocks();g.persist();}
 interact(i){const g=this.game;if(i.kind==='mapboard'){this.mark('map');g.openPanel('map');return true;}if(i.kind==='landmark'){this.discover(i.landmark);return true;}if(i.kind!=='capability')return false;const s=i.shortcut,cap=this.compositions.fieldCapabilities.find(c=>c.id===s.capability);if(!this.has(s.capability)){g.notify(t('exp.needSkill',{skill:worldText(cap.name)}),t('exp.capabilityReason',{count:cap.grant.orCaughtCount,family:cap.grant.caughtAnyFamilyRootIds.map(id=>g.byId.get(id).name).join(' / ')}));return true;}return beginFieldAction(g,s);}
 update(dt){this.timer-=dt;if(this.timer>0)return;this.timer=.25;const g=this.game,e=this.state;if(g.movementDistance>4)this.mark('move');for(const l of this.region.landmarks)if(this.distance(l.interactionPosition||l.position)<l.discoveryRadius)this.discover(l);for(const exit of this.region.entrances)if(this.distance(exit.position)<12&&!e.exits.includes(g.save.region+':'+exit.to))e.exits.push(g.save.region+':'+exit.to);
  const hour=Math.floor(g.save.worldTime),weather=['clear','mist','clear','rain'][Math.floor(hour/6)%4];if(g.save.playTime>90&&g.save.weather!==weather&&hour%6===0){g.save.weather=weather;if(this.previousWeather!==weather){this.previousWeather=weather;g.notify(t('exp.weather'),t('exp.weatherHint'));}}
 }
 tutorial(){const g=this.game,now=g.save.playTime;if(now>900||g.save.collection.length>8)return '';if(this.hintSave!==g.save){this.hintSave=g.save;this.hintSeen=new Set();this.activeHint=null;this.nextHint=0;}if(this.activeHint){const h=this.activeHint;if(now-h.started<8&&!this.state.tutorial[h.key])return t('tutorial.'+h.key);this.hintSeen.add(h.key);this.activeHint=null;this.nextHint=now+6;}if(now<this.nextHint)return '';const keys=['move','camera','dodge','target','basic','skill','capture','dex','landmark','map','track'];const key=keys.find(k=>!this.state.tutorial[k]&&!this.hintSeen.has(k));if(!key)return '';this.activeHint={key,started:now};return t('tutorial.'+key);}
}
