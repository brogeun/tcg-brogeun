'use strict';
const fs=require('fs'),path=require('path'),assert=require('node:assert/strict'),cp=require('child_process');
const root=path.resolve(__dirname,'../..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8')),write=(p,v)=>fs.writeFileSync(path.join(root,p),JSON.stringify(v)+'\n');
const bridge=require('../../assets/contained-card-prices.js'),match=require('../../assets/contained-card-match.js');
const input=read('.cache/onepiece-audit/input.json'),sources=new Map(input.sources.map(s=>[s.officialId,s]));
const proposals=read('data/onepiece-artwork-review-candidates-20261101.json'),approved=read('config/onepiece-artwork-visual-reviews-20261101.json'),doc=read('data/onepiece-reviewed-promo-links.json'),audit=read('data/onepiece-market-link-audit-20261101.json'),before=read('data/onepiece-official-search.json');
const keys=new Set(),productIds=new Set(),accepted=[];
for(const review of approved.reviews){
 const p=proposals.proposals.find(p=>p.officialId===review.officialId&&p.id===review.id),s=sources.get(review.officialId);assert(p&&s,'Missing proposal/source');
 assert.equal(review.reviewedBy,'assistant-vision');assert.equal(review.method,'visual-original-image-and-acquisition-review');assert.equal(review.reviewStatus,'verified-same-japanese-artwork-and-acquisition');
 for(const field of ['sourceSHA256','marketSHA256','comparedSourceSHA256']){assert.match(review[field],/^[a-f0-9]{64}$/);assert.equal(review[field],p[field]);}
 assert.equal(p.acquisition,s.card.acquisition);assert.equal(p.image,s.target.image);
 const product=s.candidates.find(c=>String(c.id)===p.id);assert(product,'Missing current market product');
 assert.equal(product.name,p.marketName);assert.equal(product.productNumber,p.marketProductNumber);assert.equal(product.thumbnailUrl,p.marketImage);
 const key=match.artworkKey(s.target);assert(!keys.has(key)&&!productIds.has(p.id),'Duplicate reviewed printing');keys.add(key);productIds.add(p.id);
 const conflicting=before.cards.filter(c=>String(c.productId)===p.id&&c.officialId!==p.officialId);assert.equal(conflicting.length,0,'Existing printing collision');
 const proof={...p,...review,auditRun:'20261101-recovery',evidenceId:p.officialId+'|'+p.id};
 const links=bridge.reviewedArtworkLinks([s.target],[product],{schemaVersion:1,links:[proof]},match),result=match.createResolver([product],links)(s.target);assert.equal(result.status,'matched');assert.equal(result.id,p.id);
 accepted.push(proof);
}
for(const p of accepted){doc.links=doc.links.filter(r=>r.officialId!==p.officialId);doc.links.push(p);const r=audit.cards.find(r=>r.officialId===p.officialId);assert(r);Object.assign(r,{accepted:true,reason:'visual-original-image-and-acquisition-confirmed',productId:p.id,evidence:p.imageEvidence,acquisitionEvidence:p.acquisitionEvidence,reviewedBy:p.reviewedBy});const proposal=proposals.proposals.find(r=>r.officialId===p.officialId);proposal.reviewStatus=p.reviewStatus;proposal.reviewedBy=p.reviewedBy;}
write('data/onepiece-reviewed-promo-links.json',doc);write('data/onepiece-artwork-review-candidates-20261101.json',proposals);
cp.execFileSync(process.execPath,['scripts/build_onepiece_search.cjs'],{cwd:root,stdio:'inherit'});
const search=read('data/onepiece-official-search.json'),byOfficial=new Map(search.cards.map(c=>[c.officialId,c]));
for(const p of accepted)assert.equal(byOfficial.get(p.officialId).productId,p.id);
const recovery=doc.links.filter(p=>p.auditRun==='20261101-recovery');audit.automaticConfirmed=recovery.filter(p=>p.method==='registered-original-image-and-acquisition').length;audit.visualConfirmed=recovery.filter(p=>p.method==='visual-original-image-and-acquisition-review').length;audit.additionalConfirmed=recovery.length;audit.linkedAfter=search.linkedProducts;audit.remaining=search.cards.length-search.linkedProducts;
audit.reasonCounts={};for(const r of audit.cards)audit.reasonCounts[r.reason]=(audit.reasonCounts[r.reason]||0)+1;
audit.visualReview={reviewedBy:'assistant-vision',automaticSample:57,shopSample:16,blockedPreviousArtworks:20,additionalArtworks:accepted.length,mercariArtworks:4,observedSampleMismatches:0,reviewedAt:'2026-11-01',scope:'Original illustration, Japanese printed number, frame and independently checked acquisition. No physical condition or authenticity assessment; sampled automatic links are not an exhaustive visual review.'};
audit.humanReviewSheets={...audit.humanReviewSheets,status:'completed-assistant-visual-review',reviewedBy:'assistant-vision'};
audit.coverageByBox={};for(const c of search.cards){const k=c.boxCode||c.setCode;const x=audit.coverageByBox[k]||{official:0,linked:0};x.official++;if(c.productId)x.linked++;audit.coverageByBox[k]=x;}
assert.equal(audit.linkedAfter,audit.previouslyLinked+audit.additionalConfirmed-audit.blockedPreviousLinks.length);
write('data/onepiece-market-link-audit-20261101.json',audit);
console.log(JSON.stringify({official:search.cards.length,previous:audit.previouslyLinked,automatic:audit.automaticConfirmed,visual:audit.visualConfirmed,newLinks:audit.additionalConfirmed,blocked:audit.blockedPreviousLinks.length,linked:audit.linkedAfter,remaining:audit.remaining,coverage:audit.coverageByBox,reasons:audit.reasonCounts}));
