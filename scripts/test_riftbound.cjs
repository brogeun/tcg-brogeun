const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const ctx={window:{},document:{getElementById(){return{}},addEventListener(){}},renderCardInfo(){},CI_TAB:'pokemon',location:{search:'',hash:''},URLSearchParams};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'assets/riftbound-catalog.js'),'utf8'),ctx);
const api=ctx.window.RiftboundCatalog,raw=JSON.parse(fs.readFileSync(path.join(root,'data/riftbound-catalog.json'),'utf8'));
const data=api.prepare(structuredClone(raw)),cards=data.sets.flatMap(s=>s.cards);
assert.equal(cards.length,raw.cardCount);assert.equal(new Set(cards.map(c=>c.id)).size,cards.length);
for(const c of cards){assert.equal(c.language,'en');assert.equal(c.brand,'riftbound');assert.match(c.image,/^https:\/\/(cmsassets\.rgpub\.io|cdn\.sanity\.io)\//);assert(!c.ability.includes('<p>'));assert(!Object.hasOwn(c,'price'));assert(!Object.hasOwn(c,'psa10'));}
const en=api.matching(cards,'Ahri'),ko=api.matching(cards,'아리');
assert(en.length>0);assert.deepEqual(en.map(c=>c.id),ko.map(c=>c.id));
const c=en[0];assert.equal(api.href(c.setCode,c.id),'/?set='+c.setCode+'&card='+c.id+'#cardinfo');
assert.equal(api.matching(cards,'없는카드검색어').length,0);
assert(api.matching(cards,c.number).some(x=>x.id===c.id));
assert.throws(()=>api.prepare({...raw,language:'ja'}));
assert.throws(()=>api.prepare({...raw,cardCount:0}));
const bad=structuredClone(raw);bad.sets[0].cards[0].setCode='M6';assert.throws(()=>api.prepare(bad));
console.log(`PASS: ${cards.length} English cards, unique variant IDs, Korean champion aliases, safe image hosts, no fabricated prices, detail routes and schema rejection`);
