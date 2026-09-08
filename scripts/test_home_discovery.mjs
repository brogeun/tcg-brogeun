import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const css=readFileSync(new URL('../assets/home-discovery.css',import.meta.url),'utf8');
const data=JSON.parse(readFileSync(new URL('../data/news.json',import.meta.url),'utf8')).items;
const elements=Object.fromEntries(['homeNewsSlide','homeNewsCount','homeGameSlide','homeRecommendSlide'].map(id=>[id,{innerHTML:'',textContent:'',setAttribute(){},matches:()=>hover}]));
let tick,hover=false,active=true,opened;
const ctx=vm.createContext({
  window:{matchMedia:()=>({matches:false})},
  document:{hidden:false,addEventListener(){},getElementById:id=>id==='homeNewsGrid'?{matches:()=>hover}:elements[id],querySelector:()=>({classList:{contains:()=>active}}),querySelectorAll:()=>[]},
  HUB_NEWS_ITEMS:data,
  escapeHtml:s=>String(s).replace(/"/g,'&quot;').replace(/</g,'&lt;'),
  renderNewsMedia:()=>'<div class="hub-news-placeholder"></div>',
  newsImageUrl:()=>'/images/market/onepiece-logo.png',
  HubNewsDetail:{isDirectNews:()=>true,open:n=>{opened=n}},
  setInterval:fn=>{tick=fn;return 1},clearInterval:()=>{}
});
vm.runInContext(html.slice(html.indexOf('let HOME_NEWS_INDEX'),html.indexOf('let _ETC_CAROUSEL_IDX')),ctx);
ctx.renderHomeNewsGrid();
assert.equal(ctx.homeNewsItems().length,10);
assert.equal(elements.homeNewsCount.textContent,'1 / 10');
tick();assert.equal(elements.homeNewsCount.textContent,'2 / 10');
ctx.homeNewsStep(-2);assert.equal(elements.homeNewsCount.textContent,'10 / 10');
ctx.homeNewsStep(1);assert.equal(elements.homeNewsCount.textContent,'1 / 10');
vm.runInContext('HOME_REDUCED_MOTION.matches=true',ctx);tick();assert.equal(elements.homeNewsCount.textContent,'1 / 10');
vm.runInContext('HOME_REDUCED_MOTION.matches=false',ctx);hover=true;tick();assert.equal(elements.homeNewsCount.textContent,'1 / 10');
hover=false;ctx.document.hidden=true;tick();assert.equal(elements.homeNewsCount.textContent,'1 / 10');
ctx.document.hidden=false;active=false;tick();assert.equal(elements.homeNewsCount.textContent,'1 / 10');
active=true;ctx.openHomeNews();assert.equal(opened,data[0]);
ctx.HUB_NEWS_ITEMS=[];ctx.renderHomeNewsGrid();assert.equal(elements.homeNewsCount.textContent,'0 / 0');
ctx.HUB_NEWS_ITEMS=[data[0]];ctx.renderHomeNewsGrid();assert.equal(elements.homeNewsCount.textContent,'1 / 1');
ctx.renderHomeRotatingCards([{title:'추천 첫째'},{title:'추천 둘째'}]);
assert.match(elements.homeGameSlide.innerHTML,/포켓 배구/);
assert.match(elements.homeRecommendSlide.innerHTML,/추천 첫째/);
tick();
assert.match(elements.homeGameSlide.innerHTML,/푸린 만들기/);
assert.match(elements.homeRecommendSlide.innerHTML,/추천 둘째/);
assert.equal((elements.homeGameSlide.innerHTML.match(/<a /g)||[]).length,1);
tick();assert.match(elements.homeRecommendSlide.innerHTML,/추천 첫째/);
assert.doesNotMatch(html,/id="homeNewsPause"|class="home-news-controls"/);
assert.match(css,/height:104px/);
assert.match(css,/height:96px/);
assert.match(css,/grid-template-areas:"news games" "events recommend"/);
assert.match(css,/@media\(max-width:600px\)/);
const events=html.slice(html.indexOf('function renderHomeEventsCarousel()'),html.indexOf('window._eventsCarouselGoto'));
assert.doesNotMatch(events,/window.open/);
assert.match(events,/slide.onclick = \(\) => _gotoHubSub\('events'\)/);
assert.match(html,/class="home-compact-item" onclick="_gotoHubSub\('etc'\)"/);
console.log(JSON.stringify({ok:true,newsCap:10,autoAdvance:true,wrap:true,pause:true,backgroundPause:true,emptyAndSingle:true,internalNavigation:true}));
