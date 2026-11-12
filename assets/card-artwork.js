/* Fit the visible artwork, not the source canvas. No artwork pixels are changed. */
(() => {
  const gridHosts='.set-card-grid .set-card-img, .tci-grid .tci-art, .ck-card-grid .ck-art';
  // English cards are individual cells in a clipped sprite. Only direct images are fitted.
  const selector=gridHosts.split(', ').map(host=>host+' > img').concat('#slideCardImg img','.px-art img').join(', ');
  const properties=['position','width','height','max-width','max-height','min-width','min-height','left','top','right','bottom','padding','margin','transform','object-fit'];
  let bounds={};
  const measured=new Map();
  let canvas;
  const selectedArtworks=new Map();
  function imageURL(value) {
    if(typeof value!=='string'||!value)return '';
    try {
      const base=typeof location==='object'?location.origin:'https://tcghub.kr';
      const address=new URL(value,base);
      if((address.protocol!=='https:'&&!(address.protocol==='http:'&&address.origin===base))||address.username||address.password)return '';
      if(address.hostname==='www.onepiece-cardgame.com'&&address.pathname.startsWith('/images/cardlist/card/'))return '/api/img?u='+encodeURIComponent(address.href);
      return value;
    } catch {return '';}
  }
  function remember(id,image) {
    const source=imageURL(image);if(!id||!source)return;
    selectedArtworks.delete(String(id));selectedArtworks.set(String(id),source);
    if(selectedArtworks.size>128)selectedArtworks.delete(selectedArtworks.keys().next().value);
  }
  function source(product) {
    return selectedArtworks.get(String(product?.id))||imageURL(product?.localImage)||imageURL(product?.image)||imageURL(product?.thumbnailUrl)||'';
  }
  function marketPhoto(value) {
    return typeof value==='string' && /^https:\/\/cdn\.snkrdunk\.com\/upload_bg_removed\/[a-z0-9._-]+\.(?:webp|png|jpe?g)(?:[?#]|$)/i.test(value);
  }
  function gridURL(value) {
    if(!marketPhoto(value) || bounds[value] || measured.has(value))return value;
    // This CDN does not allow browser pixel reads. Load its existing same-origin
    // raster endpoint as the thumbnail itself, so inspecting it costs no second download.
    const thumbnail=window.CardThumbnails?.smaller?.(value) || value;
    return '/api/img?u='+encodeURIComponent(thumbnail);
  }
  function proxyMatches(img,direct) {
    if(!direct || !marketPhoto(direct))return false;
    const current=img.getAttribute?.('src');
    if(!current?.startsWith('/api/img?u='))return false;
    const url=new URLSearchParams(current.slice(current.indexOf('?')+1)).get('u');
    return url===direct || url===window.CardThumbnails?.smaller?.(direct);
  }
  function proxyOriginal(img) {
    const direct=img?.getAttribute?.('data-artwork-original');
    return proxyMatches(img,direct)?direct:'';
  }
  function original(img) {
    return proxyOriginal(img) || window.CardThumbnails?.original(img) || img?.currentSrc || img?.src || '';
  }
  // Use the whole image unless its transparent surround or substantial, even
  // white studio background can be separated conservatively from the card border.
  function pixelBounds(pixels,w,h) {
    let l=w,t=h,r=0,b=0,il=w,it=h,ir=0,ib=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=4*(y*w+x);
      if(!pixels[i+3])continue;
      l=Math.min(l,x);r=Math.max(r,x+1);t=Math.min(t,y);b=Math.max(b,y+1);
      if(Math.min(pixels[i],pixels[i+1],pixels[i+2])<245){
        il=Math.min(il,x);ir=Math.max(ir,x+1);it=Math.min(it,y);ib=Math.max(ib,y+1);
      }
    }
    if(r<=l || b<=t)return null;
    const ratio=(x,y)=>Math.min(x,y)/Math.max(x,y);
    const cardRatio=n=>n>=.62 && n<=.79;
    if(Math.min((r-l)/w,(b-t)/h)>.975){
      const iw=ir-il,ih=ib-it;
      if(iw<=0 || ih<=0 || !cardRatio(ratio(iw,ih)) || Math.min(iw/w,ih/h)>=.86 ||
         (cardRatio(ratio(w,h)) && Math.min(il/w,it/h,(w-ir)/w,(h-ib)/h)<=.06) ||
         Math.abs(il-(w-ir))>w*.09 || Math.abs(it-(h-ib))>h*.09)return null;
      [l,t,r,b]=[il,it,ir,ib];
    }
    return {width:w,height:h,bounds:[Math.max(0,l-1),Math.max(0,t-1),Math.min(w,r+1),Math.min(h,b+1)]};
  }
  function measure(img,key) {
    if(measured.has(key))return measured.get(key);
    try{
      const address=new URL(img.currentSrc || img.src,location.href);
      if(address.origin!==location.origin && !img.crossOrigin)return null;
      canvas ||= document.createElement('canvas');
      const scale=Math.min(1,256/Math.max(img.naturalWidth,img.naturalHeight));
      const w=Math.max(1,Math.round(img.naturalWidth*scale)),h=Math.max(1,Math.round(img.naturalHeight*scale));
      canvas.width=w;canvas.height=h;
      const ctx=canvas.getContext('2d',{willReadFrequently:true});
      ctx.imageSmoothingEnabled=false;
      ctx.drawImage(img,0,0,w,h);
      const art=pixelBounds(ctx.getImageData(0,0,w,h).data,w,h);
      if(art){
        const sx=img.naturalWidth/w,sy=img.naturalHeight/h;
        art.bounds=art.bounds.map((edge,i)=>edge*(i%2?sy:sx));
        art.width=img.naturalWidth;art.height=img.naturalHeight;
      }
      measured.set(key,art);
      if(measured.size>1024)measured.delete(measured.keys().next().value);
      return art;
    }catch{return null;}
  }
  const watched=new WeakSet(), saved=new WeakMap();
  function geometry(art,width,height) {
    const [left,top,right,bottom]=art.bounds;
    const w=right-left,h=bottom-top;
    const scale=Math.min(width*.96/w,height*.96/h);
    return {width:art.width*scale,height:art.height*scale,left:(width-w*scale)/2-left*scale,top:(height-h*scale)/2-top*scale};
  }
  function fit(img) {
    const host=img.parentElement;
    if(!host || !img.matches(selector))return;
    const key=original(img),loaded=img.complete && img.naturalWidth;
    if(loaded && img.hasAttribute?.('data-artwork-failed')){
      img.removeAttribute('data-artwork-failed');
      host.querySelector('[data-artwork-empty]')?.remove();
    }
    const art=loaded && (bounds[key] || bounds[img.currentSrc || img.src] ||
      (host.matches?.(gridHosts) && measure(img,key)));
    if(!art){
      const old=saved.get(img);
      if(old){for(const [key,value,priority] of old)img.style.setProperty(key,value,priority);saved.delete(img);}
      return;
    }
    const width=host.clientWidth,height=host.clientHeight;
    if(!width || !height)return;
    if(!saved.has(img))saved.set(img,properties.map(key=>[key,img.style.getPropertyValue(key),img.style.getPropertyPriority(key)]));
    host.style.position='relative';host.style.overflow='hidden';
    const box=geometry(art,width,height);
    const styles={position:'absolute',width:box.width+'px',height:box.height+'px',left:box.left+'px',top:box.top+'px',
      'max-width':'none','max-height':'none','min-width':'0','min-height':'0',right:'auto',bottom:'auto',padding:'0',margin:'0',transform:'none','object-fit':'fill'};
    for(const [key,value] of Object.entries(styles))img.style.setProperty(key,value,'important');
  }
  const resize=typeof ResizeObserver==='function'?new ResizeObserver(entries=>{
    for(const entry of entries)entry.target.querySelectorAll('img').forEach(fit);
  }):null;
  function scan(root=document) {
    const images=[...(root.matches?.(selector)?[root]:[]),...root.querySelectorAll(selector)];
    for(const img of images){
      if(!watched.has(img)){watched.add(img);img.addEventListener('load',()=>fit(img));}
      resize?.observe(img.parentElement);
      fit(img);
    }
  }
  async function start(){
    scan();
    new MutationObserver(records=>{
      for(const record of records){
        if(record.type==='attributes')fit(record.target);
        else {
          for(const removed of record.removedNodes)if(removed.nodeType===1){
            // Detached nodes no longer match a selector qualified by a grid ancestor.
            if(removed.matches('.set-card-img, .tci-art, .ck-art, #slideCardImg, .px-art'))resize?.unobserve(removed);
            removed.querySelectorAll('.set-card-img, .tci-art, .ck-art, #slideCardImg, .px-art').forEach(host=>resize?.unobserve(host));
          }
          for(const added of record.addedNodes)if(added.nodeType===1)scan(added);
        }
      }
    }).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
    if(!resize)window.addEventListener('resize',()=>scan());
    try{
      const response=await fetch('/data/anniversary-artwork.json?v=20260916-artwork1');
      if(!response.ok)return;
      const data=await response.json();
      if(data.schemaVersion===1){bounds=data.images || {};scan();}
    }catch{ /* Local measurement and proportional containment remain available. */ }
  }
  document.addEventListener?.('error',event=>{
    const img=event.target,direct=img?.getAttribute?.('data-artwork-original');
    if(proxyMatches(img,direct)){
      event.stopImmediatePropagation();
      img.removeAttribute('data-artwork-original');
      img.setAttribute('data-artwork-direct',direct);
      img.src=direct;
      return;
    }
    const host=img?.parentElement;
    if(!host?.matches?.(gridHosts) || !img.isConnected)return;
    const failed=img.getAttribute('src');
    // Let the catalogue's own error handlers try their exact-print alternate first.
    setTimeout(()=>{
      if(!img.isConnected || img.getAttribute('src')!==failed || !img.complete || img.naturalWidth ||
         host.querySelector('.ck-image-placeholder,[data-artwork-empty]'))return;
      const label=document.createElement('span');
      label.setAttribute('data-artwork-empty','');
      label.textContent='이미지 준비 중';
      img.setAttribute('data-artwork-failed','');
      host.append(label);
    },0);
  },true);
  window.CardArtwork={geometry,imageURL,remember,source,gridURL,original,proxyOriginal};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
