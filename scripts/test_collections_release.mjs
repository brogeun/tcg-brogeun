import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const argument=process.argv.indexOf('--bundle-dir');
const bundle=argument<0?null:path.resolve(root,process.argv[argument+1]||'_deploy');
const keyPattern=/^cp1_[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function stableCardKey(card){
  const namespace=Buffer.from('a7872361e8205f5ebf177c918bd12f94','hex');
  const bytes=createHash('sha1').update(namespace).update(card.game+'\0'+card.language+'\0'+card.sourceKey).digest().subarray(0,16);
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const hex=bytes.toString('hex');return 'cp1_'+hex.slice(0,8)+'-'+hex.slice(8,12)+'-'+hex.slice(12,16)+'-'+hex.slice(16,20)+'-'+hex.slice(20);
}
function booleanFlags(record){for(const flag of ['sourceOnly','marketVerified','characterDiscoveryVerified','retired'])if(Object.hasOwn(record,flag))assert.equal(typeof record[flag],'boolean','Invalid '+flag+' flag');}
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
      assert.equal(card.id,stableCardKey(card),'Printing key identity changed');booleanFlags(card);
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
    const shardName=`data/collections/keys/${nibble}.json`,raw=read(base,shardName);const shard=JSON.parse(raw);assert.equal(shard.version,catalog.version);
    assert.equal(createHash('sha256').update(raw).digest('hex'),manifest.registryShardSha256[nibble],'Registry manifest checksum differs');
    for(const [key,record] of Object.entries(shard.cards)){
      booleanFlags(record);assert.equal(key[4],nibble);assert.ok(!keys.has(key));keys.add(key);
      const card=cards.get(key);assert.ok(card,'Registry key has no public card '+key);
      assert.equal(record.sourceKey,card.sourceKey);assert.equal(record.game,card.game);assert.equal(record.language,card.language);
      assert.equal(record.marketVerified===true,card.marketVerified===true);
      assert.equal(record.sourceOnly===true,card.sourceOnly===true,'Source-only registry boundary mismatch');
      assert.equal(record.characterDiscoveryVerified===true,card.characterDiscoveryVerified===true,'Verified character supplement boundary mismatch');
      if(record.marketVerified)assert.match(String(record.marketId),/^\d+$/);
    }
  }
  assert.equal(keys.size,cards.size);assert.equal(manifest.registryCards,cards.size);
  const artists=new Map(catalog.artists.map(a=>[a.id,a])),characters=new Map(catalog.characters.map(c=>[c.id,c]));
  assert.equal(artists.size,catalog.artists.length);assert.equal(characters.size,catalog.characters.length);
  assert.equal(catalog.featuredArtists.length,8);
  for(const id of catalog.featuredArtists){const a=artists.get(id);assert.ok(a?.knownFor);assert.ok(a.coverCardId&&cards.has(a.coverCardId));assert.ok(a.cardIds.includes(a.coverCardId));assert.ok(cards.get(a.coverCardId).artistIds.includes(a.id),'Featured credit and artwork mismatch');}
  for(const group of [...artists.values(),...characters.values()]){
    assert.ok(Array.isArray(group.cardIds));assert.equal(new Set(group.cardIds).size,group.cardIds.length);
    for(const key of group.cardIds){const card=cards.get(key);assert.ok(card,'Group points to absent card '+key);assert.equal(card.game,group.game);assert.ok((artists.has(group.id)?card.artistIds:card.characterIds).includes(group.id),'Nonreciprocal group membership '+group.id+' '+key);}
  }
  for(const group of characters.values())for(const key of group.cardIds){const card=cards.get(key);assert.ok(!card.sourceOnly||card.characterDiscoveryVerified===true,'Unresolved source candidate double-counted as character target');if(group.game==='onepiece')assert.ok(['Leader','Character'].includes(card.cardType),'Event/Stage or unverified type entered character targets');}
  assert.deepEqual([...characters.values()].filter(c=>c.game==='pokemon'&&c.dexId).map(c=>c.dexId).sort((a,b)=>a-b),Array.from({length:1025},(_,i)=>i+1),'Pokemon species missing or duplicated');
  for(const dexId of [15,212]){const c=characters.get('pokemon:species:'+dexId);assert.ok(c&&c.cardIds.length);assert.ok(c.familyIds?.length&&c.megaCardIds?.length,'Missing Beedrill/Scizor scope');}
  for(const id of catalog.featuredCharacters){const c=characters.get(id);assert.ok(c?.coverCardId&&c.cardIds.includes(c.coverCardId),'Featured character artwork missing');assert.equal(c.coverCard.id,c.coverCardId);assert.equal(c.coverCard.image,c.coverImage);assert.ok(c.coverImage.startsWith('/images/collections/'),'Featured character artwork must be available locally');}
  const supplements=json(base,'data/collections/sources/official-collection-supplements.json');
  for(const entry of supplements.characterPrintings){
    const card=[...cards.values()].find(c=>c.sourceKey===entry.sourceKey&&c.game==='onepiece'&&c.language==='ja');
    assert.ok(card&&card.sourceOnly===true&&card.characterDiscoveryVerified===true,'Official character printing missing');
    assert.equal(card.marketVerified,false);assert.equal(card.cardType,'Character');assert.equal(card.imageSourceUrl||card.image,entry.sourceImageUrl);
    assert.ok(card.artistIds.includes(entry.artistId));
    assert.ok(card.characterIds.length&&card.characterIds.every(id=>characters.get(id)?.cardIds.includes(card.id)));
  }
  assert.equal(supplements.characterPrintings.length,3);
  for(const entry of supplements.imageOverrides||[]){assert.equal(createHash('sha256').update(fs.readFileSync(path.join(base,entry.path.slice(1)))).digest('hex'),entry.sha256,'Verified artwork asset missing or changed');}
  const audit=json(base,'data/collections/sources/official-shinji-audit.json');assert.equal(audit.version,catalog.version);
  assert.equal(audit.included,43);assert.equal(audit.rows.length,43);assert.deepEqual(audit.missing,[]);
  assert.deepEqual(audit.rows.map(r=>r.officialId).sort(),supplements.pokemonArtistCards.map(r=>r.officialId).sort());
  for(const row of audit.rows){const card=cards.get(row.targetCardId);assert.ok(card?.artistIds.includes('pokemon:Shinji Kanda'));assert.ok(artists.get('pokemon:Shinji Kanda')?.cardIds.includes(row.targetCardId));}
  for(const sourceKey of ['JP:S10P:001/067','JP:S10P:068/067','JP:CP4:002/131','JP:SV2a:015/165','JP:CP6:007/087','JP:VS:061/141']){const card=[...cards.values()].find(c=>c.sourceKey===sourceKey&&c.game==='pokemon'&&c.language==='ja');assert.ok(card?.characterIds.includes('pokemon:species:15'),'Vendor annotation dropped a Beedrill printing '+sourceKey);}
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
const classifier=spawnSync(process.platform==='win32'?'python':'python3',['scripts/test_collection_catalog.py'],{cwd:root,stdio:'inherit',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
assert.equal(classifier.status,0,'Actual vendor card-name classification checks failed');
const tests=['scripts/tests/test_collections_api.mjs','scripts/test_card_rarity_filters.cjs','scripts/test_box_rarity_adapters.cjs',...fs.readdirSync(path.join(root,'scripts')).filter(n=>/^test_collections_(?!release).*\.(?:mjs|cjs)$/.test(n)).map(n=>'scripts/'+n)];
const child=spawnSync(process.execPath,['--test',...tests],{cwd:root,stdio:'inherit',env:{...process.env,PYTHONIOENCODING:'utf-8'}});
assert.equal(child.status,0,'Collection regression checks failed');
console.log(JSON.stringify({ok:true,source,bundleChecked:!!bundle,privateApisNeverCached:true,scope:'Collection tab only; original box rarity panels tested separately.'}));
