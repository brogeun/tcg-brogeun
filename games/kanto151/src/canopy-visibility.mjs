// Keep the player and chosen wild Pokémon visible through foreground foliage.
// Live vectors are shared with the camera; no per-frame scene traversal or
// transparent-material sorting is needed.
const installed = new WeakSet();
const vector = p => p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
const VERTEX = `
varying vec3 canopySightWorld;
`;
const WORLD_POSITION = `
vec4 canopySightPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
 canopySightPosition = batchingMatrix * canopySightPosition;
#endif
#ifdef USE_INSTANCING
 canopySightPosition = instanceMatrix * canopySightPosition;
#endif
canopySightWorld = ( modelMatrix * canopySightPosition ).xyz;
`;
const FRAGMENT = `
uniform vec3 canopySightCamera;
uniform vec3 canopySightTarget;
uniform float canopySightRadius;
uniform vec3 canopySelectedTarget;
uniform float canopySelectedActive;
varying vec3 canopySightWorld;
float canopyOpening(vec3 target, float radius) {
 vec3 ray = canopySightCamera - target;
 float rayLength = max(length(ray), 0.001);
 vec3 direction = ray / rayLength;
 vec3 offset = canopySightWorld - target;
 float along = dot(offset, direction);
 float distance = length(offset - direction * clamp(along, 0.0, rayLength));
 float opening = 1.0 - smoothstep(radius * 0.74, radius, distance);
 opening *= smoothstep(0.0, 0.45, along);
 opening *= 1.0 - smoothstep(rayLength - 0.9, rayLength - 0.2, along);
 return opening;
}
`;
const CUTOUT = `
// Only foreground foliage is opened; distant groves and trunks stay solid.
float canopySightOpening = canopyOpening(canopySightTarget, canopySightRadius);
if (canopySelectedActive > 0.5) {
 canopySightOpening = max(canopySightOpening, canopyOpening(canopySelectedTarget, canopySightRadius));
}
float canopySightDither = fract( 52.9829189 * fract( dot( floor( gl_FragCoord.xy ), vec2( 0.06711056, 0.00583715 ) ) ) );
if ( canopySightDither < canopySightOpening ) discard;
`;

function selectedFocus(world) {
 if(!world.canopyTargetFocus)world.canopyTargetFocus={position:world.cameraTarget.clone(),active:{value:0}};
 return world.canopyTargetFocus;
}

// HUD updates the live references retained by every installed foliage material.
export function updateCanopyFocus(world,actor) {
 if(!vector(world?.cameraTarget)||typeof world.cameraTarget.clone!=='function')return false;
 const focus=selectedFocus(world),position=actor?.model?.position;
 const active=!!actor&&actor.hp>0&&!actor.capturing&&actor.model?.visible!==false&&vector(position);
 focus.active.value=active?1:0;
 if(active){focus.position.copy(position);focus.position.y+=Math.max(.35,(Number(actor.model.userData?.height)||1)*.45);}
 return active;
}

/** Apply to a foliage material only; trunks, terrain and shadow passes stay solid. */
export function installCanopyVisibility(material, world, {radius=1.7}={}) {
 if(!material || !vector(world?.camera?.position) || !vector(world?.cameraTarget))return false;
 if(installed.has(material))return true;
 const previousCompile=material.onBeforeCompile, previousKey=material.customProgramCacheKey;
 const focus=selectedFocus(world),camera={value:world.camera.position}, target={value:world.cameraTarget}, sightRadius={value:Math.min(2.2,Math.max(1.2,Number.isFinite(radius)?radius:1.7))};
 material.onBeforeCompile=function(shader,renderer){
  if(previousCompile)previousCompile.call(this,shader,renderer);
  // Standard material chunks survive inherited wind and palette hooks. If a
  // caller replaces that shader completely, do not leave an unmatched varying.
  if(!shader.vertexShader.includes('#include <project_vertex>')||!shader.fragmentShader.includes('#include <clipping_planes_fragment>'))return;
  shader.uniforms.canopySightCamera=camera;shader.uniforms.canopySightTarget=target;shader.uniforms.canopySightRadius=sightRadius;shader.uniforms.canopySelectedTarget={value:focus.position};shader.uniforms.canopySelectedActive=focus.active;
  shader.vertexShader=VERTEX+shader.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\n'+WORLD_POSITION);
  shader.fragmentShader=FRAGMENT+shader.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\n'+CUTOUT);
 };
 material.customProgramCacheKey=function(){return `${previousKey?previousKey.call(this):''}|canopy-sightline-v2`;};
 material.userData??={};material.userData.canopyVisibility=true;material.needsUpdate=true;installed.add(material);return true;
}
