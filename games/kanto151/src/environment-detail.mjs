import * as THREE from '../vendor/three.module.js';

// Bake small scenic parts together. Color changes use vertices, not extra draws.
export function createDetailBatches(world,{prefix='environment'}={}){
 const groups=new Map();
 return {
  add(geometry,color,position=[0,0,0],rotation=[0,0,0],scale=[1,1,1],options={}){
   const g=geometry.index?geometry.toNonIndexed():geometry.clone();geometry.dispose();
   g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position),new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),new THREE.Vector3(...scale)));
   if(!g.attributes.normal)g.computeVertexNormals();
   const spec={surface:options.surface||'plain',roughness:options.roughness??.9,metalness:options.metalness??0,emissive:options.emissive||'#000000',emissiveIntensity:options.emissiveIntensity??0,shadow:options.shadow!==false};
   const key=JSON.stringify(spec),bucket=groups.get(key)||{spec,parts:[]};groups.set(key,bucket);
   const tint=new THREE.Color(color),p=g.attributes.position,n=g.attributes.normal,old=g.attributes.color,colors=new Float32Array(p.count*3);
   for(let i=0;i<p.count;i++){colors[i*3]=tint.r*(old?old.getX(i):1);colors[i*3+1]=tint.g*(old?old.getY(i):1);colors[i*3+2]=tint.b*(old?old.getZ(i):1);}
   bucket.parts.push({position:new Float32Array(p.array),normal:new Float32Array(n.array),color:colors});g.dispose();
  },
  flush(){
   const meshes=[];
   for(const {spec,parts} of groups.values()){
    const length=parts.reduce((sum,p)=>sum+p.position.length,0),g=new THREE.BufferGeometry();
    for(const name of ['position','normal','color']){const values=new Float32Array(length);let offset=0;for(const part of parts){values.set(part[name],offset);offset+=part[name].length;}g.setAttribute(name,new THREE.BufferAttribute(values,3));}
    g.computeBoundingBox();g.computeBoundingSphere();
    const material=new THREE.MeshStandardMaterial({vertexColors:true,roughness:spec.roughness,metalness:spec.metalness,emissive:spec.emissive,emissiveIntensity:spec.emissiveIntensity});
    material.userData.detailSurface=spec.surface;
    if(spec.surface!=='plain'){
     material.customProgramCacheKey=()=>`environment-detail-v1-${spec.surface}`;
     material.onBeforeCompile=shader=>{
      shader.vertexShader='varying vec3 detailWorld;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\ndetailWorld=(modelMatrix*vec4(transformed,1.0)).xyz;');
      shader.fragmentShader=`varying vec3 detailWorld;
float detailHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float detailNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(detailHash(i),detailHash(i+vec2(1,0)),f.x),mix(detailHash(i+vec2(0,1)),detailHash(i+vec2(1,1)),f.x),f.y);}
`+shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
float detailCloud=detailNoise(detailWorld.xz*.34+detailWorld.y*.13);
float detailGrain=detailNoise(detailWorld.xz*4.7+detailWorld.y*vec2(1.8,.7));
diffuseColor.rgb*=.83+detailCloud*.22+detailGrain*.07;
${spec.surface==='rock'?'float layer=sin(detailWorld.y*5.2+detailNoise(detailWorld.xz*.46)*2.1);diffuseColor.rgb*=1.0-.085*smoothstep(.5,.95,layer);':spec.surface==='concrete'?'float stains=smoothstep(.60,.86,detailCloud);diffuseColor.rgb=mix(diffuseColor.rgb,diffuseColor.rgb*vec3(.66,.75,.68),stains*.5);':spec.surface==='metal'?'float streaks=detailNoise(vec2(detailWorld.x*3.1+detailWorld.z*2.6,detailWorld.y*.28));diffuseColor.rgb*=.91+streaks*.15;':spec.surface==='wood'?'float grain=sin(detailWorld.y*31.0+detailCloud*12.0);diffuseColor.rgb*=.94+grain*.035;':''}`);
     };
    }
    const mesh=world.owned(new THREE.Mesh(g,material));mesh.name=`${prefix}-${meshes.length}`;mesh.userData.environmentDetail=prefix;mesh.castShadow=spec.shadow;mesh.receiveShadow=true;meshes.push(mesh);
   }
   groups.clear();return meshes;
  }
 };
}
