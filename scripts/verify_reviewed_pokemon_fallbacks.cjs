'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..')),read=f=>JSON.parse(fs.readFileSync(path.join(root,f),'utf8'));
const fallback=require(path.join(root,'assets/card-price-fallback.js')),bridge=require(path.join(root,'assets/contained-card-prices.js'));
const doc=read('data/pokemon-reviewed-fallback-links.json'),rows=fallback.decodeYuyu(read('data/yuyutei-market/pokemon.json'));
assert.equal(doc.source,'pokemon-original-image-audit');assert.equal(doc.schemaVersion,1);
const files=new Map(fs.readdirSync(path.join(root,'data/cards-by-set')).filter(f=>f.endsWith('.json')).map(f=>[f.slice(0,-5).toUpperCase(),f])),sets=new Map();let checked=0,stale=0;
for(const [key,binding]of Object.entries(doc.bindings)){
 const code=key.split(':')[1];if(!sets.has(code)){const file=files.get(code);assert(file,'Unknown source set '+code);sets.set(code,read('data/cards-by-set/'+file).cards.map(c=>bridge.targetFor({...c,brand:'pokemon',boxCode:code,setCode:c.setCode||code,language:'ja'})));}
 const target=sets.get(code).find(t=>fallback.targetKey(t)===key);assert(target,'Source card no longer exists: '+key);assert.equal(binding.verification,'original-image-and-acquisition');
 const q=fallback.resolve({...target,snkrdunkStatus:'unlinked'},{yuyuRows:rows,bindings:doc.bindings});assert.equal(q.status,'priced',key);assert.equal(q.source,'yuyutei');assert.equal(q.verification,'exact_printing');assert.equal(q.currency,'JPY');assert(q.sourceUrl.startsWith('https://yuyu-tei.jp/sell/poc/card/'));
 if(q.stale)stale++;checked++;
}
console.log(JSON.stringify({checked,staleSnapshots:stale,invalid:0,livePricesVerified:false}));
