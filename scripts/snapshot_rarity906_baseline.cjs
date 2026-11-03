/* Capture the bounded unresolved scope before applying the next review. */
const fs=require('node:fs'),path=require('node:path'),zlib=require('node:zlib'),crypto=require('node:crypto');
const root=path.join(__dirname,'..'),dir='data/collections/sources/',R=require('../assets/card-rarity-filters.js');
const read=f=>JSON.parse(fs.readFileSync(path.join(root,f))),archive=f=>JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(root,dir,f))));
const output=path.join(root,dir,'rarity906-baseline-20261104.json');
if(fs.existsSync(output))throw Error('The baseline is immutable; do not regenerate after applying the review.');
(async()=>{
  const targets=fs.readdirSync(path.join(root,dir)).filter(f=>/^rarity-crossdb-20261101-(ja|en)-\d+\.json.gz$/.test(f)).flatMap(f=>archive(f).rows);
  targets.push(...archive('rarity-crossdb-20261101-cn-ws-0000.json.gz').rows[0].proposals.filter(r=>r.language==='zh-CN').map(r=>({...r,sourceUrl:r.sourceFields.sourceUrl})));
  const jp=new Map(read('data/japanese-catalog.json').sets.map(s=>[s.code.toUpperCase(),s])),rows=[],counts={'documented-unprinted':9};
  const fetchImpl=async url=>({ok:true,json:async()=>read(url.split('?')[0].replace(/^\//,''))});
  for(const row of targets){
    const set=jp.get(row.setCode.toUpperCase()),file=row.language==='ja'?'data/cards-by-set/'+(set.fileCode||set.code)+'.json':row.language==='en'?'data/english-sets/'+row.setCode+'.json':'data/chinese-sets/'+row.setCode+'.json';
    const cards=read(file).cards.filter(c=>(c.url||c.sourceUrl)===row.sourceUrl);if(cards.length!==1)throw Error(row.sourceUrl);
    const card=cards[0],brand=row.language==='ja'?'pokemon':row.language==='en'?'pokemon-en':'pokemon-cn';
    const result=(await R.enrich([card],{brand,setCode:row.setCode,fetchImpl}))[0],state=R.metadata(result).state;
    counts[state]=(counts[state]||0)+1;
    if(['source-unlisted','unknown','reference-conflict'].includes(state))rows.push({language:row.language,setCode:row.setCode,sourceUrl:row.sourceUrl,name:card.name,number:card.number,previousState:state,rawFile:file,rawFileSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,file))).digest('hex'),...(card.sourceId?{sourceId:card.sourceId}:{}),...(card.id?{cardId:card.id}:{}),...(card.variant?{variant:card.variant}:{})});
  }
  if(rows.length!==906||Object.values(counts).reduce((a,b)=>a+b,0)!==3381)throw Error(JSON.stringify(counts));
  fs.writeFileSync(output,JSON.stringify({schemaVersion:1,reviewId:'rarity906-baseline-20261104',baselineCommit:'b0e54cce5e680d8310206beb74fd57646b81cf89',originalScope:3381,remaining:906,counts,rows})+'\n');
  console.log(JSON.stringify({remaining:rows.length,counts}));
})();
