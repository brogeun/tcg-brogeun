import * as THREE from '../vendor/three.module.js';
import {createDetailBatches} from './environment-detail.mjs';

const hash=n=>{const v=Math.sin(n*127.1+19.3)*43758.5453;return v-Math.floor(v);};
const distance=(x,z,path)=>{let best=Infinity;for(let i=1;i<path.points.length;i++){const [a,b]=[path.points[i-1],path.points[i]],dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));best=Math.min(best,Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t));}return best;};
export const HIGHLANDS_OUTDOOR_MASSES=[[-40,-7,2.3,2.1,4.6],[-39,-13,2.6,2.2,5.1],[-37,-30,3.7,2.2,3.4],[-18,-30,3.5,2.5,4.1],[-7,-30,2.2,2.5,3.8]];
export const HIGHLANDS_OUTDOOR_HUT={x:-15.5,z:-9.3,width:6,depth:4.6};
function clear(c,x,z,pad=.8){
 if(c.paths.some(p=>distance(x,z,p)<p.width/2+pad))return false;
 if(c.ecologyPockets.some(p=>Math.hypot((x-p.center[0])/(p.radius[0]+pad),(z-p.center[1])/(p.radius[1]+pad))<1))return false;
 if(Math.hypot(x-c.safePoint.position.x,z-c.safePoint.position.z)<7+pad)return false;
 if(c.landmarks.some(l=>Math.hypot(x-l.position.x,z-l.position.z)<3+pad))return false;
 if(x>-19.5&&x< -11.5&&z>-12.6&&z< -6)return false;
 return !HIGHLANDS_OUTDOOR_MASSES.some(([a,b,w,d])=>Math.abs(x-a)<w+pad&&Math.abs(z-b)<d+pad);
}
export function highlandsOutdoorPlan(c){
 if(c.id!=='highlands')return [];
 const plan=[],bands=[[-39,-19,3,13,24],[-12,-29,8,4,17],[-39,7,2.6,5,8]],beds=[[-36,-12,5,10,370],[-19,-18,5,5,210],[-11,-28,7,3,180],[-36,6,4,4,160]];
 let seed=0;
 for(const [x,z,rx,rz,n]of bands)for(let i=0;i<n;i++){const a=i*2.399963,r=Math.sqrt((i+.5)/n),px=x+Math.cos(a)*rx*r,pz=z+Math.sin(a)*rz*r;if(!clear(c,px,pz,1.1))continue;plan.push({path:'quaternius/Pine_'+(i%5===0?1:2),x:px,z:pz,height:6.2+hash(++seed)*2.7,rotation:hash(seed+1)*6.28,materialVariant:'expedition-pine',collision:{radius:.34}});}
 for(const [x,z,rx,rz,n]of beds)for(let i=0;i<n;i++){const a=i*2.399963,r=Math.sqrt((i+.5)/n),px=x+Math.cos(a)*rx*r,pz=z+Math.sin(a)*rz*r;if(!clear(c,px,pz,.45))continue;plan.push({kind:'grass',x:px,z:pz,height:.28+hash(++seed)*.44,seed});}
 return plan;
}
function rockGeometry(w,d,h,seed){
 const vertices=[],colors=[],tone=new THREE.Color('#73776b'),rings=[0,.37,.73,1].map((level,j)=>Array.from({length:8},(_,i)=>{const a=i*Math.PI/4,scale=[1,.97,.87,.57][j];return [Math.cos(a)*w*scale,h*level+(j?hash(seed+i*7+j)*.28:0),Math.sin(a)*d*scale];}));
 const tri=(a,b,c,s)=>{vertices.push(...a,...b,...c);const col=tone.clone().multiplyScalar(s);for(let i=0;i<3;i++)colors.push(col.r,col.g,col.b);};
 for(let j=0;j<3;j++)for(let i=0;i<8;i++){const k=(i+1)%8,s=.82+hash(seed+i*11+j)*.3;tri(rings[j][i],rings[j+1][i],rings[j+1][k],s);tri(rings[j][i],rings[j+1][k],rings[j][k],s*.96);}
 for(let i=0;i<8;i++)tri(rings[3][i],[0,h*1.04,0],rings[3][(i+1)%8],1.05);
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.computeVertexNormals();return g;
}
export function buildHighlandsOutdoor(world,c){
 if(c.id!=='highlands')return null;
 const batch=createDetailBatches(world,{prefix:'highlands-outdoor'}),roofs=createDetailBatches(world,{prefix:'highlands-outdoor-roof'}),add=(g,col,p,r=[0,0,0],surface='rock')=>batch.add(g,col,p,r,[1,1,1],{surface}),box=(color,size,p,r,surface='wood')=>add(new THREE.BoxGeometry(...size),color,p,r,surface),obstacles=[];
 const obstacle=(id,x,z,w,d,h)=>{const y=world.height(x,z);obstacles.push({type:'obb',x,z,halfWidth:w/2,halfDepth:d/2,rotation:0,h,bottomY:y,topY:y+h,r:Math.min(w,d)/2,structureId:'highlands-outdoor-'+id});};
 HIGHLANDS_OUTDOOR_MASSES.forEach(([x,z,w,d,h],i)=>{add(rockGeometry(w,d,h,i*31),'#ffffff',[x,world.height(x,z)-.12,z]);obstacle('crag-'+i,x,z,w*1.9,d*1.9,h);});
 const hut=HIGHLANDS_OUTDOOR_HUT,{x,z,width:w,depth:d}=hut,y=world.height(x,z);
 // An open-front survey shelter sits beside the fossil country, never on it.
 box('#5e5d4e',[w,.2,d],[x,y+.10,z]);world.walkSurfaces??=[];world.walkSurfaces.push({kind:'highlands-survey-deck',x,z,rotation:0,width:w,length:d,y:y+.20,blend:.6});
 for(const [px,pz,pw,pd]of [[x,z-d/2,w,.18],[x-w/2,z,.18,d],[x+w/2,z,.18,d]]){box('#81735b',[pw,2.5,pd],[px,y+1.35,pz]);obstacle('shelter-wall',px,pz,pw,pd,2.6);}
 for(let i=0;i<19;i++)box(i%3?'#6c6854':'#77715c',[.035,2.45,.08],[x-w/2+.2+i*.31,y+1.35,z-d/2+.12]);
 for(const dx of [-w/2,w/2]){box('#554e3e',[.18,2.7,.18],[x+dx,y+1.45,z+d/2]);obstacle('shelter-post',x+dx,z+d/2,.18,.18,2.8);}
 const pitch=.4,roofLength=d/2+.42;
 for(const side of [-1,1])roofs.add(new THREE.BoxGeometry(w+.7,.15,roofLength/Math.cos(pitch)),'#4b5952',[x,y+3.05,z+side*(d/4+.14)],[side*pitch,0,0],[1,1,1],{surface:'wood'});
 roofs.add(new THREE.BoxGeometry(w+.8,.22,.2),'#464c43',[x,y+3.57,z],[0,0,0],[1,1,1],{surface:'wood'});
 box('#968264',[2.1,.17,.8],[x+1,y+.9,z-1.5]);box('#676852',[.7,.65,.6],[x+1.6,y+.45,z-1.4]);
 // Low talus fragments root the large crags without carpeting the habitats.
 for(let i=0;i<27;i++){const m=HIGHLANDS_OUTDOOR_MASSES[i%5],a=hash(i+19)*6.28,px=m[0]+Math.cos(a)*(m[2]+.3),pz=m[1]+Math.sin(a)*(m[3]+.3);if(clear(c,px,pz,.3))add(rockGeometry(.3+hash(i)*.4,.3+hash(i+1)*.3,.16+hash(i+2)*.32,i),'#a1a18a',[px,world.height(px,pz),pz]);}
 world.colliders.push(...obstacles);const meshes=batch.flush(),roofMeshes=roofs.flush();world.cutawayMeshes??=[];for(const mesh of roofMeshes)world.cutawayMeshes.push({mesh,zone:[x-w/2,z-d/2,x+w/2,z+d/2],inside:false});world.highlandsOutdoor={meshes:[...meshes,...roofMeshes],obstacles,shelter:hut};return world.highlandsOutdoor;
}


