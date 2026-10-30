const fs=require('node:fs'),match=require('../assets/contained-card-match.js');
const read=p=>JSON.parse(fs.readFileSync(p,'utf8'));
const products=read('data/all-cards.json').details,overrides=read('data/onepiece-card-overrides.json'),resolver=match.createResolver(products);
const rows=read('data/cards-by-set/OP17.json').cards.filter(c=>/^OP17-\d+(?:_p\d+)?$/.test(c.fullId)).map(card=>{
 const target={...card,brand:'onepiece',language:'ja',boxCode:'OP17'};
 return {...target,expectedId:String(overrides[card.fullId.toUpperCase()]),candidateIds:resolver.candidates(target).map(p=>String(p.id))};
});
fs.mkdirSync('.cache/price-link-audit',{recursive:true});
fs.writeFileSync('.cache/price-link-audit/calibration.json',JSON.stringify(rows));
