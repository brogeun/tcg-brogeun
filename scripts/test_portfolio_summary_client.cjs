'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../assets/portfolio-summary-client.js'),'utf8');
const value=userId=>({ok:true,userId,holdingsCount:3,watchCount:1,totalValueJpy:120,totalCostJpy:100,sourceHash:'a'.repeat(64),fx:{asOf:'2026-11-04',rates:{JPY:10}}});
function fixture(){const requests=[],timers=new Map();let n=0;
  const ctx={window:{},AbortController,Date,fetch:(url,options)=>new Promise(resolve=>requests.push({url,options,resolve})),setTimeout:fn=>{const id=++n;timers.set(id,fn);return id;},clearTimeout:id=>timers.delete(id)};
  vm.createContext(ctx);vm.runInContext(source,ctx);return {api:ctx.window.PortfolioSummaryClient,requests,timers};}
test('home summary shares a current account request, validates ownership, and avoids persistent storage',async()=>{
  const f=fixture(),one=f.api.get('a'),two=f.api.get('a');assert.equal(f.requests.length,1);
  assert.equal(f.requests[0].url,'/api/portfolio/summary');assert.equal(f.requests[0].options.credentials,'include');assert.equal(f.requests[0].options.cache,'no-store');
  f.requests[0].resolve({ok:true,json:async()=>value('a')});await Promise.all([one,two]);await f.api.get('a');assert.equal(f.requests.length,1);
  f.api.invalidate();const fresh=f.api.get('a');assert.equal(f.requests.length,2);f.requests[1].resolve({ok:true,json:async()=>value('wrong')});await assert.rejects(fresh,/identity/);
});
test('an earlier account response cannot replace the current owner cache',async()=>{
  const f=fixture(),a=f.api.get('a'),b=f.api.get('b');
  f.requests[1].resolve({ok:true,json:async()=>value('b')});await b;
  f.requests[0].resolve({ok:true,json:async()=>value('a')});await assert.rejects(a,/identity/);
  assert.equal((await f.api.get('b')).userId,'b');assert.equal(f.requests.length,2);
});
test('network and JSON stalls have a finite deadline and permit a later retry',async()=>{
  const f=fixture(),work=f.api.get('a');f.requests[0].resolve({ok:true,json:()=>new Promise(()=>{})});
  for(const fn of [...f.timers.values()])fn();await assert.rejects(work,/timed out/);assert(f.requests[0].options.signal.aborted);
  const retry=f.api.get('a');f.requests[1].resolve({ok:true,json:async()=>value('a')});await retry;
});
