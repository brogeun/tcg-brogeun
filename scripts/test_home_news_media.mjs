import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const escapeHtml=s=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
const ctx=vm.createContext({URL,location:{origin:'http://127.0.0.1:8781'},escapeHtml});
vm.runInContext(html.slice(html.indexOf('function newsImageUrl('),html.indexOf('function renderHubNewsPage(')),ctx);
const {newsImageUrl,renderNewsMedia}=ctx;
assert.equal(newsImageUrl('http://flow.xosoft.kr/fileDownload?downname=test'),'https://onepiece-cardgame.kr/fileDownload?downname=test');
assert.equal(newsImageUrl('/images/market/onepiece-logo.png'),'/images/market/onepiece-logo.png');
assert.equal(newsImageUrl('images/test.png'),'/images/test.png');
assert.equal(newsImageUrl('http://example.com/a.jpg'),'https://example.com/a.jpg');
for(const url of ['javascript:alert(1)','data:text/html,<img>', '', 'file:///secret']) assert.equal(newsImageUrl(url),'');
assert.equal(newsImageUrl('data:image/png;base64,AAAA'),'data:image/png;base64,AAAA');
assert.match(renderNewsMedia({source:'onepiece'}),/onepiece-logo.png/);
assert.match(renderNewsMedia({source:'pokemon',thumbnail:'/a.png'}),/src="\/a.png"/);
const items=JSON.parse(readFileSync(new URL('../data/news.json',import.meta.url),'utf8')).items;
for(const item of items){
  const media=renderNewsMedia(item);
  assert.doesNotMatch(media,/src="http:\/\//);
  assert.match(media,/hub-news-fallback/);
}
const media=renderNewsMedia(items[1]);
assert.match(media,/naturalHeight>this.naturalWidth\*1.8/);
const img={hidden:false,nextElementSibling:{hidden:true}};
const handler=media.match(/onerror="([^"]+)"/)[1];
new Function(handler).call(img);
assert.equal(img.hidden,true);
assert.equal(img.nextElementSibling.hidden,false);
assert.match(html,/mo-news-thumb[^\n]+renderNewsMedia\(n\)/);
assert.match(html,/const media = renderNewsMedia\(n\)/);
assert.doesNotMatch(html,/home-official-section[^\n]*display:none/);
assert.doesNotMatch(html,/\.section2:has\(\.home-recommend-grid\)[^\n]*display:none/);
let count=0;
for(const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  if(/\bsrc=|application\/ld\+json/.test(match[1])||!match[2].trim()) continue;
  new vm.Script(match[2]); count++;
}
console.log(JSON.stringify({ok:true,newsItems:items.length,sharedRenderer:true,imageFallback:true,mobileSections:true,inlineScripts:count}));
