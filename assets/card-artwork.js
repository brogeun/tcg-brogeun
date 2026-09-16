/* Fit the visible artwork, not the source canvas. No artwork pixels are changed. */
(() => {
  const selector='.set-card-img img, #slideCardImg img, .px-art img';
  const properties=['position','width','height','max-width','max-height','min-width','min-height','left','top','right','bottom','padding','margin','transform','object-fit'];
  let bounds={};
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
    const art=bounds[img.currentSrc || img.src];
    if(!art || !img.complete || !img.naturalWidth){
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
    try{
      const response=await fetch('/data/anniversary-artwork.json?v=20260916-artwork1');
      if(!response.ok)return;
      const data=await response.json();
      if(data.schemaVersion!==1)return;
      bounds=data.images || {};
      scan();
      new MutationObserver(records=>{
        for(const record of records){
          if(record.type==='attributes')fit(record.target);
          else {
            for(const removed of record.removedNodes)if(removed.nodeType===1){
              if(removed.matches('.set-card-img, #slideCardImg, .px-art'))resize?.unobserve(removed);
              removed.querySelectorAll('.set-card-img, #slideCardImg, .px-art').forEach(host=>resize?.unobserve(host));
            }
            for(const added of record.addedNodes)if(added.nodeType===1)scan(added);
          }
        }
      }).observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['src']});
      window.addEventListener('resize',()=>scan());
    }catch{ /* Keep the original image visible if the framing manifest is unavailable. */ }
  }
  window.CardArtwork={geometry};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
