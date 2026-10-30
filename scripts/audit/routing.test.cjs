const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict'),path=require('node:path');
const html=fs.readFileSync(path.resolve(__dirname,'../..','index.html'),'utf8');
for(const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi))if(!/\bsrc\s*=|application\/ld\+json/i.test(m[1])&&m[2].trim())new vm.Script(m[2]);
const cacheVersion=fs.readFileSync(path.resolve(__dirname,'../..','functions/api/card-grades.js'),'utf8').match(/[?&]v=(\d+)/)[1];
const routing=html.slice(html.indexOf('function parsePageRoute('),html.indexOf('// data-nav 클릭'));
assert(routing.includes('function go('));
function harness(){
 const names=['home','price','cardinfo','hub','portfolio','centering','admin','casing','apply','oripa','events','etc'];
 const pages=names.map(name=>{const classes=new Set();return{name,classes,classList:{add:v=>classes.add(v),remove:v=>classes.delete(v)}};});
 const location={hash:'#home',search:'?set=OP01&card=OP01-001'},input={value:''},search=[];
 const ctx={location,AUTH_READY:true,isAdminAccount:()=>false,URLSearchParams,Set,console,
  document:{body:{dataset:{page:'home'}},querySelectorAll:s=>s==='.page'?pages:[],querySelector:s=>{if(s==='.modal-overlay2.show')return null;const m=s.match(/^\.page\[data-page="([^"\\]*)"\]$/);assert(m,'selector must contain only a normalized route');return pages.find(p=>p.name===m[1]);},getElementById:id=>id==='cardSearchInput'?input:null},
  history:{pushState(a,b,hash){location.hash=hash;},replaceState(a,b,hash){location.hash=hash;}},
  initPrice:()=>Promise.resolve(),loadCardSearchData:async()=>{},searchCards:q=>[{id:q,listingCount:1}],renderPriceSearchAsGrid:(r,q)=>search.push({q,ids:r.map(x=>x.id)}),
  initHome2(){},refreshPortfolio(){},setTimeout(){},};
 ctx.window={scrollTo(){},PortfolioScreen:{cancelChart(){}}};vm.createContext(ctx);vm.runInContext(routing,ctx);ctx.window.addEventListener=(name,fn)=>{assert.equal(name,'popstate');ctx.pop=fn;};const ps=html.indexOf("window.addEventListener('popstate', e => {");vm.runInContext(html.slice(ps,html.indexOf('\n});',ps)+4),ctx);return{ctx,pages,search,input};
}
(async()=>{
 for(const [input,expected]of [['home','home'],['price','price'],['price/618442','price'],['portfolio','portfolio'],['cardinfo','cardinfo'],['does-not-exist','home'],['price/1/2','home'],['price/\" onclick=x','home'],['\"][x]','home'],['price?q=charizard','price'],['cardinfo?set=OP01','cardinfo']]){
  const h=harness();h.ctx.go(input);await Promise.resolve();await Promise.resolve();
  assert.equal(JSON.stringify(h.pages.filter(p=>p.classes.has('active')).map(p=>p.name)),JSON.stringify([expected]),input);
 }
 const h=harness();h.ctx.go('price?q=리자몽');await new Promise(setImmediate);assert.equal(h.input.value,'리자몽');assert.equal(h.search[0].q,'리자몽');
 const cancelled=harness();cancelled.ctx.go('price?q=old');cancelled.ctx.go('home');await new Promise(setImmediate);assert.equal(cancelled.search.length,0,'a departed route must not render late search results');
 const shared=harness();shared.ctx.go('cardinfo');assert.equal(shared.ctx.location.search,'?set=OP01&card=OP01-001');assert.equal(shared.ctx.location.hash,'#cardinfo');
 for(const [encoded,decoded] of [['%2B','+'],['+',''],['A%2BB','A+B'],['A+B','A B'],['%252B','%2B']]){const qh=harness();qh.ctx.go('price?q='+encoded);await new Promise(setImmediate);assert.equal(qh.ctx.parsePageRoute('price?q='+encoded).query,decoded);if(decoded)assert.equal(qh.input.value,decoded);}
 assert.equal(html.split('/api/card-grades?id=${productId}&v='+cacheVersion).length-1,2,'both grade requests must bypass old browser cache');
 for(const [hash,page] of [['#price/618442','price'],['#price?q=A%2BB','price'],['#cardinfo','cardinfo'],['#unknown','home'],['#price/1/2','home']]){const back=harness();back.ctx.location.hash=hash;back.ctx.pop({});await new Promise(setImmediate);assert.equal(back.ctx.document.body.dataset.page,page);assert.equal(back.ctx.location.search,'?set=OP01&card=OP01-001');assert.equal(back.pages.filter(p=>p.classes.has('active')).length,1);}
 console.log('PASS: inline syntax; known/unknown/malformed route normalization; query search; stale route search cancellation');
})().catch(e=>{console.error(e);process.exitCode=1;});
