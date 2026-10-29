'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const prices=require('../assets/card-price-fallback.js');
const root=path.resolve(__dirname,'..'),dataRoot=path.join(root,'data','tcg-card-info')+path.sep;
const manifest=JSON.parse(fs.readFileSync(path.join(root,'data/tcg-card-info.json'),'utf8'));
const supported=new Set(['JPY','USD','KRW']),positive=x=>typeof x==='number'&&Number.isFinite(x)&&x>0;
let cards=0,expected=0,matched=0;const failures=[],seen=new Set();
function originalHasQuote(p){
 const r=p.grades?.raw;
 if(r&&supported.has(r.currency)&&positive(r.lowest_ask)&&r.availability!=='no-listing'&&r.active_count!==0)return true;
 if(p.listingCount===0||p.priceStatus==='no-listings')return false;
 if(p.catalogAsk?.kind==='lowest_listing_ask'&&supported.has(p.catalogAsk.currency)&&positive(p.catalogAsk.amount))return true;
 return supported.has(p.currency)&&positive(p.minPrice)&&!['unverified','invalid','error'].includes(p.priceStatus);
}
for(const game of manifest.games){
 if(game.id==='nikke')continue;
 for(const set of game.sets){
  const queue=[set.file],visited=new Set();
  while(queue.length){
   const url=queue.shift();assert(!visited.has(url),'Repeated catalogue part');visited.add(url);
   const file=path.resolve(root,url.replace(/^\//,''));assert(file.startsWith(dataRoot),'Unsafe catalogue file');
   const part=JSON.parse(fs.readFileSync(file,'utf8'));
   for(const card of part.cards){
    const key=game.id+':'+card.id;assert(!seen.has(key),'Duplicate canonical source card '+key);seen.add(key);cards++;
    const p=card.snkrProduct;if(!originalHasQuote(p))continue;expected++;
    const target={...card,grade:'raw',fullNumber:card.fullCardNumber,snkrdunkId:String(card.snkrdunkId),catalogSource:'SNKRDUNK'};
    const quote=prices.resolve(target);
    if(quote.status==='priced'&&quote.source==='snkrdunk')matched++;
    else if(failures.length<20)failures.push({game:game.id,id:card.id,number:card.fullCardNumber,status:quote.status,source:quote.source});
   }
   queue.push(...(part.shards||[]));
  }
 }
}
console.log(JSON.stringify({cards,expectedSnkrQuotes:expected,selectedSnkrQuotes:matched,failures}));
assert(cards>0&&expected>0,'Catalogue contains no current source prices');
assert.equal(matched,expected,'A known SNKR quote disappeared or incorrectly triggered fallback');
