'use strict';
// Verify the deployed identities and conditional source selection without writing public data.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert/strict');
const root=path.resolve(__dirname,'../..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const fallback=require('../../assets/card-price-fallback.js'),bridge=require('../../assets/contained-card-prices.js');
const base='https://tcghub.kr',bust=process.env.GITHUB_SHA||Date.now().toString();
async function json(p){const u=new URL(p,base);u.searchParams.set('artworkAudit',bust);const r=await fetch(u,{cache:'no-store',signal:AbortSignal.timeout(25000)});assert(r.ok,p+' HTTP '+r.status);return r.json();}
async function main(){
 const [search,bindings,refs,fx]=await Promise.all(['/data/onepiece-official-search.json','/data/onepiece-reviewed-fallback-links.json','/data/mercari-references.json','/data/fx-rates.json'].map(json));
 const report=read('data/onepiece-market-link-audit-20261101.json'),proofs=read('data/onepiece-reviewed-promo-links.json').links.filter(r=>r.auditRun==='20261101-recovery'),byId=new Map(search.cards.map(c=>[c.officialId,c]));
 assert.equal(search.cards.length,report.officialCards);assert.equal(search.linkedProducts,report.linkedAfter);
 for(const r of proofs)assert.equal(byId.get(r.officialId)?.productId,r.id,'Deployed exact identity '+r.officialId);
 for(const r of report.blockedPreviousLinks)assert.equal(byId.get(r.officialId)?.productId,null,'Deployed disproved printing remains blocked '+r.officialId);
 const response=await fetch(base+'/assets/card-price-fallback.js?artworkAudit='+bust,{cache:'no-store',signal:AbortSignal.timeout(25000)});assert(response.ok);const deployed=await response.text(),expected=fs.readFileSync(path.join(root,'assets/card-price-fallback.js'),'utf8');
 assert.equal(crypto.createHash('sha256').update(deployed).digest('hex'),crypto.createHash('sha256').update(expected).digest('hex'),'Deployed runtime is the verified runtime');
 const html=await (await fetch(base+'/?artworkAudit='+bust,{cache:'no-store'})).text();assert(html.includes('/assets/card-price-fallback.js?v=20261101-artwork-review1'),'Updated runtime version is referenced by the page');
 const deployedSw=await (await fetch(base+'/sw.js?artworkAudit='+bust,{cache:'no-store'})).text();assert.equal(deployedSw,fs.readFileSync(path.join(root,'sw.js'),'utf8'),'Current release cache routing deployed');
 const outcomes=[];
 for(const r of read('config/onepiece-mercari-artwork-reviews-20261101.json').reviews){
  const c=byId.get(r.officialId);assert(c);const t={...bridge.targetFor(c),snkrdunkStatus:c.matchStatus};
  const q=await fallback.lookup(t,{fetchJson:json});assert.equal(q.source,'mercari',r.officialId);assert.equal(q.status,'candidate');assert.equal(q.valuationEligible,false);assert.equal(q.verification,'exact_printing');
  const h=fallback.render(q,{convert:(amount,currency)=>amount*fx.rates[currency]});assert.match(h,/₩/);assert.doesNotMatch(h,/\$|¥|JPY|USD/);assert.match(h,/평가액 제외/);
  outcomes.push({officialId:r.officialId,source:q.source,sourceCurrency:q.currency,displayCurrency:'KRW',priceKind:q.priceKind,saleStatus:q.saleStatus,valuationEligible:q.valuationEligible,observedAt:q.observedAt});
 }
 const result={status:'passed',officialArtworks:search.cards.length,linkedProducts:search.linkedProducts,checkedRecoveryLinks:proofs.length,blockedWrongLinks:report.blockedPreviousLinks.length,shopBindings:Object.values(bindings.bindings).filter(r=>r.yuyuteiId).length,mercariReferences:refs.references.length,promoPriceChecks:outcomes,fxAsOf:fx.asOf};
 fs.mkdirSync(path.join(root,'.cache'),{recursive:true});fs.writeFileSync(path.join(root,'.cache/onepiece-production-check.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
}
main().catch(error=>{console.error(error.stack);process.exitCode=1;});
