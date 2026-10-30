'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createRequire}=require('node:module'),root=path.resolve(__dirname,'..'),file=path.join(root,'scripts/verify_card_info_prices_production.cjs');
test('production verification exercises every stored artwork and the complete OP16/OP17 click targets',async()=>{
 const output=[],errors=[],calls=[],state={env:{},exitCode:0};
 const context={require:createRequire(file),process:state,AbortSignal,URL,Date,JSON,setTimeout:fn=>{fn();return 0;},
  console:{log:s=>output.push(s),error:s=>errors.push(String(s))},fetch:async address=>{
   const url=new URL(address);calls.push(url.pathname);
   if(url.pathname==='/api/card-grades'){const id=url.searchParams.get('id');return new Response(JSON.stringify({ok:true,id,grades:{raw:{lowest_ask:100,currency:'JPY'}},fetchedAt:new Date().toISOString()}));}
   const target=path.join(root,url.pathname==='/'?'index.html':url.pathname.slice(1));assert(fs.existsSync(target),url.pathname);
   return new Response(fs.readFileSync(target));
  }};
 await vm.runInNewContext(fs.readFileSync(file,'utf8'),context);
 assert.equal(state.exitCode,0,errors.join('\n'));
 const report=JSON.parse(output.at(-1));assert.equal(report.artworkBindings,612);assert.equal(report.completeSets.OP16,149);assert.equal(report.completeSets.OP17,158);assert.equal(report.liveRocks.length,3);
 assert.equal(calls.filter(p=>p==='/api/card-grades').length,3);
});
