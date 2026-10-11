import {THREE} from './world.mjs';
import {TYPE_COLORS} from './core.mjs';
import {movePresentation,projectileShape,moveEffectVariant} from './move-presentation.mjs';
const UP=new THREE.Vector3(0,1,0);
export function effectCount(f,n){return Math.max(2,Math.round(n*(f.world.quality==='low'?.55:1)*(f.game.save.settings.motion===false?.7:1)));}
function ring(f,p,c,s,life=.42,ground=false){const m=f.emit('ring',p,c,s,life,null,{grow:.75,opacity:.72});if(m)m.rotation.x=ground?-Math.PI/2:0;return m;}
function basis(a,b){const forward=b.clone().sub(a).normalize(),side=new THREE.Vector3(forward.z,0,-forward.x).normalize();if(!side.lengthSq())side.set(1,0,0);return{forward,side};}
function path(f,a,b,c,n,shape='orb',scale=.13){const {side}=basis(a,b);for(let i=0;i<effectCount(f,n);i++){const t=(i+1)/(effectCount(f,n)+1),p=a.clone().lerp(b,t).addScaledVector(side,Math.sin(t*Math.PI*3)*.16);const m=f.emit(shape,p,c,scale,.32,new THREE.Vector3(0,.2,0),{spin:shape==='leaf'?5:0});if(m&&shape==='leaf')m.rotation.set(.5,i,1);}}
export function travelEffect(f,move,a,b){const family=movePresentation(move),c=TYPE_COLORS[move.type]||'#fff1cc',{forward,side}=basis(a,b),at=b.clone();if(namedTravel(f,move,a,b))return;
 if(family==='slash'){for(let i=0;i<3;i++){const start=at.clone().addScaledVector(side,-.65+i*.23).addScaledVector(UP,.65),mid=at.clone().addScaledVector(side,.15+i*.23),end=at.clone().addScaledVector(side,.6+i*.23).addScaledVector(UP,-.6);f.line(start,mid,c,.045,.18+i*.025);f.line(mid,end,c,.035,.2+i*.025);}return;}
 if(family==='bite'){for(const sign of [-1,1])for(let i=0;i<4;i++){const p=at.clone().addScaledVector(side,(i-1.5)*.3).addScaledVector(UP,sign*.55);f.line(p,p.clone().addScaledVector(UP,-sign*.4),c,.09,.25);}return;}
 if(['punch','kick','contact'].includes(family)){const p=a.clone().lerp(b,.78);f.line(p,at,c,family==='kick'?.14:.1,.16);ring(f,at,c,.28,.25);return;}
 if(family==='vine'){for(const sign of [-1,1]){let last=a;for(let i=1;i<=7;i++){const t=i/7,p=a.clone().lerp(b,t).addScaledVector(side,sign*Math.sin(t*Math.PI)*.85).addScaledVector(UP,Math.sin(t*Math.PI)*.25);f.line(last,p,c,.055,.28);last=p;}}return;}
 if(family==='spark'){f.arc(a,b,c,3);return;}
 if(family==='jet'){f.line(a,b,c,move.engine.power>=100?.22:.12,.27);path(f,a,b,0xbceeff,7,'orb',.11);ring(f,b,0xa3e7ff,.35,.3);return;}
 if(family==='bubble'){path(f,a,b,c,10,'ring',.19);path(f,a.clone().addScaledVector(side,.25),b,0xbcefff,5,'orb',.12);return;}
 if(['flame','ember'].includes(family)){path(f,a,b,c,family==='flame'?14:5,'orb',family==='flame'?[.22,.38,.22]:.12);path(f,a,b,0xffd486,5,'shard',[.06,.2,.06]);return;}
 if(family==='leaf'){path(f,a,b,c,8,'leaf',[.4,.65,.4]);return;}
 if(family==='needle'){for(let i=0;i<3;i++){const p=a.clone().lerp(b,.35+i*.2);f.line(p,p.clone().addScaledVector(forward,.65),c,.055,.22);}return;}
 if(family==='frost'){f.line(a,b,0xb5f4ff,.085,.25);path(f,a,b,c,7,'shard',[.11,.35,.11]);return;}
 if(['psychic','shadow','beam','solar'].includes(family)){f.line(a,b,c,family==='solar'?.2:.09,.3);for(let i=0;i<4;i++){const m=ring(f,a.clone().lerp(b,(i+1)/5),c,.28+i*.09,.38);if(m)m.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),forward);}return;}
 if(family==='sound'){for(let i=0;i<5;i++){const m=ring(f,a.clone().lerp(b,(i+1)/6),c,.25+i*.14,.4);if(m)m.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),forward);}return;}
 if(family==='star'){path(f,a,b,0xffe69b,6,'star',.18);return;}
 if(['stone','fault'].includes(family)){path(f,a,b,c,5,'shard',[.2,.32,.2]);return;}
 if(family==='drain'){path(f,b,a,0xa8e67b,8,'orb',.11);return;}
 if(['gust','rush'].includes(family)){for(const sign of [-1,1]){const start=a.clone().addScaledVector(side,sign*.4),end=b.clone().addScaledVector(side,sign*.45);f.line(start,end,c,.045,.22);}if(family==='gust')path(f,a,b,c,5,'leaf',.2);return;}
 if(['powder','sludge','status'].includes(family)){path(f,a,b,c,8,'orb',family==='sludge'?[.18,.28,.18]:.065);ring(f,b,c,.4,.5);return;}
 f.line(a,b,c,.06,.18);
}
export function areaEffect(f,move,center,radius){const family=movePresentation(move),c=TYPE_COLORS[move.type]||'#fff1cc',at=center.clone();at.y=f.world.height(at.x,at.z)+.14;if(namedArea(f,move,at,radius))return;const count=effectCount(f,12);
 if(family==='spark'){f.arc(at.clone().addScaledVector(UP,4),at,c,3);}
 for(let i=0;i<count;i++){const angle=i/count*Math.PI*2,d=new THREE.Vector3(Math.cos(angle),0,Math.sin(angle)),p=at.clone().addScaledVector(d,radius*.7);
  if(family==='wave'){const m=ring(f,at.clone().addScaledVector(UP,i*.07),i%2?0xa1e6ef:c,.5+i*radius/count,.65,true);if(m)m.scale.y*=.85;}
  else if(['stone','fault'].includes(family)){f.line(at,p,0x96795b,.08,.8);f.emit('shard',p,c,[.23,.6,.23],.65,d.clone().multiplyScalar(.7).addScaledVector(UP,1),{gravity:4});}
  else if(family==='frost')f.emit('shard',p.clone().addScaledVector(UP,1),c,[.1,.4,.1],.65,new THREE.Vector3(0,-1,0),{spin:2});
  else if(['ember','flame','explosion'].includes(family))f.emit('orb',p,c,[.22,.4,.22],.65,d.clone().multiplyScalar(1.2).addScaledVector(UP,1),{grow:.6});
  else if(family==='vine'){f.line(p,p.clone().addScaledVector(UP,1),c,.055,.7);f.emit('leaf',p.clone().addScaledVector(UP,.8),c,.25,.7,null,{spin:2});}
  else f.emit(projectileShape(move),p,c,.15,.5,d.clone().multiplyScalar(.7).addScaledVector(UP,.7));
 }
 if(family!=='wave')ring(f,at,c,Math.min(1.2,radius*.35),.6,true);
}
export function supportEffect(f,actor,move){const p=actor.model.position.clone().addScaledVector(UP,.7),c=move.engine.template==='heal'?0x98e6ac:TYPE_COLORS[move.type]||'#dbe9ff';
 if(move.engine.template==='shield'){for(let i=0;i<3;i++){const m=ring(f,p,c,.65+i*.13,.85);if(m)m.rotation.set(i*Math.PI/3,i*Math.PI/4,0);}}
 else for(let i=0;i<effectCount(f,8);i++){const a=i*Math.PI/4,v=new THREE.Vector3(Math.cos(a)*.45,.9,Math.sin(a)*.45);f.emit(move.engine.template==='heal'?'cross':'shard',p.clone().addScaledVector(v,.7),c,move.engine.template==='heal'?.12:[.07,.3,.07],.65,v,{grow:.2});}
}
export function projectileGeometry(move,signature){const v=moveEffectVariant(move);if(v==='fire-blast')return new THREE.ExtrudeGeometry(fireBlastShape(),{depth:.08,bevelEnabled:false}).scale(1.1,1.1,1.1);if(v==='water-gun')return new THREE.CylinderGeometry(.09,.065,.7,6);if(['hydro-cannon','overheat','blast-burn'].includes(v))return new THREE.IcosahedronGeometry(v==='hydro-cannon'?.45:.5,1);const s=signature?.36:.24,shape=projectileShape(move);if(shape==='shard')return new THREE.OctahedronGeometry(s,0);if(shape==='leaf')return new THREE.PlaneGeometry(s*2.2,s*.85);if(shape==='ring')return new THREE.TorusGeometry(s,.055,5,16);if(shape==='star')return new THREE.ExtrudeGeometry(starShape(),{depth:.05,bevelEnabled:false}).scale(s,s,s);return new THREE.IcosahedronGeometry(s,1);}
export function starShape(){const s=new THREE.Shape();for(let i=0;i<10;i++){const a=i*Math.PI/5,r=i%2?.43:1;const x=Math.sin(a)*r,y=Math.cos(a)*r;i?s.lineTo(x,y):s.moveTo(x,y);}s.closePath();return s;}
export function trailEffect(f,q){const v=moveEffectVariant(q.move),p=q.mesh.position.clone();
 if(v==='fire-blast'){faceCamera(f,q.mesh);glyph(f,p,.7,.23);return;}
 if(v==='water-gun'){q.mesh.quaternion.setFromUnitVectors(UP,q.direction);f.line(p.clone().addScaledVector(q.direction,-.85),p,0x9beaff,.055,.15);return;}
 if(v==='bubble'){faceCamera(f,q.mesh);for(let i=0;i<2;i++)faceCamera(f,ring(f,p.clone().add(new THREE.Vector3((i-.5)*.28,.1*i,0)),i?0xbef8ff:0x79d2e8,.14+i*.04,.38));return;}
 if(v==='water-pulse'){faceCamera(f,q.mesh);directedRing(f,p,0x8be3ff,.3,q.direction,.4);return;}
 if(['hydro-cannon','overheat','blast-burn'].includes(v)){const water=v==='hydro-cannon';f.emit('orb',p,water?0xa6f0ff:0xffa63d,water?[.25,.4,.25]:[.3,.5,.3],.38,null,{grow:.7});directedRing(f,p,water?0xe0faff:0xffd573,.4,q.direction,.35);return;}
 const shape=projectileShape(q.move),family=movePresentation(q.move),c=TYPE_COLORS[q.move.type]||'#fff1cc',at=q.mesh.position.clone();q.mesh.rotation.z+=.28;const scale=shape==='shard'?[.075,.2,.075]:shape==='leaf'?[.2,.35,.2]:shape==='ring'?.16:.1;f.emit(shape,at,c,scale,.28,null,{opacity:.6,spin:shape==='leaf'?4:0,grow:family==='shadow'?.7:.2});if(['jet','flame','spark'].includes(family)){const end=at.clone().addScaledVector(q.direction,-.65);family==='spark'?f.arc(end,at,c,0):f.line(end,at,c,family==='jet'?.09:.055,.13);}}
export function impactEffect(f,move,at,dir){namedImpact(f,move,at,dir);const family=movePresentation(move),c=TYPE_COLORS[move.type]||'#fff1cc';if(['bubble','star','leaf','needle','sludge','shadow','drain'].includes(family))for(let i=0;i<effectCount(f,6);i++){const a=i*Math.PI/3,v=new THREE.Vector3(Math.cos(a),.5+Math.sin(a)*.4,Math.sin(a));f.emit(family==='bubble'?'ring':family==='star'?'star':family==='leaf'?'leaf':family==='needle'?'shard':'orb',at,c,family==='needle'?[.07,.28,.07]:.18,.4,v,{spin:family==='star'||family==='leaf'?3:0,grow:family==='bubble'?.8:0});}}
// Geometry for 大 uses three burning strokes, without text/fonts or imported assets.
export function fireBlastShape(){return [[[-1,.35],[1,.35]],[[.15,1.3],[-.9,-1]],[[.05,.4],[1,-1]]].map(([a,b])=>{const dx=b[0]-a[0],dy=b[1]-a[1],n=Math.hypot(dx,dy),x=-dy/n*.115,y=dx/n*.115,s=new THREE.Shape();s.moveTo(a[0]+x,a[1]+y);s.lineTo(b[0]+x,b[1]+y);s.lineTo(b[0]-x,b[1]-y);s.lineTo(a[0]-x,a[1]-y);s.closePath();return s;});}
function faceCamera(f,m){if(m&&f.world.camera)m.quaternion.copy(f.world.camera.quaternion);return m;}
function directedRing(f,p,c,s,forward,life=.4){const m=ring(f,p,c,s,life);if(m)m.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),forward);return m;}
function glyph(f,p,scale=1.2,life=.5){faceCamera(f,f.emit('fire-glyph',p,0xff632d,scale,life,null,{opacity:.92,grow:.3}));faceCamera(f,f.emit('fire-glyph',p.clone().add(new THREE.Vector3(0,0,.015)),0xffd779,scale*.8,life*.85,null,{opacity:.9}));}
function spray(f,p,c,n,speed=2){for(let i=0;i<effectCount(f,n);i++){const angle=i/n*Math.PI*2;f.emit('orb',p,c,[.045,.19,.045],.48,new THREE.Vector3(Math.cos(angle)*speed,1.8,Math.sin(angle)*speed),{gravity:4});}}
export function elementalWindup(f,actor,move){const v=moveEffectVariant(move),p=actor.model.position.clone().addScaledVector(UP,Math.max(.65,(actor.model.userData.height||1)*.65));if(v==='fire-blast')glyph(f,p,.32,move.engine.castTime);else if(['overheat','blast-burn','hydro-cannon'].includes(v)){const water=v==='hydro-cannon';f.emit('orb',p,water?0xb9f3ff:0xff9e38,water?.3:.4,move.engine.castTime,null,{grow:1.4,opacity:.7});}else if(v==='thunder'){directedRing(f,p,0xffe76c,.6,new THREE.Vector3(0,1,0),move.engine.castTime);}}
function namedTravel(f,move,a,b){const v=moveEffectVariant(move),{forward,side}=basis(a,b);
 if(v==='flamethrower'){f.line(a,b,0xff7e2e,.15,.43);f.line(a,b,0xffdc82,.065,.38);for(let i=0;i<effectCount(f,15);i++){const t=(i+1)/16,p=a.clone().lerp(b,t).addScaledVector(side,Math.sin(t*20)*.13);f.emit('orb',p,i%3?0xff9c32:0xffcf64,[.16,.3,.16],.43,forward.clone().multiplyScalar(1.2),{grow:.4});}return true;}
 if(v==='fire-blast'){glyph(f,b,1.35,.6);return true;}
 if(v==='water-gun'){f.line(a,b,0x69cfff,.065,.22);spray(f,b,0xb7efff,3,.8);return true;}
 if(v==='hydro-pump'){f.line(a,b,0x299dda,.3,.58);f.line(a,b,0xb1efff,.115,.54);for(let i=0;i<effectCount(f,7);i++){const t=(i+1)/8;directedRing(f,a.clone().lerp(b,t),0xb4f4ff,.27+t*.2,forward,.5);}spray(f,b,0xc5f5ff,10,3);return true;}
 if(v==='bubble'){for(let i=0;i<effectCount(f,6);i++){const p=a.clone().lerp(b,(i+1)/7).addScaledVector(side,Math.sin(i*1.7)*.4);faceCamera(f,ring(f,p,i%2?0xb7f3ff:0x69cadf,.14+(i%3)*.055,.48));}return true;}
 if(v==='bubble-beam'){for(let i=0;i<effectCount(f,11);i++)directedRing(f,a.clone().lerp(b,(i+1)/12),i%2?0xc7f6ff:0x57cddd,.21+(i%3)*.025,forward,.44);return true;}
 if(v==='water-pulse'){for(let i=0;i<3;i++)directedRing(f,a.clone().lerp(b,.4+i*.2),0x81dcff,.28+i*.18,forward,.5);return true;}
 if(v==='heat-wave'){for(let i=0;i<effectCount(f,6);i++){const t=(i+1)/7,p=a.clone().lerp(b,t);directedRing(f,p,i%2?0xffc259:0xf57d38,.25+t*.75,forward,.4);f.emit('orb',p,0xffa843,[.25,.1,.25],.38,forward.clone().multiplyScalar(1.5));}return true;}
 if(v==='thunder-shock'){f.arc(a,b,0xffed79,0);return true;}
 if(v==='thunderbolt'){f.arc(a,b,0xffe367,3);f.arc(a.clone().addScaledVector(side,.15),b,0xfff4b1,2);return true;}
 return false;
}
function namedArea(f,move,at,radius){const v=moveEffectVariant(move);
 if(v==='fire-spin'){const count=effectCount(f,15);for(let i=0;i<count;i++){const t=i/count,angle=t*Math.PI*5,p=at.clone().add(new THREE.Vector3(Math.cos(angle)*radius*.65,t*2+.1,Math.sin(angle)*radius*.65));f.emit('orb',p,i%2?0xffb440:0xf5632e,[.18,.33,.18],.7,new THREE.Vector3(-Math.sin(angle)*.5,.25,Math.cos(angle)*.5),{grow:.4});}ring(f,at,0xffa646,radius*.7,.7,true);return true;}
 if(v==='thunder'){const top=at.clone().addScaledVector(UP,5);f.arc(top,at,0xffde57,3);f.arc(top.clone().add(new THREE.Vector3(.5,.5,0)),at,0xfff4b9,1);ring(f,at,0xffd859,radius*.7,.45,true);return true;}
 if(v==='blizzard'){const count=effectCount(f,18);for(let i=0;i<count;i++){const angle=i/count*Math.PI*2,p=at.clone().add(new THREE.Vector3(Math.cos(angle)*radius*.8,1+(i%3)*.5,Math.sin(angle)*radius*.8));f.emit('shard',p,i%2?0xe1fbff:0x72d9f2,[.12,.32,.12],.85,new THREE.Vector3(-Math.sin(angle)*1.5,-.65,Math.cos(angle)*1.5),{spin:3});}ring(f,at,0xc1f6ff,radius*.65,.8,true);return true;}
 return false;
}
function namedImpact(f,move,at,dir){const v=moveEffectVariant(move);
 if(v==='fire-blast'){glyph(f,at,1.55,.65);for(let i=0;i<effectCount(f,10);i++){const angle=i*Math.PI/5;f.emit('orb',at, i%2?0xffbe54:0xff672a,[.15,.28,.15],.6,new THREE.Vector3(Math.cos(angle)*2,Math.sin(angle)*1.6+.6,Math.sin(angle)*2),{grow:.4});}}
 else if(['overheat','blast-burn'].includes(v)){const burn=v==='blast-burn';for(let i=0;i<effectCount(f,burn?12:8);i++){const angle=i*Math.PI/6,p=at.clone().add(new THREE.Vector3(Math.cos(angle)*(burn?1.4:.7),-.3,Math.sin(angle)*(burn?1.4:.7)));f.emit('orb',p,i%2?0xffcb64:0xf7642b,[.22,burn?.8:.45,.22],burn?.9:.65,new THREE.Vector3(0,burn?1.5:.8,0),{grow:.6});}ring(f,at,0xff9b38,burn?1.2:.8,.55);}
 else if(v==='water-gun')spray(f,at,0xabeaff,4,1);
 else if(['hydro-pump','hydro-cannon'].includes(v)){spray(f,at,0xbaf1ff,12,3.5);for(let i=0;i<2;i++)directedRing(f,at,0x9feeff,.6+i*.35,dir,.65);}
 else if(v==='water-pulse'){for(let i=0;i<3;i++)faceCamera(f,ring(f,at,0x79d4fb,.4+i*.3,.65));}
}
