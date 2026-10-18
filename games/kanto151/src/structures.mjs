import * as THREE from '../vendor/three.module.js';
// Meter-scale detail stays independent of the box UVs and needs no extra textures
// or draw calls. Local face coordinates keep joints aligned on rotated walls;
// world coordinates keep weathering and rock strata continuous across pieces.
const SURFACE_VERTEX = `
varying vec3 vStructureWorld;
varying vec3 vStructureLocal;
varying vec3 vStructureFace;
varying vec3 vStructureWorldNormal;
`;
const SURFACE_FRAGMENT = `
uniform vec3 structureHalfSize;
varying vec3 vStructureWorld;
varying vec3 vStructureLocal;
varying vec3 vStructureFace;
varying vec3 vStructureWorldNormal;
float structureHash(vec2 p) {
 return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float structureNoise(vec2 p) {
 vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
 return mix(mix(structureHash(i), structureHash(i + vec2(1.0, 0.0)), f.x),
            mix(structureHash(i + vec2(0.0, 1.0)), structureHash(i + vec2(1.0)), f.x), f.y);
}
float structureJoint(float p, float spacing, float width) {
 float d = abs(fract(p / spacing + 0.5) - 0.5) * spacing;
 float aa = max(fwidth(p), 0.018);
 return 1.0 - smoothstep(width, width + aa, d);
}
`;
const ROCK_SURFACE = `
 vec3 structureP = vStructureWorld;
 vec3 structureN = normalize(vStructureFace);
 float structureTop = smoothstep(0.4, 0.9, structureN.y);
 float structureBroad = structureNoise(structureP.xz * 0.18 + structureP.y * 0.025);
 float structureGrain = structureNoise(structureP.xz * 0.64 + structureP.y * vec2(0.14, 0.23));
 float structureStrata = sin(structureP.y * 2.2 + structureBroad * 3.2 + structureGrain * 0.55);
 float structureLayers = smoothstep(0.5, 0.95, structureStrata) * smoothstep(0.2, 0.7, structureGrain) * (1.0 - structureTop);
 // Project onto the actual world-facing tangent, including rotated cliff pieces.
 vec3 structureWorldN = normalize(vStructureWorldNormal);
 vec2 structureTangent = normalize(vec2(-structureWorldN.z, structureWorldN.x) + vec2(0.0001));
 float structureAlong = dot(structureP.xz, structureTangent);
 float structureFissure = structureNoise(vec2(structureAlong * 0.43 + structureBroad * 0.6, structureP.y * 0.35 + structureGrain * 0.3));
 float structureCrack = (1.0 - smoothstep(0.025, 0.09, abs(structureFissure - 0.48)));
 structureCrack *= (1.0 - structureTop) * smoothstep(0.5, 0.78, structureGrain);
 float structureFoot = 1.0 - smoothstep(0.15, 1.25, vStructureLocal.y + structureHalfSize.y);
 float structureMoss = structureFoot * smoothstep(0.3, 0.72, structureBroad) * (1.0 - structureTop);
 vec3 structureTone = vec3(0.86 + structureBroad * 0.23 + structureGrain * 0.06);
 structureTone *= 1.0 - structureLayers * 0.11 - structureCrack * 0.11;
 structureTone = mix(structureTone, vec3(0.67, 0.79, 0.60), structureMoss * 0.4);
 structureTone += structureTop * vec3(0.065, 0.06, 0.035);
 diffuseColor.rgb *= structureTone;
`;
const BUILT_SURFACE = `
 vec3 structureN = abs(normalize(vStructureFace));
 vec3 structureEdge = max(structureHalfSize - abs(vStructureLocal), vec3(0.0));
 vec2 structureUv;
 float structureRim;
 if (structureN.y > 0.5) {
  structureUv = vStructureLocal.xz + structureHalfSize.xz;
  structureRim = min(structureEdge.x, structureEdge.z);
 } else if (structureN.x > 0.5) {
  structureUv = vec2(vStructureLocal.z + structureHalfSize.z, vStructureLocal.y + structureHalfSize.y);
  structureRim = min(structureEdge.z, structureEdge.y);
 } else {
  structureUv = vStructureLocal.xy + structureHalfSize.xy;
  structureRim = min(structureEdge.x, structureEdge.y);
 }
 float structureWear = structureNoise(vStructureWorld.xz * 0.27 + vStructureWorld.y * vec2(0.06, 0.13));
 float structureCell = structureNoise(floor(structureUv / structurePanelSize) + vec2(23.0, 8.0));
 float structureSeam = max(structureJoint(structureUv.x, structurePanelSize.x, 0.025), structureJoint(structureUv.y, structurePanelSize.y, 0.025));
 float structureBevel = 1.0 - smoothstep(0.015, 0.2, structureRim);
 float structureFoot = (1.0 - smoothstep(0.1, 0.85, vStructureLocal.y + structureHalfSize.y)) * (1.0 - structureN.y);
 float structureTone = 0.96 + (structureWear - 0.5) * 0.1 + (structureCell - 0.5) * 0.07;
 structureTone -= structureSeam * 0.16 + structureBevel * 0.13 + structureFoot * (0.07 + structureWear * 0.06);
 diffuseColor.rgb *= structureTone;
`;
function structureMaterial(s,c){
 const material=new THREE.MeshStandardMaterial({color:s.color||'#777d83',roughness:s.roughness??.9,metalness:s.metalness||0});
 const rock=s.kind==='cliff'||c.id==='highlands',floor=s.kind==='floor',mode=rock?'rock':floor?'paving':'panel';
 material.flatShading=s.kind==='cliff'&&c.id==='highlands';
 material.userData.structureSurface=mode;
 material.customProgramCacheKey=()=>`kanto-structure-surface-v1-${mode}`;
 material.onBeforeCompile=shader=>{
  shader.uniforms.structureHalfSize={value:new THREE.Vector3(...s.size).multiplyScalar(.5)};
  shader.uniforms.structurePanelSize={value:new THREE.Vector2(floor?2:2.8,floor?2:1.6)};
  shader.vertexShader=SURFACE_VERTEX+shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
 vStructureWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;
 vStructureLocal = transformed;
 vStructureFace = normal;
 vStructureWorldNormal = normalize(mat3(modelMatrix) * normal);
`);
  shader.fragmentShader=SURFACE_FRAGMENT+'uniform vec2 structurePanelSize;\n'+shader.fragmentShader.replace('#include <map_fragment>','#include <map_fragment>\n'+(rock?ROCK_SURFACE:BUILT_SURFACE));
 };
 return material;
}
function structureGeometry(s,c){
 if(s.kind!=='cliff'||c.id!=='highlands')return new THREE.BoxGeometry(...s.size);
 const [width,height,depth]=s.size;
 const geometry=new THREE.BoxGeometry(width,height,depth,Math.max(1,Math.ceil(width/2.6)),Math.max(3,Math.ceil(height/1.3)),Math.max(1,Math.ceil(depth/2.6)));
 const positions=geometry.attributes.position,normals=geometry.attributes.normal;
 const hash=(u,v)=>{const value=Math.sin(u*127.1+v*311.7)*43758.5453;return value-Math.floor(value);};
 for(let i=0;i<positions.count;i++){
  const x=positions.getX(i),y=positions.getY(i),z=positions.getZ(i),nx=normals.getX(i),nz=normals.getZ(i);
  if(Math.abs(normals.getY(i))>.5||Math.abs(y)>=height/2-1e-5)continue;
  const alongX=Math.abs(nz)>.5,u=alongX?x:z,halfSpan=(alongX?width:depth)/2;
  // Every perimeter vertex stays untouched, preserving ground joins, neighboring
  // cliff joins, all authored bounds and the original collision envelope.
  if(Math.abs(u)>=halfSpan-1e-5)continue;
  const worldU=u+s.position[alongX?0:2],worldY=y+s.position[1],face=alongX?nz:nx;
  const grain=hash(worldU+face*.71,worldY),stratum=.5+.5*Math.sin(worldY*2.1+Math.sin(worldU*.3)*.6);
  const inset=Math.min(.2,(alongX?depth:width)*.28)*(.18+.48*grain+.34*stratum);
  const shiftedU=u+(hash(worldU+11.4,worldY+face)-.5)*.4;
  const shiftedY=y+(hash(worldU-7.2,worldY+5.1)-.5)*.22;
  if(alongX)positions.setXYZ(i,shiftedU,shiftedY,z-face*inset);
  else positions.setXYZ(i,x-face*inset,shiftedY,shiftedU);
 }
 positions.needsUpdate=true;geometry.computeVertexNormals();geometry.computeBoundingBox();geometry.computeBoundingSphere();
 return geometry;
}
// Authored walls, slabs and cutaway roofs share the existing level/collider lifecycle.
export function buildStructures(world,c){world.cutawayMeshes=[];world.gates=[];for(const s of c.structures||[]){
 const material=structureMaterial(s,c);
 const mesh=world.owned(new THREE.Mesh(structureGeometry(s,c),material));mesh.position.set(...s.position);mesh.rotation.y=s.rotation||0;mesh.castShadow=s.kind!=='floor';mesh.receiveShadow=true;mesh.userData.structureId=s.id;
 const replaced=c.id==='highlands'&&['cave-floor','cave-west-wall','cave-east-wall','cave-roof'].includes(s.id)||c.id==='complex'&&['generator-base','generator-housing-a','generator-housing-b','broken-conduit','control-strip','lab-west','lab-east','lab-north','lab-front-left','lab-front-right','lab-shell-roof','lab-front-lintel'].includes(s.id);if(replaced){mesh.userData.visualReplacement=true;if(s.kind==='roof')material.visible=false;else mesh.visible=false;}
 if(s.kind==='roof')world.cutawayMeshes.push({mesh,zone:s.cutawayZone});
 if(['wall','cliff','door'].includes(s.kind)&&!(c.id==='highlands'&&['cave-west-wall','cave-east-wall'].includes(s.id))){const collider={type:'obb',x:s.position[0],z:s.position[2],halfWidth:s.size[0]/2,halfDepth:s.size[2]/2,rotation:s.rotation||0,h:s.size[1],bottomY:s.position[1]-s.size[1]/2,topY:s.position[1]+s.size[1]/2,r:Math.min(s.size[0],s.size[2])/2,cameraRadius:Math.min(s.size[0],s.size[2])/2,structureId:s.id};world.colliders.push(collider);if(s.kind==='door')world.gates.push({spec:s,mesh,collider});}
 if(s.kind==='floor')world.walkSurfaces.push({x:s.position[0],z:s.position[2],rotation:s.rotation||0,width:s.size[0],length:s.size[2],y:s.position[1]+s.size[1]/2,blend:s.blend??.5});
 }
 for(const l of c.localLights||[]){const lamp=new THREE.PointLight(l.color,c.id==='highlands'?(l.position[2]>-10?1.5:1):l.intensity,l.distance);lamp.position.set(...l.position);world.level.add(lamp);}
}
