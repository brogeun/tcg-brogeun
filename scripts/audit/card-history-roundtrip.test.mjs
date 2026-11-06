import assert from 'node:assert/strict';
import {createHash,webcrypto} from 'node:crypto';
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,isAbsolute,join,relative,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const sha=body=>createHash('sha256').update(body).digest('hex');

test('every actual repository price history survives its original HTTP route and packing',async t=>{
  const source=join(root,'data/history');
  assert.ok(existsSync(source),'Checkout data/history for the real preservation check');
  const names=readdirSync(source).filter(name=>/^[1-9][0-9]{0,19}\.json$/.test(name)).sort();
  assert.ok(names.length>1,'Real price history fixture is empty');
  const folder=mkdtempSync(join(tmpdir(),'tcghub-history-roundtrip-'));
  t.after(()=>{
    if(dirname(resolve(folder))!==resolve(tmpdir()))throw Error('Unsafe generated fixture cleanup');
    rmSync(folder,{recursive:true,force:true});
  });
  mkdirSync(join(folder,'scripts'),{recursive:true});
  mkdirSync(join(folder,'functions'),{recursive:true});
  mkdirSync(join(folder,'_deploy/functions'),{recursive:true});
  cpSync(join(root,'scripts/pack_card_history.py'),join(folder,'scripts/pack_card_history.py'));
  cpSync(source,join(folder,'data/history'),{recursive:true});
  cpSync(source,join(folder,'_deploy/data/history'),{recursive:true});
  cpSync(join(root,'functions/_middleware.js'),join(folder,'_deploy/functions/_middleware.js'));
  cpSync(join(root,'functions/_middleware.js'),join(folder,'functions/_middleware.js'));
  cpSync(join(root,'_routes.json'),join(folder,'_deploy/_routes.json'));
  const packed=spawnSync(process.env.PYTHON||'python',['-B',join(folder,'scripts/pack_card_history.py')],{
    cwd:folder,encoding:'utf8',timeout:180000,
  });
  assert.equal(packed.status,0,packed.stdout+'\n'+packed.stderr);
  const manifest=JSON.parse(packed.stdout.trim());
  assert.equal(manifest.status,'passed');assert.equal(manifest.sourceFiles,names.length);
  assert.ok(manifest.fileCountSaved>0);
  const scope=vm.createContext({URL,Request,Response,TextDecoder,TextEncoder,Uint8Array,atob,crypto:webcrypto,
    fetch(){throw Error('Real histories must not make external requests');}});
  vm.runInContext(readFileSync(join(folder,'_deploy/functions/_middleware.js'),'utf8').replace(/^export /gm,''),scope);
  const deploy=resolve(folder,'_deploy');let packRequests=0,manifestRequests=0,rawRequests=0,sourceBytes=0;
  const staticAsset=async input=>{
    const path=resolve(deploy,new URL(input.url).pathname.replace(/^\//,''));
    const rel=relative(deploy,path);
    assert.ok(!isAbsolute(rel)&&!rel.startsWith('..'),'Asset path escaped the disposable fixture');
    if(!existsSync(path))return new Response('missing',{status:404});
    return new Response(readFileSync(path),{headers:{'Content-Type':'application/json'}});
  };
  const invoke=(name,options={})=>{
    const request=new Request('https://tcghub.kr/data/history/'+name+'?verify=roundtrip',{method:options.method||'GET',headers:options.headers});
    return scope.onRequest({request,env:{ASSETS:{fetch:async input=>{
      if(new URL(input.url).pathname.endsWith('/manifest.json'))manifestRequests++;else packRequests++;
      return staticAsset(input);
    }}},
      next:async()=>{rawRequests++;return staticAsset(request);}});
  };
  for(const name of names) {
    const original=readFileSync(join(source,name));sourceBytes+=original.length;
    const response=await invoke(name);
    assert.equal(response.status,200,name);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()),original,name);
    assert.deepEqual(readFileSync(join(folder,'data/history',name)),original,'Repository source changed: '+name);
    assert.match(response.headers.get('Content-Type'),/application\/json/,name);
    if(!existsSync(join(deploy,'data/history',name))) {
      assert.equal(response.headers.get('ETag'),'"'+sha(original)+'"',name);
      assert.equal(Number(response.headers.get('Content-Length')),original.length,name);
    }
  }
  const headName=names.find(name=>!existsSync(join(deploy,'data/history',name)));
  const original=readFileSync(join(source,headName));
  const head=await invoke(headName,{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  const cached=await invoke(headName,{headers:{'If-None-Match':'"'+sha(original)+'"'}});
  assert.equal(cached.status,304);assert.equal(await cached.text(),'');
  assert.equal(manifest.sourceBytesPreserved,sourceBytes);
  console.log(JSON.stringify({sourceFiles:names.length,exactOriginalUrlsVerified:names.length,sourceBytesPreserved:sourceBytes,
    packedFiles:manifest.packedFiles,unpackedFiles:manifest.unpackedFiles,packFiles:manifest.packFiles,
    fileCountSaved:manifest.fileCountSaved,largestPackBytes:manifest.largestPackBytes,packRequests,manifestRequests,rawRequests,externalRequests:0}));
});
