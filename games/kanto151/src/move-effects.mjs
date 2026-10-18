import {offenseWindup,offenseTravel,offenseArea,offenseImpact,offenseTrail,offenseProjectile} from './move-vfx-offense.mjs';
import {statusWindup,statusTravel,statusSupport,statusImpact,statusArea} from './move-vfx-status.mjs';
import {THREE} from './world.mjs';
import {TYPE_COLORS} from './core.mjs';
import {movePresentation,projectileShape,moveEffectVariant} from './move-presentation.mjs';
const UP=new THREE.Vector3(0,1,0);
function motionReduced(f){return f.game.save.settings.motion===false||f.game.motionPreference?.matches===true;}
export function effectCount(f,n){return Math.max(2,Math.round(n*(f.world.quality==='low'?.55:1)*(motionReduced(f)?.4:1)));}
function ring(f,p,c,s,life=.42,ground=false){const m=f.emit('ring',p,c,s,life,null,{grow:.75,opacity:.72});if(m)m.rotation.x=ground?-Math.PI/2:0;return m;}
function basis(a,b){const forward=b.clone().sub(a);if(forward.lengthSq()<1e-8)forward.set(0,0,1);forward.normalize();const side=new THREE.Vector3(forward.z,0,-forward.x).normalize();if(!side.lengthSq())side.set(1,0,0);return{forward,side};}
// Texture layers share the bounded feedback pool. Keep the bright core narrow so
// each element reads clearly against daylight without hiding either combatant.
function stream(f,a,b,c,width,life=.4,options={}){return f.ribbon?f.ribbon(a,b,c,width,life,{additive:true,opacity:.8,...options}):f.line(a,b,c,width*.16,life);}
function glow(f,p,c,scale,life=.35,opacity=.7){return f.emit('glow',p,c,scale,life,null,{billboard:true,additive:true,opacity,grow:.3});}
function wisp(f,p,c,scale,life,velocity=null,options={}){return f.emit('mist',p,c,scale,life,velocity,{billboard:true,opacity:.5,grow:.8,spin:1.1,...options});}
function sparks(f,p,c,n,side,forward,scale=.065){const count=effectCount(f,n);for(let i=0;i<count;i++){const angle=i/count*Math.PI*2,velocity=side.clone().multiplyScalar(Math.cos(angle)*(1.1+i%3*.35)).addScaledVector(UP,Math.sin(angle)*1.3+.7).addScaledVector(forward,.8+i%2);f.emit('streak',p,c,[scale,scale*(2.2+i%3),1],.32+i%3*.08,velocity,{billboard:true,additive:true,gravity:2.1,opacity:.85,spin:i*.4});}}
function energyTravel(f,family,a,b,c){const {forward,side}=basis(a,b),count=effectCount(f,7);
 if(family==='solar'){stream(f,a,b,0x7fca35,1.1,.62,{opacity:.35});stream(f,a,b,0xe5f373,.48,.58);stream(f,a,b,0xffffdc,.13,.52,{shape:'streak'});glow(f,a,0xe8ff91,.75,.38);glow(f,b,0xe5ffad,1.1,.48);for(let i=0;i<count;i++){const t=(i+.5)/count,p=a.clone().lerp(b,t).addScaledVector(side,Math.sin(t*14)*.32);f.emit('streak',p,i%2?0xeaffb4:0x8cd84a,[.055,.25,1],.5,forward.clone().multiplyScalar(1.4).addScaledVector(UP,.35),{billboard:true,additive:true,spin:1});}return;}
 if(family==='psychic'||family==='shadow'){const shadow=family==='shadow',base=shadow?0x5a2b9f:0xf273e3,light=shadow?0xd080fc:0xffc6fa;stream(f,a,b,base,shadow?.7:.58,.5,{opacity:.6});stream(f,a,b,light,.11,.45);let last=a;for(let i=1;i<=count;i++){const t=i/count,p=a.clone().lerp(b,t).addScaledVector(side,Math.sin(t*Math.PI*3)*(shadow?.35:.23)).addScaledVector(UP,Math.sin(t*Math.PI*2)*.18);stream(f,last,p,shadow?0x9565d5:0xf9a8ef,.18,.5,{opacity:.7});if(i<count)wisp(f,p,shadow?0x382653:0xd6a2fc,shadow?.62:.45,.65,UP.clone().multiplyScalar(shadow?.18:.3),{additive:!shadow,opacity:shadow?.55:.35,spin:shadow?-1.4:1.7});last=p;}glow(f,b,light,.72,.42,.65);sparks(f,b,light,4,side,forward,.05);return;}
 stream(f,a,b,c,.65,.43,{opacity:.48});stream(f,a,b,0xffe9c2,.22,.4);stream(f,a,b,0xffffff,.065,.34,{shape:'streak'});glow(f,a,c,.55,.28);glow(f,b,c,.85,.4);for(let i=0;i<count;i++){const t=(i+.5)/count;f.emit('streak',a.clone().lerp(b,t).addScaledVector(side,Math.sin(i*2.4)*.25),c,[.055,.3,1],.35,forward.clone().multiplyScalar(2),{billboard:true,additive:true});}
}
function path(f,a,b,c,n,shape='orb',scale=.13){const {forward,side}=basis(a,b),count=effectCount(f,n);for(let i=0;i<count;i++){const t=(i+1)/(count+1),p=a.clone().lerp(b,t).addScaledVector(side,Math.sin(t*Math.PI*3)*.16);const m=f.emit(shape,p,c,scale,.32,forward.clone().multiplyScalar(.45).addScaledVector(UP,.12),{spin:shape==='leaf'?5:0});if(m&&shape==='leaf')m.rotation.set(.5,i,1);}}
export function travelEffect(f,move,a,b){if(offenseTravel(f,move,a,b)||statusTravel(f,move,a,b))return;const family=movePresentation(move),c=TYPE_COLORS[move.type]||'#fff1cc',{forward,side}=basis(a,b),at=b.clone();if(namedTravel(f,move,a,b))return;
 if(family==='slash'){for(let i=0;i<3;i++){const start=at.clone().addScaledVector(side,-.65+i*.23).addScaledVector(UP,.65),mid=at.clone().addScaledVector(side,.15+i*.23),end=at.clone().addScaledVector(side,.6+i*.23).addScaledVector(UP,-.6);stream(f,start,mid,c,.16,.18+i*.025,{shape:'streak'});stream(f,mid,end,0xfff5dd,.08,.2+i*.025,{shape:'streak'});}glow(f,at,c,.38,.24,.45);return;}
 if(family==='bite'){for(const sign of [-1,1])for(let i=0;i<4;i++){const p=at.clone().addScaledVector(side,(i-1.5)*.3).addScaledVector(UP,sign*.55);f.line(p,p.clone().addScaledVector(UP,-sign*.4),c,.09,.25);}return;}
 if(['punch','kick','contact'].includes(family)){const p=a.clone().lerp(b,.78);stream(f,p,at,c,family==='kick'?.4:.28,.16,{shape:'streak'});glow(f,at,0xfff0cc,.44,.23,.75);ring(f,at,c,.28,.25);return;}
 if(family==='vine'){for(const sign of [-1,1]){let last=a;for(let i=1;i<=7;i++){const t=i/7,p=a.clone().lerp(b,t).addScaledVector(side,sign*Math.sin(t*Math.PI)*.85).addScaledVector(UP,Math.sin(t*Math.PI)*.25);f.line(last,p,c,.055,.28);last=p;}}return;}
 if(family==='spark'){lightning(f,a,b,1);return;}
 if(family==='jet'){waterStream(f,a,b,move.engine.power>=100?1:.6);return;}
 if(family==='bubble'){path(f,a,b,c,10,'ring',.19);path(f,a.clone().addScaledVector(side,.25),b,0xbcefff,5,'orb',.12);return;}
 if(['flame','ember'].includes(family)){fireStream(f,a,b,family==='flame'?1:.55);return;}
 if(family==='leaf'){path(f,a,b,c,8,'leaf',[.4,.65,.4]);return;}
 if(family==='needle'){for(let i=0;i<3;i++){const p=a.clone().lerp(b,.35+i*.2);f.line(p,p.clone().addScaledVector(forward,.65),c,.055,.22);}return;}
 if(family==='frost'){iceStream(f,a,b,.75);return;}
 if(['psychic','shadow','beam','solar'].includes(family)){energyTravel(f,family,a,b,c);return;}
 if(family==='sound'){for(let i=0;i<5;i++){const m=ring(f,a.clone().lerp(b,(i+1)/6),c,.25+i*.14,.4);if(m)m.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),forward);}return;}
 if(family==='star'){path(f,a,b,0xffe69b,6,'star',.18);return;}
 if(['stone','fault'].includes(family)){path(f,a,b,c,5,'shard',[.2,.32,.2]);return;}
 if(family==='drain'){path(f,b,a,0xa8e67b,8,'orb',.11);return;}
 if(['gust','rush'].includes(family)){for(const sign of [-1,1]){const start=a.clone().addScaledVector(side,sign*.4),end=b.clone().addScaledVector(side,sign*.45);f.line(start,end,c,.045,.22);}if(family==='gust')path(f,a,b,c,5,'leaf',.2);return;}
 if(['powder','sludge','status'].includes(family)){path(f,a,b,c,8,'orb',family==='sludge'?[.18,.28,.18]:.065);ring(f,b,c,.4,.5);return;}
 f.line(a,b,c,.06,.18);
}
export function areaEffect(f,move,center,radius,actor){if(offenseArea(f,move,center,radius)||statusArea(f,move,center,radius,actor))return;const family=movePresentation(move),c=TYPE_COLORS[move.type]||'#fff1cc',at=center.clone();at.y=f.world.height(at.x,at.z)+.14;if(namedArea(f,move,at,radius))return;const count=effectCount(f,12);
 if(family==='spark'){f.arc(at.clone().addScaledVector(UP,4),at,c,3);}
 for(let i=0;i<count;i++){const angle=i/count*Math.PI*2,d=new THREE.Vector3(Math.cos(angle),0,Math.sin(angle)),p=at.clone().addScaledVector(d,radius*.7);
  if(family==='wave'){const m=ring(f,at.clone().addScaledVector(UP,i*.07),i%2?0xa1e6ef:c,.5+i*radius/count,.65,true);if(m)m.scale.y*=.85;}
  else if(['stone','fault'].includes(family)){f.line(at,p,0x96795b,.08,.8);f.emit('shard',p,c,[.23,.6,.23],.65,d.clone().multiplyScalar(.7).addScaledVector(UP,1),{gravity:4});}
  else if(family==='frost')f.emit('shard',p.clone().addScaledVector(UP,1),c,[.1,.4,.1],.65,new THREE.Vector3(0,-1,0),{spin:2});
 else if(['ember','flame','explosion'].includes(family)){f.emit('flame',p,i%2?0xff9a36:0xffd26e,[.42,.8,1],.65,d.clone().multiplyScalar(1.2).addScaledVector(UP,1),{billboard:true,additive:true,grow:.6});if(i%3===0)glow(f,p,0xff9c34,.7,.4,.55);}
  else if(family==='vine'){f.line(p,p.clone().addScaledVector(UP,1),c,.055,.7);f.emit('leaf',p.clone().addScaledVector(UP,.8),c,.25,.7,null,{spin:2});}
  else f.emit(projectileShape(move),p,c,.15,.5,d.clone().multiplyScalar(.7).addScaledVector(UP,.7));
 }
 if(family!=='wave')ring(f,at,c,Math.min(1.2,radius*.35),.6,true);
}
export function supportEffect(f,actor,move){if(statusSupport(f,actor,move))return;const p=actor.model.position.clone().addScaledVector(UP,Math.max(.5,(actor.model.userData.height||1)*.6)),c=move.engine.template==='heal'?0x98e6ac:TYPE_COLORS[move.type]||'#dbe9ff';
 if(move.engine.template==='shield'){for(let i=0;i<3;i++){const m=ring(f,p,c,.65+i*.13,.85);if(m)m.rotation.set(i*Math.PI/3,i*Math.PI/4,0);}}
 else {const count=effectCount(f,8);for(let i=0;i<count;i++){const a=i/count*Math.PI*2,v=new THREE.Vector3(Math.cos(a)*.45,.9,Math.sin(a)*.45);f.emit(move.engine.template==='heal'?'cross':'shard',p.clone().addScaledVector(v,.7),c,move.engine.template==='heal'?.12:[.07,.3,.07],.65,v,{grow:.2});}}
}
export function projectileGeometry(move,signature){const authored=offenseProjectile(null,move,signature);if(authored)return authored;const v=moveEffectVariant(move);if(v==='fire-blast')return new THREE.ExtrudeGeometry(fireBlastShape(),{depth:.08,bevelEnabled:false}).scale(1.1,1.1,1.1);if(v==='water-gun')return new THREE.CylinderGeometry(.09,.065,.7,6);if(['hydro-cannon','overheat','blast-burn','shadow'].includes(v))return new THREE.IcosahedronGeometry(v==='hydro-cannon'?.45:v==='shadow'?.3:.5,1);const s=signature?.36:.24,shape=projectileShape(move);if(shape==='shard')return new THREE.OctahedronGeometry(s,0);if(shape==='leaf')return new THREE.PlaneGeometry(s*2.2,s*.85);if(shape==='ring')return new THREE.TorusGeometry(s,.055,5,16);if(shape==='star')return new THREE.ExtrudeGeometry(starShape(),{depth:.05,bevelEnabled:false}).scale(s,s,s);return new THREE.IcosahedronGeometry(s,1);}
export function starShape(){const s=new THREE.Shape();for(let i=0;i<10;i++){const a=i*Math.PI/5,r=i%2?.43:1;const x=Math.sin(a)*r,y=Math.cos(a)*r;i?s.lineTo(x,y):s.moveTo(x,y);}s.closePath();return s;}
export function trailEffect(f,q){if(offenseTrail(f,q))return;const v=moveEffectVariant(q.move),p=q.mesh.position.clone();
 // Direction is part of a projectile's identity, including reduced motion. Only
 // optional wake movement and decorative rotation are reduced below.
 if(v==='fire-blast')faceCamera(f,q.mesh);else if(v==='water-gun')q.mesh.quaternion.setFromUnitVectors(UP,q.direction);
 if(motionReduced(f)){q.effectTrail=(q.effectTrail||0)+1;if(q.effectTrail%3)return;f.emit(projectileShape(q.move),p,TYPE_COLORS[q.move.type]||'#fff1cc',.11,.2,null,{opacity:.45});return;}
 if(v==='fire-blast'){glyph(f,p,.7,.23);glow(f,p,0xffa331,.75,.24,.45);f.emit('flame',p,0xffa838,[.22,.55,1],.35,UP.clone().multiplyScalar(.45),{billboard:true,additive:true,opacity:.7,spin:.6});return;}
 if(v==='water-gun'){stream(f,p.clone().addScaledVector(q.direction,-.85),p,0xc5f8ff,.16,.19,{shape:'streak'});wisp(f,p,0xc4f6ff,.25,.3,null,{additive:true,opacity:.25});return;}
 if(v==='bubble'){faceCamera(f,q.mesh);for(let i=0;i<2;i++)faceCamera(f,ring(f,p.clone().add(new THREE.Vector3((i-.5)*.28,.1*i,0)),i?0xbef8ff:0x79d2e8,.14+i*.04,.38));return;}
 if(v==='water-pulse'){faceCamera(f,q.mesh);directedRing(f,p,0x8be3ff,.3,q.direction,.4);return;}
 if(['hydro-cannon','overheat','blast-burn'].includes(v)){const water=v==='hydro-cannon';glow(f,p,water?0xa6f0ff:0xffa63d,.8,.32,.7);f.emit(water?'mist':'flame',p,water?0xd8ffff:0xffc06c,[.52,.8,1],.4,UP.clone().multiplyScalar(.25),{billboard:true,additive:true,grow:.7,opacity:.65});stream(f,p.clone().addScaledVector(q.direction,-1.25),p,water?0xcafaff:0xffb854,.38,.26);return;}
 const shape=projectileShape(q.move),family=movePresentation(q.move),c=TYPE_COLORS[q.move.type]||'#fff1cc',at=q.mesh.position.clone(),end=at.clone().addScaledVector(q.direction,-.8);q.mesh.rotation.z+=.28;
 if(['flame','ember'].includes(family)){f.emit('flame',at,0xffa034,[.24,.42,1],.32,UP.clone().multiplyScalar(.3),{billboard:true,additive:true,grow:.5,opacity:.75});stream(f,end,at,0xffd887,.18,.2);return;}
 if(family==='jet'){stream(f,end,at,0xb9f4ff,.22,.22);wisp(f,at,0x8fdfff,.34,.32,null,{additive:true,opacity:.35});return;}
 if(family==='spark'){stream(f,end,at,0xffe36b,.23,.2);glow(f,at,0xfff1ad,.38,.22,.6);return;}
 if(family==='frost'){stream(f,end,at,0xb2f3ff,.16,.24);f.emit('shard',at,0xe8ffff,[.065,.2,.065],.4,UP.clone().multiplyScalar(.15),{spin:2.4,additive:true});return;}
 if(family==='shadow'||family==='psychic'){const shadow=family==='shadow';glow(f,at,shadow?0xb368fa:0xffa9ef,shadow?.65:.5,.26,.55);wisp(f,at,shadow?0x46305d:0xe393ee,shadow?.55:.38,.44,UP.clone().multiplyScalar(.16),{additive:!shadow,spin:shadow?-1.2:1.8,opacity:.55});stream(f,end,at,shadow?0x9b59d9:0xf3a0f3,.18,.28,{opacity:.65});return;}
 const scale=shape==='shard'?[.075,.2,.075]:shape==='leaf'?[.2,.35,.2]:shape==='ring'?.16:.1;f.emit(shape,at,c,scale,.28,null,{opacity:.6,spin:shape==='leaf'?4:0,grow:.2});}
export function impactEffect(f,move,at,dir,target){if(offenseImpact(f,move,at,dir)||statusImpact(f,move,at,dir,target))return;namedImpact(f,move,at,dir);const family=movePresentation(move),c=TYPE_COLORS[move.type]||'#fff1cc',side=new THREE.Vector3(dir.z,0,-dir.x);
 if(['flame','ember','explosion'].includes(family)){glow(f,at,0xffc76b,.95,.4,.6);wisp(f,at.clone().addScaledVector(UP,.3),0x79554e,.65,.75,UP.clone().multiplyScalar(.8),{opacity:.23,grow:1.4});sparks(f,at,0xffd98a,5,side,dir,.05);}
 else if(family==='frost'){glow(f,at,0xd4ffff,.9,.42,.7);for(let i=0;i<effectCount(f,4);i++)wisp(f,at.clone().addScaledVector(side,(i-1.5)*.3),0xc4f6ff,.65,.65,side.clone().multiplyScalar((i-1.5)*.3).addScaledVector(UP,.25),{additive:true,opacity:.28,grow:1.1});}
 else if(family==='spark'){glow(f,at,0xfff0a6,.8,.3,.7);sparks(f,at,0xffed91,5,side,dir,.045);}
 else if(['beam','solar','psychic','shadow'].includes(family)){glow(f,at,family==='shadow'?0xb078f7:c,1,.45,.6);wisp(f,at,family==='shadow'?0x4f2b69:c,.85,.6,UP.clone().multiplyScalar(.2),{additive:family!=='shadow',opacity:.36,grow:1.2});}
 if(['bubble','star','leaf','needle','sludge','shadow','drain'].includes(family)){const count=effectCount(f,6);for(let i=0;i<count;i++){const a=i/count*Math.PI*2,v=new THREE.Vector3(Math.cos(a),.5+Math.sin(a)*.4,Math.sin(a)).addScaledVector(dir,.45);f.emit(family==='bubble'?'ring':family==='star'?'star':family==='leaf'?'leaf':family==='needle'?'shard':family==='shadow'?'mist':'orb',at,c,family==='needle'?[.07,.28,.07]:family==='shadow'?.35:.18,.4,v,{additive:family==='shadow',spin:family==='star'||family==='leaf'?3:0,grow:family==='bubble'?.8:0});}}}
// Geometry for 大 uses three burning strokes, without text/fonts or imported assets.
export function fireBlastShape(){return [[[-1,.35],[1,.35]],[[.15,1.3],[-.9,-1]],[[.05,.4],[1,-1]]].map(([a,b])=>{const dx=b[0]-a[0],dy=b[1]-a[1],n=Math.hypot(dx,dy),x=-dy/n*.115,y=dx/n*.115,s=new THREE.Shape();s.moveTo(a[0]+x,a[1]+y);s.lineTo(b[0]+x,b[1]+y);s.lineTo(b[0]-x,b[1]-y);s.lineTo(a[0]-x,a[1]-y);s.closePath();return s;});}
function faceCamera(f,m){if(m&&f.world.camera)m.quaternion.copy(f.world.camera.quaternion);return m;}
function directedRing(f,p,c,s,forward,life=.4){const m=ring(f,p,c,s,life);if(m)m.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),forward);return m;}
function glyph(f,p,scale=1.2,life=.5){faceCamera(f,f.emit('fire-glyph',p,0xff632d,scale,life,null,{opacity:.92,grow:.3}));faceCamera(f,f.emit('fire-glyph',p.clone().add(new THREE.Vector3(0,0,.015)),0xffd779,scale*.8,life*.85,null,{opacity:.9}));}
function spray(f,p,c,n,speed=2){const count=effectCount(f,n);for(let i=0;i<count;i++){const angle=i/count*Math.PI*2;f.emit('streak',p,c,[.055,.22,1],.48,new THREE.Vector3(Math.cos(angle)*speed,1.8,Math.sin(angle)*speed),{billboard:true,additive:true,gravity:4,angle:angle*.5,opacity:.82});}}
function fireStream(f,a,b,power=1){const {forward,side}=basis(a,b),count=effectCount(f,9),life=.56;
 stream(f,a,b,0xff4516,1.9*power,life,{opacity:.48});stream(f,a,b,0xff8c28,.85*power,.52,{opacity:.6});stream(f,a,b,0xffcb61,.22*power,.42,{opacity:.55});
 glow(f,a,0xffad38,.66*power,.34);glow(f,b,0xff9b30,1.15*power,.5,.6);
 for(let i=0;i<count;i++){const t=(i+.6)/count,p=a.clone().lerp(b,Math.min(.97,t)).addScaledVector(side,Math.sin(i*2.3)*.2*power),size=(.85+t*.65)*power,velocity=forward.clone().multiplyScalar(1.1+t*.7).addScaledVector(UP,.2+i%2*.2),tail=p.clone().addScaledVector(forward,-(.55+t*.3)*power),tip=p.clone().addScaledVector(forward,(.85+t*.4)*power).addScaledVector(UP,(i%2?.22:-.12)*power);stream(f,tail,tip,i%2?0xff6920:0xffa336,size,life,{shape:'flame',velocity,opacity:.83,grow:.4});if(i%3===0){wisp(f,p,0xff7324,size*1.35,.56,velocity,{additive:true,opacity:.32,grow:.9});f.emit('flame',p,0xffc05c,[size*.62,size*1.1,1],.44,velocity,{billboard:true,additive:true,grow:.25,angle:(i%2?.6:-.5),opacity:.68});}}
 sparks(f,b,0xffd16a,7,side,forward,.05*power);wisp(f,b.clone().addScaledVector(UP,.3),0xff8b32,1.1*power,.65,UP.clone().multiplyScalar(.5),{additive:true,opacity:.25,grow:1.3});
}
function waterStream(f,a,b,power=1){const {forward,side}=basis(a,b),count=effectCount(f,5);
 stream(f,a,b,0x218dce,.95*power,.61,{opacity:.55});stream(f,a,b,0x7ce3ff,.54*power,.58,{opacity:.8});stream(f,a,b,0xedffff,.15*power,.5,{shape:'streak',opacity:.9});
 for(const sign of [-1,1]){let last=a;for(let i=1;i<=count;i++){const t=i/count,angle=t*Math.PI*3+sign*Math.PI*.5,p=a.clone().lerp(b,t).addScaledVector(side,Math.sin(angle)*.19*power).addScaledVector(UP,Math.cos(angle)*.19*power);stream(f,last,p,sign>0?0xbcf9ff:0x4bbbef,.14*power,.58,{opacity:sign>0?.9:.6});last=p;}}
 glow(f,a,0xb2edff,.42*power,.35,.6);glow(f,b,0xc7f7ff,.75*power,.5,.55);
 for(let i=0;i<count;i++){const t=(i+1)/(count+1),p=a.clone().lerp(b,t),velocity=side.clone().multiplyScalar((i%2?1:-1)*(.35+t*.9)).addScaledVector(UP,.5).addScaledVector(forward,1);wisp(f,p,0xc4f4ff,(.35+t*.25)*power,.58,velocity,{additive:true,opacity:.32,grow:1.2});}
 sparks(f,b,0xe2ffff,6,side,forward,.055*power);
}
function lightning(f,a,b,power=1){const {forward,side}=basis(a,b),reduced=motionReduced(f),count=reduced?3:f.world.quality==='low'?5:7;let last=a;
 for(let i=1;i<=count;i++){const t=i/count,p=a.clone().lerp(b,t);if(i<count)p.addScaledVector(side,Math.sin(i*8.71)*.42*power).addScaledVector(UP,Math.cos(i*5.17)*.3*power);stream(f,last,p,0xffbc26,.78*power,.31,{opacity:.78});stream(f,last,p,0xfffee8,.2*power,.28,{shape:'streak',opacity:1});if(!reduced&&i%2===0&&i<count){const sign=i%4===0?1:-1,elbow=p.clone().addScaledVector(side,sign*.46*power).addScaledVector(UP,.22*power),branch=p.clone().addScaledVector(side,sign*.98*power).addScaledVector(UP,.54*power).addScaledVector(forward,.22*power);stream(f,p,elbow,0xffd452,.3*power,.33);stream(f,p,elbow,0xffffde,.1*power,.29,{shape:'streak'});stream(f,elbow,branch,0xffd452,.22*power,.33);stream(f,elbow,branch,0xffffde,.075*power,.29,{shape:'streak'});glow(f,p,0xffed89,.4*power,.3,.65);}last=p;}
 glow(f,a,0xffe359,.62*power,.32);glow(f,b,0xffdf64,.95*power,.35);sparks(f,b,0xfff2a1,4,side,forward,.06*power);
}
function iceStream(f,a,b,power=1){const {forward,side}=basis(a,b),count=effectCount(f,6);
 stream(f,a,b,0x299ed2,.7*power,.51,{opacity:.45});stream(f,a,b,0x94e8ff,.3*power,.47);stream(f,a,b,0xf2ffff,.075*power,.42,{shape:'streak',opacity:.95});glow(f,a,0xd8ffff,.43*power,.32);glow(f,b,0xb8f3ff,.78*power,.42);
 for(let i=0;i<count;i++){const t=(i+1)/(count+1),p=a.clone().lerp(b,t).addScaledVector(side,Math.sin(i*2.4)*.25*power);f.emit('shard',p,i%2?0xb1f4ff:0xf2ffff,[.055*power,(.18+i%3*.035)*power,.055*power],.6,side.clone().multiplyScalar(Math.sin(i*3)*.65).addScaledVector(UP,.25).addScaledVector(forward,.65),{spin:2.4,additive:true,gravity:.7,opacity:.85});if(i%2===0)wisp(f,p,0xc7f7ff,.5*power,.58,UP.clone().multiplyScalar(.15),{additive:true,opacity:.24,spin:-.7});}
 sparks(f,b,0xd4ffff,4,side,forward,.045*power);
}
export function elementalWindup(f,actor,move,target){if(offenseWindup(f,actor,target,move)||statusWindup(f,actor,target,move))return;const v=moveEffectVariant(move),family=movePresentation(move),height=actor.model.userData.height||1,forward=new THREE.Vector3(Math.sin(actor.model.rotation.y),0,Math.cos(actor.model.rotation.y)),side=new THREE.Vector3(forward.z,0,-forward.x),p=actor.model.position.clone().addScaledVector(UP,Math.max(.55,height*.62)).addScaledVector(forward,Math.min(.65,height*.22)),life=Math.max(.12,actor.combatMotion?.castTime??move.engine.castTime??.2),c=TYPE_COLORS[move.type]||'#fff1cc';
 if(v==='fire-blast'){glyph(f,p,.32,life);glow(f,p,0xffb247,.55,life,.55);return;}if(['overheat','blast-burn','hydro-cannon'].includes(v)){const water=v==='hydro-cannon';glow(f,p,water?0xb9f3ff:0xff9e38,water?.6:.75,life,.75);wisp(f,p,water?0xc9f8ff:0xff7f2a,.65,life,null,{additive:true,grow:1.2,opacity:.45});return;}if(v==='thunder'){directedRing(f,p,0xffe76c,.6,UP,life);glow(f,p,0xffed91,.55,life,.6);return;}
 if(['slash','bite','punch','kick','contact','rush'].includes(family)){const glint=p.clone().addScaledVector(side,.16);f.emit('star',glint,c,.13,Math.min(.23,life),null,{opacity:.7,grow:.3});return;}
 if(['heal','shield','buff'].includes(family))return;
 const count=effectCount(f,5),shape=projectileShape(move),radius=Math.min(.48,.18+height*.08),energy=['flame','ember','jet','frost','spark','solar','beam','psychic','shadow'].includes(family);if(energy){glow(f,p,c,.5+radius*.4,life,.4);glow(f,p,family==='shadow'?0xb189ee:0xfff4df,.2,life,.85);}
 for(let i=0;i<count;i++){const angle=i/count*Math.PI*2,offset=side.clone().multiplyScalar(Math.cos(angle)*radius).addScaledVector(UP,Math.sin(angle)*radius),start=p.clone().add(offset);f.emit(energy?'streak':shape,start,c,energy?[.035,.13,1]:shape==='leaf'?[.18,.32,.18]:.075,life,offset.multiplyScalar(-.7/Math.max(.2,life)),{billboard:energy,additive:energy,opacity:.6,angle:-angle,spin:shape==='leaf'?2:0,grow:-.25});}
 if(family==='sound')directedRing(f,p,c,radius,forward,life);
}
function namedTravel(f,move,a,b){const v=moveEffectVariant(move),{forward,side}=basis(a,b);
 if(v==='flamethrower'){fireStream(f,a,b,1.1);return true;}
 if(v==='fire-blast'){glyph(f,b,1.35,.6);glow(f,b,0xff9f31,1.6,.5,.6);sparks(f,b,0xffce6d,7,side,forward);return true;}
 if(v==='water-gun'){waterStream(f,a,b,.42);return true;}
 if(v==='hydro-pump'){waterStream(f,a,b,1.2);return true;}
 if(v==='bubble'){const count=effectCount(f,6);for(let i=0;i<count;i++){const p=a.clone().lerp(b,(i+1)/(count+1)).addScaledVector(side,Math.sin(i*1.7)*.4),s=.14+(i%3)*.055;faceCamera(f,ring(f,p,i%2?0xb7f3ff:0x69cadf,s,.48));glow(f,p.clone().addScaledVector(UP,s*.4),0xeaffff,s*.6,.4,.65);}return true;}
 if(v==='bubble-beam'){const count=effectCount(f,11);stream(f,a,b,0x55c9e9,.38,.46,{opacity:.3});for(let i=0;i<count;i++){const p=a.clone().lerp(b,(i+1)/(count+1));directedRing(f,p,i%2?0xc7f6ff:0x57cddd,.21+(i%3)*.025,forward,.44);if(i%2===0)glow(f,p,0xe1ffff,.15,.4,.5);}return true;}
 if(v==='water-pulse'){stream(f,a,b,0x48b9e7,.45,.5,{opacity:.45});for(let i=0;i<3;i++)directedRing(f,a.clone().lerp(b,.4+i*.2),0x81dcff,.28+i*.18,forward,.5);wisp(f,b,0xd1faff,.8,.6,UP.clone().multiplyScalar(.2),{additive:true,opacity:.4});return true;}
 if(v==='heat-wave'){fireStream(f,a,b,.8);const count=effectCount(f,4);for(let i=0;i<count;i++){const t=(i+1)/(count+1);wisp(f,a.clone().lerp(b,t),0xff8a3e,.6+t*.6,.6,forward.clone().multiplyScalar(.8).addScaledVector(UP,.4),{additive:true,opacity:.28});}return true;}
 if(v==='thunder-shock'){lightning(f,a,b,.6);return true;}
 if(v==='thunderbolt'){lightning(f,a,b,1.1);return true;}
 if(v==='ice-beam'){iceStream(f,a,b,1.1);return true;}
 return false;
}
function namedArea(f,move,at,radius){const v=moveEffectVariant(move);
 if(v==='fire-spin'){const count=effectCount(f,15);for(let i=0;i<count;i++){const t=i/count,angle=t*Math.PI*5,p=at.clone().add(new THREE.Vector3(Math.cos(angle)*radius*.65,t*2+.1,Math.sin(angle)*radius*.65)),velocity=new THREE.Vector3(-Math.sin(angle)*.7,.45,Math.cos(angle)*.7);f.emit('flame',p,i%2?0xffb440:0xf5632e,[.55,.95,1],.7,velocity,{billboard:true,additive:true,grow:.4,angle:Math.sin(angle)*.4});if(i%3===0)wisp(f,p,0xff772d,.85,.75,velocity,{additive:true,opacity:.3});}glow(f,at.clone().addScaledVector(UP,.5),0xff9f38,1.1,.65,.5);ring(f,at,0xffa646,radius*.7,.7,true);return true;}
 if(v==='thunder'){const top=at.clone().addScaledVector(UP,5);lightning(f,top,at,1.45);for(let i=0;i<3;i++){const angle=i/3*Math.PI*2,end=at.clone().add(new THREE.Vector3(Math.cos(angle)*radius*.65,.1,Math.sin(angle)*radius*.65));stream(f,at,end,0xffd754,.22,.4);stream(f,at,end,0xffffda,.045,.32,{shape:'streak'});}ring(f,at,0xffd859,radius*.7,.45,true);return true;}
 if(v==='blizzard'){const count=effectCount(f,18);for(let i=0;i<count;i++){const angle=i/count*Math.PI*2,p=at.clone().add(new THREE.Vector3(Math.cos(angle)*radius*.8,1+(i%3)*.5,Math.sin(angle)*radius*.8)),velocity=new THREE.Vector3(-Math.sin(angle)*1.5,-.65,Math.cos(angle)*1.5);f.emit('shard',p,i%2?0xe1fbff:0x72d9f2,[.12,.32,.12],.85,velocity,{spin:3,additive:true});if(i%3===0)wisp(f,p,0xc8f6ff,1.2,.85,velocity.clone().multiplyScalar(.6),{additive:true,opacity:.3,spin:-1.3});}glow(f,at.clone().addScaledVector(UP,.6),0xc9faff,1.4,.7,.4);ring(f,at,0xc1f6ff,radius*.65,.8,true);return true;}
 return false;
}
function namedImpact(f,move,at,dir){const v=moveEffectVariant(move);
 if(v==='fire-blast'){glyph(f,at,1.55,.65);const count=effectCount(f,10);for(let i=0;i<count;i++){const angle=i/count*Math.PI*2;f.emit('flame',at,i%2?0xffbe54:0xff672a,[.4,.75,1],.6,new THREE.Vector3(Math.cos(angle)*2,Math.sin(angle)*1.6+.6,Math.sin(angle)*2),{billboard:true,additive:true,grow:.4,angle:angle*.25});}}
 else if(['overheat','blast-burn'].includes(v)){const burn=v==='blast-burn',count=effectCount(f,burn?12:8);for(let i=0;i<count;i++){const angle=i/count*Math.PI*2,p=at.clone().add(new THREE.Vector3(Math.cos(angle)*(burn?1.4:.7),-.3,Math.sin(angle)*(burn?1.4:.7)));f.emit('flame',p,i%2?0xffcb64:0xf7642b,[.55,burn?1.7:1,1],burn?.9:.65,new THREE.Vector3(0,burn?1.5:.8,0),{billboard:true,additive:true,grow:.6});}ring(f,at,0xff9b38,burn?1.2:.8,.55);}
 else if(v==='water-gun')spray(f,at,0xabeaff,4,1);
 else if(['hydro-pump','hydro-cannon'].includes(v)){spray(f,at,0xd7fbff,12,3.5);glow(f,at,0xb9f4ff,1.1,.45,.6);for(let i=0;i<3;i++)wisp(f,at.clone().addScaledVector(UP,(i-1)*.3),0xc5f5ff,.8+i*.1,.65,new THREE.Vector3(Math.cos(i*2.1),.3,Math.sin(i*2.1)),{additive:true,opacity:.36,grow:1.2});directedRing(f,at,0x9feeff,.7,dir,.6);}
 else if(v==='water-pulse'){for(let i=0;i<3;i++)faceCamera(f,ring(f,at,0x79d4fb,.4+i*.3,.65));}
}
