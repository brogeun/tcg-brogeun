import * as THREE from '../vendor/three.module.js';

// Render only on partner appearance changes. Reuse the field renderer; the HUD
// owns no WebGL context, and its temporary model is always released afterwards.
export class PartnerPortraits {
 constructor(renderer,resources){this.renderer=renderer;this.resources=resources;this.cache=new Map();this.pending=new Map();this.size=128;}
 image(id,shiny=false){
  const key=id+':'+Boolean(shiny);
  if(this.cache.has(key)){const image=this.cache.get(key);this.cache.delete(key);this.cache.set(key,image);return Promise.resolve(image);}
  if(this.pending.has(key))return this.pending.get(key);
  const job=this.render(id,shiny).then(image=>{this.cache.set(key,image);while(this.cache.size>24)this.cache.delete(this.cache.keys().next().value);return image;}).finally(()=>this.pending.delete(key));
  this.pending.set(key,job);return job;
 }
 async render(id,shiny){
  const model=await this.resources.create(id,{shiny,grounded:false});
  try{
   model.rotation.y=.24;model.updateMatrixWorld(true);
   const heads=[...model.userData.bones.entries()].filter(([name])=>/^head\d*$/i.test(name)).map(([,bone])=>bone);
   const bounds=new THREE.Box3();for(const head of heads)bounds.union(new THREE.Box3().setFromObject(head));
   if(bounds.isEmpty())bounds.setFromObject(model);
   const center=bounds.getCenter(new THREE.Vector3()),size=bounds.getSize(new THREE.Vector3());
   const span=Math.max(size.x,size.y,.05)*1.22,distance=Math.max(size.z,span)*3+2;
   const scene=new THREE.Scene(),camera=new THREE.OrthographicCamera(-span/2,span/2,span/2,-span/2,.01,distance*3);
   camera.position.set(center.x,center.y,center.z+distance);camera.lookAt(center);
   scene.add(model,new THREE.HemisphereLight(0xfff4e2,0x7299a0,2.8));
   const keyLight=new THREE.DirectionalLight(0xffffff,2.2);keyLight.position.copy(center).add(new THREE.Vector3(-3,5,7));scene.add(keyLight);
   this.target??=new THREE.WebGLRenderTarget(this.size,this.size);this.target.texture.colorSpace=THREE.SRGBColorSpace;
   const renderer=this.renderer,previous={target:renderer.getRenderTarget(),face:renderer.getActiveCubeFace(),mip:renderer.getActiveMipmapLevel(),viewport:renderer.getViewport(new THREE.Vector4()),scissor:renderer.getScissor(new THREE.Vector4()),scissorTest:renderer.getScissorTest(),clear:renderer.getClearColor(new THREE.Color()),alpha:renderer.getClearAlpha(),exposure:renderer.toneMappingExposure};
   const pixels=new Uint8Array(this.size*this.size*4);
   try{
    renderer.setRenderTarget(this.target);renderer.setViewport(0,0,this.size,this.size);renderer.setScissorTest(false);renderer.setClearColor(0x000000,0);renderer.toneMappingExposure=1.15;renderer.clear();renderer.render(scene,camera);renderer.readRenderTargetPixels(this.target,0,0,this.size,this.size,pixels);
   }finally{
    renderer.setRenderTarget(previous.target,previous.face,previous.mip);renderer.setViewport(previous.viewport);renderer.setScissor(previous.scissor);renderer.setScissorTest(previous.scissorTest);renderer.setClearColor(previous.clear,previous.alpha);renderer.toneMappingExposure=previous.exposure;
   }
   const canvas=document.createElement('canvas');canvas.width=canvas.height=this.size;const context=canvas.getContext('2d'),image=context.createImageData(this.size,this.size),stride=this.size*4;
   for(let y=0;y<this.size;y++)image.data.set(pixels.subarray(y*stride,(y+1)*stride),(this.size-y-1)*stride);
   context.putImageData(image,0,0);return canvas.toDataURL('image/png');
  }finally{model.userData.release();}
 }
}

export {ballArtwork} from './ball-visuals.mjs';
