import {habitatValid,bodyAt} from './ecology.mjs';
import {speciesEcology} from './species-ecology.mjs';

const TAU=Math.PI*2;
const DEFAULT_PROFILE=Object.freeze({locomotion:'ground',speed:.7,rest:2,stride:2.2,altitude:0,activity:'look',habitat:'meadow',resource:'none',social:'solitary'});
const flatDistance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const busy=actor=>actor.hp<=0||actor.capturing||actor.faintTime>0||actor.actionTime>0||actor.dash||actor.recoil||['sleep','freeze','stun','trap'].includes(actor.status);

export function wildLocomotionProfile(actor) {
 return speciesEcology(actor.id??actor.species?.id??actor.speciesId)||DEFAULT_PROFILE;
}

/** Biological flight height is independent of the species' battle types. */
export function wildGroundHeight(world,id,x,z,{grounded=false}={}) {
 const profile=speciesEcology(id)||DEFAULT_PROFILE,water=bodyAt(world,x,z),wet=water?.kind==='water',ground=world.height(x,z);
 if(profile.locomotion==='swim'||profile.locomotion==='wade')return wet?water.surfaceY+.08:ground;
 if(!grounded&&(profile.locomotion==='fly'||profile.locomotion==='hover'))return (wet?Math.max(ground,water.surfaceY+.08):ground)+profile.altitude;
 return ground;
}

function separated(game,actor,x,z,gap=.9) {
 const position=actor.model.position;
 return !(game.wild||[]).some(other=>{
  if(other===actor||other.hp<=0||other.capturing)return false;
  const next=Math.hypot(other.model.position.x-x,other.model.position.z-z),current=flatDistance(other.model.position,position);
  return next<gap&&!(current<gap&&next>current+.00001);
 });
}
function legal(game,actor,x,z,from,gap=.9) {
 return habitatValid(game,actor,x,z,from)&&separated(game,actor,x,z,gap);
}
const RESOURCE_MATCH={leaves:/Tree|Bush|Fern/,berries:/berry|fruit|apple|Bush_Common_Flowers/i,grass:/Grass|Clover|Fern|Flower/,minerals:/Rock|Pebble|stone|crystal|ore|basalt/i,electric:/generator|machine|pylon|conductor|power|transformer|electric|control/i,shade:/Tree|Pine|canopy/};
function resourceAnchors(game,actor,profile,state) {
 const c=game.world.composition;
 if(state.resourceComposition===c&&state.resourceKind===profile.resource)return state.resources;
 const anchors=[],home=actor.home||actor.model.position,leash=actor.pocket?.leashRadius||7,add=(x,z,radius=0)=>{
  if(!Number.isFinite(x)||!Number.isFinite(z)||Math.hypot(x-home.x,z-home.z)>leash+4)return;
  if(actor.pocket&&Math.hypot((x-actor.pocket.center[0])/actor.pocket.radius[0],(z-actor.pocket.center[1])/actor.pocket.radius[1])>1.6)return;
  anchors.push({x,z,radius});
 };
 const match=RESOURCE_MATCH[profile.resource];
 if(match)for(const prop of c?.props||[]){
  if(!match.test(`${prop.rendererKey||''} ${prop.materialVariant||''}`))continue;
  const tree=/Tree|Pine/.test(prop.rendererKey||''),radius=tree?(prop.collision?.radius||.6):Math.max(.2,Math.min(prop.bounds?.width||.5,prop.bounds?.depth||.5)*.5);
  add(prop.x,prop.z,radius+.65);
 }
 if(profile.resource==='berries')for(const point of game.world.interactions||[])if(['apple-tree','food'].includes(point.kind))add(point.x,point.z,.35);
 if(profile.resource==='electric')for(const structure of c?.structures||[]){
  if(!RESOURCE_MATCH.electric.test(`${structure.id||''} ${structure.kind||''} ${structure.theme||''}`))continue;
  add(structure.x??structure.position?.x??structure.position?.[0],structure.z??structure.position?.z??structure.position?.[1],1.4);
 }
 if(['minerals','shade','leaves'].includes(profile.resource))for(const item of game.world.verdantLandscape?.plan||[]){
  if(profile.resource==='minerals'?item.kind==='rock':item.kind==='tree')add(item.x,item.z,(item.radius||.6)+.65);
 }
 if(['shore','water'].includes(profile.resource))for(const body of c?.waterBodies||[]){
  if(body.kind!=='water')continue;
  for(const polygon of [body.polygon,...(body.holes||[]).map(h=>h.polygon||h)])for(let i=0;i<polygon.length;i++){
   const a=polygon[i],b=polygon[(i+1)%polygon.length],segments=Math.max(1,Math.min(20,Math.ceil(Math.hypot(b[0]-a[0],b[1]-a[1])/4)));
   for(let n=0;n<segments;n++)add(a[0]+(b[0]-a[0])*n/segments,a[1]+(b[1]-a[1])*n/segments,.7);
  }
 }
 if(profile.resource==='water'&&actor.pocket)add(...actor.pocket.center,.4);
 const unique=new Map(anchors.map(p=>[`${Math.round(p.x*10)}:${Math.round(p.z*10)}`,p]));
 state.resourceComposition=c;state.resourceKind=profile.resource;state.resources=[...unique.values()].sort((a,b)=>flatDistance(a,home)-flatDistance(b,home)).slice(0,48);
 return state.resources;
}

function goalFor(game,actor,profile,state,interest=null) {
 const pos=actor.model.position,home=actor.home||pos,leash=actor.pocket?.leashRadius||7,returning=flatDistance(pos,home)>leash*.68;
 const resources=resourceAnchors(game,actor,profile,state),nearby=[...resources].sort((a,b)=>flatDistance(a,pos)-flatDistance(b,pos)).slice(0,8),candidates=[];
 const offer=(x,z)=>{
  if(Math.hypot(x-pos.x,z-pos.z)<.35||Math.hypot(x-home.x,z-home.z)>leash||!legal(game,actor,x,z,pos,1.6))return;
  const point={x,z},affinity=nearby.length?Math.min(...nearby.map(p=>Math.abs(flatDistance(p,point)-p.radius))):0;
  const score=interest?flatDistance(point,interest)*1.7+flatDistance(point,pos)*.07:affinity*.65+(returning?flatDistance(point,home)*.7:0)+Math.random()*.7;
  candidates.push({x,z,score});
 };
 if(interest)offer(interest.x,interest.z);
 for(let i=0;i<26;i++){
  const angle=Math.random()*TAU;
  if(interest){const r=1.5+Math.random()*1.2;offer(interest.x+Math.sin(angle)*r,interest.z+Math.cos(angle)*r);}
  else if(i<14&&nearby.length){const anchor=nearby[i%nearby.length],r=anchor.radius+.2+Math.random()*.7;offer(anchor.x+Math.sin(angle)*r,anchor.z+Math.cos(angle)*r);}
  else{const radius=.45+Math.random()*Math.max(.5,profile.stride),base=returning?home:pos;offer(base.x+Math.sin(angle)*radius,base.z+Math.cos(angle)*radius);}
 }
 candidates.sort((a,b)=>a.score-b.score);
 return candidates.length?{x:candidates[0].x,z:candidates[0].z}:null;
}

function pose(actor,state,profile,activity,interest=null) {
 const time=state.elapsed||0,phase=time+(actor.id%17)*.43,chewing=['graze','forage'].includes(activity),sleeping=activity==='sleep',digging=activity==='dig';
 let headYaw=Math.sin(phase*.65)*.11;
 if(interest){const a=Math.atan2(interest.x-actor.model.position.x,interest.z-actor.model.position.z)-actor.model.rotation.y;headYaw=Math.max(-.55,Math.min(.55,Math.atan2(Math.sin(a),Math.cos(a))));}
 actor.ecologyPose={activity,resource:profile.resource,headPitch:chewing?.2+Math.sin(phase*2)*.045:sleeping?.2:digging?.25+Math.sin(phase*3)*.06:activity==='look'?Math.sin(phase*.8)*.055:activity==='roost'?.1:0,headYaw:sleeping?0:headYaw,bodyDip:digging?-.035+Math.sin(phase*3)*.012:chewing?-.025:sleeping?-.025:0,breath:1+Math.sin(phase*(sleeping?.8:1.6))*(sleeping?.016:.008),phase:time};
}

// Pauses are ecological activities, not combat sleep/status effects. The caller
// owns combat transitions; this helper never edits HP, statuses or action timers.
export function updateWildRoaming(game,actor,dt,{fleeFrom=null,interest=null}={}) {
 if(!Number.isFinite(dt)||dt<=0)return;
 if(busy(actor)||actor.angry||actor.boss){actor.ecologyPose=null;return;}
 const pos=actor.model.position,profile=wildLocomotionProfile(actor),state=actor.roaming??={goal:null,rest:Math.min(2.8,profile.rest*.3)+(actor.id%5)*.11,blocked:0};
 state.elapsed=(state.elapsed||0)+dt;state.activity??=profile.activity;actor.pursuit=null;actor.moving=false;
 if(fleeFrom){
  const angle=Math.atan2(pos.x-fleeFrom.x,pos.z-fleeFrom.z);state.goal={x:pos.x+Math.sin(angle)*2.5,z:pos.z+Math.cos(angle)*2.5};state.rest=0;state.interestSource=null;
 }else if(interest&&(state.interestSource!==interest||flatDistance(state.interestPoint||interest,interest)>.35)){
  state.interestSource=interest;state.interestPoint={x:interest.x,z:interest.z};state.goal=goalFor(game,actor,profile,state,interest);state.rest=0;
 }else if(!interest)state.interestSource=null;
 if(state.rest>0){state.rest=Math.max(0,state.rest-dt);actor.behavior=interest?'look':state.activity;pose(actor,state,profile,actor.behavior,interest);return;}
 if(!state.goal)state.goal=goalFor(game,actor,profile,state,interest);
 if(!state.goal){state.rest=.35+Math.random()*.4;state.activity=interest?'look':profile.activity;actor.behavior=state.activity;pose(actor,state,profile,state.activity,interest);return;}
 const dx=state.goal.x-pos.x,dz=state.goal.z-pos.z,distance=Math.hypot(dx,dz);
 if(distance<.22){state.goal=null;state.rest=interest?.6:profile.rest*(.7+Math.random()*.3);state.activity=interest?'look':profile.activity;actor.behavior=state.activity;pose(actor,state,profile,state.activity,interest);return;}
 let angle=Math.atan2(dx,dz),sx=0,sz=0;
 for(const other of game.wild||[]){if(other===actor||other.hp<=0||other.capturing)continue;const ox=pos.x-other.model.position.x,oz=pos.z-other.model.position.z,d=Math.hypot(ox,oz);if(d>.01&&d<1.8){sx+=ox/d*(1.8-d);sz+=oz/d*(1.8-d);}}
 angle=Math.atan2(Math.sin(angle)+sx*.8,Math.cos(angle)+sz*.8);
 const travel=Math.min(distance,dt*(fleeFrom?Math.max(1.1,profile.speed*2.8):profile.speed));
 for(const turn of [0,.48,-.48,.95,-.95,1.5,-1.5]){
  const heading=angle+turn,x=pos.x+Math.sin(heading)*travel,z=pos.z+Math.cos(heading)*travel;
  if(!legal(game,actor,x,z,pos))continue;
  pos.x=x;pos.z=z;pos.y=wildGroundHeight(game.world,actor.id,x,z);
  const delta=Math.atan2(Math.sin(heading-actor.model.rotation.y),Math.cos(heading-actor.model.rotation.y));actor.model.rotation.y+=delta*Math.min(1,dt*7);actor.angle=heading;actor.moving=true;
  actor.behavior=fleeFrom?'flee':interest?'investigate':'roam';pose(actor,state,profile,'move',interest);state.blocked=0;return;
 }
 state.blocked++;state.goal=null;state.rest=.12;state.activity=interest?'look':profile.activity;actor.behavior=state.activity;pose(actor,state,profile,state.activity,interest);
}

// Only stalled pursuit uses this small local search. A short reverse segment is
// sometimes essential to leave a concave corner; ordinary pursuit remains local.
function detourFor(game,actor,target) {
 const start=actor.model.position,step=.9,limit=10,nodes=new Map(),open=[],key=(x,z)=>`${x}:${z}`;
 const first={ix:0,iz:0,x:start.x,z:start.z,g:0,f:flatDistance(start,target),parent:null};nodes.set('0:0',first);open.push(first);
 let best=first,goal=null;
 for(let visits=0;open.length&&visits<320;visits++){
  open.sort((a,b)=>a.f-b.f);const current=open.shift();if(current.closed)continue;current.closed=true;
  if(flatDistance(current,target)<flatDistance(best,target))best=current;
  if(flatDistance(current,target)<1.95){goal=current;break;}
  for(const [dx,dz]of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){
   const ix=current.ix+dx,iz=current.iz+dz;if(Math.abs(ix)>limit||Math.abs(iz)>limit)continue;
   const id=key(ix,iz),x=start.x+ix*step,z=start.z+iz*step,next=nodes.get(id),cost=current.g+Math.hypot(dx,dz)*step;
   if(next?.closed||next&&next.g<=cost||!legal(game,actor,x,z,current))continue;
   const node=next||{ix,iz,x,z};Object.assign(node,{g:cost,f:cost+Math.hypot(x-target.x,z-target.z),parent:current});if(!next){nodes.set(id,node);open.push(node);}
  }
 }
 goal??=flatDistance(first,target)-flatDistance(best,target)>.65?best:null;
 if(!goal||goal===first)return null;
 const path=[];for(let n=goal;n.parent;n=n.parent)path.push({x:n.x,z:n.z});path.reverse();
 const simplified=[];let from={x:start.x,z:start.z},index=0;
 while(index<path.length){let far=index;for(let i=path.length-1;i>index;i--)if(legal(game,actor,path[i].x,path[i].z,from)){far=i;break;}simplified.push(path[far]);from=path[far];index=far+1;}
 return simplified;
}

export function moveWildToward(game,actor,target,dt,speed=2.8) {
 if(!Number.isFinite(dt)||dt<=0||busy(actor))return false;
 actor.ecologyPose=null;
 const pos=actor.model.position,distance=flatDistance(pos,target),state=actor.pursuit??={best:distance,stalled:0,cooldown:0,path:null,target:{x:target.x,z:target.z}};
 if(flatDistance(state.target,target)>1.5){state.path=null;state.best=distance;state.stalled=0;state.target={x:target.x,z:target.z};}
 state.cooldown=Math.max(0,state.cooldown-dt);
 if(distance<state.best-.15){state.best=distance;state.stalled=0;}else if(!state.path)state.stalled+=dt;
 if(state.path?.length&&flatDistance(pos,state.path[0])<.32){state.path.shift();if(!state.path.length){state.path=null;state.best=distance;state.stalled=0;}}
 if(state.stalled>.9&&state.cooldown<=0){state.path=detourFor(game,actor,target);state.cooldown=1.5;state.stalled=0;}
 const point=state.path?.[0]||target,angle=Math.atan2(point.x-pos.x,point.z-pos.z),side=actor.id%2?1:-1,travel=Math.min(speed*dt,flatDistance(pos,point));
 for(const turn of [0,side*.5,-side*.5,side*1.05,-side*1.05,side*1.57,-side*1.57]){
  const heading=angle+turn,x=pos.x+Math.sin(heading)*travel,z=pos.z+Math.cos(heading)*travel;
  if(!legal(game,actor,x,z,pos))continue;
  pos.x=x;pos.z=z;pos.y=wildGroundHeight(game.world,actor.id,x,z);
  const delta=Math.atan2(Math.sin(heading-actor.model.rotation.y),Math.cos(heading-actor.model.rotation.y));
  actor.model.rotation.y+=Math.max(-6*dt,Math.min(6*dt,delta));
  actor.angle=heading;actor.moving=true;actor.roaming=null;return true;
 }
 actor.moving=false;
 if(state.path){state.stalled+=dt;if(state.stalled>.35){state.path=null;state.stalled=1;}}
 return false;
}
