import {THREE} from './world.mjs';
import {TYPE_COLORS,clamp} from './core.mjs';
import {presentSignature,HERO_PRESENTATIONS} from './signatures.mjs';

export const IMPACT_TIERS={
 light:{pause:0,stagger:.12,knockback:.32,shake:.025,count:5,scale:.65,gain:.45},
 medium:{pause:.035,stagger:.23,knockback:.7,shake:.12,count:9,scale:1,gain:.65},
 heavy:{pause:.065,stagger:.36,knockback:1.4,shake:.23,count:14,scale:1.4,gain:.85},
 signature:{pause:.085,stagger:.44,knockback:1.8,shake:.32,count:18,scale:1.7,gain:1}
};
export function feedbackProfile(move){
 const power=move.engine?.power??move.power??0;
 return {tier:power>=110?'signature':power>=80?'heavy':power>=45?'medium':'light',element:move.type,
  anticipation:power>=100?.55:power>=70?.32:.14,physical:move.damageClass==='physical',
  shape:({electric:'arcs',fire:'embers',water:'splash',grass:'leaves',ice:'crystals',psychic:'orbit',ghost:'shadows',ground:'fracture',rock:'stones',flying:'gust',bug:'threads',poison:'viscous',dragon:'helix',normal:'contact',fighting:'contact',steel:'sparks',fairy:'prism',dark:'shadows'})[move.type],...move.feedback};
}
export function actorRadius(actor){return clamp((actor.model?.userData.height||1)*.28,.48,1.55);}
export function contactReach(a,b){return actorRadius(a)+actorRadius(b)+.45;}
export function hitReaction(target,profile,direction){
 const tier=IMPACT_TIERS[profile.tier]||IMPACT_TIERS.medium;
 const mass=Math.sqrt(Math.max(2,target.species.weightKg||target.species.weight||20)/20);
 const resistance=clamp(mass,.6,3.4)*(target.boss?3.5:1);
 return {duration:target.boss?.11:tier.stagger,distance:clamp(tier.knockback/resistance,.06,2.3),direction:direction.clone(),time:0};
}

// Shared geometry and a bounded emitter pool. Expired slots are reused; combat never
// creates an unbounded stream of geometries, textures, audio graphs or DOM overlays.
export class CombatFeedback{
 constructor(game){this.game=game;this.world=game.world;this.pause=0;this.slow=0;this.serial=0;this.events=[];
  this.geometries={orb:new THREE.IcosahedronGeometry(1,0),shard:new THREE.OctahedronGeometry(1,0),line:new THREE.CylinderGeometry(1,1,1,5),ring:new THREE.TorusGeometry(1,.055,4,28),mark:new THREE.CircleGeometry(1,14),leaf:new THREE.PlaneGeometry(1,.45)};
  this.group=new THREE.Group();this.world.scene.add(this.group);this.pool=Array.from({length:180},()=>{const m=new THREE.Mesh(this.geometries.orb,new THREE.MeshBasicMaterial({transparent:true,depthWrite:false,toneMapped:false,side:THREE.DoubleSide}));m.visible=false;this.group.add(m);return {mesh:m,life:0,max:1,velocity:new THREE.Vector3(),spin:0,gravity:0,grow:0};});
 }
 clear(){for(const p of this.pool){p.life=0;p.mesh.visible=false;}this.pause=0;this.slow=0;}
 emit(shape,pos,color,scale,life=.4,velocity=null,options={}){const p=this.pool.find(p=>p.life<=0);if(!p)return null;p.mesh.geometry=this.geometries[shape]||this.geometries.orb;p.mesh.position.copy(pos);p.mesh.rotation.set(0,0,0);p.mesh.scale.set(...(Array.isArray(scale)?scale:[scale,scale,scale]));p.mesh.material.color.set(color);p.mesh.material.opacity=options.opacity??.85;p.opacity=p.mesh.material.opacity;p.mesh.material.blending=options.additive?THREE.AdditiveBlending:THREE.NormalBlending;p.mesh.visible=true;p.life=p.max=life;p.velocity.copy(velocity||new THREE.Vector3());p.gravity=options.gravity||0;p.spin=options.spin||0;p.grow=options.grow||0;return p.mesh;}
 line(a,b,color,width=.055,life=.2){const delta=b.clone().sub(a),mesh=this.emit('line',a.clone().lerp(b,.5),color,[width,delta.length(),width],life);if(mesh)mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return mesh;}
 arc(a,b,color,branches=2){let last=a;for(let i=1;i<=6;i++){const next=a.clone().lerp(b,i/6);if(i<6)next.add(new THREE.Vector3((Math.random()-.5)*.9,(Math.random()-.5)*1.1,(Math.random()-.5)*.8));this.line(last,next,color,.04,.17);if(i<=branches)this.line(next,next.clone().add(new THREE.Vector3((Math.random()-.5)*2,.7,(Math.random()-.5)*2)),0xfff5c2,.025,.22);last=next;}}
 windup(actor,target,move){const profile=feedbackProfile(move),color=TYPE_COLORS[move.type],pos=actor.model.position.clone().add(new THREE.Vector3(0,Math.max(.6,(actor.model.userData.height||1)*.55),0));actor.windup=profile.anticipation;this.game.audio.combat?.('launch',move.type,profile.tier,this.pan(actor));
  if(move.power>=70||actor.boss){const r=this.emit('ring',pos,color,.6,profile.anticipation,null,{grow:1.4});if(r)r.rotation.x=Math.PI/2;}
  if(target&&actor.boss){const at=target.model.position.clone();at.y=this.world.height(at.x,at.z)+.12;const ring=this.emit('ring',at,0xff715d,move.engine.radius||2,Math.max(.6,move.engine.castTime),null,{opacity:.8});if(ring)ring.rotation.x=Math.PI/2;}
 }
 travel(actor,target,move,from,to){const c=TYPE_COLORS[move.type],type=move.type;this.game.audio.combat?.('travel',type,feedbackProfile(move).tier,this.pan(actor));
  if(type==='electric'){this.arc(from,to,c,3);return;}
  if(type==='grass'){for(const side of [-1,1]){const mid=from.clone().lerp(to,.5).add(new THREE.Vector3(side*.8,.7,0));this.line(from,mid,c,.06,.24);this.line(mid,to,c,.05,.24);}return;}
  if(type==='water'){for(const side of [-1,1])this.line(from.clone().add(new THREE.Vector3(side*.22,0,0)),to,c,.2,.25);return;}
  if(type==='fire'){for(let i=0;i<7;i++){const p=from.clone().lerp(to,i/7);this.emit('orb',p,i%2?0xffcd71:c,[.22+i*.025,.32,.22+i*.025],.3,null,{grow:1.2});}return;}
  if(['psychic','ghost','dragon'].includes(type)){for(let i=0;i<4;i++){const p=from.clone().lerp(to,i/4);const r=this.emit('ring',p,c,.35+i*.14,.35);if(r)r.lookAt(to);}return;}
  this.line(from,to,c,type==='ice'?.13:.06,.2);
 }
 impact(actor,target,move,{damage=0,effectiveness=1,critical=false}={}){let profile=feedbackProfile(move);const hero=!!HERO_PRESENTATIONS[actor.species.id]&&(actor.species.signatureMoveId===move.id||move.feedback?.hero);
  if(hero&&(move.engine.power??move.power)>=75)profile={...profile,tier:'signature'};const tier=IMPACT_TIERS[profile.tier]||IMPACT_TIERS.medium;
  const from=actor.model.position.clone(),at=target.model.position.clone().add(new THREE.Vector3(0,Math.max(.6,(target.model.userData.height||1)*.5),0));const dir=at.clone().sub(from);dir.y=0;dir.normalize();const color=TYPE_COLORS[move.type]||'#ffffff';
  if(damage>0){target.hit=critical?.22:.13;target.recoil=hitReaction(target,profile,dir);target.action='recoil';target.actionTime=target.recoil.duration;target.dash=null;target.invincible=Math.max(target.invincible||0,.065);this.pause=Math.max(this.pause,tier.pause);if(profile.tier==='signature')this.slow=.14;
   const intensity=this.game.save.settings.motion?(this.game.save.settings.shake??.65):0;this.world.impulse=dir.clone().multiplyScalar(tier.shake*intensity);this.world.shake=tier.shake*intensity;
   if(this.game.save.settings.vibration&&globalThis.navigator?.vibrate)navigator.vibrate(Math.round(tier.pause*450));
  }
  if(move.type==='psychic'&&damage>0)target.suspension=.3;this.game.audio.combat?.('impact',move.type,profile.tier,this.pan(target));this.element(profile,at,dir,color,tier);
  if(hero){presentSignature(this.game,actor,target,move);}
  if(profile.tier==='signature'||critical)this.game.emit('impactEmphasis',move.type,critical,profile.tier);
  this.game.emit('damage',target,damage,effectiveness,critical,profile.tier);
  this.events.push({serial:++this.serial,moveId:move.id,actorId:actor.species.id,targetId:target.species.id,type:move.type,tier:profile.tier,damage,critical,stagger:target.recoil?.duration||0,knockback:target.recoil?.distance||0,at:this.game.save.playTime});if(this.events.length>48)this.events.shift();
 }
 element(profile,at,dir,c,tier){const s=tier.scale,type=profile.element,ground=at.clone();ground.y=this.world.height(at.x,at.z)+.08;
  if(type==='electric'){this.arc(at.clone().add(new THREE.Vector3(0,2.5*s,0)),at,c,3);for(let i=0;i<3;i++)this.arc(at,at.clone().add(new THREE.Vector3(Math.cos(i*2.1)*s,.2,Math.sin(i*2.1)*s)),c,0);}
  if(['psychic','ghost','dragon','fairy'].includes(type)){for(let i=0;i<3;i++){const r=this.emit('ring',at,c,.6+i*.35,.55+i*.07,null,{grow:.7});if(r)r.rotation.set(i*.8,i*.6,0);} }
  if(['ground','rock'].includes(type)){for(let i=0;i<5;i++){const d=new THREE.Vector3(Math.sin(i*1.26),0,Math.cos(i*1.26));this.line(ground,ground.clone().addScaledVector(d,2*s),0x765344,.06,1.2);}}
  if(['normal','fighting','flying','bug','steel'].includes(type)){const r=this.emit('ring',at,c,.35,.28,null,{grow:5});if(r)r.lookAt(at.clone().add(dir));for(let i=0;i<(type==='bug'?3:2);i++)this.line(at.clone().add(new THREE.Vector3(-.8+i*.4,1,0)),at.clone().add(new THREE.Vector3(.8+i*.4,-.3,0)),c,.045,.16+i*.06);}
  if(['fire','ice','poison','ghost'].includes(type)){const m=this.emit('mark',ground,type==='fire'?0x512b29:c,1.1*s,type==='poison'?2.5:1.5,null,{solid:true,opacity:.35});if(m)m.rotation.x=-Math.PI/2;}
  if(type==='grass'){for(let i=0;i<4;i++){const p=ground.clone().add(new THREE.Vector3(Math.sin(i*1.57),0,Math.cos(i*1.57)));this.line(p,p.clone().add(new THREE.Vector3(-Math.sin(i)*.3,1.7*s,0)),0x72b94d,.06,.7);}}
  for(let i=0;i<tier.count;i++){const angle=i/tier.count*Math.PI*2,velocity=new THREE.Vector3(Math.cos(angle)*s,1.5+Math.random()*s,Math.sin(angle)*s).addScaledVector(dir,type==='water'?3:1);let shape='orb',scale=.075*s,options={gravity:5,spin:4};
   if(type==='ice'||type==='rock'||type==='ground'){shape='shard';scale=[.1*s,.28*s,.1*s];options.gravity=type==='ice'?3:8;}
   if(type==='grass'||type==='flying'||type==='bug'){shape='leaf';scale=.35*s;options.gravity=1;}
   if(type==='poison'||type==='ghost'){scale=.22*s;options={grow:.6,gravity:-.4};velocity.multiplyScalar(.3);}
   if(type==='water'){scale=[.055*s,.2*s,.055*s];velocity.multiplyScalar(1.5);}
   if(type==='fire'){scale=[.1*s,.24*s,.1*s];options.gravity=-.8;}
   this.emit(shape,at,i%3===0&&type==='fire'?0xffe7a2:c,scale,.35+Math.random()*.5,velocity,options);
  }
 }
 pan(actor){if(!this.game.player)return 0;const delta=actor.model.position.clone().sub(this.game.player.model.position),yaw=this.world.orbit.yaw;return clamp((delta.x*Math.cos(yaw)-delta.z*Math.sin(yaw))/18,-.8,.8);}
 update(dt){this.pause=Math.max(0,this.pause-dt);this.slow=Math.max(0,this.slow-dt);for(const p of this.pool){if(p.life<=0)continue;p.life-=dt;p.mesh.visible=p.life>0;if(!p.mesh.visible)continue;p.mesh.position.addScaledVector(p.velocity,dt);p.velocity.y-=p.gravity*dt;p.mesh.rotation.z+=p.spin*dt;if(p.grow)p.mesh.scale.multiplyScalar(1+p.grow*dt);p.mesh.material.opacity=p.opacity*Math.min(1,p.life/Math.min(.25,p.max));}}
}
