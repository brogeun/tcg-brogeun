// Verify representative original chart URLs against this exact deployment snapshot.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,readFileSync,readdirSync,statSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const origin=process.env.TCGHUB_VERIFY_ORIGIN||'https://tcghub.kr';
const manifest=JSON.parse(readFileSync(join(root,'_deploy/data/card-history-packs-v1/manifest.json'),'utf8'));
const hash=value=>createHash('sha256').update(value).digest('hex');
const source=join(root,'data/history');
const names=readdirSync(source).filter(name=>/^[1-9][0-9]{0,19}\.json$/.test(name)).sort();
assert.equal(names.length,manifest.sourceFiles,'History source count differs from the deployment');
const largest=[...names].sort((a,b)=>statSync(join(source,b)).size-statSync(join(source,a)).size).slice(0,4);
const sampled=[...names].sort((a,b)=>hash(manifest.generation+a).localeCompare(hash(manifest.generation+b))).slice(0,32);
const retained=names.filter(name=>existsSync(join(root,'_deploy/data/history',name))).slice(0,4);
const chosen=[...new Set([names[0],names.at(-1),...largest,...sampled,...retained,
  ...['146897.json','881671.json','871063.json','118914.json'].filter(name=>names.includes(name))])];

async function request(path,options={}) {
  let failure;
  for(let attempt=0;attempt<3;attempt++) {
    try {
      const response=await fetch(origin+path+(path.includes('?')?'&':'?')+'verify='+manifest.generation,{
        ...options,headers:{'Cache-Control':'no-cache',...options.headers},signal:AbortSignal.timeout(20000),
      });
      if(![200,304].includes(response.status))throw Error(path+': HTTP '+response.status);
      return response;
    } catch(error) {
      failure=error;
      if(attempt<2)await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
    }
  }
  throw failure;
}

const published=await (await request('/data/card-history-packs-v1/manifest.json')).json();
assert.deepEqual(published,manifest,'Published history manifest is from another deployment');
let checked=0;
for(let index=0;index<chosen.length;index+=4) {
  await Promise.all(chosen.slice(index,index+4).map(async name=>{
    const original=readFileSync(join(source,name));
    const response=await request('/data/history/'+name);
    assert.match(response.headers.get('Content-Type')||'',/application\/json/,name);
    assert.equal(hash(Buffer.from(await response.arrayBuffer())),hash(original),name+': original history bytes differ');
    if(!existsSync(join(root,'_deploy/data/history',name)))assert.equal(response.headers.get('ETag'),'"'+hash(original)+'"',name);
    checked++;
  }));
}
const conditional=chosen.find(name=>!existsSync(join(root,'_deploy/data/history',name)));
assert.ok(conditional,'No packed history was sampled');
const head=await request('/data/history/'+conditional,{method:'HEAD'});
assert.equal(head.status,200);assert.equal(await head.text(),'');
const cached=await request('/data/history/'+conditional,{headers:{'If-None-Match':'"'+hash(readFileSync(join(source,conditional)))+'"'}});
assert.equal(cached.status,304);assert.equal(await cached.text(),'');
console.log(JSON.stringify({origin,generation:manifest.generation,sourceFiles:manifest.sourceFiles,
  originalHistoryUrlsVerified:checked,conditionalHistoryVerified:true,sourceBytesPreserved:manifest.sourceBytesPreserved,
  fileCountSaved:manifest.fileCountSaved}));
