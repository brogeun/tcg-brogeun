// Keep the player visible through foreground foliage without sorting translucent
// tree meshes or hiding whole groves. Live vectors are shared with the camera;
// no per-frame scene traversal or material updates are required.
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
varying vec3 canopySightWorld;
`;
const CUTOUT = `
// Only foliage strictly between the followed character and camera is opened.
vec3 canopySightRay = canopySightCamera - canopySightTarget;
float canopySightLength = max( length( canopySightRay ), 0.001 );
vec3 canopySightDirection = canopySightRay / canopySightLength;
vec3 canopySightOffset = canopySightWorld - canopySightTarget;
float canopySightAlong = dot( canopySightOffset, canopySightDirection );
float canopySightDistance = length( canopySightOffset - canopySightDirection * clamp( canopySightAlong, 0.0, canopySightLength ) );
float canopySightOpening = 1.0 - smoothstep( canopySightRadius * 0.74, canopySightRadius, canopySightDistance );
canopySightOpening *= smoothstep( 0.0, 0.45, canopySightAlong );
canopySightOpening *= 1.0 - smoothstep( canopySightLength - 0.9, canopySightLength - 0.2, canopySightAlong );
float canopySightDither = fract( 52.9829189 * fract( dot( floor( gl_FragCoord.xy ), vec2( 0.06711056, 0.00583715 ) ) ) );
if ( canopySightDither < canopySightOpening ) discard;
`;

/** Apply to a foliage material only; trunks, terrain and shadow passes stay solid. */
export function installCanopyVisibility(material, world, {radius=1.7}={}) {
 if(!material || !vector(world?.camera?.position) || !vector(world?.cameraTarget))return false;
 if(installed.has(material))return true;
 const previousCompile=material.onBeforeCompile, previousKey=material.customProgramCacheKey;
 const camera={value:world.camera.position}, target={value:world.cameraTarget}, sightRadius={value:Math.min(2.2,Math.max(1.2,Number.isFinite(radius)?radius:1.7))};
 material.onBeforeCompile=function(shader,renderer){
  if(previousCompile)previousCompile.call(this,shader,renderer);
  // Standard material chunks survive inherited wind and palette hooks. If a
  // caller replaces that shader completely, do not leave an unmatched varying.
  if(!shader.vertexShader.includes('#include <project_vertex>')||!shader.fragmentShader.includes('#include <clipping_planes_fragment>'))return;
  shader.uniforms.canopySightCamera=camera;shader.uniforms.canopySightTarget=target;shader.uniforms.canopySightRadius=sightRadius;
  shader.vertexShader=VERTEX+shader.vertexShader.replace('#include <project_vertex>','#include <project_vertex>\n'+WORLD_POSITION);
  shader.fragmentShader=FRAGMENT+shader.fragmentShader.replace('#include <clipping_planes_fragment>','#include <clipping_planes_fragment>\n'+CUTOUT);
 };
 material.customProgramCacheKey=function(){return `${previousKey?previousKey.call(this):''}|canopy-sightline-v1`;};
 material.userData??={};material.userData.canopyVisibility=true;material.needsUpdate=true;installed.add(material);return true;
}
