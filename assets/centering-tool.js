(function () {
  'use strict';
  const G=window.CenteringGeometry,sides=['front','back'];
  const id=name=>document.getElementById(name),$=selector=>document.querySelector(selector);
  const label=side=>side==='front'?'앞면':'뒷면';
  const cornerNames=['왼쪽 위','오른쪽 위','오른쪽 아래','왼쪽 아래'];
  const edgeNames={left:'왼쪽',right:'오른쪽',top:'위쪽',bottom:'아래쪽'};
  const empty=()=>({image:null,url:null,file:null,quad:null,rectified:null,insets:null,phase:'outer',confirmed:false,borderless:false,zoom:1,panX:0,panY:0,selected:0,step:1,fine:false,history:[],generation:0,loading:false});
  const state={front:empty(),back:empty()};
  let active='front',pickerBusy=false,analyzing=false,revision=0,lastQuota=null,bound=false;
  const gesture={points:new Map(),drag:null,pinch:null};
  const current=()=>state[active],source=s=>s.phase==='inner'?s.rectified:s.image;
  const dimensions=image=>({w:image.naturalWidth||image.width,h:image.naturalHeight||image.height});
  const show=(name,visible)=>{const el=id(name);if(el)el.hidden=!visible;};
  const put=(name,text)=>{const el=id(name);if(el)el.textContent=text;};
  const logged=()=>typeof CURRENT_USER!=='undefined'&&!!CURRENT_USER;
  const ready=()=>sides.every(side=>state[side].image&&state[side].confirmed&&!state[side].loading);
  function notice(text){put('cr-notice',text);show('cr-notice',!!text);}
  function invalidate(){revision++;if(id('centeringAIResult'))id('centeringAIResult').style.display='none';}
  function clearGesture(){gesture.points.clear();gesture.drag=null;gesture.pinch=null;}
  function handles(s){
    if(!s.image)return [];
    if(s.phase==='outer')return s.quad.map((point,key)=>({...point,key,title:cornerNames[key]}));
    if(s.borderless)return [];
    const {width:w,height:h}=s.rectified,n=s.insets;
    return [{key:'left',x:n.left*w,y:h/2},{key:'right',x:(1-n.right)*w,y:h/2},{key:'top',x:w/2,y:n.top*h},{key:'bottom',x:w/2,y:(1-n.bottom)*h}].map(p=>({...p,title:edgeNames[p.key]+' 테두리'}));
  }
  function snapshot(s){return {quad:s.quad.map(p=>({...p})),insets:s.insets?{...s.insets}:null,borderless:s.borderless};}
  function remember(s){s.history.push(snapshot(s));if(s.history.length>30)s.history.shift();}
  function dirty(){current().confirmed=false;invalidate();draw();renderMetrics();renderFine();renderActions();}
  function undo(){const s=current();if(analyzing||!s.history.length)return;Object.assign(s,s.history.pop());s.confirmed=false;invalidate();render();}
  function fit(){const s=current();s.zoom=1;s.panX=0;s.panY=0;draw();}
  function view(){
    const c=id('cr-canvas'),s=current(),r=c.getBoundingClientRect(),dim=dimensions(source(s));
    const scale=Math.min((r.width-56)/dim.w,(r.height-64)/dim.h)*s.zoom;
    return {w:dim.w,h:dim.h,scale,x:(r.width-dim.w*scale)/2+s.panX,y:(r.height-dim.h*scale)/2+s.panY,viewportWidth:r.width,viewportHeight:r.height};
  }
  function clampPan(s,v){
    const extraX=Math.max(0,(v.w*v.scale-v.viewportWidth)/2)+v.viewportWidth*.28;
    const extraY=Math.max(0,(v.h*v.scale-v.viewportHeight)/2)+v.viewportHeight*.28;
    s.panX=G.clamp(s.panX,-extraX,extraX);s.panY=G.clamp(s.panY,-extraY,extraY);
  }
  function zoomTo(value,anchor){
    const s=current();if(!s.image||analyzing)return;
    const v=view(),r=id('cr-canvas').getBoundingClientRect();
    const x=anchor?anchor.x-r.left:v.viewportWidth/2,y=anchor?anchor.y-r.top:v.viewportHeight/2;
    const sx=anchor?.sx??(x-v.x)/v.scale,sy=anchor?.sy??(y-v.y)/v.scale;
    const next=G.clamp(value,1,6),ratio=next/s.zoom;s.zoom=next;
    const scale=v.scale*ratio;
    s.panX=x-(v.viewportWidth-v.w*scale)/2-sx*scale;
    s.panY=y-(v.viewportHeight-v.h*scale)/2-sy*scale;
    if(next===1){s.panX=0;s.panY=0;}else clampPan(s,{...v,scale});
    draw();
  }
  function draw(){
    const c=id('cr-canvas'),s=current();if(!c||!s.image||c.hidden)return;
    const r=c.getBoundingClientRect();if(r.width<2||r.height<2)return;
    const dpr=Math.min(window.devicePixelRatio||1,2);
    const width=Math.round(r.width*dpr),height=Math.round(r.height*dpr);
    if(c.width!==width||c.height!==height){c.width=width;c.height=height;}
    const ctx=c.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,r.width,r.height);
    let v=view();clampPan(s,v);v=view();ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';
    ctx.drawImage(source(s),v.x,v.y,v.w*v.scale,v.h*v.scale);
    const points=handles(s),color=s.confirmed?'#8ad6bb':'#9cb6ff';ctx.lineWidth=1.5;ctx.strokeStyle=color;
    if(s.phase==='outer'){
      ctx.fillStyle='#111a2b75';ctx.beginPath();ctx.rect(0,0,r.width,r.height);
      s.quad.forEach((p,i)=>i?ctx.lineTo(v.x+p.x*v.scale,v.y+p.y*v.scale):ctx.moveTo(v.x+p.x*v.scale,v.y+p.y*v.scale));ctx.closePath();ctx.fill('evenodd');
      ctx.beginPath();s.quad.forEach((p,i)=>i?ctx.lineTo(v.x+p.x*v.scale,v.y+p.y*v.scale):ctx.moveTo(v.x+p.x*v.scale,v.y+p.y*v.scale));ctx.closePath();ctx.stroke();
    }else if(!s.borderless){
      const n=s.insets,x=v.x+n.left*v.w*v.scale,y=v.y+n.top*v.h*v.scale,w=(1-n.left-n.right)*v.w*v.scale,h=(1-n.top-n.bottom)*v.h*v.scale;
      ctx.strokeRect(x,y,w,h);ctx.setLineDash([3,5]);ctx.lineWidth=.5;ctx.strokeStyle='#ffffff50';
      ctx.beginPath();ctx.moveTo(v.x+v.w*v.scale/2,v.y);ctx.lineTo(v.x+v.w*v.scale/2,v.y+v.h*v.scale);ctx.moveTo(v.x,v.y+v.h*v.scale/2);ctx.lineTo(v.x+v.w*v.scale,v.y+v.h*v.scale/2);ctx.stroke();ctx.setLineDash([]);
    }
    if(!s.confirmed)for(const p of points){
      const x=v.x+p.x*v.scale,y=v.y+p.y*v.scale,selected=p.key===s.selected;
      // Keep the exact corner visible; the larger invisible touch target is independent.
      const arm=selected?13:10,gap=3;
      ctx.beginPath();ctx.moveTo(x-arm,y);ctx.lineTo(x-gap,y);ctx.moveTo(x+gap,y);ctx.lineTo(x+arm,y);ctx.moveTo(x,y-arm);ctx.lineTo(x,y-gap);ctx.moveTo(x,y+gap);ctx.lineTo(x,y+arm);
      ctx.lineWidth=4;ctx.strokeStyle='#101a2de6';ctx.stroke();
      ctx.lineWidth=1.5;ctx.strokeStyle=selected?'#a3f2ff':'#fff';ctx.stroke();
    }
    put('cr-zoom-value',s.zoom===1?'맞춤':Math.round(s.zoom*100)+'%');
    drawLoupe();
  }
  function drawLoupe(){
    const s=current(),visible=!!s.image&&!s.confirmed&&!s.borderless;
    show('cr-loupe',visible);if(!visible)return;
    const p=handles(s).find(p=>p.key===s.selected);if(!p)return;
    id('cr-loupe').querySelector('span').textContent=(s.phase==='outer'?cornerNames[s.selected]:edgeNames[s.selected]+' 테두리')+' · 8×';
    const c=id('cr-loupe-canvas'),ctx=c.getContext('2d'),span=c.getBoundingClientRect().width/8;
    ctx.fillStyle='#273044';ctx.fillRect(0,0,144,144);ctx.imageSmoothingEnabled=false;
    ctx.drawImage(source(s),p.x-span/2,p.y-span/2,span,span,0,0,144,144);
    ctx.beginPath();ctx.moveTo(72,0);ctx.lineTo(72,68);ctx.moveTo(72,76);ctx.lineTo(72,144);ctx.moveTo(0,72);ctx.lineTo(68,72);ctx.moveTo(76,72);ctx.lineTo(144,72);
    ctx.strokeStyle='#101a2d';ctx.lineWidth=3;ctx.stroke();ctx.lineWidth=1;ctx.strokeStyle='#a3f2ff';ctx.stroke();
  }
  function gate(){show('centeringLoginGate',!logged());show('centeringMain',logged());}
  function render(){
    if(!id('cr-canvas'))return;gate();const s=current(),has=!!s.image,any=sides.some(side=>state[side].image);
    document.querySelectorAll('[data-side-tab]').forEach(button=>{const side=button.dataset.sideTab;button.setAttribute('aria-selected',String(side===active));button.dataset.complete=String(state[side].confirmed);button.disabled=analyzing;});
    id('cr-editor').setAttribute('aria-labelledby',`cr-${active}-tab`);
    for(const side of sides)putSideStatus(side);
    document.querySelectorAll('[data-flow]').forEach(el=>{if(el.dataset.flow===(!has?'photo':s.confirmed?'result':'edit'))el.setAttribute('aria-current','step');else el.removeAttribute('aria-current');});
    document.querySelector('[data-action="reset"]').hidden=!any;
    document.querySelector('[data-action="replace"]').hidden=!has;
    show('cr-empty',!has);show('cr-canvas',has);show('cr-stage-label',has);show('cr-zoom',has);show('cr-edit-tools',has&&!s.confirmed&&!s.borderless);show('cr-action-area',has);show('cr-secondary-actions',has);show('cr-loading',s.loading);show('cr-loupe',has&&!s.confirmed&&!s.borderless);
    id('cr-editor').classList.toggle('has-image',has);put('cr-empty-title',label(active)+' 사진을 선택하세요');
    id('cr-edit-tools').classList.toggle('has-metrics',has&&s.phase==='inner'&&!s.borderless);show('cr-mobile-live',has&&s.phase==='inner'&&!s.borderless);
    put('cr-stage-title',s.confirmed?'측정 완료':s.phase==='outer'?'카드 바깥선':'안쪽 테두리');
    show('cr-guide',!has||s.phase==='outer');show('cr-results',has&&s.phase==='inner');show('cr-saved',any);show('cr-ai',sides.some(side=>state[side].confirmed));
    const guide=id('cr-guide');guide.querySelector('h2').innerHTML=has?'네 점을<br>모서리에 맞춰 주세요.':'좋은 사진이<br>좋은 측정의 시작.';
    renderFine();renderMetrics();renderActions();renderSaved();updateButton();draw();
  }
  function putSideStatus(side){const s=state[side];document.querySelector(`[data-side-status="${side}"]`).textContent=s.loading?'불러오는 중':s.confirmed?'✓ 완료':s.image?'조정 중':'사진 없음';}
  function renderFine(){
    const s=current(),editing=!!s.image&&!s.confirmed&&!s.borderless;show('cr-fine',editing);
    const toggle=$('[data-action="fine"]');toggle.hidden=true;toggle.setAttribute('aria-expanded',String(editing));
    const select=id('cr-selected'),points=handles(s),signature=s.phase+':'+points.map(p=>p.key).join(',');
    if(select.dataset.phase!==signature){select.replaceChildren(...points.map(p=>{const option=document.createElement('option');option.value=p.key;option.textContent=p.title;return option;}));select.dataset.phase=signature;}
    select.value=String(s.selected);id('cr-step').value=s.step;
    document.querySelectorAll('[data-nudge]').forEach(b=>{const vertical=['up','down'].includes(b.dataset.nudge);b.hidden=s.phase==='inner'&&(vertical===['left','right'].includes(s.selected));});
    const undoButton=$('[data-action="undo"]');if(undoButton)undoButton.disabled=analyzing||!s.history.length;
  }
  function renderMetrics(){
    const s=current();if(!s.image||s.phase!=='inner')return;
    const m=G.measure(s.insets,!s.borderless),status=id('cr-result-status');
    id('cr-edit-tools').classList.toggle('has-metrics',!!m);show('cr-mobile-live',!!m);
    status.textContent=s.confirmed?'확인 완료':'조정 중';status.dataset.confirmed=String(s.confirmed);
    put('cr-result-caption',s.borderless?'테두리를 정의하기 어려운 카드입니다. 센터링 수치는 제외합니다.':s.confirmed?label(active)+' · 확인한 경계를 기준으로 측정했어요.':'선을 옮기면 비율도 함께 바뀝니다.');
    show('cr-ratios',!!m);show('cr-dimensions',!!m);show('cr-reference',!!m);
    if(!m)return;
    put('cr-lr',`${m.lPct} : ${m.rPct}`);put('cr-tb',`${m.tPct} : ${m.bPct}`);
    put('cr-live-lr',`${m.lPct}:${m.rPct}`);put('cr-live-tb',`${m.tPct}:${m.bPct}`);
    id('cr-lr-bar').style.width=m.lPct+'%';id('cr-tb-bar').style.width=m.tPct+'%';
    const limit=active==='front'?55:75,worst=Math.max(m.lPct,m.rPct,m.tPct,m.bPct);
    put('cr-reference',s.confirmed?`PSA 10 센터링 참고치 ${limit}:${100-limit} ${worst<=limit?'이내':'초과'}`:'조정 중인 비율입니다. 선 위치를 확인한 뒤 측정을 완료해 주세요.');
    put('cr-mm',`왼쪽 ${m.lMm} / 오른쪽 ${m.rMm}mm · 위 ${m.tMm} / 아래 ${m.bMm}mm`);
  }
  function renderActions(){
    const s=current(),other=active==='front'?'back':'front';
    if(!s.image)return;
    put('cr-action-title',s.confirmed?label(active)+' 측정 완료':s.phase==='outer'?'네 모서리가 카드에 맞나요?':s.borderless?'이 면은 센터링을 제외합니다.':'안쪽 선을 테두리에 맞춰 주세요.');
    put('cr-action-copy',s.confirmed?'다른 면도 이어서 측정하거나 사진 상태를 분석할 수 있어요.':s.phase==='outer'?'확대창을 보며 십자선 중심을 맞추세요. 방향 버튼으로 1px씩 옮길 수 있어요.':s.borderless?'센터링 없이 모서리·엣지·표면을 AI로 살펴볼 수 있어요.':'그림과 바깥 테두리가 만나는 곳에 선을 맞추세요.');
    put('cr-next',s.confirmed?(state[other].confirmed?'AI로 사진 상태 분석':label(other)+(state[other].image?' 이어서 측정':' 사진 추가')):s.phase==='outer'?'이 영역으로 계속':'측정 완료');
    $('[data-action="outer"]').hidden=s.phase!=='inner'||s.confirmed;
    const borderless=$('[data-action="borderless"]');borderless.hidden=s.phase!=='inner'||s.confirmed;borderless.setAttribute('aria-pressed',String(s.borderless));borderless.textContent=s.borderless?'✓ 테두리 없는 카드 · 다시 변경':'안쪽 테두리가 없는 카드';
    $('[data-action="edit"]').hidden=!s.confirmed;
    const undoButton=$('[data-action="undo"]');if(undoButton)undoButton.disabled=analyzing||!s.history.length;
  }
  function renderSaved(){
    const count=sides.filter(side=>state[side].confirmed).length;put('cr-saved-count',count+' / 2');
    for(const side of sides){const s=state[side],m=G.measure(s.insets,s.confirmed&&!s.borderless);$(`[data-summary-value="${side}"]`).textContent=s.confirmed?(m?`좌우 ${m.lPct}:${m.rPct} · 상하 ${m.tPct}:${m.bPct}`:'센터링 제외'):s.image?'경계 확인 필요':'아직 측정 전';}
  }
  function updateButton(){
    const root=$('section[data-page="centering"]');if(!root)return;
    root.querySelectorAll('button,input,select').forEach(el=>{el.disabled=analyzing;});
    const s=current();id('cr-next').disabled=analyzing||s.loading;
    id('centeringAIBtn').disabled=!ready()||analyzing;
    put('centeringAIBtn',analyzing?'사진을 분석하고 있어요…':ready()?'AI로 사진 상태 분석':'앞·뒷면 측정 후 이용');
    put('centeringReadyHint',lastQuota?`오늘 ${lastQuota.used} / ${lastQuota.limit}회 사용`:'계정당 하루 3회 무료');
    const undoButton=$('[data-action="undo"]');if(undoButton)undoButton.disabled=analyzing||!s.history.length;
  }
  function switchSide(side){if(analyzing||!sides.includes(side))return;clearGesture();active=side;notice('');render();}
  function canvasFor(image,maxDim,crop){const region=crop||{x:0,y:0,width:image.naturalWidth,height:image.naturalHeight},c=document.createElement('canvas'),scale=Math.min(1,maxDim/Math.max(region.width,region.height));c.width=Math.max(1,Math.round(region.width*scale));c.height=Math.max(1,Math.round(region.height*scale));const ctx=c.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.imageSmoothingEnabled=true;ctx.imageSmoothingQuality='high';ctx.drawImage(image,region.x,region.y,region.width,region.height,0,0,c.width,c.height);return c;}
  async function pick(side,sourceName){
    if(pickerBusy||analyzing)return;
    const input=$(`[data-centering-file="${side}${sourceName==='camera'?'-camera':''}"]`),cap=window.Capacitor,camera=cap?.Plugins?.Camera;
    if(!cap?.isNativePlatform?.()||!camera?.getPhoto){input.value='';input.click();return;}
    pickerBusy=true;
    try{const photo=await camera.getPhoto({source:sourceName==='camera'?'CAMERA':'PHOTOS',resultType:'uri',quality:100,correctOrientation:true,saveToGallery:false});if(!photo.webPath)throw new Error('no photo');const response=await fetch(photo.webPath);if(!response.ok)throw new Error('read failed');const blob=await response.blob();await load(side,new File([blob],`${side}.${photo.format||'jpeg'}`,{type:blob.type||'image/jpeg'}));}
    catch(e){if(!/cancel|취소/i.test(String(e?.message))&&!['OS-PLUG-CAMR-0006','OS-PLUG-CAMR-0020'].includes(e?.code))notice('사진을 열지 못했어요. 사진·카메라 접근 권한을 확인해 주세요.');}
    finally{pickerBusy=false;}
  }
  let heicLoader=null;
  async function load(side,file){
    if(analyzing||!sides.includes(side))return;
    if(!file||file.size>40*1024*1024){notice('40MB 이하의 사진을 선택해 주세요.');return;}
    const generation=++state[side].generation;state[side].loading=true;active=side;clearGesture();notice('');render();let url=null;
    try{
      if(/\.(heic|heif)$/i.test(file.name)||/heic|heif/i.test(file.type)){
        if(!window.heic2any){if(!heicLoader)heicLoader=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';script.onload=resolve;script.onerror=()=>{heicLoader=null;reject(new Error('사진 변환기를 불러오지 못했어요. JPEG 또는 PNG를 선택해 주세요.'));};document.head.appendChild(script);});await heicLoader;}
        let converted=await window.heic2any({blob:file,toType:'image/jpeg',quality:.95});file=Array.isArray(converted)?converted[0]:converted;
      }
      url=URL.createObjectURL(file);const image=new Image();await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=()=>reject(new Error('사진을 읽지 못했어요. JPEG 또는 PNG 사진을 다시 선택해 주세요.'));image.src=url;});
      if(generation!==state[side].generation){URL.revokeObjectURL(url);return;}
      const w=image.naturalWidth,h=image.naturalHeight;
      if(w<200||h<200||w*h>50000000)throw new Error('200픽셀 이상, 5천만 화소 이하의 선명한 사진을 선택해 주세요.');
      const sample=canvasFor(image,480),found=G.detectOuter(sample.getContext('2d').getImageData(0,0,sample.width,sample.height));
      const quad=found?found.quad.map(p=>({x:p.x*w/sample.width,y:p.y*h/sample.height})):[{x:w*.12,y:h*.1},{x:w*.88,y:h*.1},{x:w*.88,y:h*.9},{x:w*.12,y:h*.9}];
      if(state[side].url)URL.revokeObjectURL(state[side].url);
      state[side]={...empty(),image,url,file,quad,generation};url=null;invalidate();
      if(!found&&active===side)notice('카드 바깥선을 찾기 어려워요. 네 점을 실제 모서리에 맞춰 주세요.');
    }catch(e){if(url)URL.revokeObjectURL(url);if(generation===state[side].generation)notice(e.message||'사진을 준비하지 못했어요. 다른 사진을 선택해 주세요.');}
    finally{if(generation===state[side].generation){state[side].loading=false;render();}}
  }
  function rectify(side=active){
    const s=state[side];if(analyzing||!s.image||s.loading)return false;
    if(!G.validQuad(s.quad,s.image.naturalWidth,s.image.naturalHeight)){notice('네 점이 서로 겹치지 않도록 카드 모서리에 맞춰 주세요.');return false;}
    try{
      const plan=G.planRectification(s.quad,s.image.naturalWidth,s.image.naturalHeight),original=canvasFor(s.image,4096,plan.crop),{quad,width,height}=plan;
      const pixels=G.warp(original.getContext('2d').getImageData(0,0,original.width,original.height),quad,width,height),c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').putImageData(new ImageData(pixels.data,width,height),0,0);
      s.rectified=c;s.phase='inner';s.selected='left';s.zoom=1;s.panX=s.panY=0;s.confirmed=false;s.borderless=false;s.fine=false;s.history=[];clearGesture();
      const proposed=G.detectInner(pixels);s.insets=proposed||{left:.04,right:.04,top:.04,bottom:.04};invalidate();
      notice(!proposed?'안쪽 테두리를 정확히 찾지 못했어요. 파란 선을 직접 맞추거나 테두리 없는 카드를 선택해 주세요.':width<480?'카드가 작게 찍혔어요. 센터링은 조정할 수 있지만 세부 상태 분석에는 더 큰 사진이 좋아요.':'');render();return true;
    }catch(e){notice(e.message||'각도 보정에 실패했어요. 모서리를 다시 맞춰 주세요.');return false;}
  }
  function next(){
    const s=current();if(analyzing||s.loading)return;
    if(s.phase==='outer'){rectify();return;}
    if(!s.confirmed){s.confirmed=true;s.fine=false;s.history=[];clearGesture();invalidate();notice('');render();return;}
    const other=active==='front'?'back':'front';if(state[other].confirmed)analyze();else{switchSide(other);if(!state[other].image)pick(other,'album');}
  }
  function moveHandle(key,x,y,record=true){
    const s=current();if(analyzing||s.confirmed||s.borderless)return false;
    if(s.phase==='outer'){
      const dim=dimensions(s.image),next=s.quad.map(p=>({...p}));next[key]={x:G.clamp(x,0,dim.w-1),y:G.clamp(y,0,dim.h-1)};
      if(!G.validQuad(next,dim.w,dim.h)||Math.hypot(next[key].x-s.quad[key].x,next[key].y-s.quad[key].y)<1e-5)return false;
      if(record)remember(s);s.quad=next;
    }else{
      const {width:w,height:h}=s.rectified,value=G.clamp(key==='left'?x/w:key==='right'?1-x/w:key==='top'?y/h:1-y/h,.005,.2);
      if(Math.abs(value-s.insets[key])<1e-8)return false;if(record)remember(s);s.insets[key]=value;
    }
    dirty();return true;
  }
  function nudge(dx,dy,multiplier=1){const s=current(),point=handles(s).find(p=>p.key===s.selected);if(point)moveHandle(point.key,point.x+dx*s.step*multiplier,point.y+dy*s.step*multiplier);}
  function bindCanvas(){
    const c=id('cr-canvas');
    const point=e=>{const v=view(),r=c.getBoundingClientRect();return {x:(e.clientX-r.left-v.x)/v.scale,y:(e.clientY-r.top-v.y)/v.scale};};
    const pinch=()=>{const [a,b]=[...gesture.points.values()],x=(a.x+b.x)/2,y=(a.y+b.y)/2,p=point({clientX:x,clientY:y});return {distance:Math.max(1,Math.hypot(a.x-b.x,a.y-b.y)),zoom:current().zoom,sx:p.x,sy:p.y,x,y};};
    c.onpointerdown=e=>{
      const s=current();if(!s.image||analyzing||s.loading||(e.pointerType==='mouse'&&e.button!==0))return;
      e.preventDefault();c.focus({preventScroll:true});c.setPointerCapture(e.pointerId);gesture.points.set(e.pointerId,{x:e.clientX,y:e.clientY});
      if(gesture.points.size>=2){gesture.drag=null;gesture.pinch=pinch();show('cr-loupe',false);return;}
      const p=point(e),v=view();let closest=null,distance=28;
      if(!s.confirmed)for(const h of handles(s)){const d=Math.hypot((h.x-p.x)*v.scale,(h.y-p.y)*v.scale);if(d<distance){distance=d;closest=h;}}
      if(closest){s.selected=closest.key;gesture.drag={key:closest.key,dx:closest.x-p.x,dy:closest.y-p.y,recorded:false};renderFine();draw();}
      else{gesture.drag={pan:true,x:e.clientX,y:e.clientY};c.style.cursor='grabbing';}
    };
    c.onpointermove=e=>{
      if(!gesture.points.has(e.pointerId)||analyzing)return;e.preventDefault();gesture.points.set(e.pointerId,{x:e.clientX,y:e.clientY});
      const s=current();if(gesture.pinch&&gesture.points.size>=2){const next=pinch(),start=gesture.pinch;zoomTo(start.zoom*next.distance/start.distance,{x:next.x,y:next.y,sx:start.sx,sy:start.sy});return;}
      const drag=gesture.drag;if(!drag)return;
      if(drag.pan){s.panX+=e.clientX-drag.x;s.panY+=e.clientY-drag.y;drag.x=e.clientX;drag.y=e.clientY;clampPan(s,view());draw();return;}
      const p=point(e);if(moveHandle(drag.key,p.x+drag.dx,p.y+drag.dy,!drag.recorded))drag.recorded=true;
    };
    const end=e=>{gesture.points.delete(e.pointerId);gesture.drag=null;if(gesture.points.size<2)gesture.pinch=null;c.style.cursor='crosshair';drawLoupe();};
    c.onpointerup=c.onpointercancel=c.onlostpointercapture=end;
    c.onkeydown=e=>{const s=current(),delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[e.key];if(delta){e.preventDefault();nudge(...delta,e.shiftKey?10:1);}else if(/^[1-4]$/.test(e.key)){const p=handles(s)[Number(e.key)-1];if(p){s.selected=p.key;renderFine();draw();}}else if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='z'){e.preventDefault();undo();}};
    c.addEventListener('wheel',e=>{if(!current().image||analyzing)return;e.preventDefault();zoomTo(current().zoom*Math.exp(-G.clamp(e.deltaY,-160,160)*.002),{x:e.clientX,y:e.clientY});},{passive:false});
    if(window.ResizeObserver)new ResizeObserver(draw).observe(id('cr-editor'));
  }
  function exportImage(side){const s=state[side];if(!s.image||!s.rectified||!s.confirmed)throw new Error('앞·뒷면 경계를 먼저 확인해 주세요.');return s.rectified.toDataURL('image/jpeg',.94).split(',')[1];}
  function exportDetailImage(side){
    const s=state[side];if(!s?.image||!s.confirmed)throw new Error('앞·뒷면 경계를 먼저 확인해 주세요.');
    const plan=G.planCornerDetails(s.quad,s.image.naturalWidth,s.image.naturalHeight),sheet=document.createElement('canvas');sheet.width=plan.width;sheet.height=plan.height;
    const context=sheet.getContext('2d');context.fillStyle='#fff';context.fillRect(0,0,sheet.width,sheet.height);
    context.font='11px sans-serif';context.textBaseline='top';context.fillStyle='#202b3c';
    for(const tile of plan.tiles){
      // Read each region straight from the original, never the editor or reduced whole-card canvas.
      const original=canvasFor(s.image,4096,tile.crop),pixels=original.getContext('2d').getImageData(0,0,original.width,original.height);
      const warped=G.warp(pixels,tile.quad,tile.size,tile.size);
      context.putImageData(new ImageData(warped.data,tile.size,tile.size),tile.x,tile.y);
      context.fillText(label(side)+' · '+cornerNames[tile.sourceCorner],tile.x+4,tile.y-plan.labelHeight+2,Math.max(1,plan.cellSize-8));
    }
    return {image:sheet.toDataURL('image/jpeg',.94).split(',')[1],width:sheet.width,height:sheet.height,nativeTileSizes:plan.tiles.map(tile=>tile.size)};
  }
  function renderReviewMeasurements(measurements){
    const values=measurements||Object.fromEntries(sides.map(side=>[side,G.measure(state[side].insets,!state[side].borderless&&state[side].confirmed)]));
    let count=0;
    for(const side of sides){
      const m=values[side],valid=m?.version===2&&m.confirmed===true&&['lPct','rPct','tPct','bPct'].every(key=>Number.isFinite(m[key]));
      const el=$(`[data-review-measurement="${side}"]`);if(el)el.textContent=valid?`좌우 ${m.lPct}:${m.rPct} · 상하 ${m.tPct}:${m.bPct}`:'센터링 측정 제외';
      if(valid)count++;
    }
    show('centeringAIMeasurements',count>0);return count;
  }
  function renderDetailedReport(result){
    const host=id('centeringAIReport');if(!host)return false;host.replaceChildren();host.hidden=true;
    if(!result?.cardIdentity||!result?.categoryReports)return false;
    const node=(tag,text,className)=>{const el=document.createElement(tag);if(text)el.textContent=text;if(className)el.className=className;return el;};
    const identity=result.cardIdentity,card=node('article',null,'cr-identity');
    const known=identity.confidence==='identified',tentative=identity.confidence==='tentative';
    card.append(node('span',known?'사진에서 식별한 카드':tentative?'사진 기반 추정 식별':'카드 식별 보류','cr-card-state'));
    card.append(node('h3',(known||tentative)&&identity.name?identity.name:'카드 이름 확인 어려움','cr-card-title'));
    const meta=[identity.game,identity.set,identity.number?`카드 번호 ${identity.number}`:'',identity.language].filter(x=>typeof x==='string'&&x.trim()).join(' · ');
    if(meta)card.append(node('p',meta,'cr-card-meta'));
    if(identity.evidence)card.append(node('p',identity.evidence));host.append(card);
    if(result.summary){const summary=node('section');summary.append(node('h3','전체적으로 보면'),node('p',result.summary));host.append(summary);}
    const areas=node('section');areas.append(node('h3','부위별 상세 분석'));
    for(const [key,title] of [['centering','센터링'],['corners','모서리'],['edges','엣지'],['surface','표면']]){
      const report=result.categoryReports[key];if(!report)continue;
      const area=node('section');area.dataset.reportArea=key;area.append(node('h4',title));
      const grid=node('div',null,'cr-area-grid');
      for(const [side,label] of [['front','앞면'],['back','뒷면']]){const item=node('div');item.append(node('span',label,'cr-area-side'),node('p',report[side]||'이 면의 관찰 결과가 없습니다.'));grid.append(item);}
      area.append(grid);if(report.assessment)area.append(node('p',report.assessment,'cr-area-verdict'));
      const evidence=result.scoreEvidence?.[key];
      if(evidence?.confirmedDefects?.length){
        const confirmed=node('div',null,'cr-evidence-list');confirmed.append(node('span','확인한 감점 근거','cr-evidence-title'));const list=node('ul');
        const locations={top_left:'왼쪽 위',top_right:'오른쪽 위',bottom_left:'왼쪽 아래',bottom_right:'오른쪽 아래',top_edge:'위쪽 변',right_edge:'오른쪽 변',bottom_edge:'아래쪽 변',left_edge:'왼쪽 변',center:'중앙',upper_surface:'위쪽 표면',lower_surface:'아래쪽 표면',other:'그 외 위치'};
        evidence.confirmedDefects.forEach(defect=>list.append(node('li',`${defect.side==='front'?'앞면':'뒷면'} · ${locations[defect.location]||defect.location}: ${defect.evidence}`)));confirmed.append(list);area.append(confirmed);
      }
      if(evidence?.uncertainties?.length){
        const uncertain=node('div',null,'cr-uncertainty');uncertain.append(node('span','불확실한 흔적 · 감점 없음','cr-evidence-title'));const list=node('ul');
        evidence.uncertainties.forEach(text=>list.append(node('li',text)));uncertain.append(list);area.append(uncertain);
      }
      areas.append(area);
    }
    host.append(areas);
    const takeaways=node('section',null,'cr-takeaways');
    for(const [key,title] of [['strengths','확인한 강점'],['concerns','확인한 주의점']]){
      const group=node('div');group.append(node('h3',title));const items=(result[key]||[]).filter(x=>typeof x==='string'&&x.trim());
      if(items.length){const list=node('ul');items.forEach(text=>list.append(node('li',text)));group.append(list);}else group.append(node('p','구체적으로 확인된 내용이 없습니다.'));takeaways.append(group);
    }
    host.append(takeaways);
    host.hidden=false;return true;
  }
  function renderResult(data){
    const result=data.analysis,wrap=id('centeringAIResult');wrap.style.display='';
    const measured=renderReviewMeasurements(data.measurements),evidencePolicy=data.scorePolicy?.version==='photo-evidence-v1';
    show('centeringAIScorePolicy',evidencePolicy);
    const detailCount=data.imageReview?.cornerViews;
    put('centeringAIInputNote',Number.isInteger(detailCount)&&detailCount>0?`앞·뒷면 전체와 원본 모서리 확대 ${detailCount}곳을 함께 확인했습니다.`:data.imageReview?.wholeImages===2?'앞·뒷면 전체 사진으로 확인했습니다.':'');
    for(const key of ['centering','corners','edges','surface','final']){
      const el=wrap.querySelector(`[data-score="${key}"]`),reason=wrap.querySelector(`[data-score-reason="${key}"]`),value=result?.scores?.[key];
      if(el)el.textContent=typeof value==='number'?value.toFixed(1):key==='centering'?(measured===2?'측정 완료':measured?'일부 측정':'측정 제외'):key==='final'?'종합 미산정':'확인 어려움';
      if(reason)reason.textContent=result?.limitations?.[key]||(key==='centering'?(typeof value==='number'?(evidencePolicy?'확인한 비율에 따른 앱 참고 점수':'측정값과 사진에 근거한 참고 점수'):measured?'확인한 경계의 비율':'확인한 센터링 측정값 없음'):typeof value==='number'?(evidencePolicy?(key==='final'?'네 항목 중 가장 낮은 참고 점수':'확인된 결함만 감점'):'사진에서 보이는 범위'):key==='final'?'일부 항목 미산정으로 종합 점수 없음':'이 사진으로 세부 확인 어려움');
    }
    const hasScores=['corners','edges','surface'].some(key=>typeof result?.scores?.[key]==='number');
    put('centeringAIStatus',result?.status==='ready'?'사진 상태 분석 완료':measured||hasScores?'확인 가능한 항목 분석 완료':'판독 범위 확인 완료');
    const finalScore=result?.scores?.final;
    wrap.querySelector('[data-score-grade="final"]').textContent=typeof finalScore==='number'?`종합 사진 참고 점수 ${finalScore.toFixed(1)}점 · 네 항목 중 가장 낮은 점수입니다.`:'확인 가능한 항목의 결과를 정리했습니다.';
    const detailed=renderDetailedReport(result),legacy=id('centeringAIText');legacy.hidden=detailed;legacy.textContent=detailed?'':[result?.summary,...(result?.observations||[])].filter(Boolean).join('\n\n');lastQuota=data.quota||null;
    wrap.scrollIntoView({block:'nearest',behavior:'auto'});
  }
  async function analyze(){
    if(analyzing||!ready())return;
    if(!logged()){if(typeof openLoginModal==='function')openLoginModal('AI 분석은 로그인 후 이용할 수 있습니다.');return;}
    const requestRevision=revision;analyzing=true;updateButton();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),80000);
    try{
      const response=await fetch('/api/centering-ai',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({analysisVersion:2,frontImage:exportImage('front'),backImage:exportImage('back'),detailImages:{version:1,...Object.fromEntries(sides.map(side=>[side,exportDetailImage(side)]))},frontMetrics:G.measure(state.front.insets,!state.front.borderless&&state.front.confirmed),backMetrics:G.measure(state.back.insets,!state.back.borderless&&state.back.confirmed),imageInfo:Object.fromEntries(sides.map(side=>[side,{originalWidth:state[side].image.naturalWidth,originalHeight:state[side].image.naturalHeight,width:state[side].rectified.width,height:state[side].rectified.height,borderless:state[side].borderless}]))})});
      const data=await response.json().catch(()=>{throw new Error('분석 결과를 읽지 못했어요. 잠시 후 다시 시도해 주세요.');});if(requestRevision!==revision)return;
      if(!response.ok||data.error)throw new Error(data.message||'분석을 완료하지 못했어요. 잠시 후 다시 시도해 주세요.');
      if(!data.analysis)throw new Error('분석 결과를 읽지 못했어요. 다시 시도해 주세요.');renderResult(data);
    }catch(e){if(requestRevision===revision){const wrap=id('centeringAIResult');wrap.style.display='';renderDetailedReport(null);show('centeringAIScorePolicy',false);put('centeringAIInputNote','');id('centeringAIText').hidden=false;id('centeringAIText').textContent=e.name==='AbortError'?'분석 시간이 초과되었어요. 잠시 후 다시 시도해 주세요.':e.message;wrap.querySelectorAll('[data-score]').forEach(el=>el.textContent='—');wrap.querySelectorAll('[data-score-reason]').forEach(el=>el.textContent='');const measured=renderReviewMeasurements();if(measured)wrap.querySelector('[data-score="centering"]').textContent=measured===2?'측정 완료':'일부 측정';put('centeringAIStatus','AI 분석을 완료하지 못했습니다');wrap.querySelector('[data-score-grade="final"]').textContent=measured?'확인한 센터링 측정값은 유지됩니다.':'';}}
    finally{clearTimeout(timer);analyzing=false;updateButton();}
  }
  function reset(){if(analyzing)return;clearGesture();sides.forEach(side=>{const s=state[side];if(s.url)URL.revokeObjectURL(s.url);state[side]={...empty(),generation:s.generation+1};});active='front';document.querySelectorAll('[data-centering-file]').forEach(input=>input.value='');invalidate();notice('');render();}
  function action(name){
    if(analyzing)return;const s=current();
    if(name==='album'||name==='camera')pick(active,name);
    else if(name==='replace')pick(active,'album');
    else if(name==='next')next();
    else if(name==='zoom-in')zoomTo(s.zoom*1.35);
    else if(name==='zoom-out')zoomTo(s.zoom/1.35);
    else if(name==='fit')fit();
    else if(name==='fine'){s.fine=!s.fine;renderFine();drawLoupe();}
    else if(name==='undo')undo();
    else if(name==='outer'){s.phase='outer';s.borderless=false;s.selected=0;s.fine=false;s.history=[];s.confirmed=false;clearGesture();fit();invalidate();notice('');render();}
    else if(name==='borderless'){remember(s);s.borderless=!s.borderless;dirty();render();}
    else if(name==='edit'){s.confirmed=false;s.fine=false;invalidate();render();}
    else if(name==='reset')reset();
    else if(name==='login'&&typeof openLoginModal==='function')openLoginModal('로그인 후 센터링을 이용해 주세요.');
  }
  function setup(){
    if(!id('cr-canvas'))return;
    if(!bound){bound=true;
      const root=$('section[data-page="centering"]');root.addEventListener('click',e=>{const b=e.target.closest('button');if(!b||b.disabled)return;if(b.dataset.action)action(b.dataset.action);else if(b.dataset.sideTab)switchSide(b.dataset.sideTab);else if(b.dataset.summarySide)switchSide(b.dataset.summarySide);else if(b.dataset.nudge){const d={up:[0,-1],left:[-1,0],right:[1,0],down:[0,1]}[b.dataset.nudge];nudge(...d);}});
      root.querySelectorAll('[data-side-tab]').forEach(b=>b.onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();switchSide(active==='front'?'back':'front');$(`[data-side-tab="${active}"]`).focus();}});
      document.querySelectorAll('[data-centering-file]').forEach(input=>input.onchange=e=>{const file=e.target.files?.[0];if(file)load(input.dataset.centeringFile.replace('-camera',''),file);});
      id('cr-selected').onchange=e=>{current().selected=current().phase==='outer'?Number(e.target.value):e.target.value;draw();renderFine();};
      id('cr-step').onchange=e=>{current().step=Number(e.target.value);};
      const stage=id('cr-editor');stage.ondragover=e=>{e.preventDefault();stage.classList.add('is-drop');};stage.ondragleave=e=>{if(!stage.contains(e.relatedTarget))stage.classList.remove('is-drop');};stage.ondrop=e=>{e.preventDefault();stage.classList.remove('is-drop');const file=e.dataTransfer.files?.[0];if(file)load(active,file);};
      id('centeringAIBtn').onclick=analyze;bindCanvas();
    }
    render();
  }
  window.CenteringTool={setup,load,pick,reset,analyze,state,exportImage,rectify,switchSide,zoomTo,undo,get active(){return active;},getView:view};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup);else setup();
  window.addEventListener('hashchange',()=>{if(location.hash.includes('centering'))setup();});
})();
