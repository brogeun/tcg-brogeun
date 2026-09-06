/* Native modal and allowlisted rich content for first-party hub announcements. */
(function(){
 'use strict';
 const entries=new Map();let sequence=0,dialog,opener,current;
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const icon=path=>`<svg viewBox="0 0 24 24" aria-hidden="true">${path}</svg>`;
 const shareIcon=icon('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><path d="m8.6 10.5 6.8-4M8.6 13.5l6.8 4"/>');
 const closeIcon=icon('<path d="m6 6 12 12M18 6 6 18"/>');
 const externalIcon=icon('<path d="M14 3h7v7m0-7L10 14M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-5"/>');
 function decoded(s){const t=document.createElement('textarea');t.innerHTML=String(s??'');return t.value;}
 function safeUrl(value,image=false){
  const raw=String(value||'').trim();if(!raw)return '';
  if(image&&/^data:image\/(png|jpeg|gif|webp);base64,[a-z0-9+/=\s]+$/i.test(raw))return raw;
  try {const u=new URL(raw,location.href);return ['https:','http:'].includes(u.protocol)?u.href:'';}catch{return '';}
 }
 function isDirectNews(item){
  const url=safeUrl(item.link);if(!url)return false;
  const host=new URL(url).hostname.toLowerCase();
  const official=['pokemoncard.co.kr','pokemonkorea.co.kr','onepiece-cardgame.kr'].some(domain=>host===domain||host.endsWith('.'+domain));
  const hasBody=String(item.content||'').replace(/<[^>]*>/g,'').trim()||/<img\b/i.test(item.content||'');
  return official||['pokemon','onepiece'].includes(item.source)||!hasBody;
 }
 function appendPlain(target,text){
  const parts=decoded(text).split(/(https?:\/\/[^\s<>]+)/g);
  parts.forEach(part=>{const url=/^https?:\/\//.test(part)?safeUrl(part):'';
   if(url){const a=document.createElement('a');a.href=url;a.textContent=part;a.target='_blank';a.rel='noopener noreferrer';target.append(a);}
   else target.append(document.createTextNode(part));});
 }
 function contentNode(value){
  const root=document.createElement('div');root.className='nd-copy';
  const raw=String(value||'');
  if(!/<[a-z][^>]*>/i.test(raw)){appendPlain(root,raw);return root;}
  const source=new DOMParser().parseFromString(raw,'text/html');
  const allowed=new Set(['P','DIV','BR','STRONG','B','EM','I','U','UL','OL','LI','BLOCKQUOTE','H2','H3','H4','A','IMG','TABLE','TBODY','THEAD','TR','TH','TD']);
  const blocked=new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','BUTTON','SVG','MATH','TEMPLATE','LINK','META','NOSCRIPT']);
  function visit(node,parent){
   if(node.nodeType===3){parent.append(document.createTextNode(node.textContent));return;}
   if(node.nodeType!==1||blocked.has(node.tagName))return;
   let dest=parent;
   if(allowed.has(node.tagName)){
    const name=node.tagName==='H2'?'h3':node.tagName.toLowerCase();dest=document.createElement(name);
    if(name==='a'){
     const url=safeUrl(node.getAttribute('href'));if(url){dest.href=url;dest.target='_blank';dest.rel='noopener noreferrer';}
    }
    if(name==='img'){
     const url=safeUrl(node.getAttribute('src'),true);if(!url)return;
     dest.src=url;dest.alt=node.getAttribute('alt')||'';dest.loading='lazy';dest.addEventListener('error',()=>dest.replaceWith(document.createTextNode('이미지를 불러오지 못했습니다.')));
    }
    parent.append(dest);
   }
   [...node.childNodes].forEach(child=>visit(child,dest));
  }
  [...source.body.childNodes].forEach(node=>visit(node,root));return root;
 }
 function close(){if(dialog?.open){document.documentElement.classList.remove('hub-detail-open');dialog.close();}}
 function ensure(){
  if(dialog)return;
  dialog=document.createElement('dialog');dialog.id='hubDetailModal';dialog.setAttribute('aria-labelledby','hubDetailTitle');
  dialog.innerHTML=`<header class="nd-head"><button class="nd-icon" type="button" data-nd-share aria-label="소식 공유">${shareIcon}</button><h2 id="hubDetailTitle"></h2><button class="nd-icon" type="button" data-nd-close aria-label="소식 상세 닫기" autofocus>${closeIcon}</button></header><div class="nd-body" tabindex="0" aria-label="소식 본문"></div><p class="nd-status" role="status" aria-live="polite"></p><div class="nd-share-fallback" hidden><input readonly aria-label="복사할 소식 내용"></div>`;
  document.body.append(dialog);
  dialog.querySelector('[data-nd-close]').onclick=close;
  dialog.querySelector('[data-nd-share]').onclick=share;
  let backdropDown=false;
  const outside=e=>{const r=dialog.getBoundingClientRect();return e.target===dialog&&(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom);};
  dialog.addEventListener('pointerdown',e=>{backdropDown=outside(e);});
  dialog.addEventListener('click',e=>{if(backdropDown&&outside(e))close();backdropDown=false;});
  dialog.addEventListener('close',()=>{if(dialog.open)return;document.documentElement.classList.remove('hub-detail-open');opener?.isConnected&&opener.focus?.({preventScroll:true});});
  // Do not let the shared modal's Escape listener close an underlying dialog.
  document.addEventListener('keydown',e=>{
   if(!dialog.open)return;
   if(e.key==='Escape'){e.preventDefault();e.stopImmediatePropagation();close();}
   if(e.key==='Tab'){
    const focusable=[...dialog.querySelectorAll('button:not(:disabled),a[href],input:not(:disabled),[tabindex="0"]')].filter(el=>el.getClientRects().length);
    const first=focusable[0],last=focusable[focusable.length-1];
    if(e.shiftKey&&(document.activeElement===first||!dialog.contains(document.activeElement))){e.preventDefault();last.focus();}
    else if(!e.shiftKey&&(document.activeElement===last||!dialog.contains(document.activeElement))){e.preventDefault();first.focus();}
   }
  },true);
 }
 function open(item){
  if(!item)return;ensure();opener=dialog.open?opener:document.activeElement;current=item;
  dialog.querySelector('h2').textContent=decoded(item.title||'소식');
  const body=dialog.querySelector('.nd-body');body.replaceChildren(contentNode(item.content||'등록된 본문이 없습니다.'));
  const url=safeUrl(item.link);
  if(url){const a=document.createElement('a');a.className='nd-link';a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.innerHTML=`자세히 보기 ${externalIcon}`;body.append(a);}
  dialog.querySelector('.nd-status').textContent='';dialog.querySelector('.nd-share-fallback').hidden=true;
  document.documentElement.classList.add('hub-detail-open');if(!dialog.open)dialog.showModal();body.scrollTop=0;
  dialog.querySelector('[data-nd-close]').focus({preventScroll:true});
 }
 async function share(){
  const item=current;const title=decoded(item.title||'TCG Hub 소식');const url=safeUrl(item.link)||new URL('/#hub',location.href).href;
  const payload={title,text:title,url};
  const status=message=>{if(dialog.open&&current===item)dialog.querySelector('.nd-status').textContent=message;};
  try{if(navigator.share){await navigator.share(payload);return;}}catch(e){if(e.name==='AbortError')return;}
  try{await navigator.clipboard.writeText(`${title}\n${url}`);status('소식 제목과 링크를 복사했습니다.');}
  catch{if(!dialog.open||current!==item)return;status('아래 내용을 선택해 복사해 주세요.');const box=dialog.querySelector('.nd-share-fallback');box.hidden=false;const input=box.querySelector('input');input.value=`${title} ${url}`;input.focus();input.select();}
 }
 function card(item,badge,prefix){
  const key=`${prefix||'news'}:${item.id||++sequence}`;entries.set(key,item);
  const src=safeUrl(item.image,true);const dday=badge?.dday&&typeof window.parseDday==='function'?window.parseDday(item.date):null;
  return `<button type="button" class="nd-card" data-news-detail="${escape(key)}" aria-haspopup="dialog"><span class="nd-card-media">${src?`<img src="${escape(src)}" alt="" loading="lazy" onerror="this.hidden=true">`:''}</span><span class="nd-card-content">${dday?`<span class="nd-card-dday">${escape(dday.label)}</span>`:''}${item.date?`<span class="nd-card-date">${escape(item.date)}</span>`:''}<span class="nd-card-title">${escape(decoded(item.title))}</span><span class="nd-card-action">자세히 보기</span></span></button>`;
 }
 document.addEventListener('click',event=>{const trigger=event.target.closest('[data-news-detail]');if(trigger)open(entries.get(trigger.dataset.newsDetail));});
 window.addEventListener('hashchange',close);window.addEventListener('popstate',close);
 window.HubNewsDetail={open,close,card,contentNode,safeUrl,isDirectNews};
})();
