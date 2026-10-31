'use strict';
const fs=require('fs'),path=require('path');
const root=path.resolve(__dirname,'..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const match=require('../assets/contained-card-match.js'),bridge=require('../assets/contained-card-prices.js'),repairs=require('../assets/card-catalog-repairs.js');
repairs.configure(read('data/card-catalog-repairs.json'));
const manifest=read('data/onepiece-official-manifest.json'),overrides=read('data/onepiece-card-overrides.json'),bindings=read('data/contained-card-market-links.json');
bindings.links.push(...read('data/onepiece-reviewed-promo-links.json').links);
const products=bridge.mergeSetProducts(repairs.products(read('data/all-cards.json').details),read('data/onepiece-eb05-market.json').products);
const cards=[];let linked=0;
const categoryLabel={promotion:'프로모 프로모션',limited_product:'한정상품 프리미엄',starter:'스타트덱',family_deck:'패밀리 덱',booster:'부스터',extra_booster:'엑스트라 부스터',premium_booster:'프리미엄 부스터'};
function acquisitionLabel(s){const a=[];for(const[pattern,label]of[[/フラッグシップ/,'플래그십 flagship'],[/チャンピオンシップ/,'챔피언십 championship'],[/スタンダードバトル/,'스탠다드 배틀 standard battle'],[/優勝/,'우승 winner'],[/ベスト8/,'베스트8 top8'],[/参加/,'참가'],[/プレミアムカードコレクション/,'프리미엄 카드 컬렉션'],[/ジャンプ/,'점프 잡지 부록'],[/キャンペーン/,'캠페인 배포'],[/周年/,'주년 anniversary']])if(pattern.test(s||''))a.push(label);return a.join(' ');}
for(const set of manifest.sets){
 const source=read('data/cards-by-set/'+(set.fileCode||set.code)+'.json'),targets=source.cards.map(c=>bridge.targetFor({...c,brand:'onepiece',language:'ja',boxCode:set.code}));
 const links={...bridge.reviewedLinks(targets,products,overrides,match),...repairs.verifiedLinks(targets,products),...bridge.reviewedArtworkLinks(targets,products,bindings,match),...bridge.reviewedSetLinks(targets,products,source.cards,match)};
 const resolve=match.createResolver(products,links);
 for(let i=0;i<source.cards.length;i++){
  const c=source.cards[i];if(!c.officialId)continue;
  const result=resolve(targets[i]),id=result.status==='matched'?String(result.id):null;
  if(id)linked++;
  cards.push({id:'JP:ONEPIECE:'+c.officialId,officialId:c.officialId,fullId:c.fullId,number:c.number,baseNumber:c.baseNumber,
   setCode:c.setCode,boxCode:set.code,brand:'onepiece',kind:'card',language:'ja',name:c.name,nameKo:c.nameKo||'',rarity:c.rarity,
   image:c.localImage||(c.image.startsWith('https://www.onepiece-cardgame.com/images/cardlist/card/')?'/api/img?u='+encodeURIComponent(c.image):c.image),officialImage:c.officialImage||c.image,sourceImage:c.image,sourceUrl:c.sourceUrl,acquisition:c.acquisition,sourceCategory:set.category,
   categoryLabel:categoryLabel[set.category],acquisitionLabel:acquisitionLabel(c.acquisition),productId:id,
   matchStatus:result.status,marketProductId:id,cardType:c.cardType,versionLabel:c.versionLabel||''});
 }
}
if(new Set(cards.map(c=>c.id)).size!==cards.length)throw Error('Duplicate official artwork');
if(cards.length!==manifest.officialCards)throw Error('Official search coverage mismatch');
const report={schemaVersion:1,generatedAt:manifest.generatedAt,officialCards:cards.length,linkedProducts:linked,cards};
fs.writeFileSync(path.join(root,'data/onepiece-official-search.json'),JSON.stringify(report));
console.log(JSON.stringify({officialSearchCards:cards.length,linkedProducts:linked,unresolved:cards.length-linked}));
