/* Editor presentation. Writes use the server-verified administrator session. */
(function(){
 'use strict';
 const $=id=>document.getElementById(id),fields=['adminBoard','adminTitle','adminDate','adminLink','adminMainImage','adminEditId'];
 let baseline=null,quill=null,busy=false,dirty=false;
 const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const picture='<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8" cy="8" r="2"/><path d="m21 15-5-5L5 21"/></svg>';
 function content(){return $('adminEditor').querySelector('.ql-editor')?.innerHTML||'';}
 function state(){return JSON.stringify([...fields.map(id=>$(id).value),content()]);}
 function value(){const item={id:$('adminEditId').value||'draft',title:$('adminTitle').value.trim(),date:$('adminDate').value.trim(),content:content(),link:$('adminLink').value.trim(),image:$('adminMainImage').value};
  if(!item.image){const t=document.createElement('template');t.innerHTML=item.content;item.image=t.content.querySelector('img')?.getAttribute('src')||'';}return item;}
 function message(text,kind='info'){const el=$('adminFormMessage');el.textContent=text;el.dataset.kind=kind;}
 function refresh(){
  dirty=baseline!==null&&baseline!==state();
  $('adminDraftState').textContent=busy?'게시 중':dirty?'저장하지 않은 변경':$('adminEditId').value?'게시된 글 수정':'새 글';
  const item=value(),draft={...item,title:item.title||'제목을 입력하면 여기에 표시됩니다.'};
  $('adminCardPreview').innerHTML=HubNewsDetail.card(draft,{},'admin-preview');
  const count=(quill?.getText()||'').trim().length;$('adminContentCount').textContent=`본문 ${count.toLocaleString()}자`;
 }
 function reset(){baseline=state();dirty=false;$('adminBoard').disabled=!!$('adminEditId').value;$('adminPublishButton').textContent=$('adminEditId').value?'변경사항 게시':'글 게시';message('');refresh();}
 async function enter(){try{quill=await ensureQuill();if(!quill)throw new Error('editor unavailable');if(!quill._adminUXBound){quill.on('text-change',refresh);quill._adminUXBound=true;}if(baseline===null)reset();else refresh();}catch{message('본문 편집기를 불러오지 못했습니다. 연결 상태를 확인하고 다시 진입해 주세요.','error');}}
 function allowDiscard(){if(busy){message('게시가 끝난 뒤 이동해 주세요.');return false;}if(!dirty)return true;if(!confirm('저장하지 않은 변경사항이 있습니다. 변경사항을 버리고 계속할까요?'))return false;baseline=state();dirty=false;return true;}
 function validation(){
  ['adminTitle','adminBoard','adminLink','adminMainImageUrl'].forEach(id=>$(id).removeAttribute('aria-invalid'));
  const item=value();let error='',field;
  if(!$('adminBoard').value){error='게시판을 선택해 주세요.';field=$('adminBoard');}
  else if(!item.title){error='제목을 입력해 주세요.';field=$('adminTitle');}
  else if(!quill||(!quill.getText().trim()&&!quill.root.querySelector('img'))){error='본문을 입력해 주세요.';field=quill?.root;}
  else if(item.link&&!HubNewsDetail.safeUrl(item.link)){error='링크는 http 또는 https 주소로 입력해 주세요.';field=$('adminLink');}
  else if($('adminMainImageUrl').value&&!HubNewsDetail.safeUrl($('adminMainImageUrl').value,true)){error='이미지 주소를 확인해 주세요.';field=$('adminMainImageUrl');}
  if(error){message(error,'error');field?.setAttribute('aria-invalid','true');field?.focus();return false;}return true;
 }
 async function save(){
  if(busy)return;await enter();if(busy||!validation())return;
  busy=true;$('adminPublishButton').disabled=true;$('adminPublishButton').textContent='게시 중…';message('게시 중입니다. 잠시 기다려 주세요.');refresh();
  const controls=[...document.querySelectorAll('.ae-editor input,.ae-editor select,.ae-editor button')].filter(el=>el.id!=='adminPublishButton');
  const disabledBefore=controls.map(el=>el.disabled);controls.forEach(el=>el.disabled=true);quill.enable(false);
  try{const ok=await adminSaveEntry();if(ok){reset();message('게시했습니다. 방문자 화면에 반영됩니다.');}else if($('adminFormMessage').dataset.kind!=='error')message('게시되지 않았습니다. 입력 내용은 유지됩니다. 인증 또는 연결 상태를 확인해 주세요.','error');}
  catch{message('게시하지 못했습니다. 입력 내용은 유지됩니다. 연결 상태를 확인해 주세요.','error');}
  finally{busy=false;controls.forEach((el,i)=>el.disabled=disabledBefore[i]);$('adminBoard').disabled=!!$('adminEditId').value;quill.enable(true);$('adminPublishButton').disabled=false;$('adminPublishButton').textContent=$('adminEditId').value?'변경사항 게시':'글 게시';refresh();}
 }
 function preview(){const item=value();HubNewsDetail.open({...item,title:item.title||'제목 미입력',content:item.content||'본문을 입력하면 여기에 표시됩니다.'});}
 function list(arr,tab){
  const query=$('adminEntrySearch').value.trim().toLowerCase();const items=arr.filter(e=>String(e.title||'').toLowerCase().includes(query));
  const labels={news:'뉴스',events:'이벤트',cardshow:'카드쇼',grading:'그레이딩',etc:'기타'};
  $('adminListLabel').textContent=`${labels[tab]||'전체'} ${items.length}건${query?' / 전체 '+arr.length+'건':''}`;
  document.querySelectorAll('#adminTabs [data-admin-tab]').forEach(t=>{t.classList.toggle('active',t.dataset.adminTab===tab);t.setAttribute('aria-selected',String(t.dataset.adminTab===tab));});
  if(!items.length){$('adminEntryList').innerHTML='<div class="ae-message">'+(query?'검색 결과가 없습니다.':'등록된 글이 없습니다. 새 글을 작성해 보세요.')+'</div>';return;}
  $('adminEntryList').innerHTML='<div class="ae-list">'+items.map(e=>{
   const idx=arr.indexOf(e),image=HubNewsDetail.safeUrl(e.image,true),body=HubNewsDetail.contentNode(e.content||'').textContent;
   return `<article class="admin-row" data-id="${escape(e.id)}"><span class="drag-handle" title="드래그로 순서 변경" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01"/></svg></span><span class="ae-list-image">${image?`<img src="${escape(image)}" alt="" onerror="this.hidden=true">`:picture}</span><div class="ae-list-copy"><strong>${escape(e.title)}</strong><small>${escape(e.date||'표시 날짜 없음')}</small><p>${escape(body)}</p></div><div class="ae-row-actions"><button class="ae-button" type="button" data-admin-action="edit">수정</button><button class="ae-button" type="button" data-admin-action="up" ${query||idx===0?'disabled':''} aria-label="위로 이동">↑</button><button class="ae-button" type="button" data-admin-action="down" ${query||idx===arr.length-1?'disabled':''} aria-label="아래로 이동">↓</button><button class="ae-button ae-danger" type="button" data-admin-action="delete">삭제</button></div></article>`;
  }).join('')+'</div>';
  if(!query&&typeof _initAdminSortable==='function')_initAdminSortable();
 }
 function access(user){$('adminAccessNote').textContent=user?.isAdmin===true?'관리자 계정으로 로그인되어 있습니다. 게시하면 모든 방문자에게 공개됩니다.':'관리자 계정으로 로그인해야 편집하고 게시할 수 있습니다.';}
 document.querySelector('.admin-editor-v2').addEventListener('input',e=>{if(e.target.id==='adminEntrySearch'){renderAdminList();return;}refresh();});
 $('adminEntryList').addEventListener('click',e=>{const button=e.target.closest('[data-admin-action]');if(!button||button.disabled)return;const id=button.closest('[data-id]').dataset.id;({edit:()=>adminEditEntry(id),up:()=>adminMoveEntry(id,-1),down:()=>adminMoveEntry(id,1),delete:()=>adminDeleteEntry(id)})[button.dataset.adminAction]?.();});
 window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
 window.AdminEditorUI={enter,reset,refresh,message,save,preview,list,allowDiscard,access};
})();
