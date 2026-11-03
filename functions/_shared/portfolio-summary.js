// Public quote records may be reused; private holdings and totals are never
// retained in module state, Cache Storage, or a public response.
const SHARDS=16,MAX_JSON_BYTES=1024*1024;
const FIELDS=['isBox','psa10','psa10Currency','psa9','psa9Currency','raw','rawCurrency','box','boxCurrency'];
export function quoteBucket(id){let hash=2166136261;for(const c of String(id)){hash^=c.charCodeAt(0);hash=Math.imul(hash,16777619);}return (hash>>>0)%SHARDS;}
export function validateManifest(value){
  if(value?.schemaVersion!==1||value.kind!=='portfolio-quotes'||!(/^[a-f0-9]{64}$/).test(value.sourceHash||'')||value.shardCount!==SHARDS
    ||!Number.isSafeInteger(value.rowCount)||value.rowCount<1||JSON.stringify(value.fields)!==JSON.stringify(FIELDS)
    ||!Array.isArray(value.shards)||value.shards.length!==SHARDS||new Set(value.shards.map(part=>part.bucket)).size!==SHARDS
    ||!value.shards.every(part=>Number.isInteger(part.bucket)&&part.bucket>=0&&part.bucket<SHARDS&&Number.isSafeInteger(part.rowCount)&&part.rowCount>=0
      &&new RegExp('^/data/portfolio-quotes/part-'+part.bucket.toString(16).padStart(2,'0')+'-[a-f0-9]{20}\\.json$').test(part.file))
    ||value.shards.reduce((n,part)=>n+part.rowCount,0)!==value.rowCount
    ||!['JPY','USD','CNY'].every(key=>typeof value.fx?.rates?.[key]==='number'&&Number.isFinite(value.fx.rates[key])&&value.fx.rates[key]>0)
    ||!/^\d{4}-\d{2}-\d{2}$/.test(value.fx?.asOf||'')||value.fx.basis!=='previous-business-day-close')throw Error('Invalid portfolio quote manifest');
  return value;
}
function abortable(promise,signal){
  if(!signal)return Promise.resolve(promise);
  if(signal.aborted)return Promise.reject(Error('Portfolio summary deadline exceeded'));
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(Error('Portfolio summary deadline exceeded'));};
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
async function readJSON(assets,origin,pathname,signal){
  if(signal?.aborted)throw Error('Portfolio summary deadline exceeded');
  const response=await abortable(assets.fetch(new Request(new URL(pathname,origin),{signal,headers:{Accept:'application/json','Cache-Control':'no-cache'}})),signal);
  if(!response.ok)throw Error('Portfolio quote asset unavailable');
  if(!/\bapplication\/json\b/i.test(response.headers.get('content-type')||''))throw Error('Portfolio quote JSON required');
  const length=Number(response.headers.get('content-length'));
  if(length>MAX_JSON_BYTES)throw Error('Portfolio quote asset exceeds budget');
  let bytes=0;const chunks=[],reader=response.body?.getReader();
  if(!reader)throw Error('Portfolio quote asset body missing');
  try{
    for(;;){const {value,done}=await abortable(reader.read(),signal);if(done)break;bytes+=value.byteLength;if(bytes>MAX_JSON_BYTES)throw Error('Portfolio quote asset exceeds budget');chunks.push(value);}
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  const body=new Uint8Array(bytes);let offset=0;for(const chunk of chunks){body.set(chunk,offset);offset+=chunk.byteLength;}
  return JSON.parse(new TextDecoder().decode(body));
}
function validateQuote(value){
  return Array.isArray(value)&&value.length===FIELDS.length&&typeof value[0]==='boolean'
    &&[1,3,5,7].every(index=>value[index]==null||((typeof value[index]==='number'||typeof value[index]==='string')&&Number.isFinite(Number(value[index]))))
    &&[2,4,6,8].every(index=>value[index]==null||typeof value[index]==='string');
}
export async function loadHoldingQuotes({assets,origin,holdings,signal}){
  if(!assets?.fetch)throw Error('Public asset binding unavailable');
  const manifest=validateManifest(await readJSON(assets,origin,'/data/portfolio-quotes.json',signal));
  const ids=new Set(holdings.map(row=>String(row.card_id))),buckets=[...new Set([...ids].map(quoteBucket))],quotes=new Map(),idsByBucket=new Map();let next=0;
  for(const id of ids){const n=quoteBucket(id);if(!idsByBucket.has(n))idsByBucket.set(n,[]);idsByBucket.get(n).push(id);}
  await Promise.all(Array.from({length:Math.min(4,buckets.length)},async()=>{
    while(next<buckets.length){
      const n=buckets[next++],entry=manifest.shards.find(part=>part.bucket===n);
      const part=await readJSON(assets,origin,entry.file,signal);
      if(part.schemaVersion!==1||part.sourceHash!==manifest.sourceHash||part.bucket!==n||!part.quotes||typeof part.quotes!=='object'||Array.isArray(part.quotes)
        ||Object.keys(part.quotes).length!==entry.rowCount)throw Error('Portfolio quote shard release mismatch');
      for(const id of idsByBucket.get(n)){
        if(!Object.hasOwn(part.quotes,id))continue;
        const value=part.quotes[id];if(!validateQuote(value))throw Error('Invalid portfolio quote record');
        quotes.set(id,value);
      }
    }
  }));
  return {manifest,quotes,requests:1+buckets.length};
}
function jpy(value,currency,fx){
  if(value==null)return null;
  if(currency==='USD')return Math.round(value*fx.USD/fx.JPY);
  if(currency==='KRW')return Math.round(value/fx.JPY);
  return value;
}
export function valueHoldings(holdings,quotes,fx){
  let totalValue=0,totalCost=0,fallbackHoldings=0;
  for(const holding of holdings){
    const quote=quotes.get(String(holding.card_id)),isBox=holding.grade==='box'||quote?.[0];
    const column=isBox?7:({psa10:1,psa9:3,raw:5})[holding.grade];
    const amount=column==null?null:jpy(quote?.[column],quote?.[column+1],fx);
    if(!amount)fallbackHoldings++;
    const current=amount||holding.buy_price;
    totalValue+=(current||0)*(holding.qty||0);totalCost+=(holding.buy_price||0)*(holding.qty||0);
  }
  const difference=totalValue-totalCost;
  return {totalValueJpy:totalValue,totalCostJpy:totalCost,totalValueKrw:Math.floor(totalValue*fx.JPY),
    totalCostKrw:Math.floor(totalCost*fx.JPY),differenceJpy:difference,differenceKrw:Math.floor(Math.abs(difference)*fx.JPY),
    changePercent:totalCost?difference/totalCost*100:null,fallbackHoldings};
}
