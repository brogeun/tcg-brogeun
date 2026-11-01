'use strict';
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'../..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const fallback=require('../../assets/card-price-fallback.js'),bridge=require('../../assets/contained-card-prices.js');
const manifest=read('data/onepiece-official-manifest.json'),source=new Map();
for(const set of manifest.sets)for(const c of read('data/cards-by-set/'+(set.fileCode||set.code)+'.json').cards)if(c.officialId)source.set(c.officialId,{...c,brand:'onepiece',language:'ja',boxCode:set.code});
const rows=read('data/mercari-references.json').references,proofpath=path.join(root,'data/onepiece-reviewed-fallback-links.json');
const doc=JSON.parse(fs.readFileSync(proofpath,'utf8'));let saved=0;
for(const r of read('config/onepiece-mercari-artwork-reviews-20261101.json').reviews){
 const c=source.get(r.officialId),row=rows.find(x=>x.itemId===r.itemId);if(!c||!row)throw Error('Reviewed source/listing missing: '+r.officialId);
 const t=bridge.targetFor(c),key=fallback.targetKey(t);
 if(r.verification!=='human-original-image-review'||r.reviewStatus!=='verified-same-japanese-artwork-and-printed-number'||r.marketName!==row.title||r.marketImage!==row.imageUrl||r.sourceUrl!==row.sourceUrl||
   ![r.officialImage,r.canonicalOfficialImage].includes(c.image)||r.cardNumber!==t.fullNumber)throw Error('Reviewed metadata changed: '+r.officialId);
 const own=doc.bindings[key]||{};own.mercariItems=[...(own.mercariItems||[]).filter(x=>x.itemId!==r.itemId),r];doc.bindings[key]=own;
 const result=fallback.resolve({...t,snkrdunkStatus:'unlinked'},{mercariReferences:[row],bindings:doc.bindings});
 if(result.status!=='candidate'||result.source!=='mercari'||result.valuationEligible!==false)throw Error('Reviewed reference not consumed: '+r.officialId);
 saved++;
}
fs.writeFileSync(proofpath,JSON.stringify(doc)+'\n');
const auditpath=path.join(root,'data/onepiece-market-link-audit-20261101.json'),audit=JSON.parse(fs.readFileSync(auditpath,'utf8'));audit.manualMercariBindings=saved;audit.mercariTrackedReferences=rows.length;fs.writeFileSync(auditpath,JSON.stringify(audit)+'\n');
console.log(JSON.stringify({verifiedPromoReferences:saved,trackedReferences:rows.length,automaticValuationsAdded:0}));
