import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../games/kanto151/vendor/three.module.js';
import {PokemonResources, estimatedResourceBytes} from '../games/kanto151/src/pokemon.mjs';

function fixture(id,{width=16,height=16,refs=0,used=id,geometry,texture}={}){
  geometry??=new THREE.BufferGeometry();
  if(!geometry.attributes.position)geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,0,0,1,0,0,0,1,0],3));
  texture??=new THREE.Texture({width,height});texture.generateMipmaps=false;
  const disposed={geometry:0,texture:0};
  geometry.addEventListener('dispose',()=>disposed.geometry++);texture.addEventListener('dispose',()=>disposed.texture++);
  const record={id,geometry:{bones:[{geometry}]},textures:new Map([['normal',texture]]),textureRequests:new Map(),refs,used};
  return {record,geometry,texture,disposed};
}
const resources=options=>new PokemonResources(THREE,[],'https://example.test/',options);

test('one oversized unused texture is evicted even below the species-count limit',()=>{
  const api=resources(),item=fixture(1,{width:4096,height:4096});api.cache.set(1,item.record);
  assert.equal(api.cache.size,1);assert(api.stats().estimatedBytes>32*1024*1024);
  api.evict();assert.equal(api.cache.size,0);assert.deepEqual(item.disposed,{geometry:1,texture:1});
});

test('the byte budget evicts the least-recent unused species and retains newer models',()=>{
  const api=resources({maxBytes:2200}),items=[fixture(1),fixture(2),fixture(3)];
  for(const item of items)api.cache.set(item.record.id,item.record);
  api.evict();assert.deepEqual([...api.cache.keys()],[2,3]);assert(api.stats().estimatedBytes<=2200);
  assert.equal(items[0].disposed.texture,1);assert.equal(items[1].disposed.texture,0);assert.equal(items[2].disposed.texture,0);
  api.dispose();assert.equal(items[1].disposed.texture,1);assert.equal(items[2].disposed.texture,1);
});

test('an active model can exceed the estimate budget until its last lease is released',()=>{
  const api=resources(),active=fixture(1,{width:4096,height:4096,refs:2}),idle=fixture(2);
  api.cache.set(1,active.record);api.cache.set(2,idle.record);api.evict();
  assert.deepEqual([...api.cache.keys()],[1]);assert.equal(active.disposed.texture,0);
  assert(api.stats().activeEstimatedBytes>api.stats().maxEstimatedBytes);
  active.record.refs--;api.evict();assert.equal(active.disposed.geometry,0);
  active.record.refs--;api.evict();assert.equal(api.cache.size,0);assert.deepEqual(active.disposed,{geometry:1,texture:1});
  api.evict();assert.deepEqual(active.disposed,{geometry:1,texture:1},'repeated eviction cannot double-dispose');
});

test('in-flight species cores and appearance textures are protected from eviction',()=>{
  const api=resources({maxBytes:0}),core=fixture(1),appearance=fixture(2);
  api.cache.set(1,core.record);api.cache.set(2,appearance.record);
  api.requests.set(1,Promise.resolve());appearance.record.textureRequests.set('shiny',Promise.resolve());api.evict();
  assert.equal(api.cache.size,2);assert.equal(core.disposed.geometry,0);assert.equal(appearance.disposed.texture,0);
  api.requests.clear();appearance.record.textureRequests.clear();api.evict();assert.equal(api.cache.size,0);
});

test('shared geometry, attribute storage and textures are estimated once and kept while retained',()=>{
  const first=fixture(1),second=fixture(2,{geometry:first.geometry,texture:first.texture,refs:1});
  first.record.geometry.bones.push({geometry:first.geometry});first.record.textures.set('overlay',first.texture);
  const single=estimatedResourceBytes([first.record]);
  assert.equal(estimatedResourceBytes([first.record,second.record]),single);
  const api=resources({maxBytes:0});api.cache.set(1,first.record);api.cache.set(2,second.record);api.evict();
  assert.deepEqual([...api.cache.keys()],[2]);assert.deepEqual(first.disposed,{geometry:0,texture:0});
  second.record.refs=0;api.evict();assert.deepEqual(first.disposed,{geometry:1,texture:1});
  assert.deepEqual(second.disposed,{geometry:1,texture:1});
});

test('interleaved attributes and generated mipmaps use one bounded estimate',()=>{
  const item=fixture(1),interleaved=new THREE.InterleavedBuffer(new Float32Array(18),6);
  item.geometry.setAttribute('position',new THREE.InterleavedBufferAttribute(interleaved,3,0));
  item.geometry.setAttribute('normal',new THREE.InterleavedBufferAttribute(interleaved,3,3));
  item.texture.generateMipmaps=true;
  assert.equal(estimatedResourceBytes([item.record]),72+Math.ceil(16*16*4*4/3));
});
