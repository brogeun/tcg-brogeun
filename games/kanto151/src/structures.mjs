import * as THREE from '../vendor/three.module.js';
// Authored walls, slabs and cutaway roofs share the existing level/collider lifecycle.
export function buildStructures(world,c){world.cutawayMeshes=[];world.gates=[];for(const s of c.structures||[]){
 const material=new THREE.MeshStandardMaterial({color:s.color||'#777d83',roughness:s.roughness??.9,metalness:s.metalness||0});
 const mesh=world.owned(new THREE.Mesh(new THREE.BoxGeometry(...s.size),material));mesh.position.set(...s.position);mesh.rotation.y=s.rotation||0;mesh.castShadow=s.kind!=='floor';mesh.receiveShadow=true;mesh.userData.structureId=s.id;
 if(s.kind==='roof')world.cutawayMeshes.push({mesh,zone:s.cutawayZone});
 if(['wall','cliff','door'].includes(s.kind)){const collider={type:'obb',x:s.position[0],z:s.position[2],halfWidth:s.size[0]/2,halfDepth:s.size[2]/2,rotation:s.rotation||0,h:s.size[1],bottomY:s.position[1]-s.size[1]/2,topY:s.position[1]+s.size[1]/2,r:Math.min(s.size[0],s.size[2])/2,cameraRadius:Math.min(s.size[0],s.size[2])/2,structureId:s.id};world.colliders.push(collider);if(s.kind==='door')world.gates.push({spec:s,mesh,collider});}
 if(s.kind==='floor')world.walkSurfaces.push({x:s.position[0],z:s.position[2],rotation:s.rotation||0,width:s.size[0],length:s.size[2],y:s.position[1]+s.size[1]/2,blend:s.blend??.5});
 }
 for(const l of c.localLights||[]){const lamp=new THREE.PointLight(l.color,l.intensity,l.distance);lamp.position.set(...l.position);world.level.add(lamp);}
}
