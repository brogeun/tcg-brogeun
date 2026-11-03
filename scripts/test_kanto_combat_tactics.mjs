import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from '../games/kanto151/vendor/three.module.js';
import * as core from '../games/kanto151/src/core.mjs';
import * as locale from '../games/kanto151/src/i18n.mjs';
import * as combatRules from '../games/kanto151/src/combat-rules.mjs';
import * as statusRules from '../games/kanto151/src/status-rules.mjs';
import * as escapeActions from '../games/kanto151/src/escape-action.mjs';
import {actorAnimationDelta} from '../games/kanto151/src/animation-cadence.mjs';
import {applyWildEcologyPose} from '../games/kanto151/src/wild-ecology-pose.mjs';
import {wildAttackPlan,tacticalAttackReach,attackBusySeconds,lockedAimPoint,wildCombatPursuit} from '../games/kanto151/src/combat-tactics.mjs';
const base={id:33,type:'normal',power:40,engine:{template:'melee',power:40,range:3.8,castTime:.2,knockback:1},feedback:{tier:'light'}};
const point=(x,z)=>({x,y:0,z,clone(){return point(this.x,this.z);}});
const actor=(id,extra={})=>({id,faction:'wild',hp:30,maxHp:30,attackCycle:0,species:{id,types:['normal']},model:{position:point(0,0)},...extra});
const playerAt=(x,z=0)=>({model:{position:point(x,z)}});

test('bird rush announces, locks aim and leaves recovery without modifying base data',()=>{
 const before=structuredClone(base),bird=actor(16),plan=wildAttackPlan(bird,base);
 assert.equal(plan.move.engine.template,'dash');assert.equal(plan.move.engine.lockAim,true);
 assert.ok(plan.move.engine.castTime>=.8);assert.ok(plan.recovery>=1);
 assert.ok(plan.move.engine.power<=base.engine.power);assert.ok(attackBusySeconds(plan)>plan.move.engine.castTime+1);
 assert.deepEqual(base,before);assert.equal(tacticalAttackReach(bird,base),plan.move.engine.range);
 bird.attackCycle=1;assert.equal(wildAttackPlan(bird,base).move.engine.template,'melee');
});

test('rodent flurry keeps the total learned power and has two announced hits',()=>{
 const plan=wildAttackPlan(actor(19),base);
 assert.equal(plan.move.engine.template,'multi-hit');assert.equal(plan.move.engine.hitCount,2);
 assert.equal(plan.move.engine.power,base.engine.power);assert.ok(plan.move.engine.castTime>=.6);
 assert.ok(plan.interval>attackBusySeconds(plan));assert.ok(plan.hintEnglish.includes('Two-hit'));
});

test('tactics cannot modify player moves, support moves or existing elite patterns',()=>{
 for(const a of [actor(16,{faction:'player'}),actor(16,{eliteId:'coast-guard'}),actor(19,{eliteStyle:'stone-guard'})]){
  assert.equal(wildAttackPlan(a,base),null);assert.equal(tacticalAttackReach(a,base),3.8);
 }
 assert.equal(wildAttackPlan(actor(16),{...base,engine:{...base.engine,power:0}}),null);
 assert.equal(wildAttackPlan(actor(16),null),null);
});

test('boss signature windows have distinct marked shapes and do not add base damage',()=>{
 const expected={144:'radial-aoe',145:'beam',146:'cone',150:'ground-aoe',151:'beam'};
 for(const [id,template] of Object.entries(expected)){
  const boss=actor(Number(id),{boss:true,hp:10,maxHp:100,attackCycle:2}),plan=wildAttackPlan(boss,base);
  assert.equal(plan.move.engine.template,template);assert.ok(plan.move.engine.castTime>=1);
  assert.equal(plan.move.engine.power,base.engine.power);assert.ok(plan.recovery>=.9);
  assert.ok(plan.hint);assert.ok(plan.hintEnglish);assert.ok(plan.interval>attackBusySeconds(plan));
 }
 const boss=actor(145,{boss:true,hp:80,maxHp:100,attackCycle:2});
 assert.equal(wildAttackPlan(boss,base).move.engine.template,'melee');
});

test('locked aim snapshots the target and is never used for player input',()=>{
 const bird=actor(16),target=playerAt(5,2),move=wildAttackPlan(bird,base).move;
 const locked=lockedAimPoint(bird,target,move);target.model.position.x=9;
 assert.deepEqual([locked.x,locked.z],[5,2]);assert.notEqual(locked,target.model.position);
 assert.equal(lockedAimPoint({...bird,faction:'player'},target,move),null);
 assert.equal(lockedAimPoint(bird,target,base),null);
});

test('ranged actors maintain a stable spacing band and keep retreat directions finite',()=>{
 const ranged={...base,type:'electric',engine:{...base.engine,template:'projectile',range:15}},magnet=actor(81,{species:{id:81,types:['electric']}});
 let result=wildCombatPursuit(magnet,playerAt(4),[ranged]);assert.ok(result.x<0);assert.equal(magnet.tacticalRetreat,true);
 result=wildCombatPursuit(magnet,playerAt(6.5),[ranged]);assert.ok(result.x<0);assert.equal(magnet.tacticalRetreat,true);
 assert.equal(wildCombatPursuit(magnet,playerAt(8.1),[ranged]),null);assert.equal(magnet.tacticalRetreat,false);
 assert.equal(wildCombatPursuit(magnet,playerAt(10),[ranged]).x,10);
 assert.equal(wildCombatPursuit(magnet,playerAt(0),[ranged]),null);
 assert.equal(wildCombatPursuit(magnet,playerAt(27),[ranged]),null);
});

test('birds approach inside the next actual attack range instead of stalling outside it',()=>{
 const bird=actor(16);
 assert.equal(wildCombatPursuit(bird,playerAt(5),[base]),null);
 bird.attackCycle=1;assert.ok(wildCombatPursuit(bird,playerAt(5),[base]));
 assert.equal(wildCombatPursuit(bird,playerAt(2.4),[base]),null);
 const elite=actor(95,{eliteId:'stone-guard'});assert.equal(wildCombatPursuit(elite,playerAt(7),[base]).x,7);
});

// Exercise the current cast(), dodge() and updateActor() bodies intact. Only
// rendering and the empty flat test arena are adapters; the scheduled attacks,
// movement, status rules and HP calculations are the published game methods.
const gameRoot=new URL('../games/kanto151/',import.meta.url);
const readData=name=>JSON.parse(readFileSync(new URL('data/'+name+'.json',gameRoot),'utf8'));
const speciesData=readData('species'),moveData=readData('moves'),typeChart=readData('type-chart');
const speciesById=new Map(speciesData.map(s=>[s.id,s])),movesById=new Map(moveData.map(m=>[m.id,m]));
locale.configureLocale({messages:readData('locale-messages'),entities:readData('locale-entities'),literals:readData('locale-literals')});
function publishedModule(file,names,dependencies){
 const source=readFileSync(new URL('src/'+file,gameRoot),'utf8').replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
 return new Function(...Object.keys(dependencies),source+'\nreturn {'+names.join(',')+'};')(...Object.values(dependencies));
}
const geometryRules=publishedModule('combat-feedback.mjs',['actorRadius','contactReach','feedbackProfile'],{THREE,...core});
const {cancelFieldAction}=publishedModule('field-actions.mjs',['cancelFieldAction'],{THREE,...locale,statusRules});
const {Game}=publishedModule('game.mjs',['Game'],{
 THREE,...core,...locale,...combatRules,...geometryRules,statusRules,escapeActions,
 wildAttackPlan,wildCombatPursuit,attackBusySeconds,lockedAimPoint,cancelFieldAction,
 actorAnimationDelta,applyWildEcologyPose,
 // The test world is a level dry plane with no collision/habitat blockers.
 waterAt:()=>null,deckAt:()=>null,habitatValid:()=>true,wildGroundHeight:()=>0,
});
const noop=()=>{};
function combatActor(id,x,z=0,faction='wild'){
 const model=new THREE.Group();model.position.set(x,0,z);model.userData={height:1,update:noop};
 return {id,faction,species:speciesById.get(id),model,home:model.position.clone(),level:5,
  hp:1000,maxHp:1000,status:null,statusTime:0,action:null,actionTime:0,castSerial:0,
  shield:0,buff:0,debuff:0,dodgeCooldown:0,invincible:0,moving:false,angry:faction==='wild'};
}
function combatFixture(id=16,distance=9){
 const g=Object.create(Game.prototype),save=core.newSave(),player=combatActor(1,distance,0,'player'),foe=combatActor(id,0);
 const warnings=[],hits=[];
 Object.assign(g,{save,phase:'playing',panel:null,player,wild:[foe],target:foe,tasks:[],projectiles:[],regionEpoch:1,
  inputVector:new THREE.Vector3(),byId:speciesById,moveById:movesById,chart:typeChart,motionPreference:{matches:false},
  world:{height:()=>0,collision:(x,z)=>[x,z],ring:noop,burst:noop},
  feedback:{windup:noop,travel:noop,area:noop,impact:noop,line:(from,to,color,width,duration)=>warnings.push({from:from.clone(),to:to.clone(),duration})},
  audio:{play:noop},emit:noop,notify:noop,syncPlayer:noop,
  expedition:{has:()=>false,mark:noop},canStandAt:()=>true,canStepTo:()=>true,
 });
 g.hit=function(attacker,target,move,multiplier=1,options){
  const hp=target.hp;Game.prototype.hit.call(this,attacker,target,move,multiplier,options);
  if(target.hp<hp)hits.push({at:save.playTime,attacker,target,move,multiplier,damage:hp-target.hp});
 };
 return {g,player,foe,warnings,hits};
}
function advanceCombat(g,seconds){
 for(let remaining=seconds;remaining>1e-8;){
  const dt=Math.min(.01,remaining);remaining-=dt;g.save.playTime+=dt;
  for(const a of [g.player,...g.wild])g.updateActor(a,dt);
  const due=[];g.tasks=g.tasks.filter(task=>{task.delay-=dt;if(task.delay<=1e-8){due.push(task);return false;}return true;});
  for(const task of due)task.fn();
 }
}

for(const distance of [9,1])test(`real bird cast can be sidestepped with real dodge from ${distance}m before its locked impact`,()=>{
 const {g,player,foe,warnings,hits}=combatFixture(16,distance),plan=wildAttackPlan(foe,movesById.get(16));
 g.cast(foe,player,plan.move);assert.equal(warnings.length,1);assert.equal(warnings[0].to.x,distance);
 assert.ok(warnings[0].duration>=.8,'the direction is visible for the full windup');
 advanceCombat(g,.2);g.inputVector.set(0,0,1);g.dodge();advanceCombat(g,1.7);
 assert.ok(player.model.position.z>5,'the actual dodge advances the player sideways');
 assert.equal(player.invincible,0,'success is not hidden by remaining dodge invincibility');
 assert.equal(hits.length,0);assert.equal(player.hp,1000);
 assert.ok(Math.abs(foe.model.position.z)<1e-8,'the bird never tracks the lateral dodge');
 if(distance>2)assert.ok(foe.model.position.x>6,'the rush actually travels down its original line');
});

test('the real locked rush still reaches and damages a player who stays in its line',()=>{
 const {g,player,foe,hits}=combatFixture(16,9),plan=wildAttackPlan(foe,movesById.get(16));
 g.cast(foe,player,plan.move);advanceCombat(g,.79);assert.equal(player.hp,1000);
 advanceCombat(g,.7);assert.equal(hits.length,1);assert.ok(player.hp<1000);
 assert.ok(hits[0].at>=plan.move.engine.castTime);assert.equal(foe.dash,null);
});

test('real rodent cast schedules exactly two hits at .14s spacing with one total power budget',()=>{
 const {g,player,foe,hits}=combatFixture(19,2),move=movesById.get(33),plan=wildAttackPlan(foe,move);
 const originalRandom=Math.random;Math.random=()=>.5;
 try{
  g.cast(foe,player,plan.move);assert.equal(g.tasks.length,2);
  assert.deepEqual(g.tasks.map(t=>Number(t.delay.toFixed(3))),[.6,.74]);
  advanceCombat(g,.59);assert.equal(hits.length,0);
  advanceCombat(g,.02);assert.equal(hits.length,1);
  advanceCombat(g,.13);assert.equal(hits.length,2);
  assert.ok(Math.abs(hits[1].at-hits[0].at-.14)<1e-8);
  assert.equal(hits.reduce((sum,h)=>sum+h.multiplier,0),1);
  assert.equal(plan.move.engine.power,move.engine.power);
  const fullDamage=core.damageFormula(foe,player,plan.move,typeChart,()=>.5).damage;
  const actual=hits.reduce((sum,h)=>sum+h.damage,0);
  assert.ok(Math.abs(actual-fullDamage)<=1,'two rounded half hits retain the same damage budget');
 }finally{Math.random=originalRandom;}
});

test('real player dash keeps its existing release-time aim, timing and controls',()=>{
 const {g,player,foe,warnings}=combatFixture(19,0);foe.model.position.set(5,0,0);
 const move=movesById.get(98);g.cast(player,foe,move);
 advanceCombat(g,.02);foe.model.position.z=3;advanceCombat(g,.05);
 assert.ok(player.dash);assert.equal(player.dash.aimPoint,null);
 assert.ok(player.dash.direction.z>0,'player aiming still uses target position at release');
 assert.ok(player.dash.time<=.42);assert.equal(warnings.length,0,'enemy telegraphs are not added to player input');
 const start=player.model.position.clone();advanceCombat(g,.1);
 assert.ok(player.model.position.distanceTo(start)>0,'the original player dash continues moving');
});

test('a hard status during real windup still cancels a wild planned attack',()=>{
 const {g,player,foe,hits}=combatFixture(16,9),plan=wildAttackPlan(foe,movesById.get(16));
 g.cast(foe,player,plan.move);advanceCombat(g,.2);foe.status='stun';foe.statusTime=2;advanceCombat(g,1.3);
 assert.equal(foe.dash,null);assert.equal(hits.length,0);assert.equal(player.hp,1000);
});
