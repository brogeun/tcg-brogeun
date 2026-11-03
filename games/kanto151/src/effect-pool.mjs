// A bounded pool owns complete effects, so each active material can still fade
// independently. No geometry/material is shared with capture balls or scenery.
export class EffectPool{
 constructor(limit=48){this.limit=limit;this.free=new Map();this.keys=new WeakMap();this.active=new WeakSet();this.count=0;this.created=0;this.reused=0;}
 acquire(key,create){
  const bin=this.free.get(key);let mesh=bin?.pop();
  if(mesh){this.count--;this.reused++;}else{mesh=create();this.keys.set(mesh,key);this.created++;}
  this.active.add(mesh);mesh.visible=true;mesh.position.set(0,0,0);mesh.rotation.set(0,0,0);mesh.scale.set(1,1,1);return mesh;
 }
 release(mesh){
  const key=this.keys.get(mesh);if(key===undefined)return false;
  if(!this.active.has(mesh))return true;
  this.active.delete(mesh);mesh.removeFromParent();mesh.visible=false;
  if(this.count<this.limit){if(!this.free.has(key))this.free.set(key,[]);this.free.get(key).push(mesh);this.count++;}
  else{mesh.geometry?.dispose();mesh.material?.dispose();this.keys.delete(mesh);}
  return true;
 }
 dispose(){for(const bin of this.free.values())for(const mesh of bin){mesh.geometry?.dispose();mesh.material?.dispose();this.keys.delete(mesh);}this.free.clear();this.count=0;}
}
