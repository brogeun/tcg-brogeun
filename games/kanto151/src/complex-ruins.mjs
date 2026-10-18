import * as THREE from '../vendor/three.module.js';
import {createDetailBatches} from './environment-detail.mjs';

// Replace visual shells, retain authored laboratory gates and interior physics.
export const COMPLEX_REPLACED_STRUCTURES = Object.freeze(['generator-housing-a', 'generator-housing-b', 'broken-conduit', 'control-strip', 'lab-west', 'lab-east', 'lab-north', 'lab-front-left', 'lab-front-right', 'lab-front-lintel', 'lab-shell-roof']);
export const COMPLEX_REPLACED_PROPS = Object.freeze([2, 3, 6, 7]);
export const COMPLEX_BUILDING_BOUNDS = Object.freeze([
 Object.freeze({id:'research-factory',min:[-8.8,-40.8],max:[20.8,-5.3],height:8}),
 Object.freeze({id:'old-power-house',min:[26.6,-13.9],max:[37.4,-4.1],height:6}),
 Object.freeze({id:'loading-canopy',min:[31.8,12.3],max:[35.8,18.6],height:3.7})
]);
export const COMPLEX_RUIN_WALLS = Object.freeze([
 Object.freeze({id:'power-house-west',x:27,z:-9,width:.5,depth:9,height:4.5}),
 Object.freeze({id:'power-house-east',x:37,z:-9,width:.5,depth:9,height:4.5}),
 Object.freeze({id:'power-house-north',x:32,z:-13.5,width:10,depth:.5,height:4.5}),
 Object.freeze({id:'power-house-front-west',x:30.2,z:-4.5,width:6.4,depth:.5,height:4.5}),
 Object.freeze({id:'power-house-front-east',x:36.5,z:-4.5,width:1,depth:.5,height:4.5}),
 Object.freeze({id:'power-yard-connecting-wall',x:19.6,z:.25,width:.5,depth:11.9,height:2.7}),
 Object.freeze({id:'power-yard-north-west',x:16.6,z:6.3,width:7.2,depth:.55,height:2.8}),
 Object.freeze({id:'power-yard-north-east',x:31.4,z:6.3,width:2.8,depth:.55,height:2.7}),
 Object.freeze({id:'power-yard-north-gate-pier',x:36.4,z:6.3,width:1.2,depth:.55,height:3.2})
]);
const obb=(id,x,z,width,depth,h)=>({type:'obb',structureId:id,x,z,halfWidth:width/2,halfDepth:depth/2,rotation:0,h,bottomY:0,topY:h,r:Math.min(width,depth)/2,cameraRadius:Math.min(width,depth)/2});
export function complexRuinsObstacles(c){
 if(c?.id!=='complex')return [];
 return [
  ...COMPLEX_RUIN_WALLS.map(w=>obb(w.id,w.x,w.z,w.width,w.depth,w.height)),
  ...[[32.15,12.6],[35.45,12.6],[32.15,18.25],[35.45,18.25]].map(([x,z],i)=>obb('loading-canopy-post-'+i,x,z,.26,.26,3.4)),
  obb('loading-cargo-stack',33.8,15.55,2.4,3.1,1.95)
 ];
}

const C={brick:'#974f3d',brickDark:'#753f33',mortar:'#494d40',plaster:'#b4a083',concrete:'#6c7163',asphalt:'#3b443f',steel:'#424f49',steelLight:'#7d8777',rust:'#8d4934',roof:'#8a3e2e',rubber:'#202b27',ceramic:'#abbba0',yellow:'#bb9b4d',glass:'#354b46',wood:'#7b6b4e',glow:'#e2ad60'};
const F={
 masonry:{surface:'concrete',roughness:.96},
 asphalt:{surface:'concrete',roughness:.99,shadow:false},
 steel:{surface:'metal',roughness:.7,metalness:.4},
 rust:{surface:'metal',roughness:.88,metalness:.15},
 rubber:{surface:'plain',roughness:.96},
 ceramic:{surface:'plain',roughness:.35,metalness:.08},
 glass:{surface:'plain',roughness:.24,metalness:.25},
 wood:{surface:'wood',roughness:.94},
 glow:{surface:'plain',roughness:.4,emissive:'#d79243',emissiveIntensity:.5}
};
const TAU=Math.PI*2;
const mixPoint=(a,b,f)=>a.map((v,i)=>v+(b[i]-v)*f);

export function complexRuinsPlan(c){
 if(c?.id!=='complex')return [];
 const plan=[];
 const add=(kind,at,size,color,material='steel',rotation=[0,0,0],extra={})=>plan.push({kind,at,size,color:C[color]||color,material,rotation,...extra});
 const box=(x,y,z,w,h,d,color='steel',material='steel',yaw=0,extra={})=>add('box',[x,y,z],[w,h,d],color,material,[0,yaw,0],extra);
 const cyl=(x,y,z,top,bottom,h,color='steel',material='steel',rotation=[0,0,0],extra={})=>add('cylinder',[x,y,z],[top,bottom,h],color,material,rotation,extra);
 const pipe=(points,r,color='rust',material='rust',extra={})=>add('pipe',[0,0,0],[r],color,material,[0,0,0],{points,...extra});
 const beam=(a,b,width=.11,depth=.11,color='steel',material='steel',extra={})=>add('beam',[0,0,0],[width,depth],color,material,[0,0,0],{a,b,...extra});
 const local=(x,z,yaw,u,y,v=0)=>[x+Math.cos(yaw)*u+Math.sin(yaw)*v,y,z-Math.sin(yaw)*u+Math.cos(yaw)*v];
 const facade=(id,x,z,w,h,yaw,windows=[],broken=false,color='brick')=>{
  add('brick-wall',[x,0,z],[w,h,.15],color,'masonry',[0,yaw,0],{id,windows,broken});
  const backing=local(x,z,yaw,0,h/2,-.08);add('box',backing,[w,h,.18],'mortar','masonry',[0,yaw,0]);
  for(const window of windows){
   const {x:u,y,w:ww,h:hh}=window;
   add('box',local(x,z,yaw,u,y,.015),[ww,hh,.06],'rubber','rubber',[0,yaw,0]);
   add('box',local(x,z,yaw,u,y,.055),[ww-.2,hh-.2,.035],'glass','glass',[0,yaw,0]);
   for(const du of [-ww/2,0,ww/2])add('box',local(x,z,yaw,u+du,y,.17),[.1,hh+.18,.16],du?'steel':'rust',du?'steel':'rust',[0,yaw,0]);
   for(const dy of [-hh/2,0,hh/2])add('box',local(x,z,yaw,u,y+dy,.17),[ww+.14,.085,.16],'steel','steel',[0,yaw,0]);
   add('box',local(x,z,yaw,u,y-hh/2-.12,.19),[ww+.32,.18,.38],'concrete','masonry',[0,yaw,0]);
   if(Math.round(u*3)%2===0){
    add('box',local(x,z,yaw,u+.2,y-.15,.22),[ww*.9,.16,.12],'wood','wood',[0,yaw,.13]);
    add('box',local(x,z,yaw,u-.3,y+.26,.22),[ww*.77,.13,.1],'wood','wood',[0,yaw,-.16]);
   }
  }
  for(let i=0;i<Math.floor(w/4.5)+1;i++){
   const u=-w/2+.15+i*w/Math.max(1,Math.floor(w/4.5));
   add('box',local(x,z,yaw,u,h/2,.16),[.17,h,.22],'plaster','masonry',[0,yaw,0]);
  }
 };
 const roof=(id,xa,xb,z0,z1,ridgeX,eave,peak,halfSpan,extra={})=>add('roof-panel',[0,0,0],[xa,xb,z0,z1,ridgeX,eave,peak,halfSpan],'roof','rust',[0,0,0],{id,roof:id.startsWith('research-'),cover:id.startsWith('power-roof')?'power':id==='loading-roof'?'loading':null,...extra});

 // One irregular asphalt service court replaces both isolated checker pads.
 // The builder samples the live walk height so existing .1m generator footing
 // and the rest of the flat yard retain their authored movement.
 add('asphalt',[0,0,0],[],'asphalt','asphalt',[0,0,0],{polygon:[[6,11],[12,9.5],[22,9.7],[26,10.8],[31.5,9.2],[33,12],[32.6,20.7],[30.7,25],[25.7,27.8],[18.5,28.5],[12,27.6],[6.8,25.1],[5.5,19.4]]});
 for(const [x,z,w,d,yaw]of [[12.2,19.7,4.2,1.1,.1],[25.2,13.7,3.5,1.4,-.2],[20.7,25.6,3.2,.8,.08]]){
  add('ground-patch',[x,0,z],[w,d],'#333e38','asphalt',[0,yaw,0]);
 }
 for(const z of [10.45,14.6])for(let i=0;i<4;i++)add('ground-line',[9+i*3.1,0,z],[1.7,.10],'yellow','asphalt');
 // A broad, flush former drain relates the whole court to the powerhouse.
 add('ground-line',[23.5,0,9.45],[17.7,.4],'rubber','asphalt');
 for(let i=0;i<35;i++)add('ground-line',[15.1+i*.5,0,9.45],[.09,.38],'steelLight','steel');
 for(const [x,z]of [[11,22],[27,24.7],[30.8,17]])add('ground-patch',[x,0,z],[1.4,1.1],'#505448','asphalt');

 // The main laboratory becomes a substantial red-brick factory shell rather
 // than a flat teal box. All doorway and interior collision stays authored.
 facade('research-front-left',-3.1,-5.6,9.8,5,0,[{x:-2,y:3.35,w:3.15,h:1.8},{x:2.15,y:3.35,w:2.9,h:1.8}]);
 facade('research-front-right',13,-5.6,14,5,0,[-4.55,0,4.55].map(x=>({x,y:3.35,w:3.2,h:1.8})));
 facade('research-west',-8.58,-23,34,5,-Math.PI/2,[-12,-5,2,9].map(x=>({x,y:3.3,w:4.5,h:1.75})));
 facade('research-east',20.58,-23,34,5,Math.PI/2,[-11,-3.5,4,11].map(x=>({x,y:3.3,w:4.6,h:1.75})));
 facade('research-north',6,-40.55,28,5,Math.PI,[-9,-3,3,9].map(x=>({x,y:3.35,w:3.4,h:1.8})));
 // Warm plaster over the loading lintel and a deep steel doorway carry the
 // factory's original access opening without making an alternative entrance.
 box(4,4.55,-5.48,4.7,.88,.48,'plaster','masonry');
 for(const x of[1.72,6.28])box(x,2.17,-5.37,.32,4.34,.34,'steel');
 for(let i=0;i<8;i++)for(const x of[1.72,6.28])box(x,.5+i*.43,-5.18,.24,.16,.025,i%2?'yellow':'rubber',i%2?'steel':'rubber');
 add('gable',[6,5,-5.62],[28,3,.16],'brickDark','masonry');
 add('gable',[6,5,-40.6],[28,3,.16],'brickDark','masonry',[0,Math.PI,0]);
 // Broken roof planes, exposed trusses and varying roof spans establish mass.
 roof('research-roof-west-back',-8.9,6,-41,-24,6,5.05,8,14.9);
 roof('research-roof-west-eave',-8.9,-2.8,-24,-5.1,6,5.05,8,14.9);
 roof('research-roof-west-front',-2.8,6,-12,-5.1,6,5.05,8,14.9);
 roof('research-roof-east-back',6,20.9,-41,-27,6,5.05,8,14.9);
 roof('research-roof-east-front',6,20.9,-15,-5.1,6,5.05,8,14.9);
 for(const z of[-39,-31,-23,-15,-7]){
  beam([-8.6,5,z],[6,7.94,z],.18,.19,'steel','steel',{roof:true});
  beam([6,7.94,z],[20.6,5,z],.18,.19,'steel','steel',{roof:true});
  beam([-8.6,4.9,z],[20.6,4.9,z],.13,.15,'steel','steel',{roof:true});
  for(let i=0;i<4;i++){
   const x=-6+i*6.2,top=8-Math.abs(x-6)/14.6*3.0;
   beam([x,4.9,z],[x+3,top-.35,z],.09,.10,'rust','rust',{roof:true});
  }
 }
 for(const x of[-8.8,6,20.8])beam([x,x===6?8:5.05,-41],[x,x===6?8:5.05,-5.1],.15,.16,'steel','steel',{roof:true});
 // The collapsed side shows a suspended, buckled sheet above the floor.
 roof('research-collapsed-roof',13,20,-24,-18,6,3.8,6.4,14.9,{sag:.75});

 // L-shaped northeast powerhouse is a separate architectural mass. Its south
 // doorway is east of the original lightning collector, keeping both clear.
 facade('power-house-front-west',30.2,-4.36,6.4,4.5,0,[{x:-1.6,y:2.85,w:2.1,h:1.6}]);
 facade('power-house-front-east',36.5,-4.36,1,4.5,0);
 facade('power-house-west',26.85,-9,9,4.5,-Math.PI/2,[{x:-1.9,y:2.9,w:2.4,h:1.65},{x:1.7,y:2.9,w:2.4,h:1.65}]);
 facade('power-house-east',37.15,-9,9,4.5,Math.PI/2,[{x:0,y:2.9,w:3.5,h:1.65}]);
 facade('power-house-north',32,-13.65,10,4.5,Math.PI,[{x:-2.5,y:2.9,w:2.2,h:1.65},{x:2.5,y:2.9,w:2.2,h:1.65}]);
 add('gable',[32,4.5,-4.35],[10,1.5,.2],'brickDark','masonry');
 add('gable',[32,4.5,-13.7],[10,1.5,.2],'brickDark','masonry',[0,Math.PI,0]);
 box(34.7,4.18,-4.26,3.0,.6,.43,'plaster','masonry');
 for(const x of[33.35,36.05])box(x,1.85,-4.15,.18,3.7,.26,'steel');
 box(36.2,1.9,-4.14,.62,3.5,.15,'rust','rust',-.45);
 roof('power-roof-west',26.6,32,-14,-3.9,32,4.48,6,5.4);
 roof('power-roof-east-back',32,37.4,-14,-10,32,4.48,6,5.4);
 roof('power-roof-east-front',32,37.4,-7,-3.9,32,4.48,6,5.4);
 for(const z of[-13.4,-9,-4.6]){
  beam([26.8,4.45,z],[32,5.95,z],.16,.15,'steel','steel');
  beam([32,5.95,z],[37.2,4.45,z],.16,.15,'steel','steel');
  beam([26.8,4.4,z],[37.2,4.4,z],.13,.13,'steel','steel');
 }
 box(32,.03,-9,9.6,.06,8.6,'concrete','masonry');
 // Dark open threshold and a warm lamp keep the entrance legible.
 box(34.7,.035,-4.25,2.6,.07,1.25,'rubber','rubber');
 box(33.0,3.65,-4.06,.27,.18,.16,'glow','glow');

 // Broken masonry connects the research shell, powerhouse and service court.
 for(const w of COMPLEX_RUIN_WALLS.filter(w=>w.id.startsWith('power-yard'))){
  const alongX=w.width>w.depth,yaw=alongX?0:Math.PI/2;
  facade(w.id,w.x,w.z,alongX?w.width:w.depth,w.height,yaw,[],true,'brickDark');
 }
 // Loading canopy is physically grouped with cargo at the east edge. It is
 // kept outside the four overlapping electrical encounter pockets.
 for(const [x,z]of [[32.15,12.6],[35.45,12.6],[32.15,18.25],[35.45,18.25]]){
  box(x,1.65,z,.22,3.3,.22,'steel');box(x,.13,z,.26,.26,.26,'concrete','masonry');
 }
 box(33.8,3.32,15.4,3.8,.17,6.3,'steel');
 roof('loading-roof',31.8,35.8,12.25,18.6,31.8,3.45,3.7,4);
 box(33.8,.91,15.55,2.4,1.82,3.1,'wood','wood');
 for(const x of[32.65,34.95])box(x,.95,15.55,.15,1.92,3.17,'steel');
 for(const z of[14.05,17.05])box(33.8,.95,z,2.45,1.92,.12,'steel');
 box(33.75,1.99,15.2,1.75,.12,2.1,'rust','rust');

 // Pipes have endpoints on real buildings and plant, rather than floating
 // above a decorative frame. Elevated spans remain walkable underneath.
 pipe([[32,3.2,-4.2],[32,3.2,5.6],[28,3.2,6.4],[28,3.2,14.7],[28,2.4,15]],.16);
 pipe([[19.55,2.7,-4.5],[19.55,2.7,6.3],[19,2.7,14.6],[19,2.3,17]],.13);
 for(const z of[.3,5.3,12.6])box(32.1,3.02,z,.22,.35,.14,'steel');
 for(const z of[2.5,6,14])box(19.6,2.55,z,.25,.33,.14,'steel');
 // Two distinctive pieces of power plant fill their original collision discs.
 box(19,.26,17,2.05,.28,1.90,'concrete','masonry');
 box(19,1.16,17,1.67,1.52,1.61,'steel');
 box(19,2.0,17,2.0,.17,1.9,'rust','rust');
 for(const side of[-1,1])for(let i=0;i<7;i++)box(19+side*.91,1.14,16.38+i*.205,.16,1.25,.12,i%3?'steelLight':'rust',i%3?'steel':'rust');
 for(const x of[18.5,19.5]){
  cyl(x,2.4,17,.13,.18,.65,'ceramic','ceramic');
  for(let i=0;i<5;i++)cyl(x,2.15+i*.13,17,.22-i*.013,.23-i*.013,.065,'ceramic','ceramic');
  cyl(x,2.84,17,.07,.07,.18,'rust','rust');
 }
 box(19,1.1,17.86,1.1,.83,.14,'rubber','rubber');
 for(let i=0;i<6;i++)box(19,.82+i*.105,17.94,.92,.035,.03,'steelLight');
 box(18.6,1.65,17.86,.3,.25,.025,'yellow');
 box(28,.23,15,1.82,.26,1.8,'concrete','masonry');
 cyl(28,1.25,15,.75,.8,1.8,'steel');
 for(let i=0;i<12;i++){const a=i*TAU/12;box(28+Math.cos(a)*.82,1.25,15+Math.sin(a)*.82,.09,1.45,.18,i%3?'steel':'rust',i%3?'steel':'rust',-a);}
 cyl(28,2.22,15,.9,.9,.16,'rust','rust');
 cyl(28,2.72,15,.16,.23,.85,'ceramic','ceramic');
 for(let i=0;i<6;i++)cyl(28,2.39+i*.13,15,.33-i*.018,.34-i*.018,.065,'ceramic','ceramic');
 cyl(28,3.25,15,.08,.08,.19,'rust','rust');
 add('ground-patch',[15.8,0,21],[1.75,1.2],'rubber','asphalt');
 for(let i=0;i<7;i++)add('ground-line',[15.3+i*.15,0,21],[.055,.95],'steel','steel');

 // The two old crystal placeholders become grounded steel lightning towers,
 // inside the original stone collision discs and at their authored heights.
 for(const [x,z,height,width]of [[31,-2,5.5,1.9],[21,-3,4,1.55]]){
  box(x,.25,z,width,.5,width,'concrete','masonry');
  for(const sx of[-1,1])for(const sz of[-1,1])beam([x+sx*width*.4,.4,z+sz*width*.4],[x+sx*.2,height-.6,z+sz*.2],.13,.13,'rust','rust');
  for(let j=0;j<3;j++){
   const y=.8+j*(height-1.6)/3,half=width*.36*(1-y/height)+.12;
   for(const sz of[-1,1])beam([x-half,y,z+sz*half],[x+half,y+.8,z+sz*half*.7],.08,.08,'steel');
   for(const sx of[-1,1])beam([x+sx*half,y,z-half],[x+sx*half*.7,y+.8,z+half],.08,.08,'steel');
  }
  box(x,height-.55,z,1.0,.12,.8,'steel');
  cyl(x,height-.27,z,.055,.055,.52,'steelLight');
  for(const side of[-1,1]){box(x+side*.46,height-.63,z,.08,.5,.08,'ceramic','ceramic');cyl(x+side*.46,height-.3,z,.1,.1,.14,'ceramic','ceramic');}
 }
 return plan;
}

function appendBox(position,normal,color,vertices,normals,colors){
 for(let i=0;i<position.count;i++){vertices.push(position.getX(i),position.getY(i),position.getZ(i));normals.push(normal.getX(i),normal.getY(i),normal.getZ(i));colors.push(color.r,color.g,color.b);}
}
function brickGeometry(item){
 const [w,h,d]=item.size,vertices=[],normals=[],colors=[],bw=.96,bh=.36;
 for(let row=0;row<Math.ceil(h/bh);row++){
  const y=row*bh+.175,offset=row%2?.48:0;
  for(let col=-1;col<Math.ceil(w/bw)+1;col++){
   const left=Math.max(-w/2,-w/2+col*bw+offset),right=Math.min(w/2,-w/2+(col+1)*bw+offset-.033),x=(left+right)/2;
   if(right-left<.08||y-.16>h)continue;
   if(item.broken&&y>h*(.72+.27*Math.abs(Math.sin(x*1.1+2.7))))continue;
   if(item.windows?.some(win=>Math.abs(x-win.x)<win.w/2+.1&&Math.abs(y-win.y)<win.h/2+.09))continue;
   const height=Math.min(.326,h-(y-.163)),g=new THREE.BoxGeometry(right-left,Math.max(.03,height),d).toNonIndexed();g.translate(x,y,d/2);
   const shade=.82+((row*17+col*29+109)%13)/37,c=new THREE.Color(shade,shade*.985,shade*.96);
   appendBox(g.attributes.position,g.attributes.normal,c,vertices,normals,colors);g.dispose();
  }
 }
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));g.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));g.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));return g;
}
function flatPolygon(points,depth){
 const shape=new THREE.Shape();points.forEach((p,i)=>i?shape.lineTo(...p):shape.moveTo(...p));shape.closePath();
 const g=new THREE.ExtrudeGeometry(shape,{depth,bevelEnabled:false,curveSegments:1});g.translate(0,0,-depth/2);return g;
}
function roofGeometry(item){
 const [xa,xb,z0,z1,ridge,eave,peak,half]=item.size,nx=3,nz=Math.ceil((z1-z0)/.22),v=[],ind=[];
 for(let iz=0;iz<=nz;iz++)for(let ix=0;ix<=nx;ix++){
  const x=xa+(xb-xa)*ix/nx,z=z0+(z1-z0)*iz/nz,ripple=Math.cos(z*TAU/.31)*.04;
  const edge=1-Math.abs(x-ridge)/half,y=eave+(peak-eave)*edge+ripple-(item.sag||0)*Math.sin(ix/nx*Math.PI)*Math.sin(iz/nz*Math.PI);
  v.push(x,y,z);
 }
 for(let iz=0;iz<nz;iz++)for(let ix=0;ix<nx;ix++){const a=iz*(nx+1)+ix,b=a+nx+1;ind.push(a,b,b+1,a,b+1,a+1);}
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(v,3));g.setIndex(ind);g.computeVertexNormals();return g;
}
function surfaceGeometry(item,world){
 if(item.kind==='asphalt'){
  const shape=new THREE.Shape();item.polygon.forEach((p,i)=>i?shape.lineTo(p[0],-p[1]):shape.moveTo(p[0],-p[1]));shape.closePath();
  const base=new THREE.ShapeGeometry(shape);base.rotateX(-Math.PI/2);
  // ShapeGeometry has only perimeter points. Subdivide triangles so changes
  // in the original walk-surface blend are followed across the whole court.
  const raw=base.index?base.toNonIndexed():base,source=raw.attributes.position,values=[];
  const split=(a,b,c,depth)=>{
   if(depth){const ab=mixPoint(a,b,.5),bc=mixPoint(b,c,.5),ca=mixPoint(c,a,.5);split(a,ab,ca,depth-1);split(ab,b,bc,depth-1);split(ca,bc,c,depth-1);split(ab,bc,ca,depth-1);return;}
   for(const p of[a,b,c]){const x=p[0],z=p[2];values.push(x,world.height(x,z)+.009,z);}
  };
  for(let i=0;i<source.count;i+=3)split([source.getX(i),0,source.getZ(i)],[source.getX(i+1),0,source.getZ(i+1)],[source.getX(i+2),0,source.getZ(i+2)],4);
  const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute(values,3));g.computeVertexNormals();raw.dispose();if(raw!==base)base.dispose();return g;
 }
 const [w,d]=item.size;let g;
 if(item.kind==='ground-patch'){
  const shape=new THREE.Shape();
  for(let i=0;i<18;i++){
   const angle=i*TAU/18,wear=.8+.16*Math.sin(i*2.4+item.at[0]);
   const x=Math.cos(angle)*w*.5*wear,y=Math.sin(angle)*d*.5*wear;
   if(i)shape.lineTo(x,y);else shape.moveTo(x,y);
  }
  shape.closePath();g=new THREE.ShapeGeometry(shape);g.rotateX(-Math.PI/2);
 }else{g=new THREE.PlaneGeometry(w,d,Math.max(1,Math.ceil(w/.5)),Math.max(1,Math.ceil(d/.5)));g.rotateX(-Math.PI/2);}
 const p=g.attributes.position,co=Math.cos(item.rotation[1]),si=Math.sin(item.rotation[1]);
 for(let i=0;i<p.count;i++){const u=p.getX(i),v=p.getZ(i),x=item.at[0]+u*co+v*si,z=item.at[2]-u*si+v*co;p.setXYZ(i,x,world.height(x,z)+.018,z);}
 g.computeVertexNormals();return g;
}
function geometryFor(item,world){
 if(['asphalt','ground-patch','ground-line'].includes(item.kind))return surfaceGeometry(item,world);
 if(item.kind==='brick-wall')return brickGeometry(item);
 if(item.kind==='roof-panel')return roofGeometry(item);
 if(item.kind==='gable')return flatPolygon([[-item.size[0]/2,0],[item.size[0]/2,0],[0,item.size[1]]],item.size[2]);
 if(item.kind==='cylinder')return new THREE.CylinderGeometry(...item.size,12,1);
 if(item.kind==='pipe')return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(item.points.map(p=>new THREE.Vector3(...p))),item.points.length*6,item.size[0],7,false);
 if(item.kind==='beam'){
  const a=new THREE.Vector3(...item.a),b=new THREE.Vector3(...item.b),g=new THREE.BoxGeometry(item.size[0],a.distanceTo(b),item.size[1]);
  g.applyMatrix4(new THREE.Matrix4().compose(a.clone().add(b).multiplyScalar(.5),new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0,1,0),b.sub(a).normalize()),new THREE.Vector3(1,1,1)));return g;
 }
 return new THREE.BoxGeometry(...item.size);
}

// A tattered, translucent metre of road edge reveals the actual terrain below.
// Noise is measured in world metres, so the damage remains stable while moving
// and no cutout texture, extra scenery, or extra material draw is required.
function weatherAsphalt(material,polygon){
 const inherited=material.onBeforeCompile;
 const segmentCode=polygon.map((a,i)=>{
  const b=polygon[(i+1)%polygon.length],vec=p=>'vec2('+p.map(v=>Number(v).toFixed(3)).join(',')+')';
  return 'yardDistance=min(yardDistance,yardSegment(detailWorld.xz,'+vec(a)+','+vec(b)+'));';
 }).join('\n');
 material.transparent=true;material.depthWrite=false;material.alphaTest=.07;
 material.customProgramCacheKey=()=> 'complex-worn-asphalt-v3';
 material.onBeforeCompile=(shader,renderer)=>{
  inherited(shader,renderer);
  shader.fragmentShader='float yardSegment(vec2 p,vec2 a,vec2 b){vec2 v=b-a;float t=clamp(dot(p-a,v)/dot(v,v),0.0,1.0);return length(p-a-v*t);}\n'+shader.fragmentShader;
  shader.fragmentShader=shader.fragmentShader.replace('#include <alphatest_fragment>',[
   'float yardDistance=10000.0;',segmentCode,
   'float yardCut=detailNoise(detailWorld.xz*2.9)*.65+detailNoise(detailWorld.xz*8.1)*.28;',
   'float yardWear=smoothstep(yardCut+.03,yardCut+1.05,yardDistance);',
   'diffuseColor.a*=yardWear;',
   'diffuseColor.rgb*=.89+detailNoise(detailWorld.xz*12.7)*.19;',
   '#include <alphatest_fragment>'
  ].join('\n'));
 };
}

export function buildComplexRuins(world,c){
 if(c?.id!=='complex')return [];
 const plan=complexRuinsPlan(c),batches=createDetailBatches(world,{prefix:'complex-factory'}),roofBatches=createDetailBatches(world,{prefix:'complex-factory-roof'}),powerRoofBatches=createDetailBatches(world,{prefix:'complex-powerhouse-roof'}),canopyRoofBatches=createDetailBatches(world,{prefix:'complex-loading-roof'});
 for(const item of plan){
  const ground=['asphalt','ground-patch','ground-line'].includes(item.kind),target=item.roof?roofBatches:item.cover==='power'?powerRoofBatches:item.cover==='loading'?canopyRoofBatches:batches;
  target.add(geometryFor(item,world),item.color,ground?[0,0,0]:item.at,ground?[0,0,0]:item.rotation,[1,1,1],F[item.material]);
 }
 const meshes=batches.flush(),roofMeshes=roofBatches.flush(),powerRoofMeshes=powerRoofBatches.flush(),canopyRoofMeshes=canopyRoofBatches.flush(),allMeshes=[...meshes,...roofMeshes,...powerRoofMeshes,...canopyRoofMeshes];
 const asphalt=meshes.find(mesh=>mesh.material.roughness===F.asphalt.roughness);
 if(asphalt)weatherAsphalt(asphalt.material,plan.find(item=>item.kind==='asphalt').polygon);
 for(const mesh of allMeshes)mesh.userData.complexRuins=true;
 world.cutawayMeshes??=[];
 for(const mesh of roofMeshes)world.cutawayMeshes.push({mesh,zone:[-9,-41,21,-5]});
 for(const mesh of powerRoofMeshes)world.cutawayMeshes.push({mesh,zone:[26.8,-13.6,37.2,-4.3]});
 for(const mesh of canopyRoofMeshes)world.cutawayMeshes.push({mesh,zone:[32.1,12.6,35.45,18.25]});
 world.colliders.push(...complexRuinsObstacles(c));
 world.complexRuins={meshes:allMeshes,details:plan.length,replacedStructures:[...COMPLEX_REPLACED_STRUCTURES],replacedProps:[...COMPLEX_REPLACED_PROPS],buildingBounds:COMPLEX_BUILDING_BOUNDS,roofMeshes,powerRoofMeshes,canopyRoofMeshes};
 return allMeshes;
}
