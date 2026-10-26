import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
const here=dirname(fileURLToPath(import.meta.url));
const baseline=false;
const root=resolve(here,'../..');
const index=readFileSync(join(root,'index.html'),'utf8');
const results=[];
function tagContent(html,key){const escaped=key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');const tags=[...html.matchAll(new RegExp('<meta\\b[^>]*(?:name|property)=["\']'+escaped+'["\'][^>]*>','gi'))];return tags.map(m=>m[0].match(/content=["']([^"']*)["']/i)?.[1]);}
for(const name of ['events','raffles']){
 const text=readFileSync(join(root,'functions',name+'.js'),'utf8');
 const {onRequestGet}=await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
 const url='https://tcghub.kr/'+name;
 const expectedTitle=text.match(/const OG_TITLE = '([^']*)'/)[1];
 const expectedDesc=text.match(/const OG_DESC = '([^']*)'/)[1];
 const fixtures=baseline?[index]:[index,'<!doctype html><html><head></head><body>content</body></html>',"<html><head><meta content='old' name='twitter:title'><link href='https://tcghub.kr/' rel='canonical'></head><body></body></html>"];
 for(const [fixtureIndex,fixture]of fixtures.entries()){
  const calls=[];
  const response=await onRequestGet({request:new Request(url+'?audit=1'),env:{ASSETS:{fetch:async request=>{calls.push(new URL(request.url).pathname);return new Response(fixture);}}}});
  assert.equal(response.status,200);assert.deepEqual(calls,['/index.html']);
  const html=await response.text();
  const canonical=html.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/i)?.[0].match(/href=["']([^"']*)["']/i)?.[1];
  const checks={canonical:canonical===url,
   twitterTitle:JSON.stringify(tagContent(html,'twitter:title'))===JSON.stringify([expectedTitle]),
   twitterDescription:JSON.stringify(tagContent(html,'twitter:description'))===JSON.stringify([expectedDesc]),
   twitterImage:JSON.stringify(tagContent(html,'twitter:image'))===JSON.stringify(['https://tcghub.kr/images/brand-logo.png']),
   twitterUrl:JSON.stringify(tagContent(html,'twitter:url'))===JSON.stringify([url]),
   ogTitle:JSON.stringify(tagContent(html,'og:title'))===JSON.stringify([expectedTitle]),
   ogDescription:JSON.stringify(tagContent(html,'og:description'))===JSON.stringify([expectedDesc]),
   ogUrl:JSON.stringify(tagContent(html,'og:url'))===JSON.stringify([url]),
   title:html.includes('<title>'+expectedTitle+'</title>')};
  if(baseline)assert(Object.values(checks).some(x=>!x),'baseline should reproduce the defect');else assert(Object.values(checks).every(Boolean),JSON.stringify({name,fixtureIndex,checks}));
  results.push({name,fixtureIndex,checks});
 }
 if(!baseline){
  const failed=await onRequestGet({request:new Request(url),env:{ASSETS:{fetch:async()=>{throw Error('mock assets failure');}}}});assert.equal(failed.status,500);
  const empty=await onRequestGet({request:new Request(url),env:{ASSETS:{fetch:async()=>new Response('')}}});assert.equal(empty.status,500);
 }
}

console.log(JSON.stringify({baseline,cases:results.length,failures:results.flatMap(r=>Object.entries(r.checks).filter(([,ok])=>!ok).map(([key])=>r.name+':'+key))}));
