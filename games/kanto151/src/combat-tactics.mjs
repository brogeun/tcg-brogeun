// Wild encounter tactics reuse the normal cast, status and damage rules. These
// plans only change an enemy's announced shape, spacing and recovery window.
// They never alter player moves, capture rules, rewards or saved progression.
const BIRDS=new Set([16,17,18,21,22]);
const RODENTS=new Set([19,20]);
const DISTANCE_TYPES=new Set(['water','fire','electric','psychic','ice','ghost','dragon']);
const RANGED_TEMPLATES=new Set(['projectile','homing','beam','cone']);
const idOf=actor=>Number(actor?.id??actor?.species?.id);
const powerOf=move=>Number(move?.engine?.power??move?.power??0);
const isElite=actor=>!!(actor?.eliteId||actor?.eliteStyle);
const cloneMove=(base,engine,tier)=>({...base,engine:{...base.engine,...engine},feedback:{...base.feedback,...(tier?{tier}:{})}});

export function wildAttackPlan(actor,base,{cycle=(actor?.attackCycle||0)+1}={}){
 if(!base?.engine||powerOf(base)<=0||actor?.faction==='player'||isElite(actor))return null;
 const id=idOf(actor),castTime=Math.max(.4,Number(base.engine.castTime)||0);
 if(actor.boss){
  // Retain ordinary attacks between signature windows. A boss' later phase is
  // distinguished by geometry, not by adding damage or an unavoidable status.
  const special=actor.hp<actor.maxHp*.5&&cycle%3===0;
  if(special){
   const patterns={
    144:{template:'radial-aoe',range:8,radius:4.2,castTime:1.15,hint:'얼음 고리 · 원 밖으로 피하세요',hintEnglish:'Ice ring · leave the marked circle',interval:3.6,recovery:1},
    145:{template:'beam',range:20,castTime:1.1,lockAim:true,hint:'직선 번개 · 옆으로 피하세요',hintEnglish:'Lightning beam · dodge sideways',interval:3.4,recovery:.9},
    146:{template:'cone',range:12,castTime:1.05,hint:'불꽃 부채꼴 · 정면에서 벗어나세요',hintEnglish:'Flame cone · leave the front arc',interval:3.5,recovery:1},
    150:{template:'ground-aoe',range:20,radius:4.3,castTime:1.25,hint:'초능력 폭발 · 표시된 원을 벗어나세요',hintEnglish:'Psychic blast · leave the marked circle',interval:3.8,recovery:1.1},
    151:{template:cycle%2?'beam':'ground-aoe',range:18,radius:3.2,castTime:1.15,lockAim:true,hint:cycle%2?'빛의 경로 · 옆으로 피하세요':'빛의 원 · 표시 밖으로 피하세요',hintEnglish:cycle%2?'Light path · dodge sideways':'Light circle · leave the mark',interval:3.6,recovery:1},
   };
   const pattern=patterns[id];
   if(pattern){const {hint,hintEnglish,interval,recovery,...engine}=pattern;return {move:cloneMove(base,engine,'signature'),hint,hintEnglish,interval,recovery};}
  }
  return {move:cloneMove(base,{castTime:Math.max(.55,castTime)}),hint:'공격 준비 · 예고를 보고 피하세요',hintEnglish:'Attack windup · watch the warning',interval:2.9,recovery:.45};
 }
 if(BIRDS.has(id)){
  if(cycle%2===1){
   const range=Math.min(12,Math.max(9,Number(base.engine.range)||0));
   return {move:cloneMove(base,{template:'dash',range,castTime:Math.max(.8,castTime),lockAim:true,power:Math.max(1,Math.round(powerOf(base)*.9))}),hint:'직선 돌진 · 옆으로 피하세요',hintEnglish:'Straight rush · dodge sideways',interval:3.8,recovery:1};
  }
  return {move:cloneMove(base,{castTime:Math.max(.5,castTime)}),hint:'견제 공격 · 거리를 확인하세요',hintEnglish:'Follow-up · watch your distance',interval:3.5,recovery:.55};
 }
 if(RODENTS.has(id))return {move:cloneMove(base,{template:'multi-hit',range:Math.min(3.8,Math.max(3.2,Number(base.engine.range)||0)),castTime:Math.max(.6,castTime),hitCount:2}),hint:'두 번 연속 공격 · 거리를 벌리세요',hintEnglish:'Two-hit flurry · step back',interval:4,recovery:1};
 const ranged=RANGED_TEMPLATES.has(base.engine.template)&&base.engine.range>=8;
 return {move:cloneMove(base,{castTime:ranged?Math.max(.6,castTime):castTime}),hint:ranged?'원거리 공격 · 투사체 경로를 피하세요':'근접 공격 · 잠시 거리를 벌리세요',hintEnglish:ranged?'Ranged attack · leave its path':'Close attack · step out of reach',interval:3.5,recovery:ranged?.45:.35};
}

// Candidate filtering must use the next plan's reach, before incrementing the
// actor's cycle. Otherwise a short-range base move could never start a rush.
export function tacticalAttackReach(actor,base){
 return wildAttackPlan(actor,base)?.move.engine.range??base?.engine?.range??0;
}

export function attackBusySeconds(plan){
 if(!plan)return 0;
 const e=plan.move.engine,travel=e.template==='dash'?.5:e.template==='multi-hit'?(Math.max(1,e.hitCount||1)-1)*.14+.14:.2;
 return Math.max(0,e.castTime||0)+travel+Math.max(0,plan.recovery||0);
}

// Snapshot at windup, never at impact. The returned vector belongs to the cast
// and remains fixed when the target sidesteps. Player aiming is untouched.
export function lockedAimPoint(actor,target,move){
 return actor?.faction==='wild'&&move?.engine?.lockAim&&target?.model?.position?.clone?target.model.position.clone():null;
}

// A stable retreat/hold band avoids chasing right up to the player with a beam
// and avoids reversing every frame at one distance threshold. Collision and
// habitat legality remain owned by moveWildToward in the live game.
export function wildCombatPursuit(actor,target,moves=[]){
 const a=actor?.model?.position,p=target?.model?.position;
 if(!a||!p)return null;
 const dx=p.x-a.x,dz=p.z-a.z,distance=Math.hypot(dx,dz);
 if(!Number.isFinite(distance)||distance>=26||distance<.001)return null;
 if(actor.boss||isElite(actor))return distance>2.2?{x:p.x,z:p.z,speed:actor.boss?3.8:2.8}:null;
 let rangedReach=0,maxReach=3.8;const bird=BIRDS.has(idOf(actor)),rush=bird&&((actor.attackCycle||0)+1)%2===1;
 for(const move of moves){if(powerOf(move)<=0)continue;const reach=Number(move.engine?.range)||0;maxReach=Math.max(maxReach,rush?Math.min(12,Math.max(9,reach)):reach);if(RANGED_TEMPLATES.has(move.engine?.template)&&reach>=8)rangedReach=Math.max(rangedReach,reach);}
 const distanceFighter=rangedReach>0&&(actor.species?.types||[]).some(t=>DISTANCE_TYPES.has(t));
 if(distanceFighter){
  const preferred=Math.max(5.5,Math.min(9,rangedReach*.55));
  const wasRetreating=!!actor.tacticalRetreat;
  actor.tacticalRetreat=distance<(wasRetreating?preferred-.3:preferred-2);
  if(actor.tacticalRetreat){const travel=Math.min(3,preferred-distance+.5);return {x:a.x-dx/distance*travel,z:a.z-dz/distance*travel,speed:2.1};}
  return distance>preferred+1.2?{x:p.x,z:p.z,speed:2.8}:null;
 }
 actor.tacticalRetreat=false;
 const stop=bird?Math.max(2.2,Math.min(5.5,maxReach-1)):2.2;
 return distance>stop?{x:p.x,z:p.z,speed:2.8}:null;
}
