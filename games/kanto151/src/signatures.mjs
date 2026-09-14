import {THREE} from './world.mjs';
import {TYPE_COLORS} from './core.mjs';
// Authored presentations are separate from damage, so every signature remains balanced by move data.
export const HERO_PRESENTATIONS={
 3:{style:'solar',count:6,pitch:196},6:{style:'wings',count:5,pitch:147},9:{style:'twin-cannon',count:2,pitch:220},
 25:{style:'lightning',count:3,pitch:880},26:{style:'lightning',count:5,pitch:660},38:{style:'orbit',count:9,pitch:330},
 59:{style:'rush',count:4,pitch:165},65:{style:'psychic',count:3,pitch:523},68:{style:'strikes',count:4,pitch:131},
 94:{style:'orbit',count:6,pitch:175},95:{style:'fault',count:7,pitch:65},123:{style:'cross',count:2,pitch:740},
 125:{style:'lightning',count:4,pitch:554},126:{style:'fan',count:7,pitch:185},127:{style:'cross',count:3,pitch:247},
 128:{style:'rush',count:6,pitch:98},130:{style:'helix',count:12,pitch:110},131:{style:'crown',count:6,pitch:698},
 133:{style:'rush',count:3,pitch:392},134:{style:'helix',count:8,pitch:294},135:{style:'fan',count:5,pitch:988},
 136:{style:'orbit',count:5,pitch:262},142:{style:'wings',count:4,pitch:196},143:{style:'fault',count:5,pitch:55},
 144:{style:'crown',count:12,pitch:784},145:{style:'lightning',count:8,pitch:440},146:{style:'wings',count:9,pitch:147},
 149:{style:'helix',count:16,pitch:220},150:{style:'psychic',count:5,pitch:261},151:{style:'prism',count:7,pitch:659}
};
export function presentSignature(game,actor,target,move){
 const spec=HERO_PRESENTATIONS[actor.species.id];if(!spec)return;actor.signatureUses=(actor.signatureUses||0)+1;
 const f=game.feedback,world=game.world,origin=actor.model.position.clone().add(new THREE.Vector3(0,Math.max(.65,actor.model.userData.height*.78),0));
 const aim=target?.model.position.clone().add(new THREE.Vector3(0,Math.max(.75,(target.model.userData.height||1)*.55),0))||origin.clone(),direction=aim.clone().sub(origin).normalize(),side=new THREE.Vector3(direction.z,0,-direction.x),color=TYPE_COLORS[move.type]||'#f1e9b8';
 actor.signatureTime=.7;actor.signatureStyle=spec.style;game.audio.note(spec.pitch,.3,'triangle',.08);game.audio.note(spec.pitch*1.5,.5,'sine',.06,.08);
 const ring=(point,tint,radius,life=.7,vertical=false)=>{const m=f.emit('ring',point,tint,radius,life,null,{grow:.4,opacity:.8});if(m)m.rotation.x=vertical?0:-Math.PI/2;return m;};
 const burst=(point,tint,count,kind='orb')=>{for(let j=0;j<count;j++){const a=j/count*Math.PI*2;f.emit(kind,point,tint,kind==='shard'?[.16,.65,.16]:.24,.6,new THREE.Vector3(Math.cos(a)*2,1.2,Math.sin(a)*2),{gravity:kind==='shard'?4:-.5,grow:kind==='orb'?.7:0});}};
 const ground=aim.clone();ground.y=world.height(aim.x,aim.z)+.1;
 // Ghosts consume light in a low cloud; psychic attacks suspend concentric planes.
 // Electric branches are reserved for electric attacks, instead of reused for every hero.
 if(move.type==='ghost'){ring(ground,0x482465,2.1,1.1);for(let i=0;i<8;i++){const a=i*Math.PI/4;f.emit('orb',aim.clone().add(new THREE.Vector3(Math.cos(a)*1.2,Math.sin(a*2)*.4,Math.sin(a)*1.2)),i%2?0x714a92:0x30243f,[.55,.8,.55],.85,null,{opacity:.7,grow:.8});}return;}
 if(spec.style==='psychic'||spec.style==='prism'){for(let i=0;i<spec.count;i++){const tint=spec.style==='prism'?new THREE.Color().setHSL(i/spec.count,.85,.6):color;const r=ring(aim.clone().add(new THREE.Vector3(0,(i-2)*.42,0)),tint,.8+i*.25,.8,true);if(r)r.rotation.set(Math.PI/2+i*.2,i*.35,0);}return;}
 if(spec.style==='lightning'||move.type==='electric'){for(let i=0;i<Math.min(5,spec.count);i++){const a=i/spec.count*Math.PI*2;f.arc(aim.clone().add(new THREE.Vector3(Math.cos(a)*1.4,2.5+i*.25,Math.sin(a)*1.4)),aim,color,1);}ring(ground,color,1.5,.45);return;}
 if(spec.style==='twin-cannon'){for(const sign of [-1,1]){const from=origin.clone().addScaledVector(side,sign*.75);f.line(from,aim.clone().addScaledVector(side,sign*.35),0x349ee4,.24,.5);for(let i=0;i<6;i++)f.emit('orb',from.clone().lerp(aim,i/6),0x73d7f5,[.28,.4,.28],.55,null,{opacity:.65,grow:.5});}burst(aim,0x79ddf5,10);return;}
 if(spec.style==='crown'||move.type==='ice'){ring(ground,0x5bcde8,2.3,.9);for(let i=0;i<spec.count;i++){const a=i/spec.count*Math.PI*2;f.emit('shard',ground.clone().add(new THREE.Vector3(Math.cos(a)*1.8,.65,Math.sin(a)*1.8)),i%2?0xb1f2fa:0x48b7dc,[.22,.9,.22],.95,null,{grow:.15});}burst(aim,0xa2edff,7,'shard');return;}
 if(spec.style==='fault'){for(let i=0;i<spec.count;i++){const a=i/spec.count*Math.PI*2,end=ground.clone().add(new THREE.Vector3(Math.sin(a)*3.2,0,Math.cos(a)*3.2));f.line(ground,end,0x604638,.09,1.1);burst(end,0x97765d,2,'shard');}return;}
 if(spec.style==='cross'||spec.style==='strikes'){for(let i=0;i<spec.count;i++){const start=aim.clone().addScaledVector(side,i%2?-1.3:1.3).add(new THREE.Vector3(0,1,0)),end=aim.clone().addScaledVector(side,i%2?1.3:-1.3).add(new THREE.Vector3(0,-.5,0));f.line(start,end,color,.065,.2+i*.04);}return;}
 if(spec.style==='wings'){for(let i=0;i<spec.count;i++)for(const sign of [-1,1]){const end=origin.clone().addScaledVector(side,sign*(.9+i*.45)).add(new THREE.Vector3(0,.5+Math.sin(i*.6),0));if(move.type==='fire')f.emit('orb',end,i%2?0xffb53e:0xf15f2e,[.3,.65,.25],.7,new THREE.Vector3(0,.9,0),{grow:.5});else f.emit('leaf',end,color,[.7,.3,.3],.5,null,{spin:3});}burst(aim,color,8);return;}
 if(spec.style==='solar'){for(let i=0;i<6;i++){const a=i/6*Math.PI*2;const start=origin.clone().add(new THREE.Vector3(Math.cos(a)*1.6,1.7,Math.sin(a)*1.6));f.emit('leaf',start,0x8dd658,.45,.7,origin.clone().sub(start).multiplyScalar(2),{spin:3});}f.line(origin,aim,0xb4e671,.22,.45);ring(ground,0x74b747,1.8);return;}
 if(spec.style==='helix'){for(let i=0;i<spec.count;i++){const t=(i+1)/spec.count,a=t*Math.PI*4,p=origin.clone().lerp(aim,t).addScaledVector(side,Math.cos(a)*.65).add(new THREE.Vector3(0,Math.sin(a)*.65,0));f.emit(move.type==='water'?'orb':'ring',p,color,move.type==='water'?.28:.38,.65,null,{opacity:.7,grow:.5});}burst(aim,color,6);return;}
 if(spec.style==='rush'){for(let i=0;i<spec.count;i++)ring(origin.clone().addScaledVector(direction,-i*.6),color,.8,.4,true);return;}
 // Fire orbits/fans are separated fireballs and rising embers, never lightning splines.
 for(let i=0;i<spec.count;i++){const a=i/spec.count*Math.PI*2,p=aim.clone().add(new THREE.Vector3(Math.cos(a)*1.2,.2,Math.sin(a)*1.2));f.emit('orb',p,move.type==='fire'?(i%2?0xffa845:0xed562c):color,[.3,.55,.3],.7,new THREE.Vector3(0,1,0),{grow:.6});}
}
