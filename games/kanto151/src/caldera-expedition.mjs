import * as THREE from '../vendor/three.module.js';
import {createDetailBatches} from './environment-detail.mjs';

// The western ash apron stays habitable. The higher, broken basalt surrounds
// that apron and the lava channel rather than filling every open metre.
export const CALDERA_REPLACED_PROPS=Object.freeze([2,3,4,5,6,7,8,9,10]);
const hash=n=>{const x=Math.sin(n*127.13+31.7)*43758.5453;return x-Math.floor(x);};
const TAU=Math.PI*2;
export const CALDERA_BASALT_MASSES=Object.freeze([
 ['western-buttress',-32.1,-10,1.8,2.8,3.7,-.1],
 ['fume-buttress',-30.7,-16,1.4,3.1,4.7,-.04],
 ['western-scarp',-31,-24.7,2.6,3.7,5.4,.15],
 ['northwest-bench',-24,-29.5,4,2.8,4.8,-.12],
 ['north-ash-wall',-15.8,-27,2.6,3.7,4.2,.1],
 ['channel-west-head',-12.4,-21,1.3,3.5,3.5,-.05],
 ['channel-west-turn',-12.5,-3.7,1.5,2.5,2.8,.04],
 ['channel-west-tail',-11.4,17.6,1.3,4.2,2.7,-.04],
 ['channel-east-turn',10,-4.1,1.5,2.1,3.6,-.14],
 ['channel-east-tail',8.6,20,1.7,4.7,3.3,.06],
 ['southern-rim',11.4,29,3.7,2.9,4.8,-.12],
 ['warm-nook-rim',23.7,23.2,4.2,2.5,4.1,.17],
 ['eastern-rim',31,14.5,1.8,4.7,5.2,-.09],
 ['eastern-shoulder',31.2,1.7,1.8,3.7,5.1,.08],
 ['sanctuary-east',30.4,-11,2.1,4.1,6.2,-.08],
 ['sanctuary-crown',27.6,-28,3.8,3.4,5.8,.1],
 ['sanctuary-west',15,-28.8,3.1,2.7,4.4,-.11]
].map(([id,x,z,halfWidth,halfDepth,height,rotation])=>Object.freeze({id,x,z,halfWidth,halfDepth,height,rotation})));

const distanceToPath=(x,z,p)=>{let best=Infinity;for(let i=1;i<p.points.length;i++){const a=p.points[i-1],b=p.points[i],dx=b[0]-a[0],dz=b[1]-a[1],f=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));best=Math.min(best,Math.hypot(x-a[0]-dx*f,z-a[1]-dz*f));}return best;};
const inside=(x,z,p)=>{let yes=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const a=p[i],b=p[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
function openDressing(c,x,z,r=.25){
 if(x<c.playableBounds.min[0]+r||x>c.playableBounds.max[0]-r||z<c.playableBounds.min[1]+r||z>c.playableBounds.max[1]-r)return false;
 if(c.paths.some(p=>distanceToPath(x,z,p)<p.width/2+r+.45))return false;
 if(c.waterBodies.some(b=>inside(x,z,b.polygon)))return false;
 if(c.ecologyPockets.some(p=>Math.hypot((x-p.center[0])/(p.radius[0]+r+.65),(z-p.center[1])/(p.radius[1]+r+.65))<1))return false;
 const b=c.baseLayout?.bounds;if(b&&x>b[0]-r&&x<b[2]+r&&z>b[1]-r&&z<b[3]+r)return false;
 if(Math.hypot(x-c.safePoint.position.x,z-c.safePoint.position.z)<c.safePoint.radius+r+1)return false;
 const points=[...c.landmarks.map(l=>l.interactionPosition||l.position),...c.entrances.map(e=>e.position),...c.specialBindings.map(b=>({x:b.position[0],z:b.position[1]}))];
 if(points.some(p=>Math.hypot(x-p.x,z-p.z)<r+3))return false;
 // The survey shelter and the broad basalt outcrops own their silhouettes.
 if(x>-33&&x<-26.7&&z>-4.6&&z<5.5)return false;
 for(const m of CALDERA_BASALT_MASSES){const dx=x-m.x,dz=z-m.z,co=Math.cos(m.rotation),si=Math.sin(m.rotation);if(Math.abs(dx*co-dz*si)<m.halfWidth+r+.35&&Math.abs(dx*si+dz*co)<m.halfDepth+r+.35)return false;}
 return true;
}

export function calderaExpeditionComposition(c){
 if(c?.id!=='caldera')return c;
 return {...c,palette:{...c.palette,ground:'#686354',path:'#b5a087',canopy:'#747458',sky:'#aba99a',fog:'#ada493'},
  terrain:{...c.terrain,features:[...c.terrain.features,
   {center:[-33,-17],radius:[5,16],height:1.15,falloff:3.3},
   {center:[-22,-31],radius:[13,5.5],height:1.9,falloff:3.3},
   {center:[31,14],radius:[5.5,17],height:1.7,falloff:3.1},
   {center:[18,30],radius:[13,5],height:1.55,falloff:3.2},
   {center:[-8,31],radius:[5,4],height:.9,falloff:3.3}
  ]},materialOverrides:{...(c.materialOverrides||{}),
   'caldera-charred':{color:'#716552',bark:'#635647',roughness:1},
   'caldera-scrub':{color:'#b1a477',canopy:'#8b8a57',roughness:1},
   'caldera-cinder':{color:'#6c6354',roughness:1},
   'caldera-weathered-bridge':{color:'#706351',roughness:1,metalness:0}
  },waterBodies:c.waterBodies.map(b=>b.kind==='lava'?{...b,appearance:'basalt-flow'}:b),
  props:c.props.map((p,i)=>i===0?{...p,materialVariant:'caldera-weathered-bridge'}:i===13?{...p,x:-29.2,z:-9.5}:i===14?{...p,x:26,z:4}:p),
  groundPatches:[...(c.groundPatches||[]),
   {center:[-24,-7],radius:[10,18],color:'#aaa18b',strength:.53},
   {center:[-17,-13],radius:[5,8],color:'#8c816a',strength:.44},
   {center:[-30,-23],radius:[7,12],color:'#494c43',strength:.65},
   {center:[19,12],radius:[10,12],color:'#a08a6a',strength:.48},
   {center:[28,-18],radius:[10,14],color:'#55584d',strength:.6},
   {center:[-12,18],radius:[5,12],color:'#57584b',strength:.5},
   {center:[8,19],radius:[5,13],color:'#57584b',strength:.5}
  ]};
}

export function calderaExpeditionPlan(c){
 if(c?.id!=='caldera')return [];
 const plan=[];
 const add=(path,x,z,height,seed,r=0)=>{if(!openDressing(c,x,z,r))return;plan.push({path,x,z,height,rotation:hash(seed+2)*TAU,materialVariant:path.includes('DeadTree')?'caldera-charred':path.includes('plant')?'caldera-scrub':'caldera-cinder',...(r?{collision:{radius:r}}:{})});};
 const trees=[[-32.1,10,5.2],[-31.2,14.1,4.5],[-33,22.1,5.3],[-13.3,26.6,4.8],[-12.6,31.1,5.5],[-31.6,-7,4.1],[-30.1,-21,4.6],[-12.9,-30.7,4.3],[-20.1,-22.4,3.8],[30.4,7.5,4.5],[29.1,24.2,5.3]];
 for(const [i,[x,z,h]]of trees.entries())add(`quaternius/DeadTree_${i%5+1}`,x,z,h,i+17,.28);
 // Sparse dry scrub grows only on the cooler western apron. These are
 // walk-through plants, not a green forest pasted onto the volcanic biome.
 let seed=0;
 for(const[cx,cz,rx,rz,count]of [[-28,11,3.5,5.2,39],[-28.8,-9,3.1,8,42],[-18,-23,5.4,3,32],[-12.3,23.2,1.4,5.8,24]])for(let n=0;n<count;n++){
  const s=++seed,a=n*2.3999632297,r=Math.sqrt((n+.5)/count),x=cx+Math.cos(a)*r*rx,z=cz+Math.sin(a)*r*rz;
  add(n%7===0?'nature/plant_bushDetailed':'nature/grass_large',x,z,n%7===0?.44+hash(s)*.25:.28+hash(s)*.25,s);
 }
 // Dark cinder seams trace real ledges, with large continuous forms doing
 // the scenic work. Tiny stones remain deliberately secondary.
 for(const[cx,cz,rx,rz,count]of [[-29,-25,5,4,26],[-12.9,-16,1.2,9,22],[10.4,20.4,1.4,7,20],[29,13,2,9,20]])for(let n=0;n<count;n++){
  const s=++seed,a=n*2.3999632297,r=Math.sqrt((n+.5)/count),x=cx+Math.cos(a)*r*rx,z=cz+Math.sin(a)*r*rz;
  add('quaternius/Pebble_Square_3',x,z,.18+hash(s)*.32,s);
 }
 return plan;
}

function shapeBuilder(){const positions=[],colors=[];return {
 tri(a,b,c,color){positions.push(...a,...b,...c);for(const v of Array.isArray(color)?color:[color,color,color]){const q=new THREE.Color(v);colors.push(q.r,q.g,q.b);}},
 quad(a,b,c,d,color){this.tri(a,b,c,color);this.tri(a,c,d,color);},
 geometry(){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.computeVertexNormals();g.computeBoundingBox();g.computeBoundingSphere();return g;}
};}
function basaltGeometry(m,seed){
 const out=shapeBuilder(),w=m.halfWidth,d=m.halfDepth,h=m.height;
 // The solid foot still reaches the same four physical midfaces. Clipped
 // corners and six unequal fault levels remove the former square-tower shape.
 const foot=[[-.71,-1],[.27,-.97],[.86,-.83],[1,-.21],[.91,.57],[.51,1],[-.34,.97],[-.91,.71],[-1,.08],[-.95,-.55]],levels=[0,.17,.37,.59,.82,1],scales=[1,.99,.96,.91,.85,.66],tiltX=(hash(seed+2)-.5)*.17,tiltZ=(hash(seed+9)-.5)*.18;
 const rings=levels.map((level,l)=>foot.map(([x,z],j)=>{
  const jitter=l?(hash(seed+j*19+l*37)-.5)*.07:0,scale=scales[l]+jitter,
   xx=Math.max(-w,Math.min(w,w*(x*scale+tiltX*level))),zz=Math.max(-d,Math.min(d,d*(z*scale+tiltZ*level))),
   diagonal=(x*.065-z*.045)*h*level,
   y=l?level*h+diagonal+(hash(seed+j*17+l*11)-.5)*h*(l===5?.15:.065):-.12;
  return [xx,y,zz];
 }));
 for(let l=0;l<5;l++)for(let side=0;side<10;side++){
  const next=(side+1)%10,a=rings[l][side],b=rings[l][next],c=rings[l+1][next],d2=rings[l+1][side],
   middle=a.map((value,i)=>(value+b[i]+c[i]+d2[i])/4),normal=new THREE.Vector3(...d2).sub(new THREE.Vector3(...a)).cross(new THREE.Vector3(...b).sub(new THREE.Vector3(...a))).normalize(),
   roughness=(hash(seed+side*17+l*13)-.65)*Math.min(w,d)*.13;
  middle[0]+=normal.x*roughness;middle[1]+=normal.y*roughness;middle[2]+=normal.z*roughness;
  const tone=new THREE.Color(l===0?'#343c3d':l===4?'#666d68':l%2?'#4c5654':'#3e4849').multiplyScalar(.92+hash(seed+side*7+l*43)*.16);
  for(const[p,q,k]of [[a,d2,0],[d2,c,1],[c,b,2],[b,a,3]]){
   const fissure=m.id==='fume-buttress'&&side===3&&(l===1||l===2)&&k===1;
   out.tri(p,q,middle,fissure?'#242e2b':tone.clone().multiplyScalar(.96+hash(seed+side*37+l*11+k)*.08));
  }
 }
 // A fractured, ash-dusted crown belongs to the rock itself; no raised slabs.
 const center=[w*tiltX,h*(1.015+hash(seed+31)*.055),d*tiltZ];for(let i=0;i<10;i++)out.tri(rings[5][i],center,rings[5][(i+1)%10],new THREE.Color('#80817a').multiplyScalar(.9+hash(seed+i*11)*.15));
 return out.geometry();
}
function pitchedRoof(x,z,w,d,eave,ridge){
 const out=shapeBuilder(),p=(u,y,v)=>[x+u,y,z+v];
 for(const sign of [-1,1]){const a=p(0,ridge,-d/2),b=p(sign*w/2,eave,-d/2),c=p(sign*w/2,eave,d/2),d2=p(0,ridge,d/2);if(sign<0)out.quad(a,b,c,d2,'#605c4b');else out.quad(a,d2,c,b,'#605c4b');}
 for(const side of [-1,1]){const a=p(-w/2,eave,side*d/2),b=p(w/2,eave,side*d/2),c=p(0,ridge,side*d/2);if(side<0)out.tri(a,c,b,'#7a715c');else out.tri(a,b,c,'#7a715c');}
 return out.geometry();
}
export function calderaExpeditionObstacles(c){
 if(c?.id!=='caldera')return [];
 const obstacle=(id,x,z,w,d,h,rotation=0)=>({type:'obb',structureId:'caldera-'+id,x,z,halfWidth:w/2,halfDepth:d/2,rotation,h,bottomY:0,topY:h,r:Math.min(w,d)/2,cameraRadius:Math.min(w,d)/2,calderaExpedition:true});
 return [...CALDERA_BASALT_MASSES.map(m=>obstacle(m.id,m.x,m.z,m.halfWidth*2,m.halfDepth*2,m.height,m.rotation)),
  obstacle('survey-west',-32.3,.4,.26,7.8,2.8),obstacle('survey-north',-30.05,-3.5,4.75,.26,2.8),obstacle('survey-south',-30.05,4.3,4.75,.26,2.8),
  obstacle('survey-east-left',-27.8,-2.3,.25,2.4,2.8),obstacle('survey-east-right',-27.8,2.8,.25,3,2.8),
  obstacle('survey-crates',-31.25,2.85,1.4,1.2,.9)
 ];
}

export function buildCalderaExpedition(world,c){
 if(c?.id!=='caldera')return [];
 const batch=createDetailBatches(world,{prefix:'caldera-expedition'}),rock={surface:'rock',roughness:1},wall={surface:'concrete',roughness:.98},metal={surface:'metal',roughness:.9,metalness:.15},wood={surface:'wood',roughness:1};
 const box=(x,y,z,w,h,d,color,options=wall,yaw=0)=>batch.add(new THREE.BoxGeometry(w,h,d),color,[x,y,z],[0,yaw,0],[1,1,1],options);
 const ground=(x,z)=>world.height(x,z);
 for(const[i,m]of CALDERA_BASALT_MASSES.entries()){
  const baseY=ground(m.x,m.z)-.08,geometry=basaltGeometry(m,i*43+9),p=geometry.attributes.position,co=Math.cos(m.rotation),si=Math.sin(m.rotation);
  // Sink the entire visible foot into the actual bank, including its downhill
  // corners. A single centre-height placement can leave wide rocks floating.
  for(let v=0;v<p.count;v++)if(p.getY(v)<0){const x=p.getX(v),z=p.getZ(v);p.setY(v,ground(m.x+x*co+z*si,m.z-x*si+z*co)-baseY-.18);}
  geometry.computeVertexNormals();
  batch.add(geometry,'#ffffff',[m.x,baseY,m.z],[0,m.rotation,0],[1,1,1],rock);
 }
 const base=ground(-30.05,.4),shell=calderaExpeditionObstacles(c).filter(o=>o.structureId.includes('survey-'));
 for(const o of shell){
  const crate=o.structureId.endsWith('crates');box(o.x,base+o.h/2,o.z,o.halfWidth*2,o.h,o.halfDepth*2,crate?'#87785b':'#8d8874',crate?wood:wall);
  if(!crate){
   // Low foundation and a dark weatherboard run ground the wall in the ash.
   box(o.x,base+.2,o.z,o.halfWidth*2+.045,.4,o.halfDepth*2+.045,'#595c50',rock);
   box(o.x,base+2.25,o.z,o.halfWidth*2+.05,.11,o.halfDepth*2+.05,'#615b49',wood);
  }
 }
 // Recessed east-facing windows, shutter slats and a legible empty doorway.
 for(const z of[-2.3,2.8]){
  box(-27.65,base+1.65,z,.05,.91,1.28,'#35423c',metal);
  for(const dz of[-.67,0,.67])box(-27.58,base+1.65,z+dz,.1,1.1,.07,'#665e4c',wood);
  for(const y of[1.16,2.14])box(-27.58,base+y,z,.11,.08,1.44,'#72674f',wood);
 }
 for(const z of[-1.05,1.05])box(-27.78,base+1.35,z,.32,2.7,.16,'#685f4c',wood);
 box(-27.78,base+2.62,0,.35,.21,2.3,'#72664e',wood);
 // Low tin roof, an ash-coloured ridge and sparse raised standing seams.
 const roofBatch=createDetailBatches(world,{prefix:'caldera-survey-roof'});
 roofBatch.add(pitchedRoof(-30.05,.4,6.2,9.3,base+2.82,base+3.76),'#ffffff',[0,0,0],[0,0,0],[1,1,1],metal);
 for(let z=-4.25;z<=5.1;z+=.85)for(const sign of[-1,1]){
  const a=new THREE.Vector3(-30.05,base+3.78,z),b=new THREE.Vector3(-30.05+sign*3.13,base+2.84,z),v=b.clone().sub(a),g=new THREE.BoxGeometry(.045,.045,v.length());
  const matrix=new THREE.Matrix4().lookAt(a,b,new THREE.Vector3(0,1,0)),q=new THREE.Quaternion().setFromRotationMatrix(matrix),p=a.add(b).multiplyScalar(.5);g.applyQuaternion(q);roofBatch.add(g,'#81775f',p.toArray(),[0,0,0],[1,1,1],metal);
 }
 // An old survey mast beside the shelter; all supports stand inside its walls.
 box(-31.8,base+3.9,3.6,.12,2.2,.12,'#6b6450',metal);
 box(-31.8,base+4.7,3.6,1.65,.07,.07,'#82775a',metal);
 for(const x of[-32.5,-31.8,-31.1])box(x,base+4.7,3.6,.05,.05,.64,'#82775a',metal);
 // Fumarole fissures are dark fractured faces within the actual basalt mesh.
 const meshes=batch.flush(),roofMeshes=roofBatch.flush();
 world.cutawayMeshes??=[];for(const mesh of roofMeshes)world.cutawayMeshes.push({mesh,zone:[-32.45,-3.65,-27.65,4.45]});
 const obstacles=calderaExpeditionObstacles(c);for(const o of obstacles){const y=o.structureId.includes('survey-')?base:ground(o.x,o.z);world.colliders.push({...o,bottomY:y,topY:y+o.h});}
 for(const mesh of[...meshes,...roofMeshes])mesh.userData.calderaExpedition=true;
 world.calderaExpedition={meshes:[...meshes,...roofMeshes],roofMeshes,colliders:obstacles.length,landforms:CALDERA_BASALT_MASSES.length,drawCalls:meshes.length+roofMeshes.length,triangles:[...meshes,...roofMeshes].reduce((sum,m)=>sum+m.geometry.attributes.position.count/3,0)};
 return world.calderaExpedition.meshes;
}
