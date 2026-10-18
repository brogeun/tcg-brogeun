import * as THREE from '../vendor/three.module.js';
import {installCanopyVisibility} from './canopy-visibility.mjs';

// The first expedition uses solid, authored silhouettes rather than leaf cards.
// Keep this plan public so navigation and visual QA can inspect the same scenery.
const TAU = Math.PI * 2;
export const VERDANT_TREE_PROP = /(?:CommonTree|TwistedTree|Pine)_/;
const hash = value => {let n = 2166136261; for (const char of String(value)) n = Math.imul(n ^ char.charCodeAt(0), 16777619); return n >>> 0;};
const randomFrom = seed => () => {seed |= 0; seed = seed + 0x6d2b79f5 | 0; let n = Math.imul(seed ^ seed >>> 15, 1 | seed); n ^= n + Math.imul(n ^ n >>> 7, 61 | n); return ((n ^ n >>> 14) >>> 0) / 4294967296;};
const segmentDistance = (x, z, a, b) => {const dx = b[0] - a[0], dz = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (z - a[1]) * dz) / Math.max(.0001, dx * dx + dz * dz))); return Math.hypot(x - a[0] - dx * t, z - a[1] - dz * t);};
const inPolygon = (x, z, polygon = []) => {let inside = false; for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {const a = polygon[i], b = polygon[j]; if ((a[1] > z) !== (b[1] > z) && x < (b[0] - a[0]) * (z - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;} return inside;};

// Camp ridge, western woodland, eastern lookout and the far treeline are
// deliberately asymmetric. All candidates are filtered against current routes.
export const VERDANT_LANDSCAPE_GROUPS = Object.freeze({
 rocks: Object.freeze([
  [-8.2, 14.1, 4.8, 4, 2.8, -.35], [-12.7, 13.4, 6.5, 4.5, 4.3, .24],
  [-17.4, 16.5, 4.4, 5.7, 3.5, -.6], [15.2, 16.9, 5, 4.1, 3.3, .35],
  [18.2, 20.9, 4.1, 3.8, 2.4, -.4], [16.6, 30.5, 4.9, 4.4, 2.1, .2],
  [-16.7, 30.4, 4.4, 4.2, 2.5, -.45], [-19.9, 25.6, 5.8, 4, 3.2, .18],
  [-11.8, 7.8, 4.4, 4.3, 3.7, -.22], [-15.8, 4.3, 5.2, 4.4, 4.5, .34],
  [-19.8, 6.4, 4.8, 4.6, 3.1, -.46], [25.8, 16, 5.8, 4.3, 3.4, .3],
  [28.8, 12.9, 3.4, 3.1, 2, -.35], [32.5, 1.8, 5.3, 5.1, 3.3, .15],
  [27.8, -7.9, 4.4, 4.6, 3.2, -.24], [11.5, -11.4, 5.6, 4.3, 4, .32],
  [10, -16.3, 4.1, 4.5, 2.8, -.35], [-4.5, -22.9, 5.5, 4, 3.8, -.3],
  [-7.1, -26.4, 3.7, 4.6, 2.5, .2], [-32.5, -29.5, 6.1, 5.7, 4.9, .12],
  [-31.8, -9.6, 3.8, 4, 2.5, -.32], [30.7, -29.2, 6.2, 4.9, 4.2, .45],
  [24.7, -34.4, 4.9, 4.2, 3.1, -.2], [6.2, -35.3, 5.1, 4.6, 3.5, .18],
  [-3.2, -38.3, 4.2, 4.8, 2.5, -.4], [-36.2, 19.5, 5.4, 4.5, 4.2, .3]
 ]),
 trees: Object.freeze([
  [-7, 16.3, 8.5, 'oak'], [-10.3, 12.6, 10, 'pine'], [-16, 13.3, 11.1, 'oak'],
  [-20.8, 17.5, 10.2, 'pine'], [-17.2, 23.8, 8.9, 'pine'], [-18.8, 29.9, 10.1, 'oak'],
  [-14.8, 34.8, 8.2, 'oak'], [14.2, 19.1, 8.8, 'oak'], [17.2, 24.5, 10.5, 'pine'],
  [18.6, 30.7, 10.4, 'oak'], [13, 35.3, 8.5, 'pine'], [15.1, 12.2, 10, 'oak'],
  [-6.9, 8.6, 8.2, 'pine'], [-17.7, 7.1, 11.6, 'pine'], [-22, 11, 10.5, 'oak'],
  [-27.5, 14, 11.5, 'oak'], [-26, 19, 8.8, 'pine'], [-30.5, 7.5, 12, 'pine'],
  [-33, 1.5, 9.6, 'oak'], [-34.5, -6, 10.5, 'pine'], [-36.3, -19, 11.8, 'oak'],
  [-26.7, -28.7, 10.7, 'pine'], [-21.3, -30.7, 9.8, 'oak'], [-10.1, -31.1, 10.8, 'pine'],
  [-3.8, -27.8, 9.5, 'oak'], [2.1, -30, 10, 'pine'], [9.8, -32, 11.8, 'oak'],
  [17.5, -33.6, 10.5, 'pine'], [28, -35.4, 12.4, 'pine'], [35.2, -29.9, 9.9, 'oak'],
  [35, -16.5, 11.5, 'pine'], [34.4, -3.5, 10.1, 'oak'], [29.7, -4.9, 8.7, 'pine'],
  [32.3, 14.8, 10, 'pine'], [28.4, 22.8, 11.4, 'oak'], [23.7, 26.4, 9.5, 'pine'],
  [10.7, -10.4, 8.4, 'pine'], [3.4, -16.9, 9.5, 'oak'], [-.8, -11.1, 8.9, 'pine'],
  [-7.2, -19.8, 10, 'oak'], [-35, 29.9, 10, 'pine'], [-28.4, 32.6, 11.5, 'oak'],
  [-32.8, 36, 9.5, 'pine'], [31, 33.8, 11.3, 'pine'], [35.8, 25, 12, 'oak']
 ])
});

export function verdantLandscapeClearance(c, item, interactions = []) {
 const {x, z, radius} = item, bounds = c.playableBounds;
 if (x - radius < bounds.min[0] + .15 || x + radius > bounds.max[0] - .15 || z - radius < bounds.min[1] + .15 || z + radius > bounds.max[1] - .15) return false;
 const b = c.baseLayout?.bounds || [-11.8, 18.8, 11.8, 33.4];
 if (x + radius > b[0] - .4 && x - radius < b[2] + .4 && z + radius > b[1] - .4 && z - radius < b[3] + .4) return false;
 if ((c.paths || []).some(path => path.points.some((p, i) => i && segmentDistance(x, z, path.points[i - 1], p) < path.width / 2 + radius + .65))) return false;
 if ((c.waterBodies || []).some(body => inPolygon(x, z, body.polygon) || body.polygon.some((p, i) => segmentDistance(x, z, p, body.polygon[(i + 1) % body.polygon.length]) < radius + 1))) return false;
 if (interactions.some(point => Math.hypot(point.x - x, point.z - z) < radius + 2.3)) return false;
 if ((c.entrances || []).some(entry => Math.hypot(entry.position.x - x, entry.position.z - z) < radius + 4)) return false;
 if ((c.specialBindings || []).some(binding => Math.hypot(binding.position[0] - x, binding.position[1] - z) < radius + 2.3)) return false;
 // Existing landmark centres and encounter pockets remain open and legible.
 if ((c.landmarks || []).some(point => Math.hypot(point.position.x - x, point.position.z - z) < radius + 3)) return false;
 if ((c.ecologyPockets || []).some(p => Math.hypot((x - p.center[0]) / p.radius[0], (z - p.center[1]) / p.radius[1]) < .6 + Math.min(.2, radius / Math.max(...p.radius)))) return false;
 return true;
}

/** Authored tree bindings are retained; only additional scenery is filtered. */
export function verdantLandscapePlan(c, interactions = []) {
 if (c?.id !== 'verdant') return [];
 const plan = [];
 for (const [index, prop] of (c.props || []).entries()) {
  if (prop.rendererKey === 'nature/log_large') {
   plan.push({id:`authored-log-${index}`,kind:'log',x:prop.x,z:prop.z,height:prop.height,length:Math.max(prop.bounds.width,prop.bounds.depth),rotation:prop.rotation||0,propIndex:index,authored:true});
   continue;
  }
  if (!VERDANT_TREE_PROP.test(prop.rendererKey)) continue;
  const old = /Twisted/.test(prop.rendererKey), pine = !old && index % 4 === 0;
  plan.push({id:`authored-tree-${index}`, kind:'tree', type:pine?'pine':'oak', x:prop.x, z:prop.z, height:prop.height, radius:prop.collision?.radius || .6, rotation:prop.rotation || 0, propIndex:index, ancient:old, authored:true});
 }
 for (const [index, point] of interactions.entries()) {
  if (point.kind === 'nest') {
   const id=`encounter-nest-${point.x.toFixed(3)}-${point.z.toFixed(3)}`;
   plan.push({id,kind:'nest',x:point.x,z:point.z,height:.52,radius:.65,rotation:hash(id)/4294967296*TAU,authored:true,encounterNest:true});
   continue;
  }
  if (point.kind !== 'tree') continue;
  // Encounter trees keep their exact interaction binding and original height.
  plan.push({id:`encounter-tree-${index}`,kind:'tree',type:'oak',x:point.x,z:point.z,height:5,radius:.29,rotation:index*2.399963,authored:true,interactive:true});
 }
 const emit = item => {if (verdantLandscapeClearance(c, item, interactions)) plan.push(item);};
 for (const [index, [x, z, width, depth, height, rotation]] of VERDANT_LANDSCAPE_GROUPS.rocks.entries()) {
  const item = {id:`ridge-rock-${index}`, kind:'rock', x, z, width, depth, height, rotation, radius:Math.max(width, depth) * .5};
  if (!verdantLandscapeClearance(c, item, interactions)) continue;
  plan.push(item);
  // Adjacent smaller boulders share the larger face, avoiding isolated pebbles.
  const random = randomFrom(hash(item.id));
  for (let i = 0; i < 2; i++) {
   const angle = rotation + i * 2.1 + .9, size = 1.15 + random() * 1.15;
   const fragment = {id:`${item.id}-foot-${i}`, kind:'rock', x:x + Math.cos(angle) * width * .46, z:z + Math.sin(angle) * depth * .46, width:size * 1.2, depth:size, height:height * (.22 + random() * .2), rotation:angle, radius:size * .6};
   emit(fragment);
  }
 }
 for (const [index, [x, z, height, type]] of VERDANT_LANDSCAPE_GROUPS.trees.entries()) emit({id:`grove-tree-${index}`, kind:'tree', type, x, z, height, radius:.48 + height * .013, rotation:hash(index) / 4294967296 * TAU});
 // A broken ground layer joins the trees and rocks into planted woodland beds.
 const anchors = plan.filter(item => !item.authored && (item.kind === 'rock' || item.kind === 'tree'));
 for (const anchor of anchors) {
  const random = randomFrom(hash(`${anchor.id}-understory`));
  for (let i = 0; i < 4; i++) {
   const angle = random() * TAU, spread = (anchor.kind === 'rock' ? anchor.radius : .7) + .6 + random() * .9;
   emit({id:`${anchor.id}-ground-${i}`, kind:i % 3 ? 'grass' : 'fern', x:anchor.x + Math.sin(angle) * spread, z:anchor.z + Math.cos(angle) * spread, height:.3 + random() * .42, radius:.36, rotation:angle});
  }
 }
 return plan;
}

const COLORS = {
 bark: ['#6a5741', '#5b4a37', '#80684b', '#524637'],
 canopy: ['#395f3e', '#426b40', '#517b43', '#31573d', '#67894b'],
 pine: ['#294b3a', '#31583e', '#3c6745', '#4b754a'],
 rock: ['#727970', '#858b7e', '#626e68', '#969b89'],
 moss: ['#5b733b', '#6d8347', '#7f8d51', '#495f38'],
 grass: ['#627b3e', '#758c4a', '#3f603b', '#8d9c59']
};

function geometryBucket() {
 const position = [], color = [];
 const triangle = (a, b, c, tint) => {for (const p of [a, b, c]) {position.push(...p);color.push(tint.r,tint.g,tint.b);}};
 const add = (geometry, matrix, tint, variation = 0) => {
  const g = geometry.index ? geometry.toNonIndexed() : geometry, a = g.attributes.position, p = new THREE.Vector3();
  for (let i = 0; i < a.count; i += 3) {
   const shade = 1 + Math.sin(i * 1.871 + tint.g * 19) * variation, t = tint.clone().multiplyScalar(shade), points = [];
   for (let j = 0; j < 3; j++) {p.fromBufferAttribute(a, i + j).applyMatrix4(matrix);points.push([p.x,p.y,p.z]);}
   triangle(...points, t);
  }
  if (g !== geometry) g.dispose();geometry.dispose();
 };
 const geometry = () => {const g = new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(position,3));g.setAttribute('color',new THREE.Float32BufferAttribute(color,3));g.computeVertexNormals();g.computeBoundingSphere();return g;};
 return {triangle, add, geometry, get count(){return position.length / 9;}};
}

const matrix = (position, scale = [1,1,1], rotation = [0,0,0]) => new THREE.Matrix4().compose(new THREE.Vector3(...position), new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)), new THREE.Vector3(...scale));
const tintAt = (palette, random) => new THREE.Color(palette[Math.floor(random() * palette.length)]);

function addWood(buckets, a, b, bottomRadius, topRadius, tint) {
 // Ends meet another branch, foliage or buried ground. Spending triangles on
 // their hidden caps made fine branchwork more costly than the entire crown.
 const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), direction = to.clone().sub(from), geometry = new THREE.CylinderGeometry(topRadius,bottomRadius,direction.length(),bottomRadius>.24?7:4,1,true);
 const transform = new THREE.Matrix4().compose(from.add(to).multiplyScalar(.5),new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),direction.normalize()),new THREE.Vector3(1,1,1));
 buckets.bark.add(geometry,transform,tint,.055);
}

function addTree(buckets, item, y, terrainHeight=()=>y) {
 const random = randomFrom(hash(item.id)), h = item.height, {x,z} = item, radius = item.ancient ? 1.22 : .28 + h * .018, bark = tintAt(COLORS.bark,random), lean = (random() - .5) * h * .085, leanZ = (random()-.5)*h*.055;
 const trunk=[[x,y-.2,z],[x+lean*.13,y+h*.25,z+leanZ*.12],[x+lean*.58,y+h*.49,z+leanZ*.55],[x+lean,y+h*.74,z+leanZ]];
 for(let i=0;i<3;i++)addWood(buckets,trunk[i],trunk[i+1],radius*(1-i*.24),radius*(.76-i*.24),bark.clone().multiplyScalar(.9+i*.065));
 // Low bent roots merge into the soil. Tall straight buttresses read as loose
 // wooden stakes, especially on the ancient tree beside the western trail.
 const rootRandom=randomFrom(hash(`${item.id}-roots`));
 for(let i=0;i<(item.ancient?7:4);i++){
  const angle=item.rotation+i*2.399963+(rootRandom()-.5)*.22,length=radius*(item.ancient?2.12:1.8)*(.85+rootRandom()*.23),bend=(rootRandom()-.5)*.36;
  const rootPoint=(t,lift)=>{const a=angle+bend*t,px=x+Math.cos(a)*length*t,pz=z+Math.sin(a)*length*t;return[px,terrainHeight(px,pz)+lift,pz];};
  const start=[x+Math.cos(angle)*radius*.2,y+radius*.62,z+Math.sin(angle)*radius*.2],points=item.ancient?[start,rootPoint(.42,radius*.17),rootPoint(.76,radius*.035),rootPoint(1,-.2)]:[start,rootPoint(.54,radius*.1),rootPoint(1,-.2)],radii=item.ancient?[.29,.19,.09,.012]:[.29,.135,.012];
  for(let part=0;part<points.length-1;part++)addWood(buckets,points[part],points[part+1],radius*radii[part],radius*radii[part+1],bark.clone().multiplyScalar(.8+part*.025));
 }
 const leafMass=(center,size,tone,turn,stretch=1)=>{
  const geometry=new THREE.SphereGeometry(1,7,4),p=geometry.attributes.position;
  for(let i=0;i<p.count;i++){
   const px=p.getX(i),py=p.getY(i),pz=p.getZ(i),angle=Math.atan2(pz,px),edge=1+Math.sin(angle*3+turn)*.13+Math.cos(angle*5-py*3+turn)*.07;
   p.setXYZ(i,px*edge,py*(1+Math.sin(angle*4+turn)*.1),pz*edge);
  }
  buckets.canopy.add(geometry,matrix(center,[size*stretch,size*(.57+random()*.15),size],[.1*Math.sin(turn),turn,.08*Math.cos(turn)]),tone,.035);
 };
 if (item.type === 'pine') {
  // Separate, drooping boughs make a broken conifer edge rather than a stack
  // of solid cones. Their narrow gaps reveal the crooked trunk and branchwork.
  const pine=tintAt(COLORS.pine,random),tiers=6;
  for(let tier=0;tier<tiers;tier++){
   const level=.38+tier*.098,reach=h*(.24-tier*.031),arms=tier===5?4:5,root=[x+lean*level,y+h*level,z+leanZ*level];
   for(let arm=0;arm<arms;arm++){
    const a=item.rotation+tier*.87+arm/arms*TAU+(random()-.5)*.28,co=Math.cos(a),si=Math.sin(a),length=reach*(.82+random()*.25),width=length*(.27+random()*.06),drop=h*(.024+random()*.02);
    const p=(along,across,lift)=>[root[0]+co*length*along-si*width*across,root[1]+lift-drop*along,root[2]+si*length*along+co*width*across];
    const start=p(.08,0,.03),mid=p(.62,0,h*.028),tip=p(1,0,-h*.006),left=p(.59,1,0),right=p(.57,-1,0),lower=p(.57,0,-h*.027);
    // The outer camp trees stand close to the standard camera arc. Keep their
    // exposed wood short and fine so a leaf cutout cannot reveal a blunt beam
    // across the foreground; the full bough silhouette still comes from leaves.
    const foregroundCamp=z>33&&z<43&&Math.abs(x)<20,woodReach=foregroundCamp?.57:.88,woodRadius=foregroundCamp?.085:.15,joint=p(woodReach*.58,0,-h*.007);
    if(foregroundCamp){addWood(buckets,root,joint,radius*woodRadius,radius*woodRadius*.48,bark.clone().multiplyScalar(.8));addWood(buckets,joint,p(woodReach,0,-h*.012),radius*woodRadius*.48,radius*.009,bark.clone().multiplyScalar(.84));}
    else addWood(buckets,root,p(woodReach,0,-h*.012),radius*woodRadius,radius*.009,bark.clone().multiplyScalar(.8));
    const tone=pine.clone().multiplyScalar(.83+tier*.045+random()*.07);
    for(const [a,b,c,t]of [[start,mid,left,1],[start,right,mid,.86],[left,mid,tip,1.07],[mid,right,tip,.95],[start,left,lower,.7],[start,lower,right,.73],[left,tip,lower,.8],[lower,tip,right,.77]])buckets.canopy.triangle(a,c,b,tone.clone().multiplyScalar(t));
    // Small forked tips break the straight triangular outline of each bough.
    for(const side of [-1,1]){
     const a=p(.39,side*.6,-.015),b=p(.76,side*1.03,-h*.012),c=p(.68,side*.36,h*.012);
     buckets.canopy.triangle(a,side>0?b:c,side>0?c:b,tone.clone().multiplyScalar(1.04));
    }
   }
  }
  leafMass([x+lean*.92,y+h*.93,z+leanZ*.92],h*.055,pine.clone().multiplyScalar(1.13),item.rotation,.83);
 } else {
  // Open, asymmetric scaffolds carry small overlapping leaf clusters. The
  // lower rim stays above the camp sightline; no broad central "lollipop" ball.
  const crown=h*(item.ancient?.29:.235),foliage=tintAt(COLORS.canopy,random),branches=item.ancient?6:4,nearCamp=z>17&&z<36&&Math.abs(x)<20,spread=nearCamp?.86:1;
  for(let branch=0;branch<branches;branch++){
   const angle=item.rotation+branch*2.399963+(random()-.5)*.3,reach=crown*(.6+random()*.21)*spread,level=.65+random()*.13,co=Math.cos(angle),si=Math.sin(angle),joint=[x+lean*.72+co*reach*.46,y+h*(level-.1),z+leanZ*.72+si*reach*.46],end=[x+lean+co*reach,y+h*level,z+leanZ+si*reach];
   addWood(buckets,trunk[2],joint,radius*.42,radius*.21,bark);addWood(buckets,joint,end,radius*.21,radius*.075,bark.clone().multiplyScalar(1.05));
   for(let cluster=0;cluster<3;cluster++){
    const fork=angle+(cluster-1)*.8,offset=crown*(cluster===1?.17:.29)*spread,cx=end[0]+Math.cos(fork)*offset,cz=end[2]+Math.sin(fork)*offset,cy=end[1]+h*(cluster===1?.065:.01+random()*.025),size=crown*(.36+random()*.09),tone=foliage.clone().multiplyScalar(.91+cluster*.052+(level-.65)*.65);
    if(cluster!==1)addWood(buckets,joint,[cx,cy-h*.025,cz],radius*.12,radius*.035,bark);
    leafMass([cx,cy,cz],size,tone,fork,1+random()*.18);
   }
  }
  for(let i=0;i<3;i++){
   const angle=item.rotation+i*TAU/3,r=crown*.28,level=.84+(i===1?.035:0);
   leafMass([x+lean+Math.cos(angle)*r,y+h*level,z+leanZ+Math.sin(angle)*r],crown*(.4+random()*.07),foliage.clone().multiplyScalar(1.1+i*.027),angle,1.06);
  }
 }
}

function addRock(buckets, item, baseY, terrainHeight) {
 const random = randomFrom(hash(item.id)), n = 9, rings = [], {x,z,width:w,depth:d,height:h,rotation:r} = item, co=Math.cos(r),si=Math.sin(r), shear=(random()-.5)*.38;
 const point = (u,y,v) => [x+u*co-v*si,baseY+y,z+u*si+v*co];
 const edges=Array.from({length:n},()=>.82+random()*.25),stone=tintAt(COLORS.rock,random);
 for(let ring=0;ring<4;ring++) {
  const row=[];for(let i=0;i<n;i++){const angle=i/n*TAU,scale=[1,.99,.86,.61][ring],u=Math.cos(angle)*w*.5*edges[i]*scale+ring*w*shear*.22,v=Math.sin(angle)*d*.5*edges[i]*scale+(ring===3?d*.08:0),y=ring===0?-.3:h*([0,.23,.58,.85][ring]+random()*(ring===3?.09:.07)),vertex=point(u,y,v);if(ring===0)vertex[1]=Math.min(baseY-.3,terrainHeight(vertex[0],vertex[2])-.22);row.push(vertex);}rings.push(row);
 }
 const mix=(a,b,t)=>a.map((v,i)=>v+(b[i]-v)*t),raised=p=>[p[0],p[1]+.018,p[2]];
 for(let ring=0;ring<3;ring++)for(let i=0;i<n;i++){
  const j=(i+1)%n,a=rings[ring][i],b=rings[ring][j],c=rings[ring+1][i],d=rings[ring+1][j],tone=stone.clone().multiplyScalar(.82+ring*.075+Math.sin(i*1.7)*.055);
  buckets.rock.triangle(a,c,b,tone);buckets.rock.triangle(b,c,d,tone.clone().multiplyScalar(.96));
  // Narrow broken strata follow the stone face; moss collects in the damp
  // bottom creases rather than painting the entire top a single green wedge.
  if(ring===1&&i%3===0){
   const t=.38+random()*.2,p=mix(a,c,t),q=mix(b,d,t+.015),p2=mix(a,c,t+.025),q2=mix(b,d,t+.04),face=point(Math.cos(i/n*TAU)*.012,0,Math.sin(i/n*TAU)*.012);
   const lift=v=>[v[0]+face[0]-x,v[1]+.006,v[2]+face[2]-z];
   buckets.rock.triangle(lift(p),lift(p2),lift(q),tone.clone().multiplyScalar(.65));buckets.rock.triangle(lift(q),lift(p2),lift(q2),tone.clone().multiplyScalar(.65));
  }
  if(ring===0&&i%2===0){const p=raised(mix(a,c,.2)),q=raised(mix(b,d,.13)),tip=raised(mix(c,d,.37));buckets.moss.triangle(p,tip,q,tintAt(COLORS.moss,random).multiplyScalar(.84));}
 }
 const top=point(w*shear*.48,h*.91,d*.04);
 for(let i=0;i<n;i++){
  const a=rings[3][i],b=rings[3][(i+1)%n];buckets.rock.triangle(a,top,b,stone.clone().multiplyScalar(1.02+random()*.09));
  if(i%3===1)continue;
  const centre=mix(top,mix(a,b,.45),.48+random()*.2),p=raised(mix(centre,a,.5+random()*.2)),q=raised(mix(centre,b,.35+random()*.25)),tip=raised(mix(centre,top,.38));
  buckets.moss.triangle(p,tip,q,tintAt(COLORS.moss,random));
  buckets.moss.triangle(raised(mix(p,centre,.32)),raised(centre),raised(mix(q,centre,.18)),tintAt(COLORS.moss,random).multiplyScalar(1.08));
 }
}

function addGroundPlant(buckets,item,y) {
 const random=randomFrom(hash(item.id)),{x,z,height:h}=item,tone=tintAt(COLORS.grass,random);
 if(item.kind==='fern'){
  for(let frond=0;frond<5;frond++){
   const angle=item.rotation+frond*2.399963,co=Math.cos(angle),si=Math.sin(angle),length=h*(.85+random()*.45),origin=[x+co*.04,y-.025,z+si*.04],point=t=>[origin[0]+co*length*t,origin[1]+length*(.72*Math.sin(t*1.7)+.05*t),origin[2]+si*length*t];
   const tip=point(1),mid=point(.55),stemWidth=.009;
   buckets.grass.triangle(origin,[mid[0]-si*stemWidth,mid[1],mid[2]+co*stemWidth],tip,tone.clone().multiplyScalar(.75));
   for(let pair=0;pair<3;pair++)for(const side of [-1,1]){
    const t=.2+pair*.23,base=point(t),end=point(t+.25),width=length*(.23-pair*.045),leaf=[base[0]+co*length*.12-si*width*side,base[1]+length*.025,base[2]+si*length*.12+co*width*side],ridge=[(base[0]+end[0]+leaf[0])/3,(base[1]+end[1]+leaf[1])/3+.018,(base[2]+end[2]+leaf[2])/3],shade=tone.clone().multiplyScalar(.86+pair*.09);
    buckets.grass.triangle(base,ridge,leaf,shade);buckets.grass.triangle(leaf,ridge,end,shade.clone().multiplyScalar(.83));
   }
  }
 }else{
  // Slender curved blades lean in different directions instead of forming a
  // repeated rigid diamond. Dry tips and low dark blades add a ground layer.
  for(let blade=0;blade<7;blade++){
   const angle=item.rotation+blade*2.399963,co=Math.cos(angle),si=Math.sin(angle),length=h*(.7+random()*.5),width=h*(.026+random()*.025),base=[x+co*.06,y-.035,z+si*.06],mid=[base[0]+co*length*.21,y+length*.58,base[2]+si*length*.21],tip=[base[0]+co*length*.64,y+length*(.7+random()*.16),base[2]+si*length*.64],left=[mid[0]-si*width,mid[1],mid[2]+co*width],right=[mid[0]+si*width,mid[1],mid[2]-co*width],shade=tone.clone().multiplyScalar(.79+blade*.044);
   buckets.grass.triangle(base,left,mid,shade);buckets.grass.triangle(base,mid,right,shade.clone().multiplyScalar(.7));buckets.grass.triangle(left,tip,mid,shade.clone().multiplyScalar(1.06));buckets.grass.triangle(mid,tip,right,shade.clone().multiplyScalar(.86));
  }
 }
}

function addNest(buckets,item,y) {
 const random=randomFrom(hash(item.id)),{x,z,height:h,rotation:r}=item;
 // The low, solid outer leaves shelter a small open ring of dry twigs.
 for(let i=0;i<3;i++){
  const a=r+i*TAU/3,size=.3+random()*.07;
  buckets.canopy.add(new THREE.IcosahedronGeometry(1,0),matrix([x+Math.cos(a)*.43,y+h*.36,z+Math.sin(a)*.43],[size*1.12,h*.49,size],[.08,a,.07]),tintAt(COLORS.canopy,random).multiplyScalar(.94),.03);
 }
 const twig=new THREE.Color('#a79873');
 for(let i=0;i<13;i++){
  const a=r+i/13*TAU,b=a+.48+random()*.28,ra=.34+random()*.07,rb=.34+random()*.09,lift=.09+(i%3)*.045;
  addWood(buckets,[x+Math.cos(a)*ra,y+lift,z+Math.sin(a)*ra],[x+Math.cos(b)*rb,y+lift+.025,z+Math.sin(b)*rb],.025+random()*.011,.02,twig.clone().multiplyScalar(.86+random()*.24));
 }
}

function buildLogInstances(world,c,logs) {
 if(!logs.length)return [];
 const body=new THREE.CylinderGeometry(.48,.5,1,11,1,true);body.rotateZ(-Math.PI/2);
 const position=body.attributes.position,colors=[],bark=new THREE.Color('#705039');
 for(let i=0;i<position.count;i++){
  const a=Math.atan2(position.getZ(i),position.getY(i)),tone=bark.clone().multiplyScalar(.86+Math.cos(a*5+.3)*.1+Math.sin(a*3)*.08+position.getX(i)*.1);colors.push(tone.r,tone.g,tone.b);
 }
 body.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));
 const ends=geometryBucket(),rings=geometryBucket();
 for(const sign of [-1,1]){
  const transform=matrix([sign*.501,0,0],[1,1,1],[0,sign*Math.PI/2,0]);
  ends.add(new THREE.CircleGeometry(.476,11),transform,new THREE.Color('#baa06e'),.045);
  for(const [inner,outer]of [[.125,.137],[.245,.257],[.357,.368]])rings.add(new THREE.RingGeometry(inner,outer,22),matrix([sign*.504,0,0],[1,1,1],[0,sign*Math.PI/2,0]),new THREE.Color('#8c704b'));
  rings.add(new THREE.CircleGeometry(.031,7),matrix([sign*.505,0,0],[1,1,1],[0,sign*Math.PI/2,0]),new THREE.Color('#8c704b'));
 }
 const geometryByLayer=[['log-bark',body],['log-ends',ends.geometry()],['log-rings',rings.geometry()]],meshes=[];
 world.placementRecords??=[];
 for(const [key,geometry]of geometryByLayer){
  const material=new THREE.MeshStandardMaterial({color:0xffffff,vertexColors:true,roughness:1,flatShading:true});
  const mesh=new THREE.InstancedMesh(geometry,material,logs.length);mesh.castShadow=key==='log-bark';mesh.receiveShadow=true;mesh.userData.verdantLandscape=true;mesh.userData.landscapeLayer=key;
  for(const [index,item]of logs.entries()){
   const p=c.props[item.propIndex],half=item.length*.5,co=Math.cos(item.rotation),si=Math.sin(item.rotation),a=world.height(item.x-co*half,item.z+si*half),b=world.height(item.x+co*half,item.z-si*half),slope=Math.atan2(b-a,item.length);
   const orientation=new THREE.Quaternion().setFromEuler(new THREE.Euler(0,item.rotation,0)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),slope));
   const y=Math.max((a+b)*.5,world.height(item.x,item.z)-.2)+item.height*.43-.06;
   const transform=new THREE.Matrix4().compose(new THREE.Vector3(item.x,y,item.z),orientation,new THREE.Vector3(item.length,item.height,item.height*.94));
   mesh.setMatrixAt(index,transform);world.placementRecords.push({mesh,index,path:'nature/log_large',p});
  }
  mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingSphere();world.owned(mesh);meshes.push(mesh);
 }
 return meshes;
}

/** Five merged scenery meshes and three shortcut-compatible log instances. */
export function buildVerdantLandscape(world, c = world.composition) {
 if (c?.id !== 'verdant') return null;
 const plan=verdantLandscapePlan(c,world.interactions||[]),buckets=Object.fromEntries(['bark','canopy','rock','moss','grass'].map(key=>[key,geometryBucket()]));
 const colliders=[];
 for(const item of plan){
  if(item.kind==='log')continue;
  const y=world.height(item.x,item.z,false);
  if(item.kind==='tree')addTree(buckets,item,y,(x,z)=>world.height(x,z,false));else if(item.kind==='rock')addRock(buckets,item,y,(x,z)=>world.height(x,z));else if(item.kind==='nest')addNest(buckets,item,y);else addGroundPlant(buckets,item,y);
  if(!['tree','rock'].includes(item.kind))continue;
  const prop=item.authored?c.props[item.propIndex]:undefined;
  if(prop&&(world.colliders||[]).some(collider=>collider.prop===prop))continue;
  const collider={x:item.x,z:item.z,r:item.radius,h:item.height,cameraRadius:item.kind==='tree'?item.radius:Math.min(item.width,item.depth)*.4,landscapeId:item.id,...(prop?{prop}:{})};
  world.colliders.push(collider);colliders.push(collider);
 }
 const meshes=[];
 for(const [key,bucket] of Object.entries(buckets)){
  if(!bucket.count)continue;
  const material=new THREE.MeshStandardMaterial({color:0xffffff,vertexColors:true,roughness:key==='rock'?.95:1,flatShading:true,side:key==='grass'?THREE.DoubleSide:THREE.FrontSide});
  if(key==='canopy')installCanopyVisibility(material,world);
  const mesh=new THREE.Mesh(bucket.geometry(),material);mesh.castShadow=key!=='grass'&&key!=='moss';mesh.receiveShadow=true;mesh.userData.verdantLandscape=true;mesh.userData.landscapeLayer=key;
  world.owned(mesh);meshes.push(mesh);
 }
 const logMeshes=buildLogInstances(world,c,plan.filter(item=>item.kind==='log'));meshes.push(...logMeshes);
 const result={plan,meshes,colliders,drawCalls:meshes.length,triangles:Object.values(buckets).reduce((sum,bucket)=>sum+bucket.count,0)+logMeshes.reduce((sum,mesh)=>sum+(mesh.geometry.index?.count||mesh.geometry.attributes.position.count)/3*mesh.count,0)};
 world.verdantLandscape=result;world.verdantLandscapeStats={drawCalls:result.drawCalls,triangles:result.triangles,trees:plan.filter(p=>p.kind==='tree').length,rocks:plan.filter(p=>p.kind==='rock').length,plants:plan.filter(p=>['grass','fern','nest'].includes(p.kind)).length,logs:plan.filter(p=>p.kind==='log').length,colliders:colliders.length};return result;
}

