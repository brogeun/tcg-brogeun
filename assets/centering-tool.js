(function () {
  'use strict';
  const G=window.CenteringGeometry, sides=['front','back'];
  const empty=()=>({image:null,url:null,quad:null,rectified:null,insets:null,phase:'outer',confirmed:false,borderless:false,zoom:1,drag:null,generation:0});
  const state={front:empty(),back:empty()};let pickerBusy=false,analyzing=false,revision=0,lastQuota=null;
  const $=s=>document.querySelector(s),id=s=>document.getElementById(s);
  const label=s=>s==='front'?'앞면':'뒷면';
  function message(text){if(typeof showToast==='function')showToast(text,'info');}
  function invalidate(){revision++;lastQuota=null;if(id('centeringAIResult'))id('centeringAIResult').style.display='none';}
  function gate(){const logged=typeof CURRENT_USER!=='undefined'&&!!CURRENT_USER; if(id('centeringLoginGate'))id('centeringLoginGate').style.display=logged?'none':'';if(id('centeringMain'))id('centeringMain').style.display=logged?'':'none';}
  function updateButton(){
    const ready=sides.every(s=>state[s].image&&state[s].confirmed);
    const selector='[data-centering-controls] input,[data-centering-controls] button,[data-centering-btn],[data-centering-file],#centeringMain button[onclick="resetCentering()"]';
    document.querySelectorAll(selector).forEach(el=>{el.disabled=analyzing;});
    const b=id('centeringAIBtn');if(b){b.disabled=!ready||analyzing;b.textContent=analyzing?'사진을 분석하고 있습니다…':'✨ 원본 사진으로 AI 분석';}
    const hint=id('centeringReadyHint');if(hint)hint.textContent=lastQuota?`오늘 AI 분석 ${lastQuota.used} / ${lastQuota.limit}회 사용`:ready?'앞·뒷면 경계 확인 완료 · 사진으로 보이는 상태를 분석합니다.':'앞·뒷면의 카드 모서리와 테두리를 각각 확인해 주세요.';
  }
  async function pick(side,source){
    if(pickerBusy||analyzing)return;
    const input=$(`[data-centering-file="${side}${source==='camera'?'-camera':''}"]`),cap=window.Capacitor,camera=cap?.Plugins?.Camera;
    if(!input)return;
    if(!cap?.isNativePlatform?.()||!camera?.getPhoto){input.value='';input.click();return;}
    pickerBusy=true;
    try{
      const photo=await camera.getPhoto({source:source==='camera'?'CAMERA':'PHOTOS',resultType:'uri',quality:100,correctOrientation:true,saveToGallery:false});
      if(!photo.webPath)throw new Error('사진 경로를 가져오지 못했습니다.');
      const response=await fetch(photo.webPath);if(!response.ok)throw new Error('사진 읽기 실패');
      const blob=await response.blob();await load(side,new File([blob],`${side}.${photo.format||'jpeg'}`,{type:blob.type||'image/jpeg'}));
    }catch(e){if(!/cancel|취소/i.test(String(e?.message))&&!['OS-PLUG-CAMR-0006','OS-PLUG-CAMR-0020'].includes(e?.code))message('사진을 열 수 없습니다. 사진·카메라 접근 권한을 확인해 주세요.');}
    finally{pickerBusy=false;}
  }
  function canvasFor(image,maxDim){const c=document.createElement('canvas'),scale=Math.min(1,maxDim/Math.max(image.naturalWidth,image.naturalHeight));c.width=Math.max(1,Math.round(image.naturalWidth*scale));c.height=Math.max(1,Math.round(image.naturalHeight*scale));const ctx=c.getContext('2d',{willReadFrequently:true});ctx.fillStyle='#fff';ctx.fillRect(0,0,c.width,c.height);ctx.drawImage(image,0,0,c.width,c.height);return c;}
  async function load(side,file){
    if(analyzing)return;
    if(!file||file.size>40*1024*1024){message('40MB 이하의 사진을 선택해 주세요.');return;}
    const generation=++state[side].generation;
    if(/\.(heic|heif)$/i.test(file.name)||/heic|heif/i.test(file.type)){
      try{if(!window.heic2any){await new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';script.onload=resolve;script.onerror=reject;document.head.appendChild(script);});}let converted=await window.heic2any({blob:file,toType:'image/jpeg',quality:0.95});if(Array.isArray(converted))converted=converted[0];file=converted;}
      catch{message('사진 변환이 어렵습니다. JPEG 또는 PNG로 다시 선택해 주세요.');return;}
    }
    const url=URL.createObjectURL(file),image=new Image();
    try{await new Promise((resolve,reject)=>{image.onload=resolve;image.onerror=reject;image.src=url;});}
    catch{URL.revokeObjectURL(url);message('사진을 읽지 못했습니다. JPEG 또는 PNG 사진을 선택해 주세요.');return;}
    if(generation!==state[side].generation){URL.revokeObjectURL(url);return;}
    if(image.naturalWidth<200||image.naturalHeight<200||image.naturalWidth*image.naturalHeight>50000000){URL.revokeObjectURL(url);message('200픽셀 이상, 5천만 화소 이하의 선명한 사진을 선택해 주세요.');return;}
    const old=state[side];if(old.url)URL.revokeObjectURL(old.url);
    state[side]={...empty(),image,url,file,generation};invalidate();
    const sample=canvasFor(image,480),result=G.detectOuter(sample.getContext('2d').getImageData(0,0,sample.width,sample.height));
    const w=image.naturalWidth,h=image.naturalHeight;
    state[side].quad=result?result.quad.map(p=>({x:p.x*w/sample.width,y:p.y*h/sample.height})):[{x:w*.12,y:h*.1},{x:w*.88,y:h*.1},{x:w*.88,y:h*.9},{x:w*.12,y:h*.9}];
    state[side].note=result?'경계 후보를 찾았습니다. 실제 카드의 네 모서리와 일치하는지 확인해 주세요.':'경계를 자동으로 찾기 어렵습니다. 네 점을 실제 카드 모서리에 맞춰 주세요.';
    id('centeringWorkspace').style.display='';
    const thumb=$(`[data-centering-thumb="${side}"]`);if(thumb){thumb.style.display='';thumb.textContent=`선택됨 · 원본 ${w} × ${h}`;}
    panel(side);draw(side);updateButton();
  }
  function panel(side){
    const s=state[side],host=$(`[data-centering-controls="${side}"]`);if(!host)return;
    host.replaceChildren();
    const note=document.createElement('p');note.className='ct-note';note.textContent=s.image?s.note:'사진을 먼저 선택해 주세요.';host.appendChild(note);
    if(!s.image)return;
    const zoom=document.createElement('label');zoom.className='ct-control';zoom.textContent='확대';const range=document.createElement('input');range.type='range';range.min='1';range.max='3';range.step='.25';range.value=s.zoom;range.setAttribute('aria-label',label(side)+' 사진 확대');range.oninput=()=>{s.zoom=Number(range.value);draw(side);};zoom.appendChild(range);host.appendChild(zoom);
    if(s.phase==='inner'){
      const check=document.createElement('label');check.className='ct-control';const box=document.createElement('input');box.type='checkbox';box.checked=s.borderless;box.onchange=()=>{if(analyzing)return;s.borderless=box.checked;s.confirmed=false;invalidate();panel(side);draw(side);updateButton();};check.append(box,document.createTextNode('테두리 없는 카드 · 센터링 제외'));host.appendChild(check);
      if(!s.borderless)for(const [key,title]of [['left','왼쪽'],['right','오른쪽'],['top','위쪽'],['bottom','아래쪽']]){
        const l=document.createElement('label');l.className='ct-control';const text=document.createElement('span');const set=()=>text.textContent=`${title} 여백 ${(s.insets[key]*100).toFixed(1)}%`;set();
        const slider=document.createElement('input');slider.type='range';slider.min='.5';slider.max='20';slider.step='.1';slider.value=(s.insets[key]*100).toFixed(1);slider.setAttribute('aria-label',label(side)+' '+title+' 테두리');slider.oninput=()=>{if(analyzing)return;s.insets[key]=Number(slider.value)/100;s.confirmed=false;invalidate();set();draw(side);updateButton();};l.append(text,slider);host.appendChild(l);
      }
    }
    const actions=document.createElement('div');actions.className='ct-actions';
    const confirm=document.createElement('button');confirm.type='button';confirm.className='btn primary';confirm.textContent=s.phase==='outer'?'네 모서리 확인 → 각도 보정':s.confirmed?'✓ 테두리 확인 완료':'테두리 확인 완료';confirm.onclick=()=>{if(analyzing)return;if(s.phase==='outer')rectify(side);else{s.confirmed=true;s.note=s.borderless?'테두리를 정의하기 어려운 카드입니다. 센터링 수치 없이 사진 상태를 분석합니다.':'테두리 확인 완료. 표시된 비율은 사용자가 확인한 경계 기준입니다.';invalidate();panel(side);draw(side);updateButton();}};actions.appendChild(confirm);
    if(s.phase==='inner'){const edit=document.createElement('button');edit.type='button';edit.className='btn';edit.textContent='카드 모서리 다시 맞추기';edit.onclick=()=>{if(analyzing)return;s.phase='outer';s.confirmed=false;invalidate();panel(side);draw(side);updateButton();};actions.appendChild(edit);}
    host.appendChild(actions);
  }
  function rectify(side){
    const s=state[side];if(!G.validQuad(s.quad,s.image.naturalWidth,s.image.naturalHeight)){message('네 모서리를 사진 안에서 시계 방향으로 맞춰 주세요.');return;}
    const source=canvasFor(s.image,4096),scale=source.width/s.image.naturalWidth;
    const quad=s.quad.map(p=>({x:p.x*scale,y:p.y*scale}));
    const minEdge=Math.min(...quad.map((p,i)=>Math.hypot(p.x-quad[(i+1)%4].x,p.y-quad[(i+1)%4].y)));
    const width=Math.max(64,Math.round(Math.min(1466,minEdge))),height=Math.round(width*88/63);
    try{const pixels=G.warp(source.getContext('2d').getImageData(0,0,source.width,source.height),quad,width,height),c=document.createElement('canvas');c.width=width;c.height=height;c.getContext('2d').putImageData(new ImageData(pixels.data,width,height),0,0);s.rectified=c;s.phase='inner';s.confirmed=false;
      const proposed=G.detectInner(pixels);s.insets=proposed||{left:.04,right:.04,top:.04,bottom:.04};
      s.note=proposed?'테두리 후보를 찾았습니다. 그림과 테두리가 만나는 선에 맞춘 뒤 확인해 주세요.':'안쪽 테두리가 불확실합니다. 슬라이더로 선을 맞추거나 테두리 없는 카드로 선택해 주세요.';
      if(width<480)s.note+=' 카드가 작게 찍혔습니다. 세부 상태를 보려면 카드를 더 크게 촬영해 주세요.';
      invalidate();panel(side);draw(side);updateButton();
    }catch(e){message(e.message||'각도 보정에 실패했습니다. 모서리를 다시 맞춰 주세요.');}
  }
  function draw(side){
    const s=state[side],c=$(`canvas[data-centering-canvas="${side}"]`);if(!c)return;
    const source=s.phase==='inner'?s.rectified:s.image;c.style.touchAction=s.phase==='outer'?'none':'pan-x pan-y';
    if(!source){c.width=1;c.height=1;metrics(side);return;}
    const sw=source.naturalWidth||source.width,sh=source.naturalHeight||source.height,ratio=Math.min(1,640/Math.max(sw,sh));c.width=Math.round(sw*ratio);c.height=Math.round(sh*ratio);c.style.width=`${s.zoom*100}%`;c.style.maxWidth='none';c.style.height='auto';
    const ctx=c.getContext('2d');ctx.drawImage(source,0,0,c.width,c.height);ctx.lineWidth=2;ctx.strokeStyle='#ec4899';
    if(s.phase==='outer'){
      const q=s.quad.map(p=>({x:p.x*ratio,y:p.y*ratio}));ctx.beginPath();q.forEach((p,i)=>i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y));ctx.closePath();ctx.stroke();
      q.forEach((p,i)=>{ctx.beginPath();ctx.arc(p.x,p.y,9,0,Math.PI*2);ctx.fillStyle='#fff';ctx.fill();ctx.stroke();ctx.fillStyle='#111';ctx.font='11px sans-serif';ctx.fillText(String(i+1),p.x-3,p.y+4);});
    }else if(!s.borderless){ctx.strokeStyle=s.confirmed?'#059669':'#2563eb';ctx.strokeRect(s.insets.left*c.width,s.insets.top*c.height,(1-s.insets.left-s.insets.right)*c.width,(1-s.insets.top-s.insets.bottom)*c.height);}
    metrics(side);
  }
  function metrics(side){
    const s=state[side],m=G.measure(s.insets,s.phase==='inner'&&s.confirmed&&!s.borderless);
    const put=(key,value)=>{const el=$(`[data-centering-${key}="${side}"]`);if(el)el.textContent=value;};
    put('lr',m?`${m.lMm.toFixed(1)} / ${m.rMm.toFixed(1)} mm`:'경계 확인 후 표시');put('tb',m?`${m.tMm.toFixed(1)} / ${m.bMm.toFixed(1)} mm`:'경계 확인 후 표시');put('lrpct',m?`${m.lPct} : ${m.rPct}`:'—');put('tbpct',m?`${m.tPct} : ${m.bPct}`:'—');
    const limit=side==='front'?55:75,worst=m?Math.max(m.lPct,m.rPct,m.tPct,m.bPct):null;
    put('grades',m?`PSA 10 센터링 참고 기준 (${limit}:${100-limit}) ${worst<=limit?'이내':'초과'} · 전체 등급을 뜻하지 않습니다.`:s.borderless&&s.confirmed?'테두리 없는 카드 · 센터링 판정 제외':'경계를 확인하면 센터링 참고 기준을 표시합니다.');
  }
  function bindCanvas(side){const c=$(`canvas[data-centering-canvas="${side}"]`);if(!c)return;c.style.touchAction='none';
    const point=e=>{const r=c.getBoundingClientRect();return {x:(e.clientX-r.left)/r.width*state[side].image.naturalWidth,y:(e.clientY-r.top)/r.height*state[side].image.naturalHeight};};
    c.onpointerdown=e=>{const s=state[side];if(analyzing||!s.image||s.phase!=='outer')return;const p=point(e),r=c.getBoundingClientRect(),radius=28/r.width*s.image.naturalWidth;let best=-1,d=radius;s.quad.forEach((q,i)=>{const dist=Math.hypot(q.x-p.x,q.y-p.y);if(dist<d){best=i;d=dist;}});if(best>=0||s.zoom>1){s.drag=best>=0?best:{pan:true,x:e.clientX,y:e.clientY};c.setPointerCapture(e.pointerId);e.preventDefault();}};
    c.onpointermove=e=>{const s=state[side];if(s.drag===null||analyzing)return;if(s.drag.pan){c.parentElement.scrollLeft+=s.drag.x-e.clientX;c.parentElement.scrollTop+=s.drag.y-e.clientY;s.drag.x=e.clientX;s.drag.y=e.clientY;return;}const p=point(e);s.quad[s.drag]={x:G.clamp(p.x,0,s.image.naturalWidth-1),y:G.clamp(p.y,0,s.image.naturalHeight-1)};s.confirmed=false;invalidate();draw(side);updateButton();};
    c.onpointerup=c.onpointercancel=c.onlostpointercapture=()=>{state[side].drag=null;};
  }
  function exportImage(side){
    const s=state[side];if(!s.image||!s.rectified||!s.confirmed)throw new Error('먼저 카드 경계를 확인해 주세요.');
    // Only the clean, original-derived canvas is exported. Display annotations never enter the payload.
    return s.rectified.toDataURL('image/jpeg',0.94).split(',')[1];
  }
  function renderResult(data){
    const result=data.analysis,wrap=id('centeringAIResult');wrap.style.display='';
    for(const key of ['centering','corners','edges','surface','final']){const el=wrap.querySelector(`[data-score="${key}"]`),value=result?.scores?.[key];if(el)el.textContent=typeof value==='number'?value.toFixed(1):'판독 보류';}
    const grade=wrap.querySelector('[data-score-grade="final"]');if(grade)grade.textContent=result?.gradeRange||'사진만으로 전체 등급을 확정할 수 없습니다.';
    id('centeringAIText').textContent=[result?.summary,...(result?.observations||[]),...(result?.retakeReasons||[]).map(x=>'재촬영: '+x),'사진 기반 참고 분석입니다. 실제 그레이딩 결과와 다를 수 있습니다.'].filter(Boolean).join('\n\n');
    let tag=id('aiProviderTag');if(!tag){tag=document.createElement('div');tag.id='aiProviderTag';tag.className='ct-note';wrap.appendChild(tag);}tag.textContent='분석 모델: GPT-6 Astra';
    lastQuota=data.quota||null;
  }
  async function analyze(){
    if(analyzing||!sides.every(s=>state[s].confirmed))return;
    if(typeof CURRENT_USER==='undefined'||!CURRENT_USER){if(typeof openLoginModal==='function')openLoginModal('AI 분석은 로그인 후 이용할 수 있습니다.');return;}
    const requestRevision=revision;analyzing=true;updateButton();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),80000);
    try{
      const response=await fetch('/api/centering-ai',{method:'POST',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({
        analysisVersion:2,frontImage:exportImage('front'),backImage:exportImage('back'),
        frontMetrics:G.measure(state.front.insets,!state.front.borderless&&state.front.confirmed),backMetrics:G.measure(state.back.insets,!state.back.borderless&&state.back.confirmed),
        imageInfo:Object.fromEntries(sides.map(s=>[s,{originalWidth:state[s].image.naturalWidth,originalHeight:state[s].image.naturalHeight,width:state[s].rectified.width,height:state[s].rectified.height,borderless:state[s].borderless}]))
      })});
      const data=await response.json();if(requestRevision!==revision)return;
      if(data.error)throw new Error(data.message||'분석을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      if(!data.analysis)throw new Error('분석 결과를 읽지 못했습니다. 다시 시도해 주세요.');renderResult(data);
    }catch(e){if(requestRevision===revision){id('centeringAIResult').style.display='';id('centeringAIText').textContent=e.name==='AbortError'?'분석 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.':e.message;for(const el of id('centeringAIResult').querySelectorAll('[data-score]'))el.textContent='—';const grade=$('[data-score-grade="final"]');if(grade)grade.textContent='';}}
    finally{clearTimeout(timer);analyzing=false;updateButton();}
  }
  function reset(){if(analyzing)return;sides.forEach(side=>{const s=state[side];if(s.url)URL.revokeObjectURL(s.url);state[side]={...empty(),generation:s.generation+1};const thumb=$(`[data-centering-thumb="${side}"]`);if(thumb){thumb.style.display='none';thumb.textContent='';}for(const suffix of ['', '-camera']){const input=$(`[data-centering-file="${side}${suffix}"]`);if(input)input.value='';}panel(side);draw(side);});invalidate();id('centeringWorkspace').style.display='none';updateButton();}
  function setup(){gate();sides.forEach(side=>{
    const slot=$(`.centering-upload-slot[data-side="${side}"]`);if(!slot)return;
    for(const suffix of ['','-camera']){const input=$(`[data-centering-file="${side}${suffix}"]`);if(input){input.onclick=e=>e.stopPropagation();input.onchange=e=>{if(e.target.files[0])load(side,e.target.files[0]);};}}
    for(const source of ['album','camera']){const b=$(`[data-centering-btn="${side}-${source}"]`);if(b)b.onclick=e=>{e.stopPropagation();pick(side,source);};}
    slot.onclick=e=>{if(!e.target.closest('button,input'))pick(side,'album');};slot.ondragover=e=>e.preventDefault();slot.ondrop=e=>{e.preventDefault();const f=e.dataTransfer.files[0];if(f&&(f.type.startsWith('image/')||/\.(heic|heif)$/i.test(f.name)))load(side,f);};
    bindCanvas(side);panel(side);draw(side);
  });if(id('centeringAIBtn'))id('centeringAIBtn').onclick=analyze;updateButton();}
  window.CenteringTool={setup,load,pick,reset,analyze,state,exportImage,rectify};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup);else setup();
  window.addEventListener('hashchange',()=>{if(location.hash.includes('centering'))setup();});
})();
