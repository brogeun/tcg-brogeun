import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import vm from 'node:vm';
const root = new URL('../../',import.meta.url);
const apiSource=readFileSync(new URL('functions/api/card-grades.js',root),'utf8');
const api=await import('data:text/javascript;base64,'+Buffer.from(apiSource).toString('base64'));
const original=readFileSync(new URL('index.html',root),'utf8');
const start=original.indexOf('async function renderGradesPanel(');
const panelSource=original.slice(start,original.indexOf('\n}\n',start)+3);
globalThis.caches={default:{match:async()=>null,put:async()=>{}}};
async function upstream(html){
 globalThis.fetch=async url=>String(url).includes('/apparels/')?new Response(html,{status:200}):new Response('{"usedListings":[]}',{status:200,headers:{'Content-Type':'application/json'}});
 return (await api.onRequestGet({request:new Request('https://tcghub.kr/api/card-grades?id=12345')})).json();
}
function panel(live,{failure=false,history=[]}={}){
 const elements=new Map();
 for(const key of ['gradesGrid','gradesPanelHeader','detailMainPrice','detailOrigPrice','detailAddPortfolio'])
  elements.set(key+'-12345',{innerHTML:'',textContent:'',style:{},dataset:{},querySelectorAll:()=>[]});
 const context=vm.createContext({console,Date,Number,Math,document:{getElementById:id=>elements.get(id)},
  fmtKrw:(v,c)=>c+':'+v,fmtOrig:(v,c)=>c+':'+v,
  loadCardsDetail:async()=>({cards:{'12345':{grades:{psa10:{lowest_ask:123456,currency:'JPY',active_count:3},raw:{lowest_ask:4000,currency:'JPY',active_count:4}}}}}),
  fetch:async url=>{
   if(url.startsWith('/api/card-grades')){if(failure)throw new Error('offline');return {ok:true,json:async()=>live};}
   if(url.startsWith('/data/history/'))return {ok:true,json:async()=>({history})};
   return {ok:false};
  }});
 vm.runInContext(panelSource,context);
 return context.renderGradesPanel('12345').then(()=>elements);
}
test('explicit no-listing conditions are retained alongside the available raw quote',async()=>{
 const live=await upstream('{"conditionId":18,"usedMinPrice":5000}{"conditionId":22,"hasListing":false}{"conditionId":23,"hasListing":false}');
 assert.equal(live.grades.raw.lowest_ask,5000);assert.deepEqual(live.noListingGrades,['psa10','psa9']);
});
test('all explicitly unavailable grades return availability evidence without extra listings requests',async()=>{
 const live=await upstream('{"conditionId":18,"hasListing":false}{"conditionId":22,"hasListing":false}{"conditionId":23,"hasListing":false}');
 assert.deepEqual(live.grades,{});assert.deepEqual(live.noListingGrades,['raw','psa10','psa9']);
});
test('a missing or partially parsed condition is never declared unavailable',async()=>{
 const live=await upstream('{"conditionId":18,"usedMinPrice":5000}{"conditionId":22}');
 assert.deepEqual(live.noListingGrades,[]);
});
test('contradictory listing absence and positive price never clear a saved quote',async()=>{
 const live=await upstream('{"conditionId":18,"usedMinPrice":5000}{"conditionId":22,"hasListing":false,"usedMinPrice":7000}');
 assert.equal(live.noListingGrades,undefined);
});
test('confirmed absent PSA10 clears the old quote, resists history refill, and selects current raw price',async()=>{
 const live={ok:true,grades:{raw:{lowest_ask:5000,currency:'JPY'}},noListingGrades:['psa10']};
 const elements=await panel(live,{history:[{date:'2026-10-25',psa10_price:88888,psa9_price:1234}]});
 assert.equal(elements.get('detailMainPrice-12345').textContent,'JPY:5000');
 assert.equal(elements.get('detailAddPortfolio-12345').dataset.grade,'raw');
 const html=elements.get('gradesGrid-12345').innerHTML;
 assert.ok(html.includes('현재 출품 없음'));assert.ok(!html.includes('123456'));assert.ok(!html.includes('88888'));
});
test('a failed live request preserves the saved quote instead of declaring no listings',async()=>{
 const elements=await panel(null,{failure:true});
 assert.equal(elements.get('detailMainPrice-12345').textContent,'JPY:123456');
 assert.ok(!elements.get('gradesGrid-12345').innerHTML.includes('현재 출품 없음'));
});
