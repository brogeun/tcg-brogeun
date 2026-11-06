const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const {assetGraph}=require('./helpers/app_asset_graph.cjs');
const root=path.resolve(__dirname,'..'),read=p=>fs.readFileSync(path.join(root,p),'utf8');
const context={window:{addEventListener(){}},document:{getElementById(){return null},addEventListener(){}},renderCardInfo(){},location:{search:'',hash:''},URLSearchParams,Date,Map,Set,console};
vm.createContext(context);vm.runInContext(read('assets/korean-promos.js'),context);
const api=context.window.KoreanPromos,manifest=api.prepare(JSON.parse(read('data/korean-promos.json')));
const partial={...manifest,refresh:{status:'partial',completed_product_ids:manifest.cards.filter(c=>!['893073','998016'].includes(c.id)).map(c=>c.id),failed_product_ids:['893073','998016'],completed_at:'2026-11-06T07:26:01+09:00'}};
assert.match(api.freshness(partial),/5\/7종 갱신/);
assert.match(api.freshness(partial),/이전 자료 유지/);
assert.match(api.productFreshness(manifest.cards.find(c=>c.id==='893073'),partial),/이전 자료 유지/);
assert.match(api.productFreshness(manifest.cards.find(c=>c.id==='1096144'),partial),/수집 확인/);
assert.match(api.freshness({...partial,refreshHealth:{status:'failed'}}),/5\/7종 갱신/);
assert.equal(api.gradeKey('BRG 10 영문'),'BRG 10');
assert.equal(api.gradeKey('BRG 10 한글'),'BRG 10');
assert.equal(api.gradeKey('BRG 8 영문'),'BRG 8');
assert.equal(api.variantLabel('BRG 10'),'라벨 미표기');
assert.equal(api.variantLabel('BRG 10 영문'),'영문 라벨');
assert.equal(api.variantLabel('BRG 10 한글'),'한글 라벨');
assert.equal(api.variantLabel('Ungraded A (Pack Ver.)'),'팩');
assert.deepEqual(Array.from(api.gradeOptions(['BRG 9 영문','BRG 10 한글','BRG 10 영문','BRG 8 영문','PSA 10','Ungraded A'])) ,['Ungraded A','PSA 10','BRG 10','BRG 9','BRG 8']);
let total=0;
for(const card of manifest.cards){
 const h=api.prepareHistory(JSON.parse(read(card.file.slice(1))),card.id);total+=h.rows.length;
 for(const option of Object.keys(h.counts_by_exact_option)){
  const rows=api.selectRows(h.rows,option,0),days=api.daily(rows);
  assert.equal(days.reduce((n,d)=>n+d.count,0),h.counts_by_exact_option[option]);
  assert(rows.every(r=>r.option===option));assert(days.every(d=>d.min<=d.median&&d.median<=d.max));
 }
 assert(fs.existsSync(path.join(root,card.image.slice(1))));
}
assert.equal(total,manifest.collected_trade_count);
assert(api.match(manifest.cards.find(c=>c.id==='893073'),'성수 잉어킹'));
const base={date:'2026-10-31',option:'A',price_krw:10};
assert.equal(api.daily([base,base,{...base,price_krw:30}])[0].median,10);
assert.equal(api.selectRows([base,{...base,date:'2026-09-01'}],'A',30,'2026-11-01').length,1);
assert.equal(api.selectRows([base],'B',0).length,0);
assert.throws(()=>api.prepareHistory({...JSON.parse(read('data/korean-promos/1096144.json')),id:'937107'},'1096144'));
const html=read('index.html'),sw=read('sw.js');
assetGraph(root,{html}).assertOrder('collections.js','korean-promos.js','cardinfo');
assert.match(sw,/url\.pathname\.startsWith\('\/data\/korean-promos'\)/);
console.log(JSON.stringify({ok:true,cards:7,trades:total,exactOptions:true,dailyVolumes:true,latestFirst:true}));
