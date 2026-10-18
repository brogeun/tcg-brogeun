import {movePresentation,moveEffectVariant} from './move-presentation.mjs';
import {travelEffect,areaEffect,supportEffect,projectileGeometry,trailEffect,starShape,fireBlastShape,elementalWindup,effectCount,impactEffect} from './move-effects.mjs';
import {THREE} from './world.mjs';
import {TYPE_COLORS,clamp} from './core.mjs';
import {presentSignature,HERO_PRESENTATIONS} from './signatures.mjs';
import {paintEffectTextures} from './vfx-textures.mjs';
import {offenseVfxDescriptor} from './move-vfx-catalog-offense.mjs';
import {statusVfxDescriptor} from './move-vfx-catalog-status.mjs';

// Small generated alpha textures keep the original block models while giving
// transient effects soft edges. DataTexture works in the browser and CPU tests.
export function createEffectTextures(){return paintEffectTextures(THREE);}

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
 constructor(game){this.game=game;this.world=game.world;this.game.motionPreference??=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');this.pause=0;this.slow=0;this.serial=0;this.events=[];this.visuals=[];
  this.geometries={'fire-glyph':new THREE.ShapeGeometry(fireBlastShape()),orb:new THREE.IcosahedronGeometry(1,0),shard:new THREE.OctahedronGeometry(1,0),line:new THREE.CylinderGeometry(1,1,1,5),ring:new THREE.TorusGeometry(1,.055,4,28),mark:new THREE.CircleGeometry(1,14),leaf:new THREE.PlaneGeometry(1,.45),star:new THREE.ShapeGeometry(starShape()),cross:new THREE.ShapeGeometry(new THREE.Shape([new THREE.Vector2(-.2,-1),new THREE.Vector2(.2,-1),new THREE.Vector2(.2,-.2),new THREE.Vector2(1,-.2),new THREE.Vector2(1,.2),new THREE.Vector2(.2,.2),new THREE.Vector2(.2,1),new THREE.Vector2(-.2,1),new THREE.Vector2(-.2,.2),new THREE.Vector2(-1,.2),new THREE.Vector2(-1,-.2),new THREE.Vector2(-.2,-.2)]))};
  this.textures=createEffectTextures();for(const shape of Object.keys(this.textures)){this.geometries[shape]?.dispose();this.geometries[shape]=new THREE.PlaneGeometry(1,1);}this.geometries.rock.dispose();this.geometries.rock=new THREE.IcosahedronGeometry(1,0);this.geometries.ice.dispose();this.geometries.ice=new THREE.OctahedronGeometry(1,0).scale(.5,1,.5);this._beamSide=new THREE.Vector3();this._beamView=new THREE.Vector3();this._beamNormal=new THREE.Vector3();this._beamMatrix=new THREE.Matrix4();
  this.group=new THREE.Group();this.world.scene.add(this.group);this.pool=Array.from({length:180},()=>{const m=new THREE.Mesh(this.geometries.orb,new THREE.MeshBasicMaterial({transparent:true,depthWrite:false,toneMapped:false,side:THREE.DoubleSide}));this.configureEffectMaterial(m.material);m.visible=false;this.group.add(m);const particle={mesh:m,basicMaterial:m.material,litMaterial:null,life:0,max:1,velocity:new THREE.Vector3(),beamDirection:new THREE.Vector3(0,1,0),beam:false,billboard:false,angle:0,spin:0,gravity:0,grow:0};m.userData.feedbackParticle=particle;return particle;});
 }
 clear(){for(const p of this.pool){p.life=0;p.delay=0;p.motion=null;p.follow=null;p.mesh.visible=false;}for(const ghost of this.ghosts||[]){ghost.model.removeFromParent();for(const material of ghost.materials||[ghost.material])material.dispose();}this.ghosts=[];this.pause=0;this.slow=0;}
 dispose(){this.clear();this.group.removeFromParent();for(const p of this.pool){p.basicMaterial.dispose();p.litMaterial?.dispose();}for(const geometry of Object.values(this.geometries))geometry.dispose();for(const texture of Object.values(this.textures))texture.dispose();}
 reducedMotion(){return this.game.save.settings.motion===false||this.game.motionPreference?.matches===true;}
 afterimage(actor,position,life=.5,{color=0xc7eaff,opacity=.24,delay=0,scale=1}={}){
  const cap=this.reducedMotion()?1:this.world.quality==='low'?2:4;this.ghosts??=[];if(this.ghosts.length>=cap||!actor?.model)return null;
  const materialMap=new Map(),materials=[],ghostOpacity=Math.min(this.reducedMotion()?.16:1,opacity);
  const ghostMaterial=original=>{if(materialMap.has(original))return materialMap.get(original);const cutoutThreshold=Math.max(.06,original?.alphaTest||0),material=new THREE.MeshBasicMaterial({color,map:original?.map||null,alphaMap:original?.alphaMap||null,alphaTest:cutoutThreshold*ghostOpacity,transparent:true,opacity:ghostOpacity,depthWrite:false,side:THREE.DoubleSide,toneMapped:false});material.userData.cutoutThreshold=cutoutThreshold;materialMap.set(original,material);materials.push(material);return material;};
  // Preserve each source cutout mask; turning alpha planes into a solid tint
  // would reveal the full rectangular wing/flame sheets in the afterimage.
  const copyPose=source=>{const node=source.isMesh?new THREE.Mesh(source.geometry,Array.isArray(source.material)?source.material.map(ghostMaterial):ghostMaterial(source.material)):new THREE.Group();node.position.copy(source.position);node.quaternion.copy(source.quaternion);node.scale.copy(source.scale);node.visible=source.visible;node.renderOrder=3;for(const child of source.children)node.add(copyPose(child));return node;},model=copyPose(actor.model);
  model.position.copy(position||actor.model.position);model.scale.multiplyScalar(scale);model.visible=delay<=0;this.group.add(model);
  const duration=this.reducedMotion()?Math.min(.4,life):life;this.ghosts.push({model,materials,material:materials[0],opacity:ghostOpacity,life:duration,max:duration,delay:this.reducedMotion()?0:delay});return model;
 }
 surfacePosition(position){
  const context=this.emissionContext,target=context?.target;if(!target?.model||!(context.move?.engine?.power>0)||!['travel','impact'].includes(context.stage))return position.clone();
  if(context.stage==='travel'&&!['melee','multi-hit'].includes(context.move.engine.template))return position.clone();
  const h=target.model.userData.height||1,center=target.model.position.clone().add(new THREE.Vector3(0,h*.5,0));if(position.distanceTo(center)>Math.max(.8,h*.9))return position.clone();
  const toward=this.world.camera?.position?.clone().sub(center);if(!toward?.lengthSq())return position.clone();return position.clone().addScaledVector(toward.normalize(),clamp(h*.25,.25,.85));
 }
 configureEffectMaterial(material){
  const uniforms={time:{value:0},flow:{value:0}};material.userData.fx=uniforms;
  material.onBeforeCompile=shader=>{shader.uniforms.combatTime=uniforms.time;shader.uniforms.combatFlow=uniforms.flow;
   shader.fragmentShader='uniform float combatTime; uniform float combatFlow;\n'+shader.fragmentShader;
   shader.fragmentShader=shader.fragmentShader.replace('#include <map_fragment>',`#ifdef USE_MAP
    vec2 combatUv=vMapUv;
    float combatShift=sin(combatUv.y*21.0-combatTime*7.5)*sin(combatUv.y*3.14159)*0.024*combatFlow;
    combatUv.x+=combatShift;
    vec4 combatTexel=texture2D(map,combatUv);
    combatTexel.a*=0.88+0.12*sin(combatUv.y*37.0-combatTime*9.0)*min(1.0,combatFlow);
    diffuseColor*=combatTexel;
   #endif`);
  };material.customProgramCacheKey=()=> 'kanto-combat-flow-v1';
 }
 animate(mesh,options={}){
  const p=mesh?.userData.feedbackParticle;if(!p)return mesh;const reduced=this.reducedMotion(),vector=v=>v?.clone?v.clone():new THREE.Vector3(...(Array.isArray(v)?v:[0,0,0]));
  const base=mesh.scale.clone(),scale=v=>Array.isArray(v)?new THREE.Vector3(...v):base.clone().multiplyScalar(v??1);
  const orbit=options.orbit,axis=vector(orbit?.axis||options.axis||options.normal||[0,1,0]);if(axis.lengthSq()<1e-8)axis.set(0,1,0);axis.normalize();
  const side=new THREE.Vector3().crossVectors(axis,Math.abs(axis.y)<.9?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0)).normalize(),cross=new THREE.Vector3().crossVectors(axis,side).normalize();
  const start=orbit?.center||options.from,from=start?(p.surfaceEligible?this.surfacePosition(vector(start)):vector(start)):mesh.position.clone(),to=options.to?(p.surfaceEligible?this.surfacePosition(vector(options.to)):vector(options.to)):from.clone();
  const duration=options.duration??p.max;if(options.duration!==undefined){p.life=p.max=Math.max(.05,reduced?Math.min(.5,duration):duration);}
  p.delay=reduced?Math.min(options.delay||0,.12):Math.max(0,options.delay||0);p.motion={path:!!(options.from||options.to||options.curve||orbit),from,to,curve:orbit?'orbit':options.curve||'linear',height:(options.height??options.arcHeight??0)*(reduced?.2:1),radius:(orbit?.radius??options.radius??0)*(reduced?.35:1),turns:options.turns??1,speed:orbit?.speed,phase:orbit?.phase??options.phase??0,axis,side,cross,scaleFrom:scale(options.scaleFrom),scaleTo:scale(options.scaleTo),opacityFrom:options.opacityFrom??1,opacityTo:options.opacityTo??1,pulse:options.pulse,reduced};
  if(options.velocity)p.velocity.copy(vector(options.velocity)).multiplyScalar(reduced?.12:1);
  if(options.gravity!==undefined)p.gravity=reduced?0:options.gravity;if(options.spin!==undefined)p.spin=reduced?0:options.spin;if(options.grow!==undefined)p.grow=reduced?clamp(options.grow,-.2,.25):options.grow;
  mesh.scale.copy(p.motion.scaleFrom);mesh.material.opacity=p.opacity*p.motion.opacityFrom*.55;
  if(p.delay>0)mesh.visible=false;else if(options.from||orbit)mesh.position.copy(from);
  return mesh;
 }
 emit(shape,pos,color,scale,life=.4,velocity=null,options={}){
  const reduced=this.reducedMotion(),budget=reduced?64:this.world.quality==='low'?100:180,p=this.pool.slice(0,budget).find(p=>p.life<=0);if(!p)return null;
  const lit=['rock','ice','line'].includes(shape);if(lit&&!p.litMaterial){p.litMaterial=new THREE.MeshStandardMaterial({transparent:true,depthWrite:false,roughness:.88,metalness:0,flatShading:true,side:THREE.DoubleSide});this.configureEffectMaterial(p.litMaterial);}p.mesh.material=lit?p.litMaterial:p.basicMaterial;if(lit){p.mesh.material.roughness=shape==='ice'?.18:.88;p.mesh.material.metalness=shape==='ice'?.08:0;p.mesh.material.emissive.setHex(shape==='ice'?0x5795bb:0x000000);p.mesh.material.emissiveIntensity=shape==='ice'?.12:0;}
  p.mesh.geometry=this.geometries[shape]||this.geometries.orb;p.mesh.position.copy(pos);p.mesh.rotation.set(0,0,0);p.mesh.scale.set(...(Array.isArray(scale)?scale:[scale,scale,scale]));p.mesh.material.color.set(color);p.motion=null;p.delay=0;p.shape=shape;p.baseScale=p.mesh.scale.clone();p.follow=options.follow===false?null:options.follow?.model||options.follow||this.emissionContext?.anchor||null;p.followAt=p.follow?.position?.clone();p.mesh.userData.effectSlug=this.emissionContext?.move?.slug;p.mesh.userData.effectStage=this.emissionContext?.stage;
  const coolFlame=['flame','plume'].includes(shape)&&p.mesh.material.color.b>p.mesh.material.color.r*1.2,texture=lit?null:this.textures[coolFlame?'spirit-flame':shape]||null;p.surfaceEligible=!!texture;if(texture)p.mesh.position.copy(this.surfacePosition(pos));if(!!p.mesh.material.map!==!!texture)p.mesh.material.needsUpdate=true;p.mesh.material.map=texture;p.mesh.material.alphaTest=texture?.003:0;p.beam=false;p.billboard=options.billboard??!!texture;p.angle=options.angle||0;if(p.billboard&&this.world.camera){p.mesh.quaternion.copy(this.world.camera.quaternion);p.mesh.rotateZ(p.angle);} 
  p.opacity=Math.min(options.opacity??.95,reduced?.65:1);p.mesh.material.opacity=p.opacity*.55;p.mesh.material.blending=options.additive&&!reduced&&!lit?THREE.AdditiveBlending:THREE.NormalBlending;p.mesh.visible=true;p.mesh.renderOrder=options.renderOrder??(texture?6:2);p.mesh.material.userData.fx.flow.value=!reduced&&['flame','spirit-flame','plume','fire-glyph','water','smoke','energy-orb'].includes(shape)?1:0;
  p.life=p.max=Math.max(.05,reduced?Math.min(life,.5):life);p.age=0;p.fadeIn=Math.min(.03,p.max*.12);p.velocity.copy(velocity||new THREE.Vector3()).multiplyScalar(reduced?.12:1);p.gravity=reduced?0:options.gravity||0;p.spin=reduced?0:options.spin||0;p.grow=reduced?clamp(options.grow||0,-.2,.25):options.grow||0;return p.mesh;
 }
 alignRibbon(mesh,direction){
  const view=this._beamView,side=this._beamSide,normal=this._beamNormal;
  if(this.world.camera?.position)view.copy(this.world.camera.position).sub(mesh.position);else view.set(0,0,1);
  side.crossVectors(direction,view);if(side.lengthSq()<1e-8)side.crossVectors(direction,Math.abs(direction.y)<.95?new THREE.Vector3(0,1,0):new THREE.Vector3(1,0,0));side.normalize();normal.crossVectors(side,direction).normalize();
  this._beamMatrix.makeBasis(side,direction,normal);mesh.quaternion.setFromRotationMatrix(this._beamMatrix);
 }
 ribbon(a,b,color,width=.4,life=.35,options={}){
  const delta=b.clone().sub(a),length=delta.length();if(!Number.isFinite(length)||length<1e-5)return null;
  const mesh=this.emit(options.shape||'ribbon',a.clone().lerp(b,.5),color,[width,length,1],life,options.velocity||null,{additive:true,opacity:.8,...options,billboard:false});if(!mesh)return null;
  if(options.shape==='ice')mesh.scale.y*=.5; // The crystal spans two local Y units; sprite planes span one.
  const p=mesh.userData.feedbackParticle;p.beam=true;p.beamDirection.copy(delta).multiplyScalar(1/length);this.alignRibbon(mesh,p.beamDirection);return mesh;
 }
 line(a,b,color,width=.055,life=.2){const delta=b.clone().sub(a),mesh=this.emit('line',a.clone().lerp(b,.5),color,[width,delta.length(),width],life);if(mesh)mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0,1,0),delta.normalize());return mesh;}
 arc(a,b,color,branches=2){const reduced=this.reducedMotion(),steps=reduced?3:this.world.quality==='low'?4:6;let last=a;for(let i=1;i<=steps;i++){const next=a.clone().lerp(b,i/steps);if(i<steps)next.add(new THREE.Vector3((Math.random()-.5)*(reduced?.2:.9),(Math.random()-.5)*(reduced?.2:1.1),(Math.random()-.5)*(reduced?.2:.8)));this.ribbon(last,next,color,reduced?.28:.5,reduced?.26:.2,{opacity:.65});this.line(last,next,0xfff7dd,reduced?.025:.035,reduced?.26:.2);if(!reduced&&i<=branches){const branch=next.clone().add(new THREE.Vector3((Math.random()-.5)*2,.7,(Math.random()-.5)*2));this.ribbon(next,branch,color,.24,.24,{opacity:.5});this.line(next,branch,0xfff5c2,.018,.22);}last=next;}}
 authored(move){return !!(offenseVfxDescriptor(move)||statusVfxDescriptor(move));}
 effectContext(move,stage,actor,target,fn){const previous=this.emissionContext;this.emissionContext={move,stage,actor,target,anchor:['windup','support'].includes(stage)?actor?.model:null};try{return fn();}finally{this.emissionContext=previous;}}
 windup(actor,target,move){const profile=feedbackProfile(move);actor.windup=Math.max(.08,actor.combatMotion?.castTime??profile.anticipation);this.recordVisual('windup',move);this.effectContext(move,'windup',actor,target,()=>elementalWindup(this,actor,move,target));this.game.audio.combat?.('launch',move.type,profile.tier,this.pan(actor));}
 recordVisual(stage,move){this.visuals.push({stage,moveId:move.id,family:movePresentation(move),variant:moveEffectVariant(move),template:move.engine.template,at:this.game.save.playTime});if(this.visuals.length>72)this.visuals.shift();}
 travel(actor,target,move,from,to){this.recordVisual('travel',move);this.game.audio.combat?.('travel',move.type,feedbackProfile(move).tier,this.pan(actor));this.effectContext(move,'travel',actor,target,()=>travelEffect(this,move,from,to));if(move.engine.template==='dash')this.afterimage(actor,actor.model.position,.55,{color:offenseVfxDescriptor(move)?.primary??0xc7eaff,opacity:.2});}
 area(move,center,radius,actor){this.recordVisual('area',move);this.effectContext(move,'area',actor,null,()=>areaEffect(this,move,center,radius,actor));}
 support(actor,move){this.recordVisual('support',move);this.effectContext(move,'support',actor,null,()=>supportEffect(this,actor,move));}
 projectile(move,signature){this.recordVisual('projectile',move);return projectileGeometry(move,signature);}
 styleProjectile(mesh,move){
  const descriptor=offenseVfxDescriptor(move),shape=descriptor?.coreTexture,texture=this.textures[shape];if(!texture)return;
  this.configureEffectMaterial(mesh.material);mesh.material.map=texture;mesh.material.alphaTest=.015;mesh.material.depthWrite=false;mesh.material.color.set(descriptor.coreColor??(move.type==='fire'?0xffb66c:descriptor.primary??0xffffff));mesh.material.opacity=.95;mesh.material.blending=descriptor.coreAdditive===false||descriptor.ink||shape==='fire-glyph'?THREE.NormalBlending:THREE.AdditiveBlending;mesh.material.needsUpdate=true;mesh.renderOrder=5;mesh.userData.vfxPlane=true;mesh.userData.effectSlug=move.slug;mesh.userData.vfxTexture=shape;mesh.material.userData.fx.flow.value=this.reducedMotion()?0:1;
  if(this.world.camera)mesh.quaternion.copy(this.world.camera.quaternion);
 }
 trail(q){if(offenseVfxDescriptor(q.move)&&!q.mesh.userData.vfxPlane)this.styleProjectile(q.mesh,q.move);this.effectContext(q.move,'trail',q.actor,q.target,()=>trailEffect(this,q));if(q.mesh.userData.vfxPlane&&this.world.camera){if(offenseVfxDescriptor(q.move)?.pattern==='waterjet')this.alignRibbon(q.mesh,q.direction);else q.mesh.quaternion.copy(this.world.camera.quaternion);q.mesh.material.userData.fx.time.value=this.game.save.playTime;}}
 impact(actor,target,move,{damage=0,effectiveness=1,critical=false,knockbackScale=1}={}){let profile=feedbackProfile(move);const authoredImpact=!!HERO_PRESENTATIONS[actor.species.id]&&(actor.species.signatureMoveId===move.id||move.feedback?.hero),hero=!!HERO_PRESENTATIONS[actor.species.id]&&actor.species.signatureMoveId===move.id;
  if(authoredImpact&&(move.engine.power??move.power)>=75)profile={...profile,tier:'signature'};const tier=IMPACT_TIERS[profile.tier]||IMPACT_TIERS.medium;
  const from=actor.model.position.clone(),at=target.model.position.clone().add(new THREE.Vector3(0,Math.max(.45,(target.model.userData.height||1)*.5),0));const dir=at.clone().sub(from);dir.y=0;dir.normalize();const visualDir=dir.lengthSq()>1e-8?dir:new THREE.Vector3(Math.sin(actor.model.rotation.y),0,Math.cos(actor.model.rotation.y)),color=TYPE_COLORS[move.type]||'#ffffff';if(damage>0)at.addScaledVector(visualDir,-actorRadius(target)*.8);
  if(damage>0){target.hit=critical?.22:.13;target.recoil=hitReaction(target,profile,dir);target.recoil.distance*=knockbackScale;target.action='recoil';target.actionTime=target.recoil.duration;target.dash=null;target.invincible=Math.max(target.invincible||0,.065);this.pause=Math.max(this.pause,tier.pause);if(profile.tier==='signature')this.slow=.14;
   const intensity=this.reducedMotion()?0:(this.game.save.settings.shake??.65);this.world.impulse=dir.clone().multiplyScalar(tier.shake*intensity);this.world.shake=tier.shake*intensity;
   if(this.game.save.settings.vibration&&globalThis.navigator?.vibrate)navigator.vibrate(Math.round(tier.pause*450));
  }
  if(move.type==='psychic'&&damage>0)target.suspension=.3;this.game.audio.combat?.('impact',move.type,profile.tier,this.pan(target));this.recordVisual('impact',move);this.effectContext(move,'impact',actor,target,()=>{if(!this.authored(move))this.element(profile,at,visualDir,color,tier);impactEffect(this,move,at,visualDir,target);});
  if(hero){this.recordVisual('signature',move);if(!this.authored(move))presentSignature(this.game,actor,target,move);else{const cue=HERO_PRESENTATIONS[actor.species.id];actor.signatureUses=(actor.signatureUses||0)+1;actor.signatureTime=.7;actor.signatureStyle=cue.style;this.game.audio.note?.(cue.pitch,.3,'triangle',.08);this.game.audio.note?.(cue.pitch*1.5,.5,'sine',.06,.08);}}
  if(profile.tier==='signature'||critical)this.game.emit('impactEmphasis',move.type,critical,profile.tier);
  this.game.emit('damage',target,damage,effectiveness,critical,profile.tier);
  this.events.push({serial:++this.serial,moveId:move.id,actorId:actor.species.id,targetId:target.species.id,type:move.type,tier:profile.tier,damage,critical,stagger:target.recoil?.duration||0,knockback:target.recoil?.distance||0,at:this.game.save.playTime});if(this.events.length>48)this.events.shift();
 }
 element(profile,at,dir,c,tier){const s=tier.scale,type=profile.element,ground=at.clone();ground.y=this.world.height(at.x,at.z)+.08;
  if(type==='electric'){this.arc(at.clone().add(new THREE.Vector3(0,2.5*s,0)),at,c,3);for(let i=0;i<3;i++)this.arc(at,at.clone().add(new THREE.Vector3(Math.cos(i*2.1)*s,.2,Math.sin(i*2.1)*s)),c,0);}
  if(['psychic','ghost','dragon','fairy'].includes(type)){for(let i=0;i<3;i++){const r=this.emit('ring',at,c,.6+i*.35,.55+i*.07,null,{grow:.7});if(r)r.rotation.set(i*.8,i*.6,0);} }
  if(['ground','rock'].includes(type)){for(let i=0;i<5;i++){const d=new THREE.Vector3(Math.sin(i*1.26),0,Math.cos(i*1.26));this.line(ground,ground.clone().addScaledVector(d,2*s),0x765344,.06,1.2);}}
  if(['normal','fighting','flying','bug','steel'].includes(type)){const side=new THREE.Vector3(dir.z,0,-dir.x),r=this.emit('ring',at,c,.35,.28,null,{grow:2.5});if(r)r.quaternion.setFromUnitVectors(new THREE.Vector3(0,0,1),dir);for(let i=0;i<(type==='bug'?3:2);i++)this.line(at.clone().addScaledVector(side,-.65+i*.35).add(new THREE.Vector3(0,.65,0)),at.clone().addScaledVector(side,.65+i*.35).add(new THREE.Vector3(0,-.35,0)),c,.045,.16+i*.06);}
  if(['fire','ice','poison','ghost'].includes(type)){const m=this.emit('mark',ground,type==='fire'?0x512b29:c,1.1*s,type==='poison'?2.5:1.5,null,{solid:true,opacity:.35});if(m)m.rotation.x=-Math.PI/2;}
  if(type==='grass'){for(let i=0;i<4;i++){const p=ground.clone().add(new THREE.Vector3(Math.sin(i*1.57),0,Math.cos(i*1.57)));this.line(p,p.clone().add(new THREE.Vector3(-Math.sin(i)*.3,1.7*s,0)),0x72b94d,.06,.7);}}
  const count=effectCount(this,tier.count);for(let i=0;i<count;i++){const angle=i/count*Math.PI*2,velocity=new THREE.Vector3(Math.cos(angle)*s,1.5+Math.random()*s,Math.sin(angle)*s).addScaledVector(dir,type==='water'?3:1);let shape='orb',scale=.075*s,options={gravity:5,spin:4};
   if(type==='ice'||type==='rock'||type==='ground'){shape='shard';scale=[.1*s,.28*s,.1*s];options.gravity=type==='ice'?3:8;}
   if(type==='grass'||type==='flying'||type==='bug'){shape='leaf';scale=.35*s;options.gravity=1;}
   if(type==='poison'||type==='ghost'){scale=.22*s;options={grow:.6,gravity:-.4};velocity.multiplyScalar(.3);}
   if(type==='water'){scale=[.055*s,.2*s,.055*s];velocity.multiplyScalar(1.5);}
   if(type==='fire'){scale=[.1*s,.24*s,.1*s];options.gravity=-.8;}
   this.emit(shape,at,i%3===0&&type==='fire'?0xffe7a2:c,scale,.35+Math.random()*.5,velocity,options);
  }
 }
 pan(actor){if(!this.game.player)return 0;const delta=actor.model.position.clone().sub(this.game.player.model.position),yaw=this.world.orbit.yaw;return clamp((delta.x*Math.cos(yaw)-delta.z*Math.sin(yaw))/18,-.8,.8);}
 update(dt){
  this.pause=Math.max(0,this.pause-dt);this.slow=Math.max(0,this.slow-dt);
  for(let i=(this.ghosts?.length||0)-1;i>=0;i--){const g=this.ghosts[i];if(g.delay>0){g.delay-=dt;continue;}g.life-=dt;g.model.visible=g.life>0;if(g.life<=0){g.model.removeFromParent();for(const material of g.materials||[g.material])material.dispose();this.ghosts.splice(i,1);}else for(const material of g.materials||[g.material]){material.opacity=g.opacity*Math.sin(Math.PI*clamp(g.life/g.max,0,1));material.alphaTest=(material.userData.cutoutThreshold||.06)*material.opacity;}}
  for(const p of this.pool){
   if(p.life<=0)continue;let step=dt;
   if(p.delay>0){p.delay-=step;p.mesh.visible=false;if(p.delay>0)continue;step=Math.max(0,-p.delay);p.delay=0;}
   p.life-=step;p.age+=step;p.mesh.visible=p.life>0;if(!p.mesh.visible)continue;
   const t=clamp(p.age/p.max,0,1),m=p.motion;
   if(m){
    const travel=m.curve==='return'?Math.sin(Math.PI*t):t;if(m.path)p.mesh.position.copy(m.from).lerp(m.to,travel);else p.mesh.position.addScaledVector(p.velocity,step);
    if(m.curve==='arc')p.mesh.position.addScaledVector(m.axis,Math.sin(t*Math.PI)*m.height);
    if(m.curve==='spiral'||m.curve==='orbit'){
     const angle=m.phase+(m.speed!==undefined?m.speed*p.age:t*Math.PI*2*m.turns)*(m.reduced?.2:1),radius=m.radius*(m.curve==='spiral'?1-t*.65:1);
     p.mesh.position.addScaledVector(m.side,Math.cos(angle)*radius).addScaledVector(m.cross,Math.sin(angle)*radius);
     if(m.curve==='spiral')p.mesh.position.addScaledVector(m.axis,Math.sin(t*Math.PI)*m.height);
    }
    p.mesh.scale.copy(m.scaleFrom).lerp(m.scaleTo,t);
    if(m.pulse&&!m.reduced){const pulse=typeof m.pulse==='number'?{amplitude:m.pulse}:m.pulse;p.mesh.scale.multiplyScalar(1+(pulse.amplitude??.12)*Math.sin(p.age*(pulse.speed??10)));}
   }else{p.mesh.position.addScaledVector(p.velocity,step);if(p.grow)p.mesh.scale.multiplyScalar(Math.max(.1,1+p.grow*step));}
   if(p.follow?.position&&p.followAt){const delta=p.follow.position.clone().sub(p.followAt);p.mesh.position.add(delta);if(m){m.from.add(delta);m.to.add(delta);}p.followAt.copy(p.follow.position);}
   p.velocity.y-=p.gravity*step;p.angle+=p.spin*step;
   if(p.beam)this.alignRibbon(p.mesh,p.beamDirection);else if(p.billboard&&this.world.camera){p.mesh.quaternion.copy(this.world.camera.quaternion);p.mesh.rotateZ(p.angle);}else p.mesh.rotation.z+=p.spin*step;
   const fade=Math.min(1,.55+p.age/p.fadeIn)*Math.min(1,p.life/Math.min(.22,p.max*.4)),envelope=m?m.opacityFrom+(m.opacityTo-m.opacityFrom)*t:1;
   p.mesh.material.opacity=p.opacity*fade*envelope;p.mesh.material.userData.fx.time.value=p.age;
  }
 }
}
