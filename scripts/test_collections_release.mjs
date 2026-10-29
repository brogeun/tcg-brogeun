import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const argument=process.argv.indexOf('--bundle-dir');
const bundle=argument<0?null:path.resolve(root,process.argv[argument+1]||'_deploy');
const keyPattern=/^cp1_[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function read(base,name){return fs.readFileSync(path.join(base,name),'utf8');}
function json(base,name){return JSON.parse(read(base,name));}
function validate(base){
  const catalog=json(base,'data/collections/catalog.json');
  assert.equal(catalog.schemaVersion,1);assert.match(catalog.version,/^[A-Za-z0-9_.-]{1,120}$/);
  const manifest=json(base,'data/collections/manifest.json');
  assert.equal(manifest.schemaVersion,1);assert.equal(manifest.version,catalog.version);
  assert.equal(manifest.readOnly===true,catalog.readOnly===true);
  const sandbox={module:{exports:{}},exports:{}};
  vm.runInNewContext(read(base,'assets/collection-catalog-codec.js'),sandbox);
  const {decodeShard}=sandbox.module.exports;assert.equal(typeof decodeShard,'function');
  const cards=new Map(),byShard={},baseline={};
  for(const [shard,url] of Object.entries(catalog.shards)){
    assert.match(url,/^\/data\/collections\/cards\/(?:pokemon|onepiece)-(?:ja|en|zh-CN)\.json$/);
    const decoded=decodeShard(json(base,url.slice(1)));assert.equal(decoded.version,catalog.version);
    byShard[shard]=decoded.cards.length;baseline[shard]=0;
    for(const card of decoded.cards){
      assert.match(card.id,keyPattern);assert.ok(!cards.has(card.id),'Duplicate printing key '+card.id);
      assert.equal(card.game+'-'+card.language,shard);assert.equal(typeof card.sourceKey,'string');assert.ok(card.sourceKey);
      assert.ok(card.image==null||typeof card.image==='string');
      assert.ok(Array.isArray(card.artistIds));assert.ok(Array.isArray(card.characterIds));
      cards.set(card.id,card);if(!card.sourceOnly)baseline[shard]++;
    }
  }
  assert.equal(cards.size,catalog.coverage.registryCards);
  assert.deepEqual(baseline,catalog.coverage.baselineByShard);
  assert.ok(Object.values(baseline).reduce((a,b)=>a+b,0)>=62242,'Baseline cards were dropped');
  const keys=new Set();
  for(const nibble of '0123456789abcdef'){
    const shard=json(base,`data/collections/keys/${nibble}.json`);assert.equal(shard.version,catalog.version);
    for(const [key,record] of Object.entries(shard.cards)){
      assert.equal(key[4],nibble);assert.ok(!keys.has(key));keys.add(key);
      const card=cards.get(key);assert.ok(card,'Registry key has no public card '+key);
      assert.equal(record.sourceKey,card.sourceKey);assert.equal(record.game,card.game);assert.equal(record.language,card.language);
      assert.equal(record.marketVerified===true,card.marketVerified===true);
      if(record.marketVerified)assert.match(String(record.marketId),/^\d+$/);
    }
  }
  assert.equal(keys.size,cards.size);
  const artists=new Map(catalog.artists.map(a=>[a.id,a])),characters=new Map(catalog.characters.map(c=>[c.id,c]));
  assert.equal(artists.size,catalog.artists.length);assert.equal(characters.size,catalog.characters.length);
  assert.equal(catalog.featuredArtists.length,8);
  for(const id of catalog.featuredArtists){const a=artists.get(id);assert.ok(a?.knownFor);assert.ok(a.coverCardId&&cards.has(a.coverCardId));assert.ok(a.cardIds.includes(a.coverCardId));}
  for(const group of [...artists.values(),...characters.values()]){
    assert.ok(Array.isArray(group.cardIds));assert.equal(new Set(group.cardIds).size,group.cardIds.length);
    for(const key of group.cardIds){const card=cards.get(key);assert.ok(card,'Group points to absent card '+key);assert.equal(card.game,group.game);}
  }
  for(const group of characters.values())for(const key of group.cardIds)assert.ok(!cards.get(key).sourceOnly,'Source candidate double-counted as character target');
  assert.equal([...characters.values()].filter(c=>c.game==='pokemon'&&c.dexId).length,1025);
  for(const dexId of [15,212]){const c=characters.get('pokemon:species:'+dexId);assert.ok(c&&c.cardIds.length);assert.ok(c.familyIds?.length&&c.megaCardIds?.length,'Missing Beedrill/Scizor scope');}
  const html=read(base,'index.html');
  for(const asset of ['card-rarity-filters.js','card-rarity-filters.css','collection-catalog-codec.js','collections.js','collections.css'])assert.ok(html.includes('/assets/'+asset),'Unlinked '+asset);
  assert.ok(html.indexOf('/assets/card-rarity-filters.js')<html.indexOf('/assets/japanese-catalog.js'));
  assert.ok(html.indexOf('/assets/collection-catalog-codec.js')<html.indexOf('/assets/collections.js'));
  const required=['functions/_shared/collections.js','functions/api/collections/index.js','functions/api/collections/[id].js','functions/api/collections/[id]/items.js','functions/api/collection-ownership.js','functions/api/auth/delete-account.js'];
  for(const name of required)assert.ok(fs.statSync(path.join(base,name)).size,'Missing deployed endpoint '+name);
  for(const table of ['collections','collection_mutations','user_card_states'])assert.ok(read(base,'functions/api/auth/delete-account.js').includes("'"+table+"'"));
  assert.ok(read(base,'sw.js').includes("url.pathname.startsWith('/api/')"),'Private API cache boundary missing');
  return {version:catalog.version,registryCards:cards.size,baselineCards:Object.values(baseline).reduce((a,b)=>a+b,0),artistLabels:artists.size,characters:characters.size,shards:byShard};
}
const source=validate(root);let built=null;if(bundle)built=validate(bundle);
if(built)assert.deepEqual(built,source,'Bundle and source catalogue disagree');
const tests=['scripts/tests/test_collections_api.mjs','scripts/test_card_rarity_filters.cjs','scripts/test_box_rarity_adapters.cjs',...fs.readdirSync(path.join(root,'scripts')).filter(n=>/^test_collections_(?!release).*\.(?:mjs|cjs)$/.test(n)).map(n=>'scripts/'+n)];
const child=spawnSync(process.execPath,['--test',...tests],{cwd:root,stdio:'inherit',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
assert.equal(child.status,0,'Collection regression checks failed');
console.log(JSON.stringify({ok:true,source,bundleChecked:!!bundle,privateApisNeverCached:true,scope:'Collection tab only; original box rarity panels tested separately.'}));
