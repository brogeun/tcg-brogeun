'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),root=path.resolve(__dirname,'..'),file=path.join(root,'scripts/verify_card_info_prices_production.cjs');
const {verifyPriceAssets}=require('./verify_card_info_prices_production.cjs');
function assetFixture({lazy=true,loaderSource,htmlTransform=html=>html,remoteTransform=(_path,source)=>source}={}){
 const calls=[],sourceFor=name=>name==='assets/app-route-loader.js'&&loaderSource!==undefined?loaderSource:fs.readFileSync(path.join(root,name),'utf8');
 const script=file=>'<script src="/assets/'+file+'?v=fixture-declared"></script>';
 const core=['contained-card-match.js','price-expanded.js','card-price-fallback.js','contained-card-prices.js'].map(script).join('\n');
 const html=htmlTransform(core+(lazy?script('app-route-loader.js')+'<script>AppRouteLoader.ensure(\'cardinfo\');go(initialPage);</script>':['english-catalog.js','tcg-card-info.js'].map(script).join('\n')));
 return {calls,html,readSource:sourceFor,get:async address=>{
  calls.push(address);if(address==='/')return html;
  const url=new URL(address,'https://tcghub.kr');return remoteTransform(url.pathname,sourceFor(url.pathname.slice(1)));
 }};
}
test('production asset gate accepts eager scripts without a historical version-string marker',async()=>{
 const h=assetFixture({lazy:false});assert(!h.html.includes('20261030-price-audit2'));
 const report=await verifyPriceAssets(h);assert.equal(report.lazy,false);
 assert(h.calls.includes('/assets/english-catalog.js?v=fixture-declared'));
 assert(h.calls.includes('/assets/tcg-card-info.js?v=fixture-declared'));
 assert(!h.calls.some(url=>url.includes('app-route-loader')));
});
test('production asset gate reads the declared remote loader and fetches exact cardinfo manifest URLs',async()=>{
 const h=assetFixture(),report=await verifyPriceAssets(h);assert.equal(report.lazy,true);
 assert(h.calls.includes('/assets/app-route-loader.js?v=fixture-declared'));
 for(const name of ['english-catalog.js','tcg-card-info.js']){
  assert(h.calls.includes('/assets/'+name+'?v=20261104-modular1'));
  assert(!h.calls.includes('/assets/'+name),'The declared query must be retained when fetching source bytes');
 }
});
test('production asset gate validates the actual deployed bootstrap and route manifest contract',async()=>{
 const h=assetFixture({htmlTransform:()=>fs.readFileSync(path.join(root,'index.html'),'utf8')});
 const report=await verifyPriceAssets(h);assert.equal(report.lazy,true);
 const declared=[...h.html.matchAll(/<script\b[^>]*\bsrc=["'](\/assets\/(?:app-route-loader|contained-card-match)\.js\?[^"']+)["']/g)].map(match=>match[1]);
 assert.equal(declared.length,2);
 for(const url of declared)assert(h.calls.includes(url),'The actual index version URL must be verified: '+url);
});
test('production asset gate rejects absent, unrelated or unwired feature loaders and incomplete pages',async()=>{
 const broken=[
  assetFixture({htmlTransform:html=>html.replace(/<script src="\/assets\/app-route-loader[^>]*><\/script>/,'')}),
  assetFixture({loaderSource:'window.AppRouteLoader={ensure(){},manifest:{home:{scripts:[]}}};'}),
  assetFixture({htmlTransform:html=>html.replace('AppRouteLoader.ensure(','OtherLoader.ensure(')}),
  assetFixture({htmlTransform:()=>'<html><body>Check your browser</body></html>'}),
 ];
 for(const h of broken)await assert.rejects(verifyPriceAssets(h),/linked once|cardinfo script profile|wired before route activation/);
});
test('production asset gate rejects missing or reversed cardinfo scripts and deferred bootstrap loaders',async()=>{
 for(const scripts of [['/assets/english-catalog.js?v=fixture'],['/assets/tcg-card-info.js?v=fixture','/assets/english-catalog.js?v=fixture']]){
  const loaderSource='window.AppRouteLoader={ensure(){},manifest:{cardinfo:{scripts:'+JSON.stringify(scripts)+'}}};';
  await assert.rejects(verifyPriceAssets(assetFixture({loaderSource})),/linked once|dependency order/);
 }
 await assert.rejects(verifyPriceAssets(assetFixture({htmlTransform:html=>html.replace('<script src="/assets/app-route-loader','<script defer src="/assets/app-route-loader')})),/ready before navigation/);
});
test('production asset gate retains source-byte verification for remote loader and lazy scripts',async()=>{
 for(const stale of ['/assets/app-route-loader.js','/assets/english-catalog.js','/assets/tcg-card-info.js','/sw.js']){
  await assert.rejects(verifyPriceAssets(assetFixture({remoteTransform:(pathname,source)=>pathname===stale?source+'\n/* stale */':source})),/Stale production asset/);
 }
});
test('production verification exercises every stored artwork and the complete OP16/OP17 click targets',async()=>{
 const output=[],errors=[],calls=[],state={env:{},exitCode:0};
 const context={require:createRequire(file),module:{exports:{}},process:state,AbortSignal,URL,Date,JSON,setTimeout:fn=>{fn();return 0;},
  console:{log:s=>output.push(s),error:s=>errors.push(String(s))},fetch:async address=>{
   const url=new URL(address);calls.push(url.pathname);
   if(url.pathname==='/api/card-grades'){const id=url.searchParams.get('id');return new Response(JSON.stringify({ok:true,id,grades:{raw:{lowest_ask:100,currency:'JPY'}},fetchedAt:new Date().toISOString()}));}
   const target=path.join(root,url.pathname==='/'?'index.html':url.pathname.slice(1));assert(fs.existsSync(target),url.pathname);
   return new Response(fs.readFileSync(target));
  }};
 vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
 await context.module.exports.run();
 assert.equal(state.exitCode,0,errors.join('\n'));
 // The reviewed vintage publication adds 517 bindings to the original 612.
 const report=JSON.parse(output.at(-1));assert.equal(report.artworkBindings,1129);assert.equal(report.completeSets.OP16,149);assert.equal(report.completeSets.OP17,158);assert.equal(report.liveRocks.length,3);
 assert.equal(calls.filter(p=>p==='/api/card-grades').length,3);
});
