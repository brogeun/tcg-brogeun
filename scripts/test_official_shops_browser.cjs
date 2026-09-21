const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const root=path.resolve(__dirname,'..'),html=fs.readFileSync(path.join(root,'index.html'),'utf8');
const styles=[...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(m=>m[0]).join('\n');
const nodes={shopList:{innerHTML:''},shopSrc:{innerHTML:''}};
const ctx=vm.createContext({window:{},document:{getElementById:id=>nodes[id]}});
const start=html.indexOf('const SHOPS =');vm.runInContext(html.slice(start,html.indexOf('\nrenderShops();',start)),ctx);
const output=path.join(root,'debug','official-shops-fix');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
 try{
  const page=await browser.newPage();
  await page.route('**/*',async route=>{
   const u=new URL(route.request().url());
   if(u.hostname==='shops.test'&&/^\/images\/market\/[\w.-]+$/.test(u.pathname))return route.fulfill({path:path.join(root,u.pathname.slice(1))});
   return route.abort();
  });
  for(const width of [960,720,390])for(const brand of ['pokemon','onepiece','riftbound']){
   await page.setViewportSize({width,height:850});vm.runInContext(`SHOP_BRAND='${brand}';renderShops()`,ctx);
   await page.setContent(`<html><head><base href="http://shops.test/">${styles}</head><body><main style="padding:16px;width:100%;box-sizing:border-box"><div id="shopList" class="grid auto-shop">${nodes.shopList.innerHTML}</div></main></body></html>`);
   await page.locator('#shopList img').evaluateAll(imgs=>Promise.all(imgs.map(i=>i.decode())));
   const frames=await page.locator('#shopList .card > div:first-child').evaluateAll(xs=>xs.map(x=>({w:x.getBoundingClientRect().width,h:x.getBoundingClientRect().height})));
   for(const f of frames)assert(Math.abs(f.w/f.h-1.6)<0.01,'16:10 frames');
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
   const links=await page.locator('#shopList a.btn').evaluateAll(xs=>xs.map(x=>x.href));
   if(brand==='riftbound'){assert.equal(new Set(links).size,11);for(const u of links)assert.match(u,/^https:\/\/m\.place\.naver\.com\/place\/\d+\/home$/);}
   else if(brand==='pokemon'){const crop=await page.locator('#shopList img').first().evaluate(i=>({fit:getComputedStyle(i).objectFit,pos:getComputedStyle(i).objectPosition}));assert.equal(crop.fit,'cover');assert.equal(crop.pos,'50% 0%');assert.equal(await page.locator('#shopList .card').first().locator('a[href="tel:07086808510"]').count(),1);}
   assert.equal(await page.getByText('공식 안내 확인',{exact:false}).count(),0);
   const rows=await page.locator('#shopList .card').evaluateAll(cards=>cards.map(c=>{const r=c.getBoundingClientRect(),b=c.querySelector('a.btn').getBoundingClientRect(),p=c.querySelector('.shop-contact').getBoundingClientRect();return {top:Math.round(r.top),bottom:r.bottom,button:b.top,phone:p.top,gap:r.bottom-b.bottom};}));
   for(const r of rows){assert(Math.abs(r.gap-12)<1.1,'uniform bottom inset');for(const peer of rows.filter(p=>p.top===r.top)){assert(Math.abs(peer.button-r.button)<1,'aligned map buttons per row');assert(Math.abs(peer.phone-r.phone)<1,'aligned contact rows');}}
   await page.screenshot({path:path.join(output,`${brand}-${width}.png`)});
   if(brand==='pokemon'&&width===390)await page.locator('#shopList .card').first().screenshot({path:path.join(output,'gangneung-mobile.png')});
   console.log('PASS browser',brand,width,'frames',frames.length,'links',links.length);
  }
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
