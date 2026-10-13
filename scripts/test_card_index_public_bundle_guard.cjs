/* Regression checks for complete and accidentally regressed full-site deployment bundles. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {createHash}=require('node:crypto');
const {spawnSync}=require('node:child_process');
const {verifyPublicBundle}=require('./verify_card_index_public_bundle.cjs');
const workspace=path.resolve(__dirname,'..'),source=path.resolve(process.env.TCG_CARD_INDEX_GUARD_SOURCE||workspace);
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const names=['index.html','assets/market-price-index.js','assets/market-price-index.css','data/market-price-index.json','data/market-price-index-validation.json','data/market-price-index-independent-verification.json'];
const originals=Object.fromEntries(names.map(name=>[name,fs.readFileSync(path.join(source,name))]));
const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'tcg-card-index-public-guard-')),checks=[];
function save(name,value){fs.writeFileSync(path.join(fixture,name),typeof value==='string'||Buffer.isBuffer(value)?value:JSON.stringify(value));}
function restore(){for(const [name,raw]of Object.entries(originals)){fs.mkdirSync(path.dirname(path.join(fixture,name)),{recursive:true});save(name,raw);}}
function text(name,mutate){save(name,mutate(fs.readFileSync(path.join(fixture,name),'utf8')));}
function json(name,mutate){const value=JSON.parse(fs.readFileSync(path.join(fixture,name),'utf8'));mutate(value);save(name,value);}
function resign(){
 const dataHash=sha(fs.readFileSync(path.join(fixture,'data/market-price-index.json')));
 json('data/market-price-index-independent-verification.json',value=>value.dataSha256=dataHash);
 json('data/market-price-index-validation.json',value=>{value.dataSha256=dataHash;value.independentAudit.dataSha256=dataHash;value.independentAudit.sha256=sha(fs.readFileSync(path.join(fixture,'data/market-price-index-independent-verification.json')));});
}
async function rejected(label,mutate,message){restore();mutate();await assert.rejects(()=>verifyPublicBundle(fixture),message,label);checks.push(label);}
(async()=>{
 try{
  restore();assert.equal((await verifyPublicBundle(fixture)).ok,true);checks.push('complete approved bundle passes');
  restore();text('index.html',html=>html+'<!-- <div id="marketFlowRoot"></div> --><script>const test="<div id=\"marketFlowRoot\"></div>";</script>');assert.equal((await verifyPublicBundle(fixture)).ok,true);checks.push('comments and inline JS strings are not counted as mounts');
  await rejected('missing home mount',()=>text('index.html',html=>html.replace(/<div id="marketFlowRoot"[^>]*><\/div>/,'')),/exactly one marketFlowRoot/);
  await rejected('duplicate home mount',()=>text('index.html',html=>html+'<div id="marketFlowRoot"></div>'),/exactly one marketFlowRoot/);
  await rejected('hidden home mount',()=>text('index.html',html=>html.replace('id="marketFlowRoot"','hidden id="marketFlowRoot"')),/must not be hidden/);
  await rejected('missing script reference',()=>text('index.html',html=>html.replace(/<script src="\/assets\/market-price-index\.js[^>]*><\/script>/,'')),/exactly one local.*market-price-index.js/);
  await rejected('external script reference',()=>text('index.html',html=>html.replace('src="/assets/market-price-index.js','src="https://outside.example.invalid/assets/market-price-index.js')),/exactly one local.*market-price-index.js/);
  await rejected('missing stylesheet reference',()=>text('index.html',html=>html.replace(/<link rel="stylesheet" href="\/assets\/market-price-index\.css[^>]*>/,'')),/exactly one local.*market-price-index.css/);
  await rejected('JavaScript asset replaced with HTML fallback',()=>save('assets/market-price-index.js',originals['index.html']),/HTML fallback/);
  await rejected('invalid JavaScript syntax',()=>text('assets/market-price-index.js',js=>js+'\nconst broken = ;'),/Unexpected token/);
  for(const name of names.slice(1))await rejected('missing '+name,()=>fs.unlinkSync(path.join(fixture,name)),/Required card index file missing/);
  await rejected('empty stylesheet asset',()=>save('assets/market-price-index.css',''),/file is empty/);
  for(const name of names.filter(name=>name.endsWith('.json')))await rejected('invalid JSON '+name,()=>save(name,'<html>not JSON</html>'),/JSON is invalid/);
  await rejected('stale validation hash',()=>json('data/market-price-index-validation.json',value=>value.dataSha256='0'.repeat(64)),/자료와 계산 확인 결과가 일치하지 않습니다/);
  await rejected('stale independent proof hash',()=>text('data/market-price-index-independent-verification.json',raw=>raw+'\n'),/독립 검산을 확인하지 못했습니다/);
  await rejected('failed validation status',()=>json('data/market-price-index-validation.json',value=>value.status='failed'),/계산 확인 결과가 지수 자료와 일치하지 않습니다/);
  await rejected('failed independent proof after rehashing',()=>{json('data/market-price-index-independent-verification.json',value=>value.status='failed');resign();},/독립 검산을 확인하지 못했습니다/);
  await rejected('incorrect numeric index even with matching file hashes',()=>{json('data/market-price-index.json',value=>value.series.pokemon.points.at(-1).value+=20);resign();},/data is rejected/);
  await rejected('mixed validation policy',()=>json('data/market-price-index-validation.json',value=>value.methodPolicy.version='other-policy'),/계산 확인 결과가 지수 자료와 일치하지 않습니다/);
  await rejected('date panel moved outside disclosure',()=>text('assets/market-price-index.js',js=>js.replace(/extra\.querySelector\('summary'\)\.after\(root\.querySelector\('\.mpi-selected-view'\)\);/,'')),/Selected date panel must remain inside/);
  await rejected('details open by default',()=>text('assets/market-price-index.js',js=>js.replace('<details class="mpi-extra-details">','<details class="mpi-extra-details" open>')),/initially closed|must not open/);
  restore();const result=await verifyPublicBundle(fixture);assert.equal(result.sha256['data/market-price-index.json'],sha(originals['data/market-price-index.json']));checks.push('unmodified verified data remains unchanged');
  const withoutCredentials={...process.env};for(const name of ['CF_API_TOKEN','CLOUDFLARE_API_TOKEN','CLOUDFLARE_ACCOUNT_ID'])delete withoutCredentials[name];
  const credentialFree=spawnSync(process.execPath,[path.join(__dirname,'verify_card_index_public_bundle.cjs'),'--bundle-dir',fixture],{encoding:'utf8',env:withoutCredentials,windowsHide:true});
  assert.equal(credentialFree.status,0,credentialFree.stderr);assert.equal(JSON.parse(credentialFree.stdout).ok,true);checks.push('read-only deployment guard runs without Cloudflare credentials');
  const originalFunctions=path.join(fixture,'original-functions'),bundledFunctions=path.join(fixture,'functions');
  for(const [name,body]of [['api/auth/google/native.js','export const onRequestPost=()=>{};'],['_shared/auth.js','export const requireUser=()=>{};']]){
   for(const dir of [originalFunctions,bundledFunctions]){fs.mkdirSync(path.dirname(path.join(dir,name)),{recursive:true});fs.writeFileSync(path.join(dir,name),body);}
  }
  const functionOptions={functionsSourceDirectory:originalFunctions};
  assert.equal((await verifyPublicBundle(fixture,functionOptions)).functions.requiredJavaScriptFiles,2);checks.push('complete OAuth function and helper source is preserved');
  fs.unlinkSync(path.join(bundledFunctions,'api/auth/google/native.js'));
  await assert.rejects(()=>verifyPublicBundle(fixture,functionOptions),/Required function file missing.*api\/auth\/google\/native.js/);checks.push('missing native login function blocks deployment');
  fs.copyFileSync(path.join(originalFunctions,'api/auth/google/native.js'),path.join(bundledFunctions,'api/auth/google/native.js'));
  fs.unlinkSync(path.join(bundledFunctions,'_shared/auth.js'));
  await assert.rejects(()=>verifyPublicBundle(fixture,functionOptions),/Required function file missing.*_shared\/auth.js/);checks.push('missing shared authentication helper blocks deployment');
  fs.copyFileSync(path.join(originalFunctions,'_shared/auth.js'),path.join(bundledFunctions,'_shared/auth.js'));
  fs.appendFileSync(path.join(bundledFunctions,'_shared/auth.js'),'\n// stale deployed helper');
  await assert.rejects(()=>verifyPublicBundle(fixture,functionOptions),/Bundled function differs from source/);checks.push('stale shared helper blocks deployment');
  for(const [name,bundle,condition]of [['scrape.yml','_deploy',null],['pokemon-detect.yml','.',"steps.changes.outputs.has_changes == 'true'"],['onepiece-sync.yml','.',"steps.changes.outputs.has_changes == 'true'"],['psa-pop-daily.yml','.',null]]){
   const yaml=fs.readFileSync(path.join(source,'.github/workflows',name),'utf8');
   const guard=yaml.indexOf('      - name: Verify public home card index before deploy');
   const deploy=yaml.indexOf('      - name: Deploy to Cloudflare Pages',guard);
   assert.ok(guard>=0&&deploy>guard,name+' must gate deployment');
   const step=yaml.slice(guard,deploy);assert.ok(step.includes('node scripts/verify_card_index_public_bundle.cjs --bundle-dir '+bundle),name+' must inspect its actual bundle');
   assert.equal((yaml.slice(guard,deploy).match(/      - name:/g)||[]).length,1,name+' guard must immediately precede deployment');
   if(condition)assert.ok(step.includes('if: '+condition),name+' guard must use the same deploy condition');
   if(name==='scrape.yml'){
    assert.ok(!/^\s*if:/m.test(step),'Daily index guard must not be skipped because step credentials are absent');
    assert.ok(step.includes('--functions-source-dir functions'),'Daily bundle must be checked against its complete original functions');
    checks.push('daily deployment guard runs unconditionally and checks source function coverage');
   }
   checks.push(name+' full deployment is gated');
  }
  console.log(JSON.stringify({ok:true,suite:'card-index-public-bundle-deployment-guard',source,checksPassed:checks.length,checks,sourceAsOf:result.sourceAsOf,externalWritesPerformed:false},null,2));
 }finally{
  // Remove only the explicitly created temporary fixture directory.
  const resolved=path.resolve(fixture);assert.equal(path.dirname(resolved),path.resolve(os.tmpdir()));assert.match(path.basename(resolved),/^tcg-card-index-public-guard-[a-zA-Z0-9]+$/);fs.rmSync(resolved,{recursive:true,force:true});
 }
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
