import * as THREE from '../vendor/three.module.js';
// Plant communities frame the service yard; circulation stays open underneath.
const hash=n=>{const x=Math.sin(n*127.13+39.7)*43758.5453;return x-Math.floor(x);};
const pathDistance=(x,z,path)=>{let best=Infinity;for(let i=1;i<path.points.length;i++){const a=path.points[i-1],b=path.points[i],dx=b[0]-a[0],dz=b[1]-a[1],t=Math.max(0,Math.min(1,((x-a[0])*dx+(z-a[1])*dz)/(dx*dx+dz*dz)));best=Math.min(best,Math.hypot(x-a[0]-dx*t,z-a[1]-dz*t));}return best;};
function clear(c,x,z,tree=false){
 if(c.paths.some(p=>pathDistance(x,z,p)<p.width*.5+(tree?1.2:.38)))return false;
 if(c.ecologyPockets.some(p=>Math.hypot((x-p.center[0])/(p.radius[0]+(tree?1.2:.25)),(z-p.center[1])/(p.radius[1]+(tree?1.2:.25)))<1))return false;
 const points=[c.safePoint.position,...c.entrances.map(e=>e.position),...c.landmarks.map(l=>l.interactionPosition||l.position),...c.specialBindings.map(b=>({x:b.position[0],z:b.position[1]}))];
 if(points.some(p=>Math.hypot(x-p.x,z-p.z)<(tree?3:1.5)))return false;
 if(c.id==='complex'&&((x>-9&&x<21&&z>-41&&z<-4.5)||(x>25.5&&x<38.5&&z>-15&&z<-3)||(x>18.5&&x<21&&z>-6&&z<7)||(x>31.5&&x<36&&z>11.5&&z<19)))return false;
 return true;
}
export function expeditionFramePlan(c){
 if(!['complex','highlands'].includes(c?.id))return [];
 const plan=[],add=(path,x,z,height,seed,tree=false)=>{if(!clear(c,x,z,tree))return;plan.push({path,x,z,height,rotation:hash(seed+17)*Math.PI*2,materialVariant:tree?'expedition-pine':'expedition-understory',...(tree?{collision:{radius:.34+hash(seed)*.09}}:{})});};
 const trees=c.id==='complex'?[
  [37,10,6.8],[41,12,8.4],[38,16,7.4],[42,18,8.8],[37.7,22.5,7.5],[41.2,25.4,8.6],[37,28.8,7.2],[42,31.3,8.5],[34.5,33,7.8],[39,35.6,8.2],
  [9.2,2.4,6.6],[13,2.2,7.4],[17.1,1,7.9],[10.2,6.2,5.8],[15.8,5.4,6.6],[18.8,4.8,7.2],
  [-2,28.6,6.7],[1.4,32.2,7.8],[5.5,34,7.2],[9.2,31.6,6.7],[12.8,35.3,7.8],[16.4,32.2,7.2],[20,35.5,8.1],[25,34.2,7.7],[29.4,35.2,7.3],
  [-1.8,4.2,6.6],[-3.8,8,7.8],[.4,1.2,7.1]
 ]:[[-1,-7,7.6],[1.1,-3.5,6.6],[-2,1.5,8.2],[1,8.9,7.2],[25.5,-7.4,7.4],[28.2,-3.6,8.2],[26.8,1,7.4],[30.3,4.8,8.3],[25.1,8,6.8]];
 for(const [i,[x,z,h]]of trees.entries())add(`quaternius/Pine_${i%5===0?5:i%3===0?1:2}`,x,z,h,i+9,true);
 const beds=c.id==='complex'?[
  [39.2,22,4.8,16,220],[13.8,3.1,6.3,4,88],[3,32,7,3.8,100],[16,33,10,4.4,120],[1,20,5.4,6.4,90],[33.4,25.8,2.1,4.7,55]
 ]:[[-1,-2,2.7,8,44],[26.8,1.3,3.6,8.8,70]];
 let index=0;
 for(const [cx,cz,rx,rz,baseCount]of beds)for(let n=0,count=Math.round(baseCount*2.6);n<count;n++){
  const seed=++index,angle=n*2.3999632297,r=Math.sqrt((n+.5)/count),x=cx+Math.cos(angle)*r*rx+(hash(seed*7)-.5)*.45,z=cz+Math.sin(angle)*r*rz+(hash(seed*11)-.5)*.45;
  // Narrow worn breaks between dense swaths keep the planted edge irregular.
  if(hash(Math.floor(x*1.2)*37+Math.floor(z*1.2)*71)<.1)continue;
  if(n%19===0)add('nature/plant_bushDetailed',x,z,1.05+hash(seed)*.45,seed);
  else if(clear(c,x,z))plan.push({kind:'grass',x,z,height:.68+hash(seed*5)*.58,seed});
  if(n%23===0)add('quaternius/Pebble_Square_3',x+.35,z+.13,.28+hash(seed)*.3,seed+5);
 }
 return plan;
}

export function buildExpeditionGroundCover(world,plan){
 const clumps=plan.filter(p=>p.kind==='grass');if(!clumps.length)return null;
 const positions=[],colors=[],bends=[],base=new THREE.Color('#535b2d'),tip=new THREE.Color('#a6a357');
 const triangle=(a,b,c,shade,levels)=>{positions.push(...a,...b,...c);for(let i=0;i<3;i++){const color=base.clone().lerp(tip,levels[i]*.8).multiplyScalar(shade);colors.push(color.r,color.g,color.b);bends.push(levels[i]);}};
 for(const p of clumps){
  const ground=world.height(p.x,p.z)+.014;
  for(let j=0;j<8;j++){
   const angle=hash(p.seed*37+j*19)*Math.PI*2,dx=Math.cos(angle),dz=Math.sin(angle),spread=.08+hash(p.seed+j*11)*.23,x=p.x+dx*spread,z=p.z+dz*spread,h=p.height*(.65+hash(p.seed+j*7)*.45),width=.022+hash(p.seed+j*13)*.022,lean=.04+hash(p.seed+j*3)*.10,across=[-dz*width,dx*width],shade=.82+hash(p.seed+j*43)*.32;
   const a=[x-across[0],ground,z-across[1]],b=[x+across[0],ground,z+across[1]],c=[x+dx*lean+across[0]*.55,ground+h*.59,z+dz*lean+across[1]*.55],d=[x+dx*lean-across[0]*.55,ground+h*.59,z+dz*lean-across[1]*.55],e=[x+dx*lean*1.9,ground+h,z+dz*lean*1.9];
   triangle(a,b,c,shade,[0,0,.59]);triangle(a,c,d,shade,[0,.59,.59]);triangle(d,c,e,shade,[.59,.59,1]);
  }
 }
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));geometry.setAttribute('color',new THREE.Float32BufferAttribute(colors,3));geometry.setAttribute('grassBend',new THREE.Float32BufferAttribute(bends,1));geometry.computeVertexNormals();geometry.computeBoundingSphere();
 const material=new THREE.MeshStandardMaterial({vertexColors:true,side:THREE.DoubleSide,roughness:1});
 material.onBeforeCompile=shader=>{shader.uniforms.groundCoverTime=world.wind||{value:0};shader.vertexShader='uniform float groundCoverTime;attribute float grassBend;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ntransformed.x+=sin(groundCoverTime*1.1+position.x*.57+position.z*.36)*grassBend*.11;transformed.z+=cos(groundCoverTime*.8+position.x*.32)*grassBend*.07;');};
 material.customProgramCacheKey=()=> 'expedition-ground-cover-v1';
 const mesh=world.owned(new THREE.Mesh(geometry,material));mesh.name='expedition-ground-cover';mesh.receiveShadow=true;mesh.castShadow=false;world.expeditionGroundCover={mesh,clumps:clumps.length,triangles:positions.length/9};return world.expeditionGroundCover;
}
