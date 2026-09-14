// Path coverage is evaluated per pixel in world metres, independently of terrain tessellation.
import * as THREE from '../vendor/three.module.js';
export function terrainMaterial(composition){
 const segments=[];
 for(const path of composition.paths)for(let i=1;i<path.points.length;i++)segments.push({a:path.points[i-1],b:path.points[i],radius:path.width*.5});
 const zones=composition.surfaceZones||[],zoneCount=Math.max(1,zones.length),count=Math.max(1,segments.length),material=new THREE.MeshStandardMaterial({roughness:1});
 material.onBeforeCompile=shader=>{
  shader.uniforms.trailSegments={value:segments.length?segments.map(s=>new THREE.Vector4(...s.a,...s.b)):[new THREE.Vector4()]};
  shader.uniforms.trailRadii={value:segments.length?segments.map(s=>s.radius):[0]};
  shader.uniforms.soilColor={value:new THREE.Color(composition.palette.path)};
  shader.uniforms.grassColor={value:new THREE.Color(composition.palette.ground)};
  shader.uniforms.zoneBounds={value:zones.length?zones.map(z=>new THREE.Vector4(...z.bounds)):[new THREE.Vector4(1000,1000,1001,1001)]};
  shader.uniforms.zoneColors={value:zones.length?zones.map(z=>new THREE.Color(z.color)):[new THREE.Color()]};
  shader.vertexShader='varying vec2 terrainXZ;\n'+shader.vertexShader.replace('#include <begin_vertex>','#include <begin_vertex>\nterrainXZ=position.xz;');
  shader.fragmentShader=`varying vec2 terrainXZ;
uniform vec4 trailSegments[${count}];
uniform float trailRadii[${count}];
uniform vec3 soilColor;uniform vec3 grassColor;
uniform vec4 zoneBounds[${zoneCount}];uniform vec3 zoneColors[${zoneCount}];
float terrainHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float terrainNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(terrainHash(i),terrainHash(i+vec2(1,0)),f.x),mix(terrainHash(i+vec2(0,1)),terrainHash(i+vec2(1,1)),f.x),f.y);}
`+shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
float trailDistance=1000.0;
for(int i=0;i<${count};i++){vec2 a=trailSegments[i].xy,b=trailSegments[i].zw,d=b-a;float t=clamp(dot(terrainXZ-a,d)/max(dot(d,d),.001),0.0,1.0);trailDistance=min(trailDistance,length(terrainXZ-a-d*t)-trailRadii[i]);}
float broad=terrainNoise(terrainXZ*.24),grain=terrainNoise(terrainXZ*3.3);
float edge=trailDistance+(broad-.5)*.23;
float pathMask=1.0-smoothstep(-.18,.30,edge);
vec3 grass=grassColor*(.88+broad*.22+(grain-.5)*.055);
vec3 soil=soilColor*(.92+broad*.12+(grain-.5)*.045);
diffuseColor.rgb=mix(grass,soil,pathMask);
for(int i=0;i<${zoneCount};i++){vec4 b=zoneBounds[i];float border=min(min(terrainXZ.x-b.x,b.z-terrainXZ.x),min(terrainXZ.y-b.y,b.w-terrainXZ.y));float blend=smoothstep(-.6,1.2,border);diffuseColor.rgb=mix(diffuseColor.rgb,zoneColors[i]*(.92+broad*.12-pathMask*.13),blend);}
`);
 };
 material.customProgramCacheKey=()=>`terrain-trails-v2-${count}-${zoneCount}`;
 return material;
}
