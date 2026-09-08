import assert from 'node:assert/strict';
import {readFileSync,existsSync} from 'node:fs';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);
const html=readFileSync(new URL('index.html',root),'utf8');
const src=readFileSync(new URL('assets/news-detail.js',root),'utf8');
const window={addEventListener(){}};
const context=vm.createContext({URL,window,location:{href:'https://tcghub.kr/raffles/nested/'},document:{addEventListener(){}}});
vm.runInContext(src,context);
const safe=window.HubNewsDetail.safeUrl;
for(const channel of ['narockisrock1','yobeullyANN','damggudonggu'])assert.equal(safe('t.me/'+channel),'https://t.me/'+channel);
assert.equal(safe(' www.youtube.com/@HappyCircuit '),'https://www.youtube.com/@HappyCircuit');
assert.equal(safe('https://t.me/+invite'),'https://t.me/+invite');
assert.equal(safe('/#hub'),'https://tcghub.kr/#hub');
assert.equal(safe('/images/30th.png',true),'https://tcghub.kr/images/30th.png');
for(const bad of ['javascript:alert(1)','data:text/html,evil','file:///etc/passwd','tg://resolve?domain=x'])assert.equal(safe(bad),'');
vm.runInContext(src.slice(src.indexOf(' function externalLink('),src.indexOf(' function isDirectNews(')),context);
context.a={};vm.runInContext('externalLink(a,"https://t.me/damggudonggu")',context);
assert.equal(context.a.target,'_blank');assert.equal(context.a.rel,'noopener noreferrer');
window.Capacitor={isNativePlatform:()=>true};
vm.runInContext('externalLink(a,"https://t.me/damggudonggu")',context);
assert.equal(context.a.target,'_self');assert.equal(context.a.href,'https://t.me/damggudonggu');

const applies=vm.runInNewContext(html.slice(html.indexOf('const APPLIES ='),html.indexOf('const ORIPAS ='))+'APPLIES');
assert.equal(applies.length,3);
for(const a of applies){
  assert.ok(a.img.startsWith('/images/'));
  for(const base of ['https://tcghub.kr/','https://tcghub.kr/raffles/','https://tcghub.kr/price/123']){
    const url=new URL(a.img,base);
    assert.equal(url.pathname,a.img.split('?')[0]);
    assert.ok(existsSync(new URL('.'+url.pathname,root)));
  }
}
assert.ok(existsSync(new URL('images/brand-logo.png',root)));
const fallback=vm.createContext({document:{createElement:()=>({style:{}})}});
vm.runInContext(html.slice(html.indexOf('function applyThumbFallback('),html.indexOf('const _applyHtml =')),fallback);
const img={dataset:{},replaceWith(node){this.replacement=node;}};
fallback.img=img;vm.runInContext('applyThumbFallback(img)',fallback);
assert.equal(img.src,'/images/brand-logo.png');
vm.runInContext('applyThumbFallback(img)',fallback);
assert.equal(img.onerror,null);assert.match(img.replacement.textContent,/로딩 실패/);
console.log(JSON.stringify({ok:true,telegramLinks:3,webAndNativeTargets:true,unsafeSchemesBlocked:true,rootImages:3,nestedPaths:true,boundedImageFallback:true}));
