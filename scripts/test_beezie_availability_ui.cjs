const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const html = fs.readFileSync(path.resolve(__dirname, '../ev-calculator/index.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)[1];
const now = 1_000_000;
function sandbox(){
  const nodes = new Map();
  const getNode = id => {
    if(!nodes.has(id)) nodes.set(id, {textContent:'',disabled:false,innerHTML:'',style:{},classList:{add(){},remove(){}},querySelectorAll(){return [];}});
    return nodes.get(id);
  };
  const context = vm.createContext({console:{warn(){},log(){},error(){}}, Date, Map, Number, JSON,
    localStorage:{getItem(){return null;},setItem(){}}, document:{readyState:'loading',addEventListener(){},getElementById:getNode},
    setTimeout(){return 1;},clearTimeout(){}});
  vm.runInContext(script,context);
  const api = vm.runInContext('({applyBeezieSnapshot,normalizeStoredState,machineNotice,machineVerdict,calcEv})',context);
  return {context,api,getNode};
}
function input(){
  return {machines:Array.from({length:4},()=>({price:100,avg:110,updatedAt:100,fieldSources:{price:'auto',avg:'auto'}}))};
}
function paused(){
  return {schemaVersion:2,ok:true,fetchedAt:now,checkedAt:now,status:'unavailable',pricesFresh:false,
    catalogue:{complete:true,machineIds:[98,100,104]},results:[
      {id:98,tier:'Wildcard',sourceName:'Wildcard',ok:true,status:'paused',price:null,avg:null,ev:null,url:'https://beezie.com/claw/Wildcard-98'},
      {id:100,tier:'Gold TCG',sourceName:'Gold TCG',ok:true,status:'paused',price:null,avg:null,ev:null,url:'https://beezie.com/claw/Gold-TCG-100'},
      {id:104,tier:'Silver TCG',sourceName:'Silver',ok:true,status:'paused',price:null,avg:null,ev:null,url:'https://beezie.com/claw/Silver-104'}]};
}

test('official machine labels prevent reordered quotes entering another machine',()=>{
  const {api} = sandbox();
  const snapshot = paused();
  snapshot.results = [
    {tier:'Wildcard',ok:true,status:'active',price:30,avg:33,checkedAt:now},
    {tier:'Silver',ok:true,status:'active',price:50,avg:55,checkedAt:now},
    {tier:'Gold TCG',ok:true,status:'active',price:250,avg:275,checkedAt:now}];
  const result = api.applyBeezieSnapshot(input(),snapshot,undefined,now);
  assert.equal(result.state.machines[0].price,null);
  assert.equal(result.state.machines[0].availability,'retired');
  assert.equal(result.state.machines[1].price,250);
  assert.equal(result.state.machines[2].price,50);
  assert.equal(result.state.machines[3].price,30);
});

test('paused source clears only automatic values and retains explicitly edited manual fields',()=>{
  const {api} = sandbox();
  const current = input();
  current.machines[1] = {price:123,avg:150,updatedAt:999,fieldSources:{price:'manual',avg:'manual'}};
  const before = JSON.stringify(current);
  const result = api.applyBeezieSnapshot(current,paused(),undefined,now);
  assert.equal(JSON.stringify(current),before);
  assert.equal(result.state.machines[0].price,null);
  assert.equal(result.state.machines[2].avg,null);
  assert.equal(result.state.machines[3].price,null);
  assert.equal(result.state.machines[1].price,123);
  assert.equal(result.state.machines[1].avg,150);
  assert.equal(result.state.machines[1].updatedAt,999);
  assert.match(api.machineNotice(result.state.machines[1]),/수동 입력값 보존/);
  assert.match(api.machineNotice(result.state.machines[1]),/현재 자동시세 아님/);
  assert.match(api.machineVerdict(result.state.machines[1]),/수동 계산.*공급자 시세 없음/);
  assert.equal(result.state.machines[1].sourceUrl,'https://beezie.com/claw/Gold-TCG-100');
});

test('legacy ambiguous cached values are preserved and clearly labelled as manual/unverified',()=>{
  const {api} = sandbox();
  const current = {machines:Array.from({length:4},()=>({price:100,avg:110,updatedAt:500}))};
  const result = api.applyBeezieSnapshot(current,paused(),undefined,now);
  assert.equal(result.state.machines[1].price,100);
  assert.equal(result.state.machines[1].fieldSources.price,'legacy');
  assert.match(api.machineNotice(result.state.machines[1]),/수동 입력값 보존.*현재 자동시세 아님/);
});

test('active automatic refresh preserves manual prices while retaining current source values separately',()=>{
  const {api} = sandbox();
  const current = input(); current.machines[1].fieldSources.price='manual';current.machines[1].price=222;
  const snapshot = paused();snapshot.results[1]={tier:'Gold TCG',ok:true,status:'active',price:250,avg:275,checkedAt:now};
  const result = api.applyBeezieSnapshot(current,snapshot,undefined,now);
  assert.equal(result.state.machines[1].price,222);
  assert.equal(result.state.machines[1].avg,275);
  assert.equal(result.state.machines[1].automaticQuote.price,250);
  assert.match(api.machineNotice(result.state.machines[1]),/수동 입력값으로 계산/);
});

test('stale snapshot does not refresh a cached quote timestamp',()=>{
  const {api} = sandbox();const snapshot=paused();snapshot.fetchedAt=1;
  const result=api.applyBeezieSnapshot(input(),snapshot,undefined,now+31*60*1000);
  assert.equal(result.fresh,false);
  assert.equal(result.state.machines[1].updatedAt,null);
  assert.equal(result.state.machines[1].price,null);
  assert.equal(result.state.machines[1].availability,'stale');
});

test('valid paused source stops after free GitHub snapshot and never calls paid fallback',async()=>{
  const {context}=sandbox();const calls=[];const messages=[];
  const data=paused();data.fetchedAt=Date.now();data.checkedAt=data.fetchedAt;
  context.fetch=async endpoint=>{calls.push(endpoint);return {ok:true,json:async()=>data};};
  context.captureToast=message=>messages.push(message);
  vm.runInContext('saveState=()=>{};renderCards=()=>{};showToast=captureToast;',context);
  await context.tryAuto();
  assert.equal(calls.length,1);
  assert.match(calls[0],/raw\.githubusercontent\.com/);
  assert.match(messages[0],/일시 중지.*자동시세 없음/);
});

test('manual input event records field ownership and keeps source pause warning',()=>{
  const {context,api}=sandbox();
  context.fixture=input();context.fixture.machines[1].availability='paused';
  vm.runInContext('state=fixture;saveState=()=>{};renderSummary=()=>{};updateGlobalTs=()=>{};',context);
  context.onInputChange({type:'input',target:{dataset:{idx:'1',field:'price'},value:'123'}});
  const result=vm.runInContext('state.machines[1]',context);
  assert.equal(result.price,123);
  assert.equal(result.fieldSources.price,'manual');
  assert.match(api.machineNotice(result),/일시 중지.*수동 입력값 보존/);
});
