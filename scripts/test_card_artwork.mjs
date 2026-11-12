import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {fileURLToPath} from 'node:url';
import assetGraphTools from './helpers/app_asset_graph.cjs';
const read=file=>readFileSync(new URL('../'+file,import.meta.url),'utf8');
const manifest=JSON.parse(read('data/anniversary-artwork.json'));
const ctx=vm.createContext({window:{},URL,document:{readyState:'loading',addEventListener(){}}});
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
assetGraphTools.assetGraph(fileURLToPath(new URL('../',import.meta.url))).assertScript('card-artwork.js');
const artwork=ctx.window.CardArtwork,official='https://www.onepiece-cardgame.com/images/cardlist/card/OP01-016_p9.png';
assert.equal(artwork.source({image:official}),'/api/img?u='+encodeURIComponent(official));
assert.equal(artwork.source({thumbnailUrl:'https://cdn.snkrdunk.com/card.webp'}),'https://cdn.snkrdunk.com/card.webp');
artwork.remember('nami','/images/onepiece-official/OP01-016_p9.webp');
assert.equal(artwork.source({id:'nami',image:official}),'/images/onepiece-official/OP01-016_p9.webp','Selected printing keeps the image already displayed in the grid');
assert.equal(artwork.source({id:'another-nami',image:official}),'/api/img?u='+encodeURIComponent(official),'Different printings never inherit the selected artwork');
for(const unsafe of ['javascript:alert(1)','data:text/html,hello','https://user:secret@example.com/image.png'])assert.equal(artwork.imageURL(unsafe),'');
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

// A square marketplace photo in a regular box can hold a portrait or landscape card.
// Feed real canvas-style RGBA into the grid load path, also exercising its direct fallback.
const direct='https://cdn.snkrdunk.com/upload_bg_removed/grid-card.webp?size=m';
const proxy='/api/img?u='+encodeURIComponent(direct);
const listeners={},attrs=new Map([['src',proxy],['data-artwork-original',direct]]);
const props=new Map();
let landscape=false,opaque=false,reads=0,gridMutation;
const frame={style:{},clientWidth:180,clientHeight:252,matches:()=>true,querySelectorAll:()=>[photo]};
const photo={parentElement:frame,complete:true,naturalWidth:400,naturalHeight:400,
  get src(){return new URL(attrs.get('src'),'https://tcghub.kr').href;},
  set src(value){attrs.set('src',value);},get currentSrc(){return this.src;},
  style:{getPropertyValue:k=>props.get(k)||'',getPropertyPriority:()=>'',setProperty:(k,v)=>props.set(k,v)},
  getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v),removeAttribute:k=>attrs.delete(k),matches:()=>true,addEventListener(){}};
const canvas={getContext:()=>({drawImage(){},getImageData(){
  reads++;
  const w=canvas.width,h=canvas.height,data=new Uint8ClampedArray(w*h*4);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const mx=landscape?.1:.21,my=landscape?.21:.1;
    const inside=x>=w*mx && x<w*(1-mx) && y>=h*my && y<h*(1-my);
    const i=(y*w+x)*4;
    if(opaque && !inside)data.fill(255,i,i+3);
    data[i+3]=opaque || inside?255:0;
  }
  return {data};
}})};
const gridContext=vm.createContext({window:{},URL,URLSearchParams,
  location:{origin:'https://tcghub.kr',href:'https://tcghub.kr/'},
  document:{readyState:'complete',body:{},querySelectorAll:()=>[photo],createElement:()=>canvas,
    addEventListener:(name,fn)=>{listeners[name]=fn;}},
  fetch:async()=>({ok:false}),
  ResizeObserver:class{observe(){}unobserve(){}},
  MutationObserver:class{constructor(fn){gridMutation=fn;}observe(){}}});
vm.runInContext(read('assets/card-artwork.js'),gridContext);
const gridArt=gridContext.window.CardArtwork;
assert.equal(gridArt.original(photo),direct);
assert.equal(gridArt.gridURL(direct),direct,'reuse measured bounds without proxying a subsequent view');
assert.equal(gridArt.gridURL('https://cdn.snkrdunk.com/upload_bg_removed/other.webp'),
  '/api/img?u='+encodeURIComponent('https://cdn.snkrdunk.com/upload_bg_removed/other.webp'));
assert.equal(gridArt.gridURL('https://static.tcgcollector.com/image.jpg'),'https://static.tcgcollector.com/image.jpg');
function checkEdges(w,h){
  const scaled=parseFloat(props.get('width'));
  const x=parseFloat(props.get('left'))+scaled*(1-w)/2,y=parseFloat(props.get('top'))+scaled*(1-h)/2;
  assert.ok(x>=0 && y>=0 && x+scaled*w<=frame.clientWidth && y+scaled*h<=frame.clientHeight,'all edges visible');
  assert.ok(Math.max(scaled*w/frame.clientWidth,scaled*h/frame.clientHeight)>.93,'actual card fills the frame');
}
checkEdges(.58,.80);
gridMutation([{type:'attributes',target:photo}]);assert.equal(reads,1,'loaded source measured once');
landscape=true;opaque=true;
attrs.delete('data-artwork-original');attrs.set('src','/landscape.webp');
gridMutation([{type:'attributes',target:photo}]);checkEdges(.80,.58);
let stopped=false;
attrs.set('src',proxy);attrs.set('data-artwork-original',direct);
listeners.error({target:photo,stopImmediatePropagation:()=>{stopped=true;}});
assert.ok(stopped);assert.equal(attrs.get('src'),direct);assert.ok(!attrs.has('data-artwork-original'));
stopped=false;listeners.error({target:photo,stopImmediatePropagation:()=>{stopped=true;}});
assert.equal(stopped,false,'subsequent errors reach the original catalogue fallback');
console.log('PASS: transparent portraits, white-padded landscapes, cached bounds, proxy failures and original detail sources');
