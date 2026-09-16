import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const manifest=JSON.parse(read('data/anniversary-artwork.json'));
const ctx=vm.createContext({window:{},document:{readyState:'loading',addEventListener(){}}});
vm.runInContext(read('assets/card-artwork.js'),ctx);
const {geometry}=ctx.window.CardArtwork;
const dimensions=[[110,160],[165,213],[225,285],[358,288],[632,320],[320,320]];
for(const [url,art] of Object.entries(manifest.images)){
  const [l,t,r,b]=art.bounds;
  assert.ok(l>=0 && t>=0 && r<=art.width && b<=art.height && r>l && b>t,url);
  for(const [w,h] of dimensions){
    const fit=geometry(art,w,h),sx=fit.width/art.width,sy=fit.height/art.height;
    assert.ok(Math.abs(sx-sy)<1e-9,'No image distortion');
    const visible={l:fit.left+l*sx,t:fit.top+t*sy,r:fit.left+r*sx,b:fit.top+b*sy};
    assert.ok(visible.l>=0 && visible.t>=0 && visible.r<=w && visible.b<=h,'No card edge clipped');
    assert.ok(Math.abs(visible.l+visible.r-w)<1e-8 && Math.abs(visible.t+visible.b-h)<1e-8,'Centered');
    assert.ok(Math.abs((visible.r-visible.l)/w-.96)<1e-8 || Math.abs((visible.b-visible.t)/h-.96)<1e-8,'Same 96% visible-art fit');
  }
}
for(const code of ['M6a','MF']){
  for(const card of JSON.parse(read(`data/cards-by-set/${code}.json`)).cards)assert.ok(manifest.images[card.image],`${code} ${card.number}`);
}
const products=JSON.parse(read('data/anniversary-market.json')).products;
for(const product of Object.values(products))if(product.kind==='card')assert.ok(manifest.images[product.thumbnailUrl]);
const cards=JSON.parse(read('data/cards-by-set/M6a.json')).cards;
for(const number of ['128/103','129/103','131/103','R/RGB','G/RGB','B/RGB']){
  const card=cards.find(c=>c.number===number),art=manifest.images[card.image];
  assert.ok(art.bounds[0]>0,'Reported small card really contains blank padding');
  const fit=geometry(art,165,213);
  assert.ok((art.bounds[3]-art.bounds[1])*fit.height/art.height>200,'Reported cards fill the normal card area');
}
assert.ok(read('index.html').includes('/assets/card-artwork.js?v=20260916-artwork1'));
console.log(`PASS: ${Object.keys(manifest.images).length} source images, 6 desktop/mobile sizes, all catalogue/detail images covered, no clipping or stretching, reported 6 cards normalized`);

// Verify actual DOM styling, resizing and fallback restoration, not only the math.
let resizeCallback,mutationCallback;
const declarations=new Map([['padding',['4px','']]]);
const style={getPropertyValue:k=>declarations.get(k)?.[0] || '',getPropertyPriority:k=>declarations.get(k)?.[1] || '',setProperty:(k,v,p)=>declarations.set(k,[v,p])};
const example=cards.find(c=>c.number==='R/RGB');
const img={src:example.image,currentSrc:example.image,complete:true,naturalWidth:1000,style,matches:()=>true,addEventListener(){}};
const host={clientWidth:165,clientHeight:213,style:{},querySelectorAll:()=>[img]};img.parentElement=host;
const runtime=vm.createContext({window:{addEventListener(){}},document:{readyState:'complete',body:{},querySelectorAll:()=>[img]},
  fetch:async()=>({ok:true,json:async()=>manifest}),
  ResizeObserver:class{constructor(fn){resizeCallback=fn;}observe(){}unobserve(){}},
  MutationObserver:class{constructor(fn){mutationCallback=fn;}observe(){}}});
vm.runInContext(read('assets/card-artwork.js'),runtime);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(declarations.get('position')[0],'absolute');
assert.equal(declarations.get('transform')[0],'none');
assert.equal(host.style.overflow,'hidden');
const initialWidth=declarations.get('width')[0];
host.clientWidth=110;host.clientHeight=160;resizeCallback([{target:host}]);
assert.notEqual(declarations.get('width')[0],initialWidth,'Recalculate when viewport changes');
img.src=img.currentSrc='/unmeasured-fallback.png';mutationCallback([{type:'attributes',target:img}]);
assert.equal(declarations.get('padding')[0],'4px','Restore original sizing on unmeasured fallback');
assert.equal(declarations.get('position')[0],'');
console.log('PASS: DOM image fitting, viewport resize, safe original-image fallback');
