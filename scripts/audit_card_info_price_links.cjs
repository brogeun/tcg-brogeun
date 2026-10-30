'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(__dirname,'..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const match=require('../assets/contained-card-match.js'),bridge=require('../assets/contained-card-prices.js'),fallback=require('../assets/card-price-fallback.js'),repairs=require('../assets/card-catalog-repairs.js');
repairs.configure(read('data/card-catalog-repairs.json'));
const all=bridge.mergeSetProducts(repairs.products(read('data/all-cards.json').details),read('data/onepiece-eb05-market.json').products).filter(p=>!match.foreign(p)),byId=new Map(all.map(p=>[String(p.id),p])),overrides=read('data/onepiece-card-overrides.json'),details=read('data/cards-detail.json');
const html=fs.readFileSync(path.join(root,'index.html'),'utf8'),context=vm.createContext({});
vm.runInContext(html.slice(html.indexOf('const CARDINFO = {'),html.indexOf('let CI_TAB',html.indexOf('const CARDINFO = {'))),context);
const visible=vm.runInContext('CARDINFO',context),visibleKeys=new Set(Object.entries(visible).flatMap(([brand,sets])=>sets.map(s=>brand+':'+s.code.toUpperCase())));
const artworkFile='data/contained-card-market-links.json',artwork=fs.existsSync(path.join(root,artworkFile))?read(artworkFile):{schemaVersion:1,links:[]};
const totals={},sets=[],unresolved=[],matched=[];
for(const file of fs.readdirSync(path.join(root,'data/cards-by-set')).filter(f=>f.endsWith('.json'))){
 const code=file.slice(0,-5),raw=read('data/cards-by-set/'+file),brand=raw.brand||(/^(?:(?:OP|EB|PRB|ST)\d|OPCD)/.test(code)?'onepiece':'pokemon'),body=repairs.setCards(raw,code);
 const identities=body.cards.map(card=>({...card,brand,language:'ja',boxCode:code,setCode:card.setCode||code}));
 const targets=identities.map(bridge.targetFor),links={...(code==='EB05'?bridge.reviewedSetLinks(targets,all,raw.cards,match):{}),...bridge.reviewedLinks(targets,all,overrides,match),...repairs.verifiedLinks(targets,all),...(bridge.reviewedArtworkLinks?.(targets,all,artwork,match)||{})},resolve=match.createResolver(all,links);
 const summary={brand,code,visible:visibleKeys.has(brand+':'+code.toUpperCase()),cards:targets.length,status:{},priced:0};
 for(const target of targets){
  const result=resolve(target);summary.status[result.status]=(summary.status[result.status]||0)+1;
  if(result.status==='matched'){
   const product=byId.get(String(result.id)),quote=fallback.resolve({...target,snkrdunkId:String(result.id),snkrProduct:bridge.withRawDetail(product,details)});
   if(quote.status==='priced'&&quote.source==='snkrdunk')summary.priced++;
   matched.push({brand,boxCode:code,fullId:target.fullId||target.number,id:String(result.id),status:quote.status});
  }else{
   const candidates=resolve.candidates(target);
   unresolved.push({...target,visible:summary.visible,matchStatus:result.status,candidateIds:candidates.map(p=>String(p.id)),pricedCandidateIds:candidates.filter(p=>p.minPrice>0||p.catalogAsk?.amount>0||p.grades?.raw?.lowest_ask>0).map(p=>String(p.id))});
  }
 }
 sets.push(summary);const t=totals[brand]||={sets:0,cards:0,matched:0,priced:0,unresolvedWithCandidates:0,unresolvedWithPricedCandidates:0};t.sets++;t.cards+=summary.cards;t.matched+=summary.status.matched||0;t.priced+=summary.priced;
 if(sets.length%25===0)console.log(JSON.stringify({phase:'identity',sets:sets.length}));
}
for(const row of unresolved){if(row.candidateIds.length)totals[row.brand].unresolvedWithCandidates++;if(row.pricedCandidateIds.length)totals[row.brand].unresolvedWithPricedCandidates++;}
const destination=process.argv[2]||'.cache/price-link-audit/baseline';fs.mkdirSync(path.join(root,destination),{recursive:true});
const visibleTotals={};for(const s of sets.filter(s=>s.visible)){const t=visibleTotals[s.brand]||={sets:0,cards:0,matched:0,priced:0};t.sets++;t.cards+=s.cards;t.matched+=s.status.matched||0;t.priced+=s.priced;}
for(const [name,value]of Object.entries({summary:{sourceCommit:process.env.GITHUB_SHA||null,totals,visibleTotals,sets},unresolved,matched,products:all}))fs.writeFileSync(path.join(root,destination,name+'.json'),JSON.stringify(value));
fs.writeFileSync(path.join(root,'.cache/price-link-audit/visible-unresolved.json'),JSON.stringify(unresolved.filter(r=>r.visible)));
console.log(JSON.stringify({totals,visibleTotals}));
