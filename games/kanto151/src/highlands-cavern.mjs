import * as THREE from '../vendor/three.module.js';
import {createDetailBatches} from './environment-detail.mjs';

const F=4.05,TAU=Math.PI*2;
const hash=n=>{const p=Math.sin(n*127.1+311.7)*43758.5453;return p-Math.floor(p);};
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
export const HIGHLANDS_CAVERN=Object.freeze({floorY:F,cutawayZone:Object.freeze([6,-20,18,2]),replacementStructures:Object.freeze(['cave-floor','cave-west-wall','cave-east-wall','cave-roof']),replacementProp:'nature/cliff_cave_rock'});
export const HIGHLANDS_CAVERN_HABITATS=Object.freeze({
 air:Object.freeze({center:Object.freeze([6,-7.2]),radius:Object.freeze([2.2,3.6])}),
 burrow:Object.freeze({center:Object.freeze([6.5,-12]),radius:Object.freeze([1.8,2])}),
 rock:Object.freeze({center:Object.freeze([18.4,-7.7]),radius:Object.freeze([2.2,3.5])}),
 nest:Object.freeze({center:Object.freeze([12.1,-16]),radius:Object.freeze([1.7,1.7])})
});
// The wall masses overlap at their feet. Their negative space makes an entrance,
// two broad damp side chambers, a pinched eastern bend, and a stone-bridge exit.
export const HIGHLANDS_CAVERN_MASSES=Object.freeze([
 ['west-mouth',4.6,0,2.1,2.1,3.5,-.06],['west-fault',.3,-3.5,2.8,2.5,4.5,-.06],
 ['west-chamber',-1,-7,3.2,2.7,5.1,.04],['west-keystone',.8,-9.7,2,2.5,5.8,-.04],
 ['west-deep',-1,-13.1,3.2,2.8,5.5,.05],['west-sediment',2.9,-16.3,2.4,1.7,4.6,-.03],
 ['west-exit',6,-17.8,2.1,1.5,5.15,.02],['west-arch-foot',7.7,-18.55,.9,.72,4.3,0],
 ['east-mouth',18.4,0,2,2.1,4.2,.04],['east-shoulder',22,-2.7,2.3,1.2,4.5,.03],['east-high',24.3,-4.5,2.8,2.6,5.5,.07],
 ['east-chamber',25,-9,2.5,3,5.75,-.04],['east-monolith',22.3,-15.2,3,2.6,6.1,.02],['east-fold',18.3,-15,1.8,2,5.8,-.04],
 ['east-exit',18.4,-17.5,2.3,1.5,5.3,-.02],['east-arch-foot',16.65,-18.5,1.05,.75,4.5,0]
].map(([id,x,z,halfWidth,halfDepth,height,rotation])=>Object.freeze({id,x,z,halfWidth,halfDepth,height,rotation})));
export const HIGHLANDS_CAVERN_FLOOR=Object.freeze([[7.8,2.3],[16.5,2.3],[20.6,-2.5],[21.7,-4],[22.1,-10.5],[16.5,-13],[16.1,-17],[15.7,-20.1],[8.4,-20.1],[7.1,-17],[5.6,-15],[2.4,-14.5],[2,-5.6],[3.8,-3.2]].map(Object.freeze));
const FLOOR_POLYGON=HIGHLANDS_CAVERN_FLOOR;
function inside(x,z,p=FLOOR_POLYGON){let yes=false;for(let i=0,j=p.length-1;i<p.length;j=i++){const a=p[i],b=p[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;}
function builder(){const positions=[],colors=[];const triangle=(a,b,c,color)=>{positions.push(...a,...b,...c);for(const v of Array.isArray(color)?color:[color,color,color]){const q=new THREE.Color(v);colors.push(q.r,q.g,q.b);}};return {triangle,quad(a,b,c,d,color){triangle(a,b,c,color);triangle(a,c,d,color);},geometry(){const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.computeVertexNormals();g.computeBoundingBox();g.computeBoundingSphere();return g;}};}
const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t);
function fracturedFace(out,a,b,c,d,color,seed,n=3){
 const point=(u,v)=>{const q=mix(mix(a,b,u),mix(d,c,u),v);if(u>0&&u<1&&v>0&&v<1){const normal=new THREE.Vector3().fromArray(b).sub(new THREE.Vector3().fromArray(a)).cross(new THREE.Vector3().fromArray(d).sub(new THREE.Vector3().fromArray(a))).normalize(),depth=(hash(seed+u*17+v*53)-.65)*.12;q[0]+=normal.x*depth;q[1]+=normal.y*depth;q[2]+=normal.z*depth;}return q;};
 for(let y=0;y<n;y++)for(let x=0;x<n;x++){const p=point(x/n,y/n),q=point((x+1)/n,y/n),r=point((x+1)/n,(y+1)/n),s=point(x/n,(y+1)/n),tone=new THREE.Color(color).multiplyScalar(.93+hash(seed+x*31+y*59)*.12);out.quad(p,q,r,s,tone);}
}
function massGeometry(item,seed=0){
 const out=builder(),ring=[[-.75,-1],[.75,-1],[1,-.72],[1,.72],[.75,1],[-.75,1],[-1,.72],[-1,-.72]],levels=[0,.3,.69,1],scale=[1,1.025,.93,.72],rings=levels.map((level,l)=>ring.map(([x,z],j)=>{
  const factor=scale[l]+(l? (hash(j*37+seed)-.5)*.08:0),y=l===0?0:level+(hash(j*31+l*11+seed)-.5)*(l===3?.2:.13);
  return [x*item.halfWidth*factor+(l?Math.sin(seed+l)*.17:0),item.height*y,z*item.halfDepth*factor+(l?Math.cos(seed+l)*.16:0)];
 }));
 for(let l=0;l<rings.length-1;l++)for(let j=0;j<8;j++){const k=(j+1)%8,tone=new THREE.Color(l===0?'#515d5b':l===2?'#76817c':'#646f70').multiplyScalar(.91+hash(seed+j*19+l*7)*.16);fracturedFace(out,rings[l][j],rings[l+1][j],rings[l+1][k],rings[l][k],tone,seed*37+j*11+l*29,3);}
 const crown=[.06,item.height*.91,-.05];for(let j=0;j<8;j++)out.triangle(rings.at(-1)[j],crown,rings.at(-1)[(j+1)%8],new THREE.Color('#79837b').multiplyScalar(.9+hash(seed+j)*.12));
 const g=out.geometry();return g;
}
function floorGeometry(){
 const out=builder(),step=.6,rows=40,cols=40,startX=0,startZ=3;
 const tone=p=>{const [x,,z]=p,trail=12+Math.sin(z*.24)*.52+Math.sin(z*.58)*.22;let edge=clamp((Math.abs(x-trail)-.75)/2.8,0,1);edge=edge*edge*(3-2*edge);const wet=(Math.exp(-((x-5.8)**2/9+(z+6.1)**2/8))+Math.exp(-((x-6)**2/8+(z+11.4)**2/5))+Math.exp(-((x-17.5)**2/5+(z+9.1)**2/13)))*.72;return new THREE.Color('#8f8572').lerp(new THREE.Color('#525d57'),edge).lerp(new THREE.Color('#354341'),clamp(wet,0,.7)).multiplyScalar(.97+Math.sin(x*.7+z*.22)*.035);};
 for(let j=0;j<rows;j++)for(let i=0;i<cols;i++){const x=startX+i*step,z=startZ-j*step;if(!inside(x+step*.5,z-step*.5))continue;const p=(px,pz)=>[px,F+.014+(Math.sin(px*.57+pz*.2)+1)*.007,pz],a=p(x,z),b=p(x+step,z),c=p(x+step,z-step),d=p(x,z-step);out.triangle(a,b,c,[tone(a),tone(b),tone(c)]);out.triangle(a,c,d,[tone(a),tone(c),tone(d)]);}
 return out.geometry();
}
function fan(x,z,rx,rz,color,y=F+.047,seed=0){const out=builder(),n=17;for(let i=0;i<n;i++){const p=j=>{const a=j/n*TAU,r=.8+hash(j%n*43+seed)*.22;return [x+Math.cos(a)*rx*r,y,z+Math.sin(a)*rz*r];};out.triangle([x,y,z],p(i+1),p(i),color);}return out.geometry();}
function crystal(){const out=builder(),n=5;for(let i=0;i<n;i++){const a=i/n*TAU,b=(i+1)/n*TAU,p=[Math.cos(a)*.5,0,Math.sin(a)*.5],q=[Math.cos(b)*.5,0,Math.sin(b)*.5],u=[p[0]*.82,.72,p[2]*.82],v=[q[0]*.82,.72,q[2]*.82];out.quad(p,u,v,q,i%2?'#9cb7bc':'#4c7495');out.triangle(u,[.07,1.08,0],v,i%2?'#c6d9d4':'#6d93b4');}return out.geometry();}
function archGeometry(){
 const out=builder(),outer=[[7.9,6.1],[8.9,9.1],[11.7,10.55],[15.25,9.65],[17.25,6.2]],inner=[[9.05,6.05],[10,7.5],[12,8.05],[14.3,7.65],[15.3,6.1]],sections=[-18.3,-19.35];
 for(let s=0;s<1;s++)for(let j=0;j<4;j++){const p=(shape,k,z)=>[shape[k][0],shape[k][1],z+Math.sin(k*1.3)*.12],a=p(outer,j,sections[0]),b=p(outer,j+1,sections[0]),c=p(outer,j+1,sections[1]),d=p(outer,j,sections[1]),i=p(inner,j,sections[0]),k=p(inner,j+1,sections[0]),m=p(inner,j+1,sections[1]),n=p(inner,j,sections[1]);fracturedFace(out,a,b,c,d,'#6d7a77',j*71,4);fracturedFace(out,i,n,m,k,'#40545a',j*13,3);fracturedFace(out,a,i,k,b,'#7a8376',j*31,3);fracturedFace(out,d,c,m,n,'#667570',j*19,3);}
 return out.geometry();
}
function centralRoofGeometry(){
 const out=builder(),sections=[-.8,-4.3,-8,-11.5,-15.8],inner=[[7.6,6.8],[9,8.2],[12.2,8.85],[15.3,8.0],[17.4,6.8]],outer=[[6.5,7.3],[8.2,9.5],[12,10.4],[16.5,9.4],[18.5,7.4]],profiles=sections.map((z,i)=>({inner:inner.map(([x,y],j)=>[x+Math.sin(i+j)*.12,y+Math.sin(i*.7+j)*.12,z+Math.sin(j*1.4+i*.3)*.2]),outer:outer.map(([x,y],j)=>[x+Math.sin(i+j*.7)*.2,y+Math.sin(i+j*.9)*.19,z+Math.sin(j*1.4+i*.3)*.2])}));
 for(let i=0;i<profiles.length-1;i++)for(let j=0;j<4;j++){const a=profiles[i],b=profiles[i+1];fracturedFace(out,a.outer[j],a.outer[j+1],b.outer[j+1],b.outer[j],'#6b7974',i*41+j,3);out.quad(a.inner[j],b.inner[j],b.inner[j+1],a.inner[j+1],'#52656a');}
 for(const index of [0,profiles.length-1])for(let j=0;j<4;j++){const p=profiles[index];if(index===0)out.quad(p.outer[j],p.inner[j],p.inner[j+1],p.outer[j+1],'#788176');else out.quad(p.outer[j],p.outer[j+1],p.inner[j+1],p.inner[j],'#6b7974');}
 return out.geometry();
}
function massColliders(item){
 const {x,z,rotation,halfWidth:w,halfDepth:d,height}=item;
 return [[w,.72*d],[.75*w,d]].map(([halfWidth,halfDepth],i)=>({type:'obb',x,z,halfWidth,halfDepth,rotation,h:height,bottomY:F-.12,topY:F+height,r:Math.min(halfWidth,halfDepth),cameraRadius:Math.min(halfWidth,halfDepth)*.7,landscapeId:`highlands-cavern-${item.id}-${i}`}));
}
export function buildHighlandsCavern(world,c=world.composition){
 if(c?.id!=='highlands')return null;
 const batches=createDetailBatches(world,{prefix:'highlands-cavern'}),add=(g,color,p=[0,0,0],r=[0,0,0],s=[1,1,1],o={})=>batches.add(g,color,p,r,s,o),colliders=[];
 world.colliders??=[];
 world.walkSurfaces??=[];world.walkSurfaces.push({kind:'cavern-floor',polygon:FLOOR_POLYGON,y:F,blend:0});
 for(const [i,mass]of HIGHLANDS_CAVERN_MASSES.entries()){add(massGeometry(mass,11+i*37),'#ffffff',[mass.x,F-.12,mass.z],[0,mass.rotation,0],[1,1,1],{surface:'rock'});colliders.push(...massColliders(mass));}
 add(floorGeometry(),'#ffffff',[0,0,0],[0,0,0],[1,1,1],{surface:'rock',shadow:false});
 // Damp sediment blends continuously into the floor's vertex colors; no
 // separate discs or bright-edged puddle patches sit above the cave earth.
 // Medium rubble is grouped at faults. It connects the monoliths to the floor
 // without filling every habitat with a repeated circle of tiny props.
 const rubble=[[6.2,-2.2,.55,.5,.7],[2.7,-4.7,.7,.62,.8],[2,-8.2,.45,.5,.9],[1.9,-10.3,.6,.55,.8],[2.1,-13.5,.55,.6,.75],[7.4,-17.4,.45,.52,.6],[17.5,-2.5,.6,.55,.8],[22.3,-6.1,.6,.58,.8],[22.5,-10.4,.6,.6,.7],[16.7,-12.3,.45,.55,.7],[16.2,-16.4,.4,.6,.7]];
 for(const [i,[x,z,w,h,d]]of rubble.entries()){const m={id:`talus-${i}`,x,z,rotation:i*.7,halfWidth:w,halfDepth:d,height:h};add(massGeometry(m,451+i*7),'#a1a394',[x,F-.1,z],[0,m.rotation,0],[1,1,1],{surface:'rock'});colliders.push(...massColliders(m));}
 for(let i=0;i<34;i++){const side=i%2?-1:1,z=-1-hash(i*47)*16.5,x=side<0?6.5+Math.sin(z*.4)*.8:17.3+Math.sin(z*.3)*.65;if(!inside(x,z))continue;const m={halfWidth:.07+hash(i*11)*.12,halfDepth:.07+hash(i*3)*.15,height:.05+hash(i*7)*.08};add(massGeometry(m,801+i),'#929784',[x,F+.005,z],[0,i*2.399963,0],[1,1,1],{surface:'rock',shadow:false});}
 // Mineral seams are deliberately small against the room-sized rock masses.
 for(const [i,[x,z,size]]of [[3.2,-8.6,.6],[21.1,-5.8,.62],[15.95,-15.4,.5]].entries())for(let j=0;j<4;j++){const angle=j*2.4+i;add(crystal(),'#ffffff',[x+Math.cos(angle)*size*.4,F+.05,z+Math.sin(angle)*size*.4],[.1*Math.cos(angle),angle,.16*Math.sin(angle)],[size*.32,size*(j===0?1.5:.8),size*.32],{surface:'plain',roughness:.45,metalness:.08,emissive:'#527da0',emissiveIntensity:.22});}
 // A high stone bridge and short side overhangs stay visible indoors. Only the
 // central foreground ceiling is a cutaway, keeping a cave silhouette in play.
 add(archGeometry(),'#ffffff',[0,0,0],[0,0,0],[1,1,1],{surface:'rock'});
 for(const [i,[x,z,w,d,h]]of [[2.3,-11.8,2.35,2.0,1.2],[24,-6.5,3.5,2.5,1.35],[21.4,-14.4,4.5,2.0,1.2]].entries())add(massGeometry({halfWidth:w,halfDepth:d,height:h},903+i*37),'#ffffff',[x,F+3.3,z],[0,.08*i,0],[1,1,1],{surface:'rock'});
 const lamps=[[3.3,5.5,-5.3],[16.15,5.55,-14.3]];
 for(const [i,[x,y,z]]of lamps.entries()){
  add(new THREE.CylinderGeometry(.12,.15,.36,7),'#e9b866',[x,y,z],[0,0,0],[1,1,1],{emissive:'#ffc16b',emissiveIntensity:1.1});
  for(const dy of [-.22,.22])add(new THREE.CylinderGeometry(.2,.2,.075,7),'#354442',[x,y+dy,z],[0,0,0],[1,1,1],{surface:'metal',metalness:.65});
  add(new THREE.CylinderGeometry(.035,.035,.6,5),'#354442',[x+(i?.25:-.25),y+.05,z],[0,0,Math.PI/2],[1,1,1],{surface:'metal',metalness:.65});
  const light=new THREE.PointLight('#ffc281',9.5,8,2);light.position.set(x,y+.02,z);light.userData.highlandsCavern=true;world.level.add(light);
 }
 const meshes=batches.flush();
 const roofMaterial=new THREE.MeshStandardMaterial({color:'#ffffff',vertexColors:true,roughness:.98,side:THREE.DoubleSide}),roof=new THREE.Mesh(centralRoofGeometry(),roofMaterial);roof.castShadow=false;roof.receiveShadow=true;roof.userData.detailLayer='central-cutaway';world.owned(roof);meshes.push(roof);
 world.cutawayMeshes??=[];world.cutawayMeshes.push({mesh:roof,zone:[...HIGHLANDS_CAVERN.cutawayZone]});
 for(const mesh of meshes)mesh.userData.highlandsCavern=true;
 world.colliders.push(...colliders);
 const result={meshes,drawCalls:meshes.length,lights:lamps.length,floorY:F,cutawayRoof:roof,colliders,masses:HIGHLANDS_CAVERN_MASSES,habitats:HIGHLANDS_CAVERN_HABITATS,permanentArch:{center:[12,-18.85],opening:[9.05,15.3],height:4}};world.highlandsCavern=result;return result;
}
