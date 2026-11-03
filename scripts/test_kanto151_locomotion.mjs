import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {selectLocomotionClip,settleActorLocomotion,steeringCandidates,rememberSteering} from '../games/kanto151/src/locomotion.mjs';
import {updateWildRoaming,moveWildToward} from '../games/kanto151/src/wild-roaming.mjs';
import {wildGroundHeight} from '../games/kanto151/src/wild-roaming.mjs';
import {constrainWild,habitatValid} from '../games/kanto151/src/ecology.mjs';
import {actorAnimationDelta} from '../games/kanto151/src/animation-cadence.mjs';
import {applyWildEcologyPose} from '../games/kanto151/src/wild-ecology-pose.mjs';
import * as statusRules from '../games/kanto151/src/status-rules.mjs';
import * as THREE from '../games/kanto151/vendor/three.module.js';

const manifest=JSON.parse(await readFile(new URL('../games/kanto151/data/pokemon-manifest.json',import.meta.url),'utf8'));
const actor=(id=25)=>({id,hp:20,model:{position:{x:0,y:0,z:0},rotation:{y:0}},home:{x:0,z:0}});

test('hovering legendary birds keep native wing motion when stationary or battling',()=>{
 for(const id of [144,145,146]){
  const info=manifest.find(row=>row.id===id),animations=Object.fromEntries(info.animations.map(name=>[name,{}]));
  for(const battle of [false,true])assert.equal(selectLocomotionClip(info,animations,{locomotion:'fly',battle}),`animation.${info.slug}.air_idle`);
  assert.equal(selectLocomotionClip(info,animations,{airborne:true,moving:true}),`animation.${info.slug}.air_fly`);
  assert.equal(selectLocomotionClip(info,animations,{locomotion:'fly',grounded:true}),info.clips.idle);
  assert.equal(selectLocomotionClip(info,animations,{locomotion:'fly',airborne:false}),info.clips.idle);
 }
});

test('unavailable air clips and ordinary ground actors preserve their authored fallback',()=>{
 const info={clips:{idle:'ground',walk:'walk',battle:'battle'},animations:['air.air_idle','ground']};
 assert.equal(selectLocomotionClip(info,{ground:{}},{locomotion:'fly'}),'ground');
 assert.equal(selectLocomotionClip(info,{'air.air_idle':{}},{battle:true}),'battle');
 assert.equal(selectLocomotionClip(info,{}, {moving:true}),'walk');
});

test('locomotion uses final displacement, including slow species, without turning collision nudges into walks',()=>{
 const a=actor(11);a.moving=true;a.model.position.z=.08/60;
 settleActorLocomotion(a,{x:0,z:0},1/60);assert.equal(a.moving,true);
 assert.ok(Math.abs(a.locomotionState.speed-.08)<1e-8);
 const nudged=actor();nudged.moving=false;nudged.model.position.x=.1;
 settleActorLocomotion(nudged,{x:0,z:0},1/60);assert.equal(nudged.moving,false);
});

test('briefly blocked steps retain the gait, sustained blocking settles to idle',()=>{
 const a=actor();a.moving=true;a.model.position.z=.05;
 settleActorLocomotion(a,{x:0,z:0},.05);assert.equal(a.moving,true);
 for(let i=0;i<2;i++){a.moving=true;settleActorLocomotion(a,{...a.model.position},.03);assert.equal(a.moving,true);}
 a.moving=true;settleActorLocomotion(a,{...a.model.position},.04);assert.equal(a.moving,false);
});

test('capture, fainting and recoil cannot sustain a locomotion pose or change capture state',()=>{
 for(const status of [{capturing:true},{hp:0},{recoil:{time:.1}}]){
  const a=actor();Object.assign(a,status);a.moving=true;a.locomotionState={moving:true,stoppedFor:0};
  const before=JSON.stringify(status);settleActorLocomotion(a,{...a.model.position},.016);
  assert.equal(a.moving,false);assert.equal(JSON.stringify(Object.fromEntries(Object.keys(status).map(key=>[key,a[key]]))),before);
 }
});

test('air state follows species locomotion rather than battle type',()=>{
 const bird=actor(144);settleActorLocomotion(bird,{...bird.model.position},.016);assert.equal(bird.airborne,true);
 const doduo=actor(84);settleActorLocomotion(doduo,{...doduo.model.position},.016);assert.equal(doduo.airborne,false);
 const grounded=actor(144);grounded.grounded=true;settleActorLocomotion(grounded,{...grounded.model.position},.016);assert.equal(grounded.airborne,false);
});

test('avoidance keeps its chosen side briefly, then tries the direct path again',()=>{
 const state={},turns=[0,.5,-.5,1,-1];rememberSteering(state,-.5);
 assert.equal(steeringCandidates(state,.016,turns)[0],-.5);
 rememberSteering(state,-.5);assert.equal(steeringCandidates(state,.25,turns)[0],0);
 rememberSteering(state,0);assert.equal(steeringCandidates(state,.016,turns)[0],0);
});

function worldFixture(){
 return {composition:{playableBounds:{min:[-100,-100],max:[100,100]},safePoint:{position:{x:90,z:90},radius:1},paths:[],waterBodies:[],props:[]},height:()=>0,
  collision:(x,z)=>z>.01&&Math.abs(x)<.01?[x+.1,z]:[x,z]};
}

test('roaming steps keep a successful obstacle side after the direct route opens',()=>{
 const a=actor();a.roaming={goal:{x:0,z:8},rest:0,blocked:0};
 const game={world:worldFixture(),wild:[a]};updateWildRoaming(game,a,1/60);
 const side=a.roaming.steeringTurn,first=a.model.position.x;assert.ok(side>0);assert.ok(first>0);
 updateWildRoaming(game,a,1/60);assert.equal(a.roaming.steeringTurn,side);assert.ok(a.model.position.x>first);
});

test('pursuit retains obstacle steering without changing target or health',()=>{
 const a=actor();const game={world:worldFixture(),wild:[a]},target={x:0,z:8};
 assert.equal(moveWildToward(game,a,target,1/60,1),true);
 const side=a.pursuit.steeringTurn;assert.notEqual(side,0);
 assert.equal(moveWildToward(game,a,target,1/60,1),true);assert.equal(a.pursuit.steeringTurn,side);
 assert.equal(a.hp,20);assert.deepEqual(target,{x:0,z:8});
});

// Execute the current Game method with the real cadence, ecology and constraint
// modules. Browser-only setup and rendering are never constructed in this suite.
const gameSource=(await readFile(new URL('../games/kanto151/src/game.mjs',import.meta.url),'utf8')).replace(/^import[^\n]*\n/gm,'').replace(/^export /gm,'');
const dependencies={THREE,statusRules,wildGroundHeight,constrainWild,settleActorLocomotion,actorAnimationDelta,applyWildEcologyPose,habitatValid,
 waterAt:()=>null,deckAt:()=>false,actorRadius:()=>.5,TYPE_COLORS:{}};
const Game=new Function(...Object.keys(dependencies),gameSource+'\nreturn Game;')(...Object.values(dependencies));
function integratedActor(distance=30){
 const model=new THREE.Group(),rig=new THREE.Group(),root=new THREE.Group(),head=new THREE.Group();
 model.position.x=distance;model.add(rig);rig.add(root);root.add(head);root.userData.bedrock={};head.userData.bedrock={};
 const samples=[];model.userData={height:1,bones:new Map([['root',root],['head',head]]),update(dt,state){samples.push({dt,state});head.rotation.set(0,0,0);root.position.set(0,0,0);root.scale.set(1,1,1);}};
 const a={id:25,faction:'wild',hp:20,maxHp:20,species:{id:25,ai:[]},model,home:model.position.clone(),shield:0,buff:0,debuff:0,status:null,statusTime:0,actionTime:0,moving:false,
  ecologyPose:{headPitch:.2,headYaw:.1,bodyDip:-.025,breath:1.008}};
 const g=Object.create(Game.prototype);Object.assign(g,{save:{settings:{motion:false}},player:{model:{position:new THREE.Vector3()}},world:{...worldFixture(),actorVisible:()=>true,burst(){}}});
 return {a,g,head,root,samples};
}

for(const visible of [true,false])test(`actual updateActor never accumulates ecology overlays between ${visible?'visible':'offscreen'} distant samples`,()=>{
 const {a,g,head,root,samples}=integratedActor(50);g.world.actorVisible=()=>visible;
 for(let frame=0;frame<120;frame++){
  Game.prototype.updateActor.call(g,a,1/60);
  assert.ok(Math.abs(head.rotation.x-.2)<1e-10,'head overlay must apply once per reset');
  assert.ok(Math.abs(root.position.y+.4)<1e-10,'body dip must not accumulate while sampling is skipped');
  assert.ok(Math.abs(root.scale.y-1.008)<1e-10,'breathing must not multiply repeatedly');
 }
 assert.ok(samples.length>=9&&samples.length<=32);
});

test('actual updateActor resolves habitat constraints before reporting locomotion to the model',()=>{
 const {a,g,samples}=integratedActor(0);a.moving=true;a.model.position.z=.02;
 const previous=new THREE.Vector3();Game.prototype.updateActor.call(g,a,1/60,previous);
 assert.equal(a.model.position.z,0);assert.equal(a.locomotionState.speed,0);
 assert.equal(samples.at(-1).state.moving,false);
});

test('actual distant updateActor keeps status and damage timers at simulation frequency',()=>{
 const {a,g,samples}=integratedActor(50);g.world.actorVisible=()=>false;a.status='poison';a.statusTime=2;
 Game.prototype.updateActor.call(g,a,1/60);const count=samples.length,hp=a.hp;
 Game.prototype.updateActor.call(g,a,1/60);
 assert.equal(samples.length,count,'the second bone sample is throttled');
 assert.ok(Math.abs(a.statusTime-(2-2/60))<1e-10);assert.ok(a.hp<hp,'poison still advances on an unsampled step');
});
