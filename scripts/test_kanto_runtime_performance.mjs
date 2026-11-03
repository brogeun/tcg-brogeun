import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as THREE from '../games/kanto151/vendor/three.module.js';
import {PokemonResources,appearancePaths} from '../games/kanto151/src/pokemon.mjs';
import {actorAnimationDelta} from '../games/kanto151/src/animation-cadence.mjs';
import {EffectPool} from '../games/kanto151/src/effect-pool.mjs';

const fixtureInfo={id:1,model:'model.json',animationFiles:['animation.json'],texture:'normal.png',shinyTexture:'shiny.png',layers:[{texture:{frames:['common.png','normal-overlay.png'],fps:8}}],shinyLayers:[{texture:{frames:['common.png','shiny-overlay.png'],fps:8}}],clips:{idle:'idle',walk:'walk',battle:'idle'}};
const model={'minecraft:geometry':[{description:{texture_width:64,texture_height:64},bones:[{name:'root',pivot:[0,0,0],cubes:[{origin:[0,0,0],size:[16,16,16],uv:[0,0]}]}]}]};
const animation={animations:{idle:{loop:true,animation_length:1,bones:{}},walk:{loop:true,animation_length:1,bones:{root:{rotation:[0,'math.sin(q.anim_time*360)',0]}}}}};
function resources({deferShiny=false,failShiny=false,maxSpecies=24}={}){
 const calls=[],pending=[],jsonCalls=[];
 class Loader{loadAsync(url){calls.push(url);if(url.includes('shiny')&&failShiny)return Promise.reject(Error('texture unavailable'));const texture=new THREE.Texture();texture.userData.url=url;if(deferShiny&&url.includes('shiny'))return new Promise(resolve=>pending.push(()=>resolve(texture)));return Promise.resolve(texture);}}
 const api=new PokemonResources({...THREE,TextureLoader:Loader},[fixtureInfo],'https://assets.example/',{maxSpecies});
 api.json=async path=>{jsonCalls.push(path);return path==='model.json'?model:animation;};
 return {api,calls,pending,jsonCalls};
}

test('normal preparation excludes shiny textures and loads only the selected overlay frames',async()=>{
 const {api,calls}=resources();
 assert.deepEqual(appearancePaths(fixtureInfo),['normal.png','common.png','normal-overlay.png']);
 await api.load(1);assert.deepEqual(calls.map(x=>x.split('/').at(-1)).sort(),['common.png','normal-overlay.png','normal.png'].sort());
 await api.load(1,{shiny:true});assert.equal(calls.length,5);assert.equal(calls.filter(x=>x.endsWith('common.png')).length,1);
 api.dispose();
});

test('creating a shiny actor first does not download its normal-only appearance',async()=>{
 const {api,calls}=resources(),instance=await api.create(1,{shiny:true});
 assert.equal(instance.userData.shiny,true);assert.ok(!calls.some(x=>x.endsWith('/normal.png')||x.endsWith('/normal-overlay.png')));assert.ok(calls.some(x=>x.endsWith('/shiny.png')));instance.userData.release();api.dispose();
});

test('simultaneous forms share the species core and each common texture request',async()=>{
 const {api,calls,jsonCalls}=resources();
 await Promise.all([api.load(1),api.load(1,{shiny:true}),api.load(1,{shiny:true})]);
 assert.equal(jsonCalls.filter(x=>x==='model.json').length,1);assert.equal(calls.length,5);assert.equal(api.requests.size,0);assert.equal(api.cache.get(1).textureRequests.size,0);api.dispose();
});

test('a late shiny request cannot replace the latest normal selection',async()=>{
 const {api,pending}=resources({deferShiny:true}),instance=await api.create(1);
 const before=instance.userData.materials[0].map;
 const shiny=instance.userData.setShiny(true);
 assert.equal(instance.userData.shiny,false,'keep the displayed form until its textures are ready');
 assert.equal(await instance.userData.setShiny(false),true);
 pending.splice(0).forEach(resolve=>resolve());
 assert.equal(await shiny,false);assert.equal(instance.userData.shiny,false);assert.equal(instance.userData.materials[0].map,before);
 instance.userData.release();api.dispose();
});

test('closing a preview during a pending form change releases its textures after loading',async()=>{
 const {api,pending}=resources({deferShiny:true,maxSpecies:0}),instance=await api.create(1),record=api.cache.get(1);
 const changing=instance.userData.setShiny(true);instance.userData.release();
 assert.equal(record.refs,0);assert.ok(api.cache.has(1),'pending resources must not be destroyed while loading');
 pending.splice(0).forEach(resolve=>resolve());assert.equal(await changing,false);assert.equal(api.cache.size,0);
});

test('a failed lazy form keeps the previous material and can be retried',async()=>{
 const {api}=resources({failShiny:true}),instance=await api.create(1),material=instance.userData.materials[0],before=material.map;
 await assert.rejects(instance.userData.setShiny(true),/texture unavailable/);assert.equal(material.map,before);assert.equal(instance.userData.shiny,false);assert.equal(api.cache.get(1).textureRequests.size,0);instance.userData.release();api.dispose();
});

function sampleActor(distance,{visible=true,target=false,angry=false}={}){
 const actor={model:{position:{x:distance,y:0,z:0}},angry},game={player:{model:{position:{x:0,y:0,z:0}}},world:{actorVisible:()=>visible}};
 if(target)game.target=actor;return {actor,game};
}
function runSamples(fixture,frames=120){let calls=0,elapsed=0;for(let n=0;n<frames;n++){const dt=actorAnimationDelta(fixture.game,fixture.actor,1/60);if(dt){calls++;elapsed+=dt;}}return {calls,elapsed};}
test('visual sampling drops at distance while elapsed animation time remains continuous',()=>{
 const near=runSamples(sampleActor(8)),far=runSamples(sampleActor(30)),hidden=runSamples(sampleActor(50,{visible:false}));
 assert.equal(near.calls,120);assert.ok(far.calls>=28&&far.calls<=32);assert.ok(hidden.calls>=9&&hidden.calls<=12);
 assert.ok(Math.abs(near.elapsed-2)<1e-8);assert.ok(far.elapsed>1.9);assert.ok(hidden.elapsed>1.8);
});
test('targeted or fighting actors and the player stay at the simulation rate',()=>{
 assert.equal(runSamples(sampleActor(40,{target:true})).calls,120);assert.equal(runSamples(sampleActor(40,{angry:true})).calls,120);
 const a=sampleActor(80,{visible:false});a.game.player=a.actor;assert.equal(runSamples(a).calls,120);
});
test('a newly revealed actor immediately catches up rather than waiting for the offscreen interval',()=>{
 let visible=false;const a=sampleActor(50,{visible:false});a.game.world.actorVisible=()=>visible;
 assert.equal(actorAnimationDelta(a.game,a.actor,1/60),1/60);assert.equal(actorAnimationDelta(a.game,a.actor,1/60),0);visible=true;assert.equal(actorAnimationDelta(a.game,a.actor,1/60),2/60);
});

function worldFixture(){
 const source=readFileSync(new URL('../games/kanto151/src/world.mjs',import.meta.url),'utf8').replace(/^import .*;\r?$/gm,'').replace(/^export \{THREE\};\r?$/gm,'').replace(/^export /gm,'').replaceAll('import.meta.url',JSON.stringify(new URL('../games/kanto151/src/world.mjs',import.meta.url).href));
 const World=new Function('THREE','EffectPool',source+'\nreturn World;')(THREE,EffectPool);
 const world=Object.create(World.prototype);Object.assign(world,{effects:new THREE.Group(),particles:[],rings:[],beams:[]});return world;
}
test('actual world effects reuse independent meshes, materials, geometry and velocity arrays',()=>{
 const world=worldFixture(),p=new THREE.Vector3(1,2,3);world.burst(p,0xff0000,12,1);const first=world.particles.pop(),g=first.mesh.geometry,m=first.mesh.material,velocities=first.v;
 world.releaseEffect(first.mesh);world.burst(p,0x00ff00,12,2);const second=world.particles.pop();assert.equal(second.mesh,first.mesh);assert.equal(second.mesh.geometry,g);assert.equal(second.mesh.material,m);assert.equal(second.v,velocities);assert.equal(m.color.getHex(),0x00ff00);assert.equal(m.size,.24);assert.ok([...g.attributes.position.array].every(x=>x===0));world.clearEffects();
});
test('straight beam reuse scales a unit cylinder to the new endpoints',()=>{
 const world=worldFixture(),a=new THREE.Vector3(0,0,0),b=new THREE.Vector3(0,5,0);const first=world.beam(a,b,0xff0000,.2);world.beams=[];world.releaseEffect(first);
 const next=world.beam(a,new THREE.Vector3(4,0,0),0x0000ff,.3);assert.equal(first,next);assert.deepEqual(next.scale.toArray(),[.3,4,.3]);next.updateMatrixWorld(true);assert.ok(new THREE.Vector3(0,.5,0).applyMatrix4(next.matrixWorld).distanceTo(new THREE.Vector3(4,0,0))<1e-8);world.clearEffects();
});
test('effect pool stays bounded and clearing a region disposes all retained effects',()=>{
 const pool=new EffectPool(1);let disposed=0;
 const create=()=>{const m=new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial());m.geometry.addEventListener('dispose',()=>disposed++);return m;};
 const a=pool.acquire('a',create),b=pool.acquire('b',create);pool.release(a);pool.release(a);assert.equal(pool.count,1);pool.release(b);assert.equal(disposed,1);pool.dispose();assert.equal(disposed,2);assert.equal(pool.count,0);
 const world=worldFixture();world.ring(new THREE.Vector3(),0xff0000);world.burst(new THREE.Vector3(),0xffffff,3);world.clearEffects();assert.equal(world.effects.children.length,0);assert.equal(world.effectPool.count,0);assert.equal(world.particles.length,0);assert.equal(world.rings.length,0);
});
