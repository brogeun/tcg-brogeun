import * as THREE from '../vendor/three.module.js';

// Woodland clearings are framed from their perimeter. Encounter definitions and
// the ranger village stay authoritative; this layer only adds their surroundings.
const TAU = Math.PI * 2;
const hash = n => {const v = Math.sin(n * 127.13 + 39.7) * 43758.5453; return v - Math.floor(v);};
const distanceToSegment = (x,z,a,b) => {const dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/Math.max(.001,dx*dx+dz*dz)));return Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t);};
const inPolygon = (x,z,polygon=[]) => {let yes=false;for(let i=0,j=polygon.length-1;i<polygon.length;j=i++){const a=polygon[i],b=polygon[j];if((a[1]>z)!==(b[1]>z)&&x<(b[0]-a[0])*(z-a[1])/(b[1]-a[1])+a[0])yes=!yes;}return yes;};
const footprintDistance = (x,z,s) => Math.hypot(Math.max(0,Math.abs(x-s.x)-s.width/2),Math.max(0,Math.abs(z-s.z)-s.depth/2));

export const VERDANT_EXPEDITION_SHELTERS = Object.freeze([
 Object.freeze({id:'meadow-rain-shelter',x:2.8,z:-8.4,width:5.6,depth:4,height:2.8,roofRise:.95,kind:'rain-shelter'}),
 Object.freeze({id:'reserve-observation-hide',x:36.8,z:-11.5,width:5.5,depth:4.8,height:2.75,roofRise:1.0,kind:'observation-hide'})
]);

export function verdantExpeditionComposition(c) {
 if(c?.id!=='verdant')return c;
 // The original ornamental pool did not contain Dratini's full roam area.
 // Keep its radius and encounter method; move the centre only half a metre
 // southeast and give the animal an actual continuous pond with a soft bank.
 const pondPolygon=[[28.15,-20.05],[30.5,-19.42],[32.65,-19.44],[34.3,-20.15],[35.6,-21.4],[35.55,-24.8],[34.55,-26.75],[32.8,-27.85],[30.25,-28.1],[28.1,-27.25],[27,-25.45],[27.02,-22.1]];
 const treeMoves=new Map([[25,[37.2,-19.4]],[39,[32.5,-30.1]]]);
 return {...c,
  waterBodies:c.waterBodies.map(body=>body.id==='verdant-reserve-pond'?{...body,polygon:pondPolygon,basin:{...body.basin,shoreBlendWidth:1.45}}:body),
  ecologyPockets:c.ecologyPockets.map(p=>p.id==='verdant-reserve-pond-nest'?{...p,center:[31.3,-23.55]}:p),
  props:c.props.map((p,i)=>treeMoves.has(i)?{...p,x:treeMoves.get(i)[0],z:treeMoves.get(i)[1]}:p),
  palette:{...c.palette,ground:'#687045',path:'#9b835b',canopy:'#617448',sky:'#a2b6aa',fog:'#a5b2a0'},
  terrain:{...c.terrain,features:[...c.terrain.features,
   {center:[-39,-19],radius:[4.5,14],height:1.2,falloff:3.2},
   {center:[39,-31],radius:[5,9],height:1.4,falloff:3.4},
   {center:[6,-38],radius:[9,4],height:.8,falloff:3.5}
  ]},
  materialOverrides:{...(c.materialOverrides||{}),'verdant-expedition-pine':{canopy:'#788453',bark:'#655440',roughness:1},'verdant-expedition-understory':{color:'#a5af80',canopy:'#7b8a4d',roughness:1}},
  groundPatches:[...(c.groundPatches||[]),
   {center:[3,-7.7],radius:[5.2,4],color:'#807355',strength:.52},
   {center:[14,-4.5],radius:[9,4.4],color:'#6f7850',strength:.24},
   {center:[-29,-17],radius:[9.5,13],color:'#5f6643',strength:.34},
   {center:[35,-12.5],radius:[6.5,6],color:'#8c8059',strength:.4},
   {center:[22,-27.8],radius:[12,4.5],color:'#6b7046',strength:.28}
  ],artDirection:{...c.artDirection,expeditionRevision:'forest-clearing-20261018'}};
}

// Radius here includes body clearance, not canopy width. Soft understory never
// collides, but stays outside complete encounter ellipses to retain visibility.
function clear(c,x,z,r=.3,{solid=false,structures=true}={}) {
 const b=c.playableBounds;if(x-r<b.min[0]+.3||x+r>b.max[0]-.3||z-r<b.min[1]+.3||z+r>b.max[1]-.3)return false;
 const base=c.baseLayout?.bounds||[-11.8,18.8,11.8,33.4];
 if(x+r>base[0]-.7&&x-r<base[2]+.7&&z+r>base[1]-.7&&z-r<base[3]+.7)return false;
 if((c.paths||[]).some(p=>p.points.some((b,i)=>i&&distanceToSegment(x,z,p.points[i-1],b)<p.width/2+r+.65)))return false;
 if((c.ecologyPockets||[]).some(p=>Math.hypot((x-p.center[0])/(p.radius[0]+r+.7),(z-p.center[1])/(p.radius[1]+r+.7))<1))return false;
 const points=[c.safePoint.position,...(c.landmarks||[]).map(p=>p.interactionPosition||p.position),...(c.entrances||[]).map(p=>p.position),...(c.specialBindings||[]).map(p=>({x:p.position[0],z:p.position[1]})),...Object.values(c.services||{}).map(p=>({x:p[0],z:p[1]}))];
 if(points.some(p=>Math.hypot(x-p.x,z-p.z)<r+(solid?3:1.3)))return false;
 if((c.waterBodies||[]).some(w=>inPolygon(x,z,w.polygon)||w.polygon.some((p,i)=>distanceToSegment(x,z,p,w.polygon[(i+1)%w.polygon.length])<r+.55)))return false;
 if(structures&&VERDANT_EXPEDITION_SHELTERS.some(s=>footprintDistance(x,z,s)<r+.7))return false;
 if(solid&&(c.props||[]).some(p=>p.collision&&Math.hypot(x-p.x,z-p.z)<r+(p.collision.radius||.65)+.45))return false;
 return true;
}

export function verdantExpeditionPlan(c) {
 if(c?.id!=='verdant')return [];
 const plan=[];
 const trees=[
  [-2.3,4.7,7.2],[-4.8,6.3,8.3],[-3.5,10.1,7.6],[-5.6,13.4,8.8],
  [19.8,-7.1,7.9],[16.3,-7.8,8.4],[20.2,-11.1,8.2],
  [6.6,-18.5,8.7],[4.8,-21,7.6],[11,-27,8.9],[15.9,-29.4,8.1],[19.6,-30.9,9.1],[24,-31.7,8.2],
  [35.9,-20.8,8.9],[38.7,-23.3,8.3],[37.6,-27.6,9.3],[39.4,-31.7,8.4],
  [-35.3,-9,9.0],[-37.3,-12.8,8.4],[-35,-17.8,9.2],[-37.7,-21.7,8.6],[-34.2,-29.4,8.6],[-30.6,-30.2,7.8],[-27.6,-30,8.5],
  [-10.8,-21.5,7.6],[-10.4,-25.4,8.1],[-2.5,-22.2,8.1],[1,-20.7,7.7],
  [27,12,7.5],[32,11.8,8.6],[36.2,13.9,8.1],[29.2,17.1,8.9],
  [39,-1.2,7.6],[39.5,-18.4,7.6],[-34.9,-34.2,9.5]
 ];
 for(const [i,[x,z,height]]of trees.entries())if(clear(c,x,z,.44,{solid:true}))plan.push({id:`verdant-canopy-${i}`,path:`quaternius/Pine_${i%4===0?1:i%5===0?5:2}`,x,z,height,rotation:hash(i+19)*TAU,materialVariant:'verdant-expedition-pine',collision:{radius:.37+hash(i+9)*.07},expeditionScenery:true});
 // Unequal plant swaths tie each grove to the ground instead of outlining every
 // pocket with a repeated decorative ring.
 const beds=[[-3.6,6.8,3.2,9,125],[15,-7.3,7.4,2.2,150],[.8,-16,4.1,5.2,95],[-5,-23.7,7,3.2,100],[-34,-15.5,5,14.5,180],[22,-29.7,11,3.2,170],[37,-23.5,4.2,11.5,130],[30.5,14.4,8.8,4.2,100]];
 let seed=3000;
 for(const [cx,cz,rx,rz,count]of beds)for(let i=0;i<count*2;i++){
  const angle=i*2.3999632297,r=Math.sqrt((i+.5)/(count*2)),x=cx+Math.cos(angle)*r*rx+(hash(++seed)-.5)*.4,z=cz+Math.sin(angle)*r*rz+(hash(seed+19)-.5)*.4;
  if(!clear(c,x,z,.14))continue;
  if(i%27===0)plan.push({path:'nature/plant_bushDetailed',x,z,height:.7+hash(seed+5)*.42,rotation:angle,materialVariant:'verdant-expedition-understory',expeditionScenery:true});
  else plan.push({kind:'grass',x,z,height:.42+hash(seed+11)*.49,seed,expeditionScenery:true});
 }
 // Shaded dwellers get fern/mushroom litter outside their roaming area; open
 // meadow species keep an unbroken short-grass centre.
 for(const p of c.ecologyPockets||[])if(/shaded|rotting|root|leaf|thorn|understory|woodland/.test(p.habitatRole)){
  for(let i=0;i<7;i++){
   const a=i*2.399963+hash(++seed)*.45,x=p.center[0]+Math.cos(a)*(p.radius[0]+1.3),z=p.center[1]+Math.sin(a)*(p.radius[1]+1.3);
   if(clear(c,x,z,.12))plan.push({path:i%3?'quaternius/Fern_1':'quaternius/Mushroom_Common',x,z,height:i%3?.3+hash(seed)*.2:.19+hash(seed)*.12,rotation:a,materialVariant:'verdant-expedition-understory',expeditionScenery:true});
  }
 }
 return plan;
}

function geometryBucket(){
 const positions=[],colors=[];
 const triangle=(a,b,c,tone)=>{positions.push(...a,...b,...c);for(let i=0;i<3;i++)colors.push(tone.r,tone.g,tone.b);};
 const add=(g,color,p=[0,0,0],r=[0,0,0])=>{const flat=g.index?g.toNonIndexed():g,tint=new THREE.Color(color),q=new THREE.Quaternion().setFromEuler(new THREE.Euler(...r)),matrix=new THREE.Matrix4().compose(new THREE.Vector3(...p),q,new THREE.Vector3(1,1,1)),v=new THREE.Vector3(),points=flat.attributes.position;
  for(let i=0;i<points.count;i+=3){const vertices=[];for(let n=0;n<3;n++){v.fromBufferAttribute(points,i+n).applyMatrix4(matrix);vertices.push(v.toArray());}const a=new THREE.Vector3(...vertices[1]).sub(new THREE.Vector3(...vertices[0])),b=new THREE.Vector3(...vertices[2]).sub(new THREE.Vector3(...vertices[0])),normal=a.cross(b).normalize(),shade=.9+Math.max(-.3,normal.y)*.1;triangle(...vertices,tint.clone().multiplyScalar(shade));}
  if(flat!==g)flat.dispose();g.dispose();};
 const finish=()=>{const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));g.computeVertexNormals();g.computeBoundingBox();g.computeBoundingSphere();return g;};
 return {triangle,add,finish,get triangles(){return positions.length/9;}};
}

export function buildVerdantExpedition(world,c=world.composition){
 if(c?.id!=='verdant')return null;
 const buckets=new Map(),meshes=[],colliders=[],shelters=[],banks=[];
 const bucket=key=>{if(!buckets.has(key))buckets.set(key,geometryBucket());return buckets.get(key);};
 const box=(key,color,size,p,r=[0,0,0])=>bucket(key).add(new THREE.BoxGeometry(...size),color,p,r);
 const solid=(s,x,z,width,depth,height,bottom=0)=>{const q={type:'obb',x:s.x+x,z:s.z+z,rotation:0,halfWidth:width/2,halfDepth:depth/2,r:Math.min(width,depth)/2,h:height,bottomY:s.y+bottom,topY:s.y+bottom+height,verdantExpedition:s.id};world.colliders.push(q);colliders.push(q);return q;};
 for(const spec of VERDANT_EXPEDITION_SHELTERS){
  const s={...spec,y:world.height(spec.x,spec.z)},w=s.width,d=s.depth,h=s.height,front=s.z+d/2,roofKey=`roof-${s.id}`;
  const at=(x,y,z)=>[s.x+x,s.y+y,s.z+z];
  // Foundations are sunk into the bank. The floor is a real blended walk surface.
  for(const x of [-w/2+.22,w/2-.22])for(const z of [-d/2+.2,d/2-.2])box('stone','#797b64',[.58,.5,.58],at(x,-.07,z));
  box('wood','#4d4735',[w,.18,d],at(0,.04,0));
  for(let i=0,n=Math.ceil(w/.36);i<n;i++)box('wood',i%3?'#a48a60':'#b19a70',[w/n-.014,.065,d-.08],at(-w/2+(i+.5)*w/n,.16,0));
  world.walkSurfaces?.push({kind:'woodland-shelter-deck',x:s.x,z:s.z,rotation:0,width:w,length:d,y:s.y+.195,blend:.8});
  for(const x of [-w/2+.19,w/2-.19])for(const z of [-d/2+.16,d/2-.16]){box('wood','#695438',[.22,h,.22],at(x,h/2+.18,z));solid(s,x,z,.22,.22,h,.18);box('wood','#a18b60',[.34,.12,.34],at(x,h-.05,z));}
  for(const z of [-d/2,d/2])box('wood','#715a3c',[w+.38,.2,.22],at(0,h+.13,z));
  for(const x of [-w/2,w/2])box('wood','#5b4b34',[.2,.23,d+.3],at(x,h+.13,0));
  // Back planks are solid up to shoulder height; the observation hide remains
  // open towards the reserve instead of functioning as a new locked building.
  const backH=s.kind==='rain-shelter'?1.9:1.25;
  for(let i=0,n=Math.ceil(w/.25);i<n;i++)box('wood',i%4?'#85724e':'#746342',[w/n-.018,backH,.105],at(-w/2+(i+.5)*w/n,backH/2+.18,-d/2+.06));
  solid(s,0,-d/2+.06,w,.105,backH,.18);
  if(s.kind==='rain-shelter'){
   for(let side of [-1,1]){box('wood','#746343',[.1,.62,d*.62],at(side*(w/2-.06),.5,-d*.17));solid(s,side*(w/2-.06),-d*.17,.1,d*.62,.62,.18);}
   // A map-board wall and bench distinguish the hut from a tent or prop pad.
   box('wood','#514b36',[2.0,.9,.1],at(-.7,1.2,-d/2+.15));box('paper','#c5b992',[1.6,.6,.025],at(-.7,1.2,-d/2+.212));
   for(let i=0;i<4;i++)box('paper','#8a976a',[.17,.018,.028],at(-1.22+i*.29,1.07+i*.075,-d/2+.23),[0,0,-.35]);
   box('wood','#9b8156',[2.35,.11,.52],at(.15,.66,-d/2+.72));solid(s,.15,-d/2+.72,2.35,.52,.66,.18);
   for(const x of [-.75,.95])box('wood','#5d4d33',[.14,.5,.36],at(x,.4,-d/2+.72));
  }else{
   // West-facing slatted screen frames the pond and leaves a 2.4 m entry gap.
   const x=w/2-.06;
   for(let i=0;i<5;i++)box('wood','#8e7b50',[.09,.12,d-.1],at(x,.55+i*.21,0));solid(s,x,0,.09,d-.1,1.3,.18);
   box('wood','#9c865c',[1.7,.1,.55],at(.3,.83,-d/2+.6));solid(s,.3,-d/2+.6,1.7,.55,.83,.18);
  }
  // Two sloping metal sheets, thick dark eaves and a distinct ridge make the
  // roof readable at normal camera distance, without high contrast stripe grids.
  const half=d/2+.5,rise=s.roofRise,slant=Math.hypot(half,rise),angle=Math.atan2(rise,half);
  for(const side of [-1,1]){
   const z=side*half/2,y=h+.28+rise/2;
   box(roofKey,side<0?'#495b48':'#56694f',[w+1.05,.13,slant],at(0,y,z),[side*angle,0,0]);
   for(let i=0,n=Math.ceil((w+1.05)/.62);i<n;i++)box(roofKey,'#5b6a4e',[.035,.035,slant-.03],at(-(w+1.05)/2+(i+.5)*(w+1.05)/n,y+.09,z),[side*angle,0,0]);
   box(roofKey,'#354735',[w+1.16,.17,.13],at(0,h+.22,side*half));
  }
  box(roofKey,'#384a37',[w+1.14,.16,.25],at(0,h+.3+rise,0));
  // Timber gable braces remain beneath a cutaway roof.
  for(const x of [-w/2,w/2])for(const side of [-1,1]){
   const a=new THREE.Vector3(...at(x,h+.18,side*d/2)),b=new THREE.Vector3(...at(x,h+.2+rise,0)),dir=b.clone().sub(a),geom=new THREE.BoxGeometry(.13,dir.length(),.13);geom.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),dir.normalize()));bucket('wood').add(geom,'#69573b',a.add(b).multiplyScalar(.5).toArray());
  }
  shelters.push({...s,front,entry:s.kind==='rain-shelter'?[s.x,front+.7]:[s.x-w/2-.7,s.z],roofKey});
 }
 // A handful of broad low banks join the old root grove and reserve shoreline
 // to the peripheral slopes. Their actual footprint is kept outside habitats.
 const bankCandidates=[[-35,-10.5,3.7,2.6,1.2,.25],[-38,-26.5,4.2,3,1.15,-.3],[-29,-31.2,3.5,2.4,.85,.2],[38.8,-21.5,3.2,4.4,1.35,.2],[22.5,-33.2,5,2.5,1.1,-.2],[7,-36.2,4.8,2.9,.95,.1]];
 for(const [i,[x,z,w,d,h,r]]of bankCandidates.entries()){
  const radius=Math.max(w,d)/2;if(!clear(c,x,z,radius,{solid:true}))continue;
  const y=world.height(x,z),n=9,rings=[];
  for(let ring=0;ring<3;ring++)rings.push(Array.from({length:n},(_,j)=>{const a=j/n*TAU+r,f=.89+hash(i*73+j)*.18,scale=ring===0?1: ring===1?.95:.68,px=x+Math.cos(a)*w*.5*scale*f,pz=z+Math.sin(a)*d*.5*scale*f;return [px,ring===0?Math.min(y-.2,world.height(px,pz)-.13):y+h*(ring===1?.3:.9+hash(j+i)*.08),pz];}));
  const rock=bucket('stone');for(let ring=0;ring<2;ring++)for(let j=0;j<n;j++){const next=(j+1)%n,tone=new THREE.Color(j%3?'#737965':'#899079');rock.triangle(rings[ring][j],rings[ring+1][j],rings[ring][next],tone);rock.triangle(rings[ring][next],rings[ring+1][j],rings[ring+1][next],tone.clone().multiplyScalar(.96));}
  const top=[x,y+h*.93,z];for(let j=0;j<n;j++)rock.triangle(rings[2][j],top,rings[2][(j+1)%n],new THREE.Color(j%3?'#7e885e':'#8d9570'));
  const collider={x,z,r:radius,h,verdantExpedition:`woodland-bank-${i}`,cameraRadius:radius};world.colliders.push(collider);colliders.push(collider);banks.push({x,z,width:w,depth:d,height:h});
 }
 for(const [key,b]of buckets){
  if(!b.triangles)continue;const geometry=b.finish(),material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:1,side:THREE.DoubleSide});
  const mesh=world.owned(new THREE.Mesh(geometry,material));mesh.name=`verdant-expedition-${key}`;mesh.castShadow=key!=='paper';mesh.receiveShadow=true;mesh.userData.verdantExpedition=true;
  if(key.startsWith('roof-')){const s=shelters.find(s=>s.roofKey===key);mesh.castShadow=false;world.cutawayMeshes?.push({mesh,zone:[s.x-s.width/2,s.z-s.depth/2,s.x+s.width/2,s.z+s.depth/2]});s.roof=mesh;}
  meshes.push(mesh);
 }
 const result={meshes,colliders,shelters,banks,drawCalls:meshes.length,triangles:meshes.reduce((n,m)=>n+m.geometry.attributes.position.count/3,0)};world.verdantExpedition=result;return result;
}


