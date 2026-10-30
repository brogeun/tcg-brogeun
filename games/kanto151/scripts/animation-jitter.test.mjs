import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import * as THREE from '../vendor/three.module.js';
import {PokemonResources,compileGeometry,compileAnimations} from '../src/pokemon.mjs';
import {moveWildToward} from '../src/wild-roaming.mjs';

const assetRoot=process.env.KANTO151_ASSET_ROOT||fileURLToPath(new URL('../assets/cobblemon/',import.meta.url));
const read=path=>JSON.parse(readFileSync(resolve(assetRoot,path),'utf8'));
const manifest=JSON.parse(readFileSync(new URL('../data/pokemon-manifest.json',import.meta.url),'utf8'));
async function modelFor(id){
 const info=manifest.find(p=>p.id===id),animations={};
 for(const path of info.animationFiles)Object.assign(animations,read(path).animations);
 const resources=new PokemonResources(THREE,manifest,'');
 const textures=new Map([info.texture,info.shinyTexture,...(info.layers||[]).flatMap(l=>l.texture?.frames||[]),...(info.shinyLayers||[]).flatMap(l=>l.texture?.frames||[])].filter(Boolean).map(path=>[path,new THREE.Texture()]));
 const record={id,info,geometry:compileGeometry(THREE,read(info.model)),animations:compileAnimations(animations),textures,refs:0,used:0};
 resources.load=async()=>record;resources.cache.set(id,record);
 return resources.create(id,{maxDimension:5.5});
}
const pose=model=>new Map([...model.userData.bones].map(([name,b])=>[name,{q:b.quaternion.clone(),p:b.position.clone()}]));
const delta=(a,b)=>Math.max(...[...a].map(([name,v])=>v.q.angleTo(b.get(name).q)));

test('Machop and Charmeleon do not snap between walk and rest at a stationary animation time',async()=>{
 for(const id of [5,66]){
  const model=await modelFor(id);
  model.userData.update(0,{time:.37,moving:false});
  let before=pose(model),worst=0;
  for(let i=0;i<60;i++){
   model.userData.update(1/60,{time:.37,moving:i%2===0});
   const after=pose(model);worst=Math.max(worst,delta(before,after));before=after;
  }
  console.log(JSON.stringify({id,worstPoseStepDegrees:worst*180/Math.PI}));
  assert(worst>.001,'gait changes were frozen instead of blended');
  assert(worst<.15,`${id} pose snaps ${worst*180/Math.PI} degrees per frame`);
  model.userData.release();
 }
});

test('native locomotion continues moving and a held gait settles to its authored pose',async()=>{
 for(const id of [5,66]){
  const actual=await modelFor(id),reference=await modelFor(id);
  actual.position.set(7,2,11);actual.rotation.y=.7;
  actual.userData.update(0,{time:.37,moving:false});
  for(let i=0;i<30;i++)actual.userData.update(1/60,{time:.37,moving:true});
  reference.userData.update(0,{time:.37,moving:true});
  assert(delta(pose(actual),pose(reference))<1e-6,'walk did not settle');
  const before=pose(actual);actual.userData.update(.1,{time:.47,moving:true});
  assert(delta(before,pose(actual))>.001,'authored walking was frozen');
  assert.deepEqual(actual.position.toArray(),[7,2,11]);assert.equal(actual.rotation.y,.7);
  actual.userData.release();reference.userData.release();
 }
});

test('pursuit turns through the shortest arc without instant heading flips',()=>{
 const actor={id:66,hp:10,model:{position:new THREE.Vector3(),rotation:{y:Math.PI-.05}}};
 const game={wild:[actor],world:{height:()=>0,collision:(x,z)=>[x,z]}};
 const before=actor.model.rotation.y;
 moveWildToward(game,actor,{x:-3,z:-1},1/60);
 const change=Math.abs(Math.atan2(Math.sin(actor.model.rotation.y-before),Math.cos(actor.model.rotation.y-before)));
 assert(change<=.12,`pursuit snapped ${change} radians`);
 assert(actor.moving);assert(actor.model.position.length()>0);
});
