import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {parseHTML} from './fixtures/linkedom.worker.mjs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const helper=readFileSync(new URL('../assets/card-thumbnails.js',import.meta.url),'utf8');
const dialog=readFileSync(new URL('../assets/search-modal.js',import.meta.url),'utf8');
const base='https://cdn.snkrdunk.com/upload_bg_removed/4bfe7bdb-4f7e-4398-9689-334e15831532.webp';
const original=base+'?signature=a%2Fb%2B%3D&size=l&token=x+y&keep=%7e#original';
const thumbnail=original.replace('size=l','size=m');
const escapeHtml=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function fixture(markup=''){
 const {window}=parseHTML('<html><body>'+markup+'</body></html>'),document=window.document;
 const context=vm.createContext({window:{addEventListener(){}},document,URL,console,escapeHtml,setTimeout,clearTimeout,innerWidth:1440,location:{hash:'#price'}});
 vm.runInContext(helper,context);return {window,document,context,api:context.window.CardThumbnails};
}
const sourceWrites=image=>{const writes=[],set=image.setAttribute.bind(image);image.setAttribute=(key,value)=>{if(key==='src')writes.push(value);return set(key,value);};return writes;};
const extract=(start,end)=>html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));
function renderFixture(){
 const h=fixture('<div data-home-top-list="pokemon"></div><div id="homeTopPokemon"></div><div id="priceGrid"></div><div id="priceStatus"></div><div id="priceListInfo"></div><div id="priceSearchPages"></div>');
 Object.assign(h.context,{fmtKrw:value=>'₩'+value,fmtOrig:value=>'¥'+value,HomeMarket:{quote:p=>({value:p.lastPrice,currency:p.currency})},HOME_TRADE_CHANGES:{},HOME_TOP_KO_NAMES:{},CARDINFO:{pokemon:[],onepiece:[]},_homeProductKind:()=> 'card',PRICE_CAT:'card',PRICE_BRAND:'pokemon'});
 for(const [start,end] of [['function renderHomeTop(','\nfunction renderHomeTopSkeleton'],['function _homePriceRowHTML(','\nconst HOME_TRADE_CHANGES'],['function renderPriceGrid(','\nfunction changePricePage'],['function renderPriceSearchAsGrid(','\nfunction renderSearchResultsTo(']])vm.runInContext(extract(start,end),h.context);
 return h;
}

test('attributes select size=m in initial HTML, preserving exact signed query and safe quoting',()=>{
 const h=fixture();h.document.body.innerHTML='<div class="price-card-img"><img '+h.api.attributes(original)+'></div>';
 const image=h.document.querySelector('img');assert.equal(image.getAttribute('src'),thumbnail);assert.equal(image.getAttribute('data-original-src'),original);
 assert.equal(h.api.original(image),original);assert.equal(h.api.original(thumbnail),original);
 const unsafe=base+'?size=l&value=" onerror="alert(1)';h.document.body.innerHTML='<div class="price-card-img"><img '+h.api.attributes(unsafe)+'></div>';
 const escaped=h.document.querySelector('img');assert.equal(escaped.getAttribute('src'),unsafe.replace('size=l','size=m'));assert.equal(escaped.hasAttribute('onerror'),false);
});

test('preselected images register fallback without reassigning src; original retry runs once',()=>{
 const h=fixture();h.document.body.innerHTML='<div class="price-card-img"><img '+h.api.attributes(original)+'></div>';
 const image=h.document.querySelector('img'),writes=sourceWrites(image);let previous=0,previousThis,previousEvent;
 image.onerror=function(event){previous++;previousThis=this;previousEvent=event;};
 assert.equal(h.api.apply(h.document.body),0);assert.equal(writes.length,0);const handler=image.onerror;
 assert.equal(h.api.apply(h.document.body),0);assert.equal(image.onerror,handler);assert.equal(writes.length,0);
 image.onerror({type:'error'});assert.deepEqual(writes,[original]);assert.equal(previous,0);assert.equal(h.api.apply(h.document.body),0);
 const event={type:'error',original:true};image.onerror(event);assert.equal(previous,1);assert.equal(previousThis,image);assert.equal(previousEvent,event);assert.deepEqual(writes,[original]);
});

test('HTML attribute originals survive reverse-map eviction and helper reload',()=>{
 const h=fixture();h.document.body.innerHTML='<div class="price-card-img"><img '+h.api.attributes(original)+'></div>';
 const image=h.document.querySelector('img');
 for(let i=0;i<520;i++)h.api.attributes(base+'?size=l&item='+i);
 assert.equal(h.api.original(thumbnail),thumbnail);assert.equal(h.api.original(image),original);
 vm.runInContext(helper,h.context);const fresh=h.context.window.CardThumbnails,writes=sourceWrites(image);
 assert.equal(fresh.original(image),original);assert.equal(fresh.apply(h.document.body),0);assert.equal(writes.length,0);image.onerror({type:'error'});assert.deepEqual(writes,[original]);
});

test('local official artwork, existing srcsets and detail surfaces retain original image handling',()=>{
 const h=fixture();const local='/images/onepiece-official/OP01-016_p9.webp?size=l';
 assert.equal(h.api.attributes(local),'src="'+local+'"');
 h.document.body.innerHTML='<div id="slidePanel"><img src="'+escapeHtml(original)+'"></div><div class="price-card-img"><img src="'+escapeHtml(original)+'" srcset="'+escapeHtml(original)+' 856w"></div>';
 assert.equal(h.api.apply(h.document.body),0);for(const image of h.document.querySelectorAll('img'))assert.equal(image.getAttribute('src'),original);
 assert.match(html,/CardThumbnails\?\.original\(cardImageElement\)/);assert.match(html,/CardThumbnails\?\.original\(sourceImageElement\)/);
});

for(const renderer of ['home-cards','home-rows','price-grid','price-search'])test(`${renderer} real template starts with thumbnail src and keeps original artwork`,()=>{
 const h=renderFixture(),product={id:'100',name:'테스트 카드',image:original,thumbnailUrl:original,lastPrice:100,minPrice:100,currency:'JPY',brand:'pokemon',kind:'card',displayName:'테스트 카드',setName:'테스트 팩'};
 let container;
 if(renderer==='home-cards'){h.context.renderHomeTop('pokemon',[product]);container=h.document.querySelector('[data-home-top-list]');}
 if(renderer==='home-rows'){container=h.document.getElementById('homeTopPokemon');container.innerHTML=h.context._homePriceRowHTML(product,0);}
 if(renderer==='price-grid'){h.context.renderPriceGrid([product]);container=h.document.getElementById('priceGrid');}
 if(renderer==='price-search'){h.context.renderPriceSearchAsGrid([product],'테스트',1,{total:1});container=h.document.getElementById('priceGrid');}
 const image=container.querySelector('img');assert.ok(image);assert.equal(image.getAttribute('src'),thumbnail);assert.equal(image.getAttribute('data-original-src'),original);
 const writes=sourceWrites(image);h.api.apply(container);assert.equal(writes.length,0);assert.equal(h.api.original(image),original);
});

test('real templates remain compatible when the optional new attributes helper is unavailable',()=>{
 const h=renderFixture();h.context.window.CardThumbnails={apply(){}};
 h.context.renderPriceGrid([{id:'100',name:'테스트 카드',image:original,lastPrice:100,currency:'JPY',brand:'pokemon'}]);
 assert.equal(h.document.querySelector('#priceGrid img').getAttribute('src'),original);
});

test('actual search dialog template uses initial thumbnail selection and preserves local official artwork',async()=>{
 const h=fixture('<div id="gsResults"></div>');
 const row={id:'100',name:'테스트 카드',displayName:'테스트 카드',thumbnailUrl:original,kind:'card',brand:'pokemon',setName:'테스트 팩',minPrice:100,currency:'JPY'};
 const client={search:async()=>({results:[row],total:1})};h.context.window.CardSearchClient=client;h.context.CardSearchClient=client;
 Object.assign(h.context,{fmtKrw:value=>'₩'+value,fmtOrig:value=>'¥'+value});
 const hooked=dialog.replace(/\}\)\(\);\s*$/,'window.__thumbnailDialogTest={render,setHosts(hosts){modal=hosts.modal;input=hosts.input;list=hosts.list;count=hosts.count;}};})();');
 vm.runInContext(hooked,h.context);const hosts={modal:{hidden:false},input:{value:'테스트'},list:h.document.getElementById('gsResults'),count:{}};
 h.context.window.__thumbnailDialogTest.setHosts(hosts);await h.context.window.__thumbnailDialogTest.render();
 const image=hosts.list.querySelector('img');assert.equal(image.getAttribute('src'),thumbnail);assert.equal(h.api.original(image),original);assert.equal(h.api.apply(hosts.list),0);
 row.thumbnailUrl='/images/onepiece-official/OP01-016_p9.webp';await h.context.window.__thumbnailDialogTest.render();assert.equal(hosts.list.querySelector('img').getAttribute('src'),row.thumbnailUrl);
 h.context.window.CardThumbnails={apply(){}};row.thumbnailUrl=original;await h.context.window.__thumbnailDialogTest.render();assert.equal(hosts.list.querySelector('img').getAttribute('src'),original);
});
