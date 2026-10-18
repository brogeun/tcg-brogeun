// Surface detail is shaded in world metres; authored heights and path widths stay intact.
import * as THREE from '../vendor/three.module.js';
export function terrainMaterial(composition){
 const segments=[];
 for(const path of composition.paths)for(let i=1;i<path.points.length;i++)segments.push({a:path.points[i-1],b:path.points[i],radius:path.width*.5});
 const region=composition.id,zones=composition.surfaceZones||[],zoneCount=Math.max(1,zones.length),count=Math.max(1,segments.length),patches=composition.groundPatches||[];
 // Only the coast needs shoreline work. The existing water polygon supplies its edge.
 const shores=region==='waterside'?(composition.waterBodies||[]).filter(b=>b.kind==='water').flatMap(b=>[b.polygon,...(b.holes||[]).map(h=>h.polygon||h)].flatMap(r=>r.map((a,i)=>new THREE.Vector4(...a,...r[(i+1)%r.length])))):[];
 const forestBanks=region==='verdant'?(composition.waterBodies||[]).filter(b=>b.kind==='water').flatMap(b=>b.polygon.map((a,i)=>new THREE.Vector4(...a,...b.polygon[(i+1)%b.polygon.length]))):[];
 const material=new THREE.MeshStandardMaterial({roughness:1});
 material.onBeforeCompile=shader=>{
  shader.uniforms.trailSegments={value:segments.length?segments.map(s=>new THREE.Vector4(...s.a,...s.b)):[new THREE.Vector4()]};
  shader.uniforms.trailRadii={value:segments.length?segments.map(s=>s.radius):[0]};
  shader.uniforms.soilColor={value:new THREE.Color(composition.palette.path)};
  shader.uniforms.grassColor={value:new THREE.Color(composition.palette.ground)};
  shader.uniforms.zoneBounds={value:zones.length?zones.map(z=>new THREE.Vector4(...z.bounds)):[new THREE.Vector4(1000,1000,1001,1001)]};
  shader.uniforms.zoneColors={value:zones.length?zones.map(z=>new THREE.Color(z.color)):[new THREE.Color()]};
  if(shores.length)shader.uniforms.shoreSegments={value:shores};
  if(forestBanks.length)shader.uniforms.forestBanks={value:forestBanks};
  if(patches.length){shader.uniforms.groundPatches={value:patches.map(p=>new THREE.Vector4(...p.center,...p.radius))};shader.uniforms.patchColors={value:patches.map(p=>new THREE.Color(p.color))};shader.uniforms.patchStrength={value:patches.map(p=>p.strength??1)};}
  shader.vertexShader='varying vec2 terrainXZ;\nvarying vec2 terrainRelief;\n'+shader.vertexShader.replace('#include <begin_vertex>',`#include <begin_vertex>
terrainXZ=position.xz;
terrainRelief=vec2(position.y,1.0-clamp(normal.y,0.0,1.0));`);
  shader.fragmentShader=`varying vec2 terrainXZ;
varying vec2 terrainRelief;
uniform vec4 trailSegments[${count}];
uniform float trailRadii[${count}];
uniform vec3 soilColor;uniform vec3 grassColor;
uniform vec4 zoneBounds[${zoneCount}];uniform vec3 zoneColors[${zoneCount}];
${shores.length?`uniform vec4 shoreSegments[${shores.length}];`:''}
${forestBanks.length?`uniform vec4 forestBanks[${forestBanks.length}];`:''}
${patches.length?`uniform vec4 groundPatches[${patches.length}];uniform vec3 patchColors[${patches.length}];uniform float patchStrength[${patches.length}];`:''}
float terrainHash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float terrainNoise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(terrainHash(i),terrainHash(i+vec2(1.0,0.0)),f.x),mix(terrainHash(i+vec2(0.0,1.0)),terrainHash(i+vec2(1.0,1.0)),f.x),f.y);}
${region==='verdant'?`
vec3 forestSurfaceNormal(vec3 surfacePosition,vec3 surfaceNormal,float relief){
 vec3 dx=dFdx(surfacePosition),dy=dFdy(surfacePosition),rx=cross(dy,surfaceNormal),ry=cross(surfaceNormal,dx);
 float det=dot(dx,rx);
 return normalize(max(abs(det),.000001)*surfaceNormal-sign(det)*(dFdx(relief)*rx+dFdy(relief)*ry));
}
`:''}
`+shader.fragmentShader.replace('#include <color_fragment>',`#include <color_fragment>
float trailDistance=1000.0,trailCenter=1000.0,trailRadius=1.0;
${region==='verdant'?'vec2 forestTrailDirection=vec2(1.0,0.0);float forestTrailSide=0.0;':''}
for(int i=0;i<${segments.length};i++){
 vec2 a=trailSegments[i].xy,b=trailSegments[i].zw,d=b-a;
 float t=clamp(dot(terrainXZ-a,d)/max(dot(d,d),.001),0.0,1.0);
 float center=length(terrainXZ-a-d*t),edge=center-trailRadii[i];
 if(edge<trailDistance){trailDistance=edge;trailCenter=center;trailRadius=trailRadii[i];${region==='verdant'?'forestTrailDirection=normalize(d+vec2(.00001));forestTrailSide=dot(terrainXZ-a-d*t,vec2(-forestTrailDirection.y,forestTrailDirection.x));':''}}
}
// Three noise scales give broad vegetation patches, worn edges and fine grain.
float broad=terrainNoise(terrainXZ*.075),variation=terrainNoise(terrainXZ*.48+vec2(31.7,8.9)),grain=terrainNoise(terrainXZ*3.2);
float edge=trailDistance+(variation-.5)*.60+(grain-.5)*.10;
float pathEnvelope=1.0-smoothstep(-.10,.38,edge);
float pathCore=1.0-smoothstep(.43,.84,trailCenter/max(trailRadius,.1)+(variation-.5)*.13);
// The walkable width is unchanged: a worn, grassy shoulder surrounds compact earth.
float brokenVerge=.23+smoothstep(.34,.67,variation)*.32;
float pathMask=pathEnvelope*mix(brokenVerge,1.0,pathCore);
float shoulder=1.0-smoothstep(-.25,.95,edge);
float wear=1.0-smoothstep(.10,.29,abs(trailCenter/max(trailRadius,.1)-.42));
vec2 cell=terrainXZ*3.4,cellId=floor(cell);
float seed=terrainHash(cellId+vec2(9.2,43.1));
vec2 pebbleUV=fract(cell)-vec2(.24+seed*.48,.25+fract(seed*7.13)*.5);
float pebble=(1.0-smoothstep(.075,.14,length(pebbleUV*vec2(1.0,1.4))))*step(.77,seed);
// Fade the smallest marks as they become subpixel, avoiding distant sparkle.
float detailFade=1.0-smoothstep(.12,.42,max(fwidth(terrainXZ.x),fwidth(terrainXZ.y)));
pebble*=detailFade;
float meadow=smoothstep(.22,.76,broad);
vec3 grass=grassColor*mix(vec3(.54,.72,.62),vec3(1.20,1.15,.84),meadow);
grass*=.93+variation*.12+(grain-.5)*.045;
grass=mix(grass,grassColor*vec3(1.28,1.13,.74),smoothstep(.57,.77,variation)*meadow*.21);
grass*=1.0-pebble*.12;
vec3 soil=soilColor*vec3(.66,.52,.38)*(.83+broad*.27+(variation-.5)*.12+(grain-.5)*.065+wear*.09);
soil=mix(soil,soilColor*.84,pebble*.58);
// A darker, thin grass verge anchors the path instead of outlining it in beige.
grass*=1.0-shoulder*(1.0-pathMask)*.10;
${region==='waterside'?`
float shoreDistance=1000.0;
${shores.length?`for(int i=0;i<${shores.length};i++){vec2 a=shoreSegments[i].xy,d=shoreSegments[i].zw-a;float t=clamp(dot(terrainXZ-a,d)/max(dot(d,d),.001),0.0,1.0);shoreDistance=min(shoreDistance,length(terrainXZ-a-d*t));}`:''}
float sandMask=1.0-smoothstep(1.1,5.2,shoreDistance+(variation-.5)*1.8);
float wetSand=1.0-smoothstep(.25,1.6,shoreDistance);
vec3 sand=soilColor*vec3(1.06,1.025,.91)*(.86+broad*.13+(grain-.5)*.095-wetSand*.18);
sand=mix(sand,soilColor*.66,pebble*.38);
grass=mix(grass,sand,sandMask);
soil=mix(soil,sand,sandMask*.82);
`:region==='highlands'?`
float rockMask=smoothstep(.055,.32,terrainRelief.y);
float strata=.5+.5*sin(terrainRelief.x*3.0+variation*3.2);
vec3 rock=grassColor*vec3(.94,.96,1.04)*(.69+broad*.25+variation*.17+strata*.055);
rock=mix(rock,soilColor*.86,pebble*.38);
grass=mix(grass,rock,.32+rockMask*.68);
float snowMask=smoothstep(7.4,9.0,terrainRelief.x+(variation-.5)*1.8)*(1.0-rockMask*.75);
grass=mix(grass,vec3(.69,.77,.80)*(.91+grain*.09),snowMask*.82);
soil=mix(soil,rock,.20+rockMask*.50);
`:region==='caldera'?`
float ash=smoothstep(.38,.72,variation),charcoal=smoothstep(.51,.70,grain);
grass=grassColor*(.66+broad*.35+variation*.15-charcoal*.09);
grass=mix(grass,grassColor*vec3(1.32,1.13,.94),ash*.28);
grass=mix(grass,grassColor*.49,pebble*.62);
soil=soilColor*vec3(.55,.49,.42)*(.83+broad*.22+(grain-.5)*.07+wear*.08);
soil=mix(soil,grassColor*1.26,pebble*.48);
`:region==='complex'?`
// Service roads have worn aggregate and broad repairs, without a tiled grid.
float repair=terrainNoise(terrainXZ*.31+vec2(9.1,23.7));
vec3 asphalt=vec3(.19,.215,.18)*(.84+broad*.30+(grain-.5)*.16);
asphalt=mix(asphalt,vec3(.31,.315,.245),smoothstep(.61,.74,repair)*.42);
asphalt=mix(asphalt,soilColor*.69,(1.0-pathCore)*.32);
asphalt+=pebble*vec3(.045,.047,.035);
soil=mix(soil,asphalt,.83);
grass=mix(grass,grassColor*.71,smoothstep(.53,.73,variation)*.24);
`:region==='verdant'?`
// Worn earth and living ground have different colour, relief and roughness.
grass=grassColor*mix(vec3(.58,.78,.67),vec3(1.02,1.15,.80),smoothstep(.15,.82,broad));
grass*=.89+variation*.22+(grain-.5)*.055;
float forestRuts=exp(-pow((abs(forestTrailSide)-.43)/.16,2.0))*pathCore*(.55+variation*.45);
soil*=1.0-forestRuts*.18;
`:''}
diffuseColor.rgb=mix(grass,soil,pathMask);
${patches.length?`for(int i=0;i<${patches.length};i++){vec4 p=groundPatches[i];float distance=length((terrainXZ-p.xy)/p.zw);float mask=(1.0-smoothstep(.58,1.10,distance+(variation-.5)*.13))*patchStrength[i];vec3 patchTint=patchColors[i]*(.76+broad*.28+(variation-.5)*.16+(grain-.5)*.08);${region==='verdant'?`
 // The old 91% opaque courtyard tint erased every path and grass shoulder.
 // Keep the authored footprint, letting foot traffic define the bare ground.
 if(p.y>15.0&&abs(p.x)<6.0&&p.z>10.0){mask*=.17+pathCore*.71;patchTint=mix(soil,patchTint,.16);}
 else{mask*=.42;patchTint=mix(diffuseColor.rgb,patchTint,.62);}
 `:''}diffuseColor.rgb=mix(diffuseColor.rgb,patchTint,mask);}`:''}
for(int i=0;i<${zoneCount};i++){
 vec4 b=zoneBounds[i];
 float border=min(min(terrainXZ.x-b.x,b.z-terrainXZ.x),min(terrainXZ.y-b.y,b.w-terrainXZ.y));
 float blend=smoothstep(-.6,1.2,border);
 // Authored surface colors, including the summit snow, keep their identity.
 vec3 zone=zoneColors[i]*(.86+broad*.15+(variation-.5)*.07+(grain-.5)*.045-pathMask*.105);
 diffuseColor.rgb=mix(diffuseColor.rgb,zone,blend);
}
${region==='verdant'?`
float forestBankDistance=1000.0;
${forestBanks.length?`for(int i=0;i<${forestBanks.length};i++){vec2 a=forestBanks[i].xy,d=forestBanks[i].zw-a;float t=clamp(dot(terrainXZ-a,d)/max(dot(d,d),.001),0.0,1.0);forestBankDistance=min(forestBankDistance,length(terrainXZ-a-d*t));}`:''}
float forestWet=(1.0-smoothstep(.2,1.8,forestBankDistance+(variation-.5)*.55));
vec3 forestBankSoil=mix(soil*.62,vec3(.095,.13,.09),.22)*(.84+grain*.28);
diffuseColor.rgb=mix(diffuseColor.rgb,forestBankSoil,forestWet*.86);
// Sparse gravel and leaf litter use irregular local shapes, not a tiling grid.
vec2 forestCell=terrainXZ*1.9,forestId=floor(forestCell);
float forestSeed=terrainHash(forestId+vec2(71.2,9.8));
vec2 forestUV=fract(forestCell)-vec2(.25+forestSeed*.5,.25+fract(forestSeed*9.7)*.5);
float forestAngle=forestSeed*6.283185,forestCS=cos(forestAngle),forestSN=sin(forestAngle);
vec2 forestTurn=mat2(forestCS,-forestSN,forestSN,forestCS)*forestUV;
float forestStoneShape=length(forestTurn*vec2(1.0,1.4));
float forestStone=(1.0-smoothstep(.10,.17,forestStoneShape))*step(.78,forestSeed)*detailFade;
float forestLeaf=(1.0-smoothstep(.52,.85,length(forestTurn/vec2(.085,.20))))*step(.22,forestSeed)*step(forestSeed,.43)*detailFade;
float forestLitterDensity=(.24+(1.0-pathCore)*.76)*(.50+broad*.50);
vec3 forestLeafColor=mix(vec3(.16,.12,.053),vec3(.28,.235,.098),fract(forestSeed*17.0));
diffuseColor.rgb=mix(diffuseColor.rgb,forestLeafColor,forestLeaf*forestLitterDensity*.64);
vec3 forestStoneColor=mix(vec3(.19,.20,.145),vec3(.34,.33,.25),fract(forestSeed*13.0));
diffuseColor.rgb=mix(diffuseColor.rgb,forestStoneColor,forestStone*(.25+pathMask*.40));
float forestMicro=terrainNoise(terrainXZ*8.0+vec2(5.7,19.2));
float forestRelief=((grain-.5)*.024+(forestMicro-.5)*.009+forestStone*.035-forestRuts*.018)*detailFade;
forestRelief+=(variation-.5)*.021*(1.0-pathMask*.5);
`:''}
`);
  if(region==='verdant')shader.fragmentShader=shader.fragmentShader
   .replace('#include <roughnessmap_fragment>','#include <roughnessmap_fragment>\nroughnessFactor=clamp(.96-pathMask*.08-forestWet*.19+forestStone*.04,.65,1.0);')
   .replace('#include <normal_fragment_maps>','#include <normal_fragment_maps>\nnormal=forestSurfaceNormal(-vViewPosition,normal,forestRelief);');
 };
 material.customProgramCacheKey=()=>`terrain-surface-${region==='verdant'?'v6':'v5'}-${region}-${count}-${zoneCount}-${shores.length}-${patches.length}-${forestBanks.length}`;
 return material;
}
