import * as THREE from '../vendor/three.module.js';
import {currentLocale} from './i18n.mjs';

const services={
 heal:{paper:'#e7dfc2',ink:'#60392f',accent:'#a54f3c',face:['회복','HEAL'],ko:['회복 · 친구 교체','체력·상태 회복 / 함께할 친구 선택'],en:['Rest & switch','Recover your team / Choose a companion'],icon:'heal'},
 save:{paper:'#294d55',ink:'#fff0c9',accent:'#b5a675',face:['저장','SAVE'],ko:['복귀 기록 저장','쓰러지면 저장한 기록으로 복귀'],en:['Save return record','Return to this record after defeat'],icon:'book'},
 rations:{paper:'#594532',ink:'#fff0cf',accent:'#b6955c',face:['음식','FOOD'],ko:['음식 보충','무료 기본 식량 받기'],en:['Refill food','Collect free camp food'],icon:'food'},
 research:{paper:'#284c49',ink:'#fff0ce',accent:'#b6a273',face:['연구·저장','RESEARCH · SAVE'],ko:['연구 · 저장','도감 연구 / 복귀 기록 저장'],en:['Research & save','Pokédex research / Save return record'],icon:'book'},
 shop:{paper:'#e4d6af',ink:'#513c28',accent:'#a87b3b',face:['물품','SUPPLIES'],ko:['구매 · 음식','물품 구매 / 무료 음식 보충'],en:['Shop & food','Buy supplies / Collect free food'],icon:'crate'}
};
const UP=new THREE.Vector3(0,1,0),ATLAS=1024;
const FACE=[0,0,256,256],SECONDARY=[256,0,256,256],EMBLEM=[0,512,256,256];
const swatches=['#66513b','#ac9567','#3b4641','#e4d8b6','#9c4c39','#2d504c','#8b927d','#302e26'];

function symbol(ctx,kind,x,y,size,color,accent){
 ctx.fillStyle=color;ctx.strokeStyle=color;ctx.lineWidth=size*.055;ctx.lineJoin='round';ctx.lineCap='round';
 if(kind==='heal'){
  const arm=size*.29;ctx.fillRect(x+(size-arm)/2,y,arm,size);ctx.fillRect(x,y+(size-arm)/2,size,arm);
 }else if(kind==='book'){
  for(const side of [-1,1]){
   ctx.beginPath();ctx.moveTo(x+size*.5,y+size*.2);ctx.quadraticCurveTo(x+size*(.5+side*.18),y+size*.06,x+size*(.5+side*.43),y+size*.13);ctx.lineTo(x+size*(.5+side*.43),y+size*.82);ctx.quadraticCurveTo(x+size*(.5+side*.18),y+size*.75,x+size*.5,y+size*.89);ctx.closePath();ctx.stroke();
   for(let row=0;row<3;row++){const sy=y+size*(.35+row*.145);ctx.beginPath();ctx.moveTo(x+size*(.5+side*.12),sy+size*.015);ctx.lineTo(x+size*(.5+side*.32),sy-size*.02);ctx.stroke();}
  }
  ctx.strokeStyle=accent;ctx.beginPath();ctx.moveTo(x+size*.5,y+size*.18);ctx.lineTo(x+size*.5,y+size*.92);ctx.stroke();
 }else if(kind==='crate'){
  ctx.lineWidth=size*.065;ctx.strokeRect(x+size*.1,y+size*.23,size*.8,size*.66);
  for(const sy of [.43,.66]){ctx.beginPath();ctx.moveTo(x+size*.1,y+size*sy);ctx.lineTo(x+size*.9,y+size*sy);ctx.stroke();}
  ctx.beginPath();ctx.moveTo(x+size*.15,y+size*.85);ctx.lineTo(x+size*.85,y+size*.28);ctx.stroke();
  ctx.strokeStyle=accent;ctx.beginPath();ctx.moveTo(x+size*.29,y+size*.21);ctx.lineTo(x+size*.37,y+size*.08);ctx.lineTo(x+size*.63,y+size*.08);ctx.lineTo(x+size*.71,y+size*.21);ctx.stroke();
 }else{
  ctx.beginPath();ctx.moveTo(x+size*.08,y+size*.48);ctx.quadraticCurveTo(x+size*.15,y+size*.94,x+size*.5,y+size*.94);ctx.quadraticCurveTo(x+size*.85,y+size*.94,x+size*.92,y+size*.48);ctx.closePath();ctx.fill();
  ctx.fillStyle=accent;ctx.beginPath();ctx.ellipse(x+size*.5,y+size*.48,size*.42,size*.105,0,0,Math.PI*2);ctx.fill();
  ctx.strokeStyle=color;ctx.lineWidth=size*.075;ctx.beginPath();ctx.moveTo(x+size*.64,y+size*.47);ctx.lineTo(x+size*.82,y+size*.12);ctx.stroke();ctx.fillStyle=color;ctx.beginPath();ctx.ellipse(x+size*.85,y+size*.08,size*.072,size*.11,.4,0,Math.PI*2);ctx.fill();
  ctx.lineWidth=size*.035;for(const sx of [.3,.48]){ctx.beginPath();ctx.moveTo(x+size*sx,y+size*.32);ctx.quadraticCurveTo(x+size*(sx-.06),y+size*.22,x+size*sx,y+size*.12);ctx.stroke();}
 }
}
function stitch(ctx,x,y){ctx.strokeStyle='rgba(76,57,33,.35)';ctx.lineWidth=2;ctx.setLineDash([7,7]);ctx.strokeRect(x+10,y+10,236,236);ctx.setLineDash([]);}
function paintFace(ctx,service,secondary=false){
 const shop=service===services.shop,cloth=service===services.heal||shop;
 const x=secondary?256:0,y=0,icon=shop&&secondary?'food':service.icon;
 ctx.fillStyle=service.paper;ctx.fillRect(x,y,256,256);
 if(cloth){
  ctx.fillStyle='rgba(99,79,49,.035)';for(let row=0;row<16;row++)ctx.fillRect(x+8,y+row*16,240,1);
  ctx.fillStyle=service.accent;ctx.fillRect(x,y+248,256,8);stitch(ctx,x,y);
 }else if(service===services.rations){
  ctx.fillStyle='rgba(22,15,8,.2)';ctx.fillRect(x,y+126,256,3);ctx.fillStyle='rgba(232,211,170,.07)';for(const[sx,sy,w]of [[18,37,74],[140,65,92],[22,215,108]])ctx.fillRect(x+sx,y+sy,w,2);
 }else{
  ctx.strokeStyle=service.accent;ctx.lineWidth=3;ctx.strokeRect(x+9,y+9,238,238);ctx.fillStyle='rgba(14,31,28,.18)';ctx.fillRect(x+12,y+232,232,12);
 }
 symbol(ctx,icon,x+40,y+38,176,service===services.heal?service.accent:service.ink,service.accent);
}
// Physical service markers contain symbols only; interaction names stay localized.
function paint(ctx,service,locale){
 const english=locale==='en-US';paintFace(ctx,service);paintFace(ctx,service,true);
 ctx.fillStyle='#e7dfc2';ctx.fillRect(0,512,1024,256);ctx.strokeStyle='rgba(88,67,40,.35)';ctx.lineWidth=2;ctx.setLineDash([7,7]);ctx.strokeRect(10,522,236,236);ctx.setLineDash([]);
 symbol(ctx,service===services.shop?'food':service.icon,39,547,178,service===services.heal?service.accent:service===services.rations?'#62472a':service.paper,service.accent);
 for(let i=0;i<swatches.length;i++){ctx.fillStyle=swatches[i];ctx.fillRect(i*128,768,128,256);}
 const[title,detail]=service[english?'en':'ko'];return{serviceTitle:title,serviceDetail:detail};
}
function shape(width,height,radius){
 const x=width/2,y=height/2,r=Math.min(radius,x,y),s=new THREE.Shape();s.moveTo(-x+r,-y);s.lineTo(x-r,-y);s.quadraticCurveTo(x,-y,x,-y+r);s.lineTo(x,y-r);s.quadraticCurveTo(x,y,x-r,y);s.lineTo(-x+r,y);s.quadraticCurveTo(-x,y,-x,y-r);s.lineTo(-x,-y+r);s.quadraticCurveTo(-x,-y,-x+r,-y);return s;
}
function signGeometry(facility){
 const pieces=[];
 const add=(geometry,position,quaternion=new THREE.Quaternion(),swatch=0,rect=null)=>{
  const g=geometry.index?geometry.toNonIndexed():geometry;if(g!==geometry)geometry.dispose();if(!g.attributes.normal)g.computeVertexNormals();const uv=g.attributes.uv;
  if(rect){for(let i=0;i<uv.count;i++)uv.setXY(i,(rect[0]+uv.getX(i)*rect[2])/ATLAS,1-(rect[1]+(1-uv.getY(i))*rect[3])/ATLAS);}
  else for(let i=0;i<uv.count;i++)uv.setXY(i,(swatch*128+64)/ATLAS,.125);
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position),quaternion,new THREE.Vector3(1,1,1)));pieces.push(g);
 };
 const box=(size,p,swatch=0,q=new THREE.Quaternion())=>add(new THREE.BoxGeometry(...size),p,q,swatch);
 const beam=(from,to,width=.045,swatch=2)=>{const a=new THREE.Vector3(...from),b=new THREE.Vector3(...to),direction=b.clone().sub(a);add(new THREE.BoxGeometry(width,direction.length(),width),a.add(b).multiplyScalar(.5).toArray(),new THREE.Quaternion().setFromUnitVectors(UP,direction.normalize()),swatch);};
 const surface=(position,width,height,{rotation=0,orientation=null,style='enamel',rect=FACE}={})=>{
  const q=orientation||new THREE.Quaternion().setFromAxisAngle(UP,rotation),p=new THREE.Vector3(...position),point=(x,y,z)=>new THREE.Vector3(x,y,z).applyQuaternion(q).add(p).toArray();
  const depth=style==='enamel'?.075:style==='timber'?.11:0;
  if(style==='enamel'){const g=new THREE.ExtrudeGeometry(shape(width,height,.09),{depth,bevelEnabled:true,bevelSize:.018,bevelThickness:.012,bevelSegments:1,steps:1,curveSegments:4});g.translate(0,0,-depth/2);add(g,position,q,2);}
  else if(style==='timber')for(const side of [-1,1])box([width,height/2-.012,depth],point(0,side*height/4,0),0,q);
  const face=new THREE.ShapeGeometry(shape(width-(depth?.045:0),height-(depth?.045:0),style==='patch'?.12:.065),5),pos=face.attributes.position;face.computeBoundingBox();const bounds=face.boundingBox;
  for(let i=0;i<pos.count;i++){const x=pos.getX(i),y=pos.getY(i);face.attributes.uv.setXY(i,(x-bounds.min.x)/(bounds.max.x-bounds.min.x),(y-bounds.min.y)/(bounds.max.y-bounds.min.y));if(style==='cloth')pos.setY(i,y-.035*(.5-y/height)*(1-4*(x/width)**2));}
  add(face,point(0,0,depth/2+(style==='enamel'?.016:.006)),q,0,rect);
  if(style==='enamel'||style==='timber'||style==='decal'){
   for(const side of [-1,1]){
    if(style!=='decal')box([style==='timber'?.085:.105,height*(style==='timber'?.93:.4),.027],point(side*(width/2-.11),0,depth/2+.012),style==='timber'?2:1,q);
    for(const sy of [-1,1]){const boltQ=q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0),Math.PI/2));add(new THREE.CylinderGeometry(.022,.025,.023,8),point(side*(width/2-.11),sy*(height/2-.095),depth/2+(style==='decal'?.016:.021)),boltQ,6);}
   }
  }else for(const side of [-1,1])add(new THREE.TorusGeometry(.025,.009,4,10),point(side*(width/2-.10),height/2-.045,.012),q,1);
  return{point};
 };
 const emblem=(position,size,rotation=0)=>{const q=new THREE.Quaternion().setFromAxisAngle(UP,rotation),body=new THREE.CylinderGeometry(size/2,size/2,.045,16);body.rotateX(Math.PI/2);add(body,position,q,3);const p=new THREE.Vector3(0,0,.027).applyQuaternion(q).add(new THREE.Vector3(...position));add(new THREE.CircleGeometry(size/2-.035,24),p.toArray(),q,0,EMBLEM);};
 const village=!!facility.group.userData.villageArchitecture,kind=facility.kind,theme=facility.theme;
 if(village&&kind==='research'){
  surface([0,2.60,3.84],.84,.84);for(const x of [-.28,.28])beam([x,2.73,3.70],[x,2.73,3.80],.055);
 }else if(village&&kind==='shop'){
  // Compact sewn symbols identify the two counters without a blank text banner.
  for(const[x,rect]of [[-1.35,FACE],[1.15,SECONDARY]]){
   const patch=surface([x,2.21,2.674],.84,.84,{style:'cloth',rect});
   for(const side of [-1,1]){beam([x+side*.32,2.66,2.62],patch.point(side*.32,.375,.006),.025,3);box([.06,.10,.045],patch.point(side*.32,-.37,.008),1);}
   const hem=new THREE.CylinderGeometry(.026,.026,.90,8);hem.rotateZ(Math.PI/2);add(hem,patch.point(0,-.44,-.006),new THREE.Quaternion(),0);
  }
 }else if(village&&kind==='heal'){
  surface([-2.688,2.49,0],.90,.90,{rotation:-Math.PI/2,style:'cloth'});for(const z of [-.35,.35])beam([-2.03,2.70,z],[-2.69,2.89,z],.035,3);
  emblem([0,3.03,2.67],.78);beam([0,3.51,2.61],[0,3.39,2.65],.035,4);
 }else if(kind==='save'){
  surface([0,1.87,-.765],.95,.95,{style:'decal'});
 }else if(kind==='rations'){
  surface([0,1.52,1.075],.80,.80,{style:'timber'});box([1.02,.095,.11],[0,1.945,1.0],0);
  for(const x of [-.46,.46]){beam([x,2.02,-.7],[x,1.945,1],.065,0);beam([x,1.48,-.7],[x,1.91,1],.05,0);beam([x*.75,1.945,1],[x*.75,1.91,1.075],.035);}
  const n=new THREE.Vector3(0,1,.12).normalize(),u=new THREE.Vector3(1,0,0),v=new THREE.Vector3(0,.12,-1).normalize(),orientation=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u,v,n)),center=new THREE.Vector3(0,2.12,0).addScaledVector(n,.009);
  const patch=surface(center.toArray(),1.24,1.17,{orientation,style:'patch',rect:EMBLEM});for(const x of [-.5,.5])for(const y of [-1,1])beam(patch.point(x,y*.53,.012),patch.point(x,y*.64,-.009),.023,3);
 }else if(kind==='heal'){
  const tent=theme==='highlands'||theme==='caldera';
  if(tent){
   const slope=1.74/2.3,n=new THREE.Vector3(slope,1,0).normalize(),u=new THREE.Vector3(0,0,-1),v=new THREE.Vector3(-1,slope,0).normalize(),orientation=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u,v,n)),center=new THREE.Vector3(1.14,3.04-1.14*slope,0).addScaledVector(n,.009);
   const patch=surface(center.toArray(),.99,.99,{orientation,style:'patch'});for(const x of [-.39,.39])for(const y of [-1,1])beam(patch.point(x,y*.45,.01),patch.point(x,y*.57,-.009),.025,3);
   emblem([0,2.54,1.90],.70);beam([0,2.92,1.865],[0,2.86,1.885],.03,3);
  }else{
   const u=new THREE.Vector3(0,.14,-1).normalize(),v=new THREE.Vector3(0,1,.14).normalize(),n=new THREE.Vector3(1,0,0),orientation=new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(u,v,n)),roofY=2.64+(theme==='complex'?0:.13);
   surface([2.309,roofY-.38,0],.88,.88,{orientation,style:'cloth'});for(const z of [-.34,.34])beam([2.05,roofY-.14*z-.05,z],[2.30,roofY-.14*z-.035,z],.035,3);
   emblem([0,2.08,1.955],.70);beam([0,2.40,1.87],[0,2.39,1.94],.03,3);
  }
 }
 const geometry=new THREE.BufferGeometry();for(const[name,itemSize]of [['position',3],['normal',3],['uv',2]]){const data=new Float32Array(pieces.reduce((n,g)=>n+g.attributes[name].array.length,0));let offset=0;for(const g of pieces){data.set(g.attributes[name].array,offset);offset+=g.attributes[name].array.length;}geometry.setAttribute(name,new THREE.BufferAttribute(data,itemSize));}for(const g of pieces)g.dispose();geometry.computeBoundingSphere();return geometry;
}
/** Architectural signs share one lit mesh and never follow the camera. */
export function attachBaseWayfinding(world,base){
 if(typeof document==='undefined'||!base)return;
 for(const facility of base.facilities){
  const service=services[facility.kind];if(!service)continue;const canvas=document.createElement('canvas');canvas.width=canvas.height=ATLAS;const ctx=canvas.getContext('2d');if(!ctx)continue;
  let locale=currentLocale();const text=paint(ctx,service,locale),texture=new THREE.CanvasTexture(canvas);texture.colorSpace=THREE.SRGBColorSpace;texture.anisotropy=Math.min(8,world.renderer?.capabilities.getMaxAnisotropy?.()||1);
  const material=new THREE.MeshStandardMaterial({map:texture,roughness:.88,metalness:.04});material.addEventListener('dispose',()=>texture.dispose());const board=new THREE.Mesh(signGeometry(facility),material);board.name=`${facility.id}-mounted-service-board`;board.castShadow=board.receiveShadow=true;
  Object.assign(board.userData,{owned:true,baseFacility:facility.id},text);board.onBeforeRender=()=>{const next=currentLocale();if(next!==locale){locale=next;Object.assign(board.userData,paint(ctx,service,locale));texture.needsUpdate=true;}};facility.group.add(board);facility.serviceBoard=board;
 }
}
