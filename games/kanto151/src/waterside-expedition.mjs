import * as THREE from '../vendor/three.module.js';
import {createDetailBatches} from './environment-detail.mjs';

// The waterline, fishing sites and species territories remain the authored map.
// Architecture occupies the dry working bank; marshes stay quiet and open.
const hash=n=>{const a=Math.sin(n*127.17+17.51)*43758.5453;return a-Math.floor(a);};
const inside=(x,z,poly)=>{let yes=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const a=poly[i],b=poly[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
const wet=(c,x,z)=>c.waterBodies.some(b=>inside(x,z,b.polygon)&&!(b.holes||[]).some(h=>inside(x,z,h.polygon||h)));
const pathDistance=(x,z,p)=>{let best=Infinity;for(let i=1;i<p.points.length;i++){const a=p.points[i-1],b=p.points[i],dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));best=Math.min(best,Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t));}return best;};
export const WATERSIDE_BUILDINGS=Object.freeze([
 Object.freeze({id:'fisher-boathouse',min:[-33.5,.5],max:[-21.5,13.5],height:6}),
 Object.freeze({id:'beach-gear-shelter',min:[28.3,31],max:[38,37],height:4.2})
]);
const buildingAt=(x,z,margin=0)=>WATERSIDE_BUILDINGS.some(b=>x>b.min[0]-margin&&x<b.max[0]+margin&&z>b.min[1]-margin&&z<b.max[1]+margin);
function clear(c,x,z,{tree=false,cover=false}={}){
 if(wet(c,x,z)||buildingAt(x,z,tree?.8:.15))return false;
 const base=c.baseLayout?.bounds,pad=tree?1.1:.35;
 if(base&&x>base[0]-pad&&x<base[2]+pad&&z>base[1]-pad&&z<base[3]+pad)return false;
 if(c.paths.some(p=>pathDistance(x,z,p)<p.width/2+(tree?1.1:cover?.3:.55)))return false;
 if(tree&&c.ecologyPockets.some(p=>Math.hypot((x-p.center[0])/(p.radius[0]+1.05),(z-p.center[1])/(p.radius[1]+1.05))<1))return false;
 const points=[c.safePoint.position,...c.entrances.map(e=>e.position),...c.landmarks.map(l=>l.interactionPosition||l.position),c.fishingPoint,...c.specialBindings.map(b=>({x:b.position[0],z:b.position[1]})),...c.digSites.map(b=>({x:b.position[0],z:b.position[1]})),{x:-18,z:16}];
 if(points.some(p=>Math.hypot(x-p.x,z-p.z)<(tree?3.2:cover?1.1:1.8)))return false;
 return true;
}

export function watersideExpeditionComposition(c){
 if(c?.id!=='waterside')return c;
 const beachStones=[[17.5,29.1],[18.2,32.7],[20.7,30],[21.8,34.7],[25.3,29.4],[26.1,32.3],[17,34.9],[19.3,35.8],[22.3,32.1],[24,35.9],[28.1,29.2],[30.2,28.8],[15.6,33.2],[18.9,30.8],[23.2,29.8],[25.2,33.6],[28,37.6],[32,38.5]];
 let stone=0;
 return {...c,
  palette:{...c.palette,ground:'#747e53',path:'#b0a078',canopy:'#667c57',sky:'#a7c4c5',fog:'#aebdad',water:'#3f7a76',accent:'#b1c8a1'},
  terrain:{...c.terrain,features:[...c.terrain.features,
   {center:[-40,6],radius:[7,20],height:2.2,falloff:3.6},
   {center:[-38,-29],radius:[7,10],height:1.2,falloff:3.4},
   {center:[39,35],radius:[8,8],height:1.1,falloff:3.8},
   {center:[40,-12],radius:[5,17],height:1.8,falloff:3.6}
  ]},
  props:c.props.map((p,i)=>{
   if(i===11)return {...p,x:-37,z:16};
   if(i===0)return {...p,materialVariant:'waterside-timber'};
   if(p.rendererKey==='quaternius/Pebble_Round_1'&&stone<beachStones.length){const [x,z]=beachStones[stone++];return {...p,x,z,rotation:hash(i)*6.28,materialVariant:'waterside-shale'};}
   return p;
  }),
  materialOverrides:{...(c.materialOverrides||{}),
   'waterside-timber':{color:'#817453',roughness:1,metalness:0},
   'waterside-willow':{canopy:'#627c51',bark:'#665b46',roughness:1},
   'waterside-understory':{color:'#a5ad79',canopy:'#718553',roughness:1},
   'waterside-shale':{color:'#6d7367',roughness:1},
   'waterside-gear':{color:'#827555',roughness:1}
  },
  groundPatches:[...(c.groundPatches||[]),
   {center:[-26,7],radius:[14,12],color:'#817351',strength:.74},
   {center:[-29,-22],radius:[13,16],color:'#4d5942',strength:.82},
   {center:[-10,-3],radius:[6,13],color:'#858260',strength:.65},
   {center:[-5,6],radius:[6,10],color:'#9f9872',strength:.60},
   {center:[23,29],radius:[16,12],color:'#c2b389',strength:.85},
   {center:[36,-7],radius:[5,22],color:'#8d9167',strength:.45}
  ]
 };
}

export function watersideExpeditionPlan(c){
 if(c?.id!=='waterside')return [];
 const plan=[];
 const asset=(path,x,z,height,seed,{tree=false,variant}={})=>{
  if(!clear(c,x,z,{tree}))return;
  plan.push({path,x,z,height,rotation:hash(seed)*Math.PI*2,materialVariant:variant||(tree?'waterside-willow':'waterside-understory'),...(tree?{collision:{radius:.38}}:{})});
 };
 const trees=[[-39,-33,8.6],[-34,-35,8],[-31,-34,6.8],[-39,-24,9.6],[-37,-17,8.7],[-37,-10,8.5],[-39,-3,9.5],[-36,-1,7.8],[-38,4,9.1],[-39,11,8.5],[-35,19,8],[-29,20,7.5],[-26,19,6.4],[-31,35,8.1],[-37,35,7.7],[-24,36,7.2],[-11,35,7.4],[-7,33,6.4],[40,12,7.8],[40,1,8.1],[41,-12,7.3],[40,-20,8.2],[38,-29,6.8],[30,38,7.4],[24,37,6.8]];
 trees.forEach(([x,z,h],i)=>asset(`quaternius/TwistedTree_${i%3===0?3:2}`,x,z,h,91+i,{tree:true}));
 // Small fishing gear belongs to the building's sheltered apron, not scattered
 // across Pokémon territory. The large shelter is built below in merged draws.
 for(const [i,[path,x,z,h]]of [
  ['nature/canoe',-27,15.5,.8],['survival/barrel',-22.3,14.6,1.2],['survival/barrel',-23.4,14.9,.92],
  ['survival/box-large',-30.8,15.3,.75],['survival/chest',-30.1,14.9,.6],
  ['nature/canoe',36.6,29.4,.6],['survival/barrel',38,29.6,1.05]
 ].entries())asset(path,x,z,h,35+i,{variant:'waterside-gear'});
 // Vegetation is authored as connected banks. Sparse short plants inside the
 // marsh leave bodies readable; tall reeds stand at the perimeter of territories.
 const beds=[
  [-34,-19,5.6,14,200],[-24,-23,4.5,11,145],[-12,-16,1.2,8,82],[-9,3,1.8,7.5,110],[-3,10,1.5,4,65],
  [-36,16,4,6,80],[-27,20,7,2.6,90],[-13,33,5.5,3,70],[18,34,5.5,2.3,70],[39,-11,2.1,18,160]
 ];
 let seed=0;
 for(const [cx,cz,rx,rz,count]of beds)for(let i=0;i<count;i++){
  const n=++seed,a=i*2.3999632297,r=Math.sqrt((i+.5)/count),x=cx+Math.cos(a)*r*rx+(hash(n*5)-.5)*.28,z=cz+Math.sin(a)*r*rz+(hash(n*11)-.5)*.28;
  if(!clear(c,x,z,{cover:true})||hash(Math.floor(x)*31+Math.floor(z)*73)<.11)continue;
  const habitat=c.ecologyPockets.find(p=>Math.hypot((x-p.center[0])/p.radius[0],(z-p.center[1])/p.radius[1])<1.12);
  // Reedy edges shelter Psyduck, Slowpoke and the marsh families without forming
  // opaque walls through their roaming area. There are no grass colliders.
  if(i%22===0&&!habitat)asset('nature/plant_bushDetailed',x,z,.65+hash(n)*.45,n);
  else plan.push({kind:'grass',x,z,height:habitat?.id.includes('marsh') ? .34+hash(n)*.25 : habitat ? .48+hash(n)*.28 : .88+hash(n)*.65,seed:n,community:'waterside-reeds'});
  if(i%37===0)asset('quaternius/Pebble_Round_1',x+.25,z+.15,.16+hash(n)*.22,n,{variant:'waterside-shale'});
 }
 // A broken gravel strand follows the dry western shoreline, not a regular row.
 for(const [i,[x,z,h]]of [[-10.8,-19,.65],[-11.4,-15,.45],[-10.8,-10,.7],[-7.8,-5,.45],[-4.5,-.5,.5],[-4.1,8.7,.55],[-4.4,13,.42],[12.8,32.7,.4],[16.7,34.6,.48],[21.6,34.5,.35],[30.5,29.5,.6]].entries())asset('nature/rock_smallA',x,z,h,i+900,{variant:'waterside-shale'});
 return plan;
}

export function watersideExpeditionObstacles(c){
 if(c?.id!=='waterside')return [];
 const box=(id,x,z,w,d,h)=>({type:'obb',structureId:id,x,z,halfWidth:w/2,halfDepth:d/2,rotation:0,h,bottomY:-.2,topY:h,r:Math.min(w,d)/2,cameraRadius:.18});
 return [
  box('boathouse-west',-33,7,.3,12,3.8),box('boathouse-north',-27.5,1,11,.3,3.8),box('boathouse-south',-27.5,13,11,.3,3.8),
  box('boathouse-east-north',-22,2.5,.3,3,3.8),box('boathouse-east-south',-22,10.5,.3,5,3.8),
  ...[[28.8,31.5],[37.5,31.5],[28.8,36.5],[37.5,36.5]].map(([x,z],i)=>box('beach-shelter-post-'+i,x,z,.24,.24,3.25))
 ];
}

export function buildWatersideExpedition(world,c){
 if(c?.id!=='waterside')return [];
 const detail=createDetailBatches(world,{prefix:'waterside-expedition'}),roof=createDetailBatches(world,{prefix:'waterside-expedition-roof'}),beachRoof=createDetailBatches(world,{prefix:'waterside-beach-roof'});
 const ground=(x,z)=>world.height(x,z);
 const spec={wood:{surface:'wood',roughness:1},dark:{surface:'wood',roughness:.98},roof:{surface:'metal',roughness:.9,metalness:.15},steel:{surface:'metal',roughness:.76,metalness:.4},stone:{surface:'rock',roughness:1},plain:{roughness:.95},glow:{emissive:'#b57b34',emissiveIntensity:.5,roughness:.8}};
 const colors={wood:'#857455',dark:'#514e3a',roof:'#596d61',steel:'#48564c',stone:'#737568',plain:'#63705c',glow:'#dab478'};
 const box=(x,y,z,w,h,d,material='wood',yaw=0,rx=0,target=detail,color)=>target.add(new THREE.BoxGeometry(w,h,d),color||colors[material],[x,y,z],[rx,yaw,0],[1,1,1],spec[material]);
 const beam=(a,b,width=.13,material='wood',target=detail,color)=>{
  const from=new THREE.Vector3(...a),to=new THREE.Vector3(...b),q=new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),to.clone().sub(from).normalize()),e=new THREE.Euler().setFromQuaternion(q);
  target.add(new THREE.BoxGeometry(width,from.distanceTo(to),width),color||colors[material],from.add(to).multiplyScalar(.5).toArray(),e.toArray().slice(0,3),[1,1,1],spec[material]);
 };
 const base=ground(-27.5,7)+.08;
 // Vertical siding varies in height and tone, reading as weathered timber from
 // the normal play camera without hundreds of individual material draws.
 const siding=(cx,cz,length,axis,open=null)=>{
  const count=Math.ceil(length/.45);
  for(let i=0;i<count;i++){
   const u=-length/2+(i+.5)*length/count;
   if(open&&u>open[0]&&u<open[1])continue;
   const h=3.7+(hash(i+cx*5+cz*7)-.5)*.13,x=cx+(axis==='x'?u:0),z=cz+(axis==='z'?u:0),t=hash(i*7+cx*3+cz*5),color=new THREE.Color('#8d8060').lerp(new THREE.Color('#635f48'),t).getHex();
   box(x,base+h/2,z,axis==='x'?length/count-.025:.22,h,axis==='z'?length/count-.025:.22,'wood',0,0,detail,color);
  }
 };
 siding(-33,7,12,'z');siding(-27.5,1,11,'x');siding(-27.5,13,11,'x');siding(-22,7,12,'z',[-3,1]);
 for(const z of[1.1,7,12.9])for(const x of[-32.9,-22.1])box(x,base+1.85,z,.26,3.9,.26,'dark');
 for(const z of[1,13])for(const y of[.3,3.5])box(-27.5,base+y,z,11.3,.16,.27,'dark');
 for(const x of[-33,-22])for(const y of[.3,3.5])box(x,base+y,7,.28,.16,12.2,'dark');
 // East doorway is a real 4m opening. Open barn doors and steel hangers frame it.
 box(-21.95,base+3.5,6, .32,.3,4.7,'dark');
 for(const [z,yaw]of[[3.8,-.6],[8.2,.65]])box(-21.28,base+1.65,z,.14,3.3,2,'wood',yaw);
 for(const z of[4,8])box(-21.76,base+3.8,z,.13,.13,.13,'steel');
 // Window is a dark inset with raised mullions, not an emissive rectangle.
 box(-27.7,base+2.2,13.16,3,1.4,.08,'plain',0,0,detail,'#293d36');
 for(const x of[-29.2,-27.7,-26.2])box(x,base+2.2,13.23,.12,1.6,.15,'dark');
 for(const y of[1.5,2.9])box(-27.7,base+y,13.23,3.2,.12,.15,'dark');
 box(-27.7,base+1.4,13.3,3.5,.18,.45,'wood');
 const eave=base+3.8,peak=base+6,half=6.1;
 for(const side of[-1,1]){
  // Metal seams and irregular darker replaced sheets carry a restrained rhythm.
  for(let z=.5;z<13.6;z+=1.3)beam([-27.5,peak+.06,z],[-27.5+side*half,eave+.06,z],.045,'steel',roof);
 }
 const roofMeshes=[];
 const face=(vertices,color,material='roof',target=roof)=>{const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.computeVertexNormals();target.add(geometry,color,[0,0,0],[0,0,0],[1,1,1],spec[material]);};
 // The pitched sheets are formed from their four corners to avoid axis ambiguity.
 for(const side of[-1,1]){
  const x=-27.5+side*half,a=[-27.5,peak,.35],b=[x,eave,.35],d=[-27.5,peak,13.65],e=[x,eave,13.65];
  const order=side<0?[...a,...b,...e,...a,...e,...d]:[...a,...e,...b,...a,...d,...e];face(order,colors.roof);
 }
 for(const z of[.98,13.02])face([-33,base+3.7,z,-22,base+3.7,z,-27.5,peak-.1,z,-33,base+3.7,z,-27.5,peak-.1,z,-22,base+3.7,z],'#6f694e','wood',detail);
 for(const z of[1.2,7,12.8]){
  beam([-33,eave-.08,z],[-27.5,peak-.15,z],.17,'dark',roof);beam([-27.5,peak-.15,z],[-22,eave-.08,z],.17,'dark',roof);
  beam([-33,eave-.08,z],[-22,eave-.08,z],.13,'dark',roof);
 }
 // Thin ground-following timber apron and a short dry bank landing. Neither
 // covers water nor becomes a new bridge bypassing the existing Surf route.
 for(let i=0;i<13;i++){
  const x=-21.75+i*.2,z=6,y=ground(x,z)+.045;
  box(x,y,z,.18,.075,5.4,'wood',0,0,detail,i%4===0?'#746a4e':'#8b7c5c');
 }
 for(let i=0;i<16;i++){
  const z=9.4+i*.21,y=ground(-6.7,z)+.035;
  box(-6.7,y,z,5.4,.06,.19,'wood',0,0,detail,i%3===0?'#726b50':'#8d8063');
 }
 for(const [x,z]of[[-9.2,9.3],[-4.2,9.3],[-9.2,12.8],[-4.2,12.8]])box(x,ground(x,z)+.38,z,.14,.76,.14,'dark');
 // Gear hangs beside the boathouse, with cargo grouped under its south eaves.
 for(const x of[-31,-29,-27,-25]){
  beam([x,base+2.6,13.4],[x,base+1.4,14.3],.055,'steel');
  box(x,base+1.4,14.3,.65,.05,.9,'dark',0,0,detail,'#6f7760');
 }
 for(let i=0;i<4;i++)box(-32+hash(i)*1.2,base+.13+i*.12,14.4+hash(i+4)*.5,3.1,.16,.24,'wood',.15+i*.04);
 box(-21.5,base+2.8,8.4,.25,.38,.25,'glow');
 // Beach net shed is open-sided. Its four narrow posts and shared long roof
 // frame the sandbar without placing a new solid wall in Seel's tidal territory.
 const bx=33.15,bz=34,bbase=ground(bx,bz),beave=bbase+3.15,bpeak=bbase+4.15;
 for(const [x,z]of[[28.8,31.5],[37.5,31.5],[28.8,36.5],[37.5,36.5]])box(x,ground(x,z)+1.6,z,.22,3.2,.22,'dark');
 for(const z of[31.5,36.5])box(bx,beave,z,9.2,.18,.18,'dark');
 for(const side of[-1,1]){
  const x=bx+side*4.8,a=[bx,bpeak,30.9],b=[x,beave,30.9],d=[bx,bpeak,37.1],e=[x,beave,37.1];
  face(side<0?[...a,...b,...e,...a,...e,...d]:[...a,...e,...b,...a,...d,...e],'#667563','roof',beachRoof);
 }
 for(let i=0;i<9;i++){
  const x=29.3+i*.95;
  beam([x,beave-.1,36.5],[x,bbase+.75,36.5],.035,'dark');
  for(let j=0;j<5;j++)beam([x,bbase+1+j*.38,36.48],[x+.95,bbase+1+j*.38,36.48],.025,'dark');
 }
 // Small irregular exposed stones terminate the woodland banks; no rings,
 // artificial puddles, neon props or repeated square ground panels are added.
 for(const [i,[x,z,s]]of [[-35.8,2.2,1.2],[-36.3,9.6,1.5],[-34.9,18,1.1],[-32.7,-9,1],[-35.6,-28,1.1],[39,17,1.3]].entries()){
  const g=new THREE.DodecahedronGeometry(s,0);detail.add(g,colors.stone,[x,ground(x,z)+s*.32,z],[hash(i)*.3,hash(i+2)*6,hash(i+4)*.2],[1,.65,.8],spec.stone);
 }
 const meshes=detail.flush();roofMeshes.push(...roof.flush());const beachMeshes=beachRoof.flush();
 world.cutawayMeshes??=[];
 for(const mesh of roofMeshes)world.cutawayMeshes.push({mesh,zone:[-33,1,-22,13]});
 for(const mesh of beachMeshes)world.cutawayMeshes.push({mesh,zone:[28.3,31,38,37]});
 const obstacles=watersideExpeditionObstacles(c);
 for(const obstacle of obstacles){const y=ground(obstacle.x,obstacle.z);world.colliders.push({...obstacle,bottomY:y-.2,topY:y+obstacle.h});}
 world.watersideExpedition={meshes:[...meshes,...roofMeshes,...beachMeshes],colliders:obstacles.length,drawCalls:meshes.length+roofMeshes.length+beachMeshes.length,buildings:WATERSIDE_BUILDINGS,triangles:[...meshes,...roofMeshes,...beachMeshes].reduce((sum,m)=>sum+m.geometry.attributes.position.count/3,0)};
 return world.watersideExpedition.meshes;
}
