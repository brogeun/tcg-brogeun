import {AccountSaveController,createAccountSaveTransport} from './account-save.mjs';
import {readAccountGameBundle,validateAccountGameBundle,applyAccountGameBundle,archiveAccountGameOriginal,accountBundleSummary} from './account-save-game.mjs';
import {returnToTitle} from './camp-guidance.mjs';
import {setLocale} from './i18n.mjs';

const $=s=>document.querySelector(s);
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const when=value=>value&&Number.isFinite(Date.parse(value))?new Date(value).toLocaleString('ko-KR'):'아직 저장하지 않음';

function statusCopy(s){
 const text={checking:'계정 기록을 확인하고 있어요',local:s.localBundle?'이 브라우저에 자동 저장돼요':'이 브라우저에 저장된 탐험이 없어요',offline:'이 기기 기록은 유지했어요 · 계정 연결을 다시 확인해 주세요',
  'link-required':'이 기기의 기존 기록을 계정에 연결할 수 있어요','cloud-available':'계정에서 이어할 기록을 찾았어요',conflict:'서로 다른 기록이 있어요 · 사용할 기록을 확인해 주세요',
  synced:s.pending?'이 기기에 저장됨 · 계정 저장 대기':'계정에 저장했어요',syncing:'이 기기에 저장됨 · 계정에 저장하고 있어요',error:'계정에 저장하지 못했어요 · 이 기기 기록은 유지해요'};
 return text[s.status]||'계정 기록을 확인해 주세요';
}

export class AccountSaveUI{
 constructor(game,ui,{transport}={}){
  this.game=game;this.ui=ui;this.busy=false;this.applying=false;
  this.controller=new AccountSaveController({transport:transport||createAccountSaveTransport(),storage:game.storage,validateBundle:bundle=>{validateAccountGameBundle(bundle,game);return true;},onChange:()=>this.changed()});
  game.accountSave=this.controller;game.accountSaveUI=this;ui.accountSave=this;
  const box=document.createElement('div');box.className='account-save-title';
  box.innerHTML='<small id="account-save-status" role="status" aria-live="polite">계정 기록을 확인하고 있어요</small><button id="account-save-open" type="button">계정 저장</button>';
  $('#title-actions').after(box);$('#account-save-open').onclick=()=>this.open();
  this._storage=event=>{if(event.key?.startsWith('tcghub:kanto151:')&&this.controller.snapshot.user){this.localTabChanged=true;this.changed();}};
  window.addEventListener('storage',this._storage);
  this._visibility=()=>{if(document.hidden)this.controller.flush().catch(()=>{});};
  document.addEventListener('visibilitychange',this._visibility);
 }
 async init(){
  try{
   const s=await this.controller.init(readAccountGameBundle(this.game));
   if(s.status==='cloud-available')await this.restoreCloud();
  }catch(error){this.problem=error.message;}
  this.changed();
 }
 changed(){
  if(!this.controller)return;
  const s=this.controller.snapshot,message=this.localTabChanged?'다른 창에서 기록이 바뀌었어요 · 계정 기록을 다시 확인해 주세요':statusCopy(s);
  const title=$('#account-save-status');if(title)title.textContent=message;
  const compact=$('#account-settings-status');if(compact)compact.textContent=message;
  if(this.game.phase==='playing'){
   const note=$('#save-note');
   if(note){
    clearTimeout(this.ui.saveTimer);
    note.textContent=['offline','error','conflict'].includes(s.status)?'기기에 저장됨 · 계정 기록 확인 필요':s.status==='syncing'||s.pending?'기기에 저장됨 · 계정 저장 대기':s.status==='synced'?'계정 저장 완료':'이 기기에 저장 완료';
    note.dataset.accountStatus=s.status;
    if(!['offline','error','conflict'].includes(s.status))this.ui.saveTimer=setTimeout(()=>{note.textContent='';},3200);
   }
  }
  const badge=$('#account-save-open');if(badge){badge.dataset.status=s.status;badge.textContent=['conflict','link-required','cloud-available'].includes(s.status)?'계정 기록 확인':'계정 저장';}
  if(this.game.panel==='account-save'&&!this.busy)this.renderPanel();
 }
 onSaved(){
  if(this.applying)return;
  try{this.controller.onStored(readAccountGameBundle(this.game));}
  catch(error){this.problem=error.message;this.controller.suspend(error);this.changed();}
 }
 open(){
  if(this.game.phase==='playing')this.game.persist();
  this.game.openPanel('account-save');
 }
 renderSettings(){
  const node=document.createElement('section');node.className='account-settings';
  node.innerHTML='<strong>카카오 계정으로 이어하기</strong><p id="account-settings-status" class="notice"></p><button id="account-settings-open" type="button">계정 저장 확인</button>';
  $('#panel-body').prepend(node);$('#account-settings-open').onclick=()=>this.open();this.changed();
 }
 card(label,bundle){
  const s=accountBundleSummary(bundle,this.game);
  if(s.empty)return `<section class="account-record"><h3>${label}</h3><p>저장된 탐험 없음</p></section>`;
  if(s.invalid)return `<section class="account-record"><h3>${label}</h3><p>불러오기 전에 기록을 확인해야 해요.</p></section>`;
  return `<section class="account-record"><h3>${label}</h3><strong>${esc(s.partner)} Lv. ${s.level}</strong><p>도감 ${s.caught} / 151 · 동료 ${s.count}마리<br>${esc(s.region)} · ${s.minutes}분 탐험</p><small>${esc(when(s.savedAt))}</small></section>`;
 }
 renderPanel(){
  const s=this.controller.snapshot,playing=this.game.phase!=='title',blocked=this.busy||['checking','syncing'].includes(s.status);
  this.ui.shell('카카오 계정 저장','KANTO 151');
  const identity=s.user?.displayName||s.user?.name||(s.user?'로그인한 카카오 계정':'로그인하지 않은 상태');
  $('#panel-body').innerHTML=`<section class="account-status"><strong>${esc(identity)}</strong><p role="status">${esc(statusCopy(s))}</p>${s.lastSuccessfulAt?`<small>계정 저장 확인 · ${esc(when(s.lastSuccessfulAt))}</small>`:''}</section>
   <div class="account-records">${this.card('이 브라우저 기록',s.localBundle)}${s.record?this.card('계정에 보관된 기록',s.record.bundle):`<section class="account-record"><h3>계정에 보관된 기록</h3><p>${s.status==='checking'?'계정 기록을 확인하고 있어요.':s.status==='offline'||s.status==='error'?'계정에 연결하지 못해 기록을 확인하지 못했어요.':!s.user?'로그인 후 계정 기록을 확인할 수 있어요.':'이 계정에 저장된 탐험이 없어요.'}</p></section>`}</div>
   ${!playing&&!this.game.save.starter?'<p class="notice">이 브라우저에 저장된 탐험이 없어 이어하기가 비활성화돼 있어요. 기존 기록은 같은 카카오 계정으로 로그인하거나 기록 파일을 가져와 이어할 수 있어요.</p>':''}
   <p class="notice">포켓몬·도감·가방·탐험 진행과 저장대 복귀 기록을 함께 보관해요. 빈 기록은 계정 기록을 덮어쓰지 않아요.</p>
   ${['conflict','link-required'].includes(s.status)?'<p class="account-choice-notice">두 기록은 자동으로 합치지 않아요. 선택하기 전 기기 원본을 백업하고, 계정의 이전 기록도 보관해요.</p>':''}
   ${s.reason==='different-account'?'<p class="account-choice-notice">이 기기에는 다른 계정에서 사용한 기록이 있어요. 사용할 기록을 직접 확인해 주세요.</p>':''}
   ${this.problem?`<p class="account-choice-notice" role="alert">${esc(this.problem)}</p>`:''}
   <div class="account-buttons">
    ${s.canUpload&&['link-required','conflict'].includes(s.status)?`<button id="account-use-local" type="button" ${blocked?'disabled':''}>${s.record?'이 기기 기록을 계정에 저장':'기존 기기 기록을 계정에 연결'}</button>`:''}
    ${s.canUseCloud&&['cloud-available','conflict'].includes(s.status)?`<button id="account-use-cloud" type="button" ${blocked||playing?'disabled':''}>계정 기록으로 이어하기</button>`:''}
    ${s.status==='synced'?`<button id="account-sync-now" type="button" ${blocked?'disabled':''}>지금 계정에 저장</button>`:''}
    <button id="account-refresh" type="button" ${blocked?'disabled':''}>계정 기록 다시 확인</button>
    ${!playing?'<button id="account-import-file" type="button">기록 파일 가져오기</button>':''}
    <button id="account-export-local" type="button" ${this.game.save.starter?'':'disabled'}>기기 기록 파일로 보관</button>
    ${s.record?'<button id="account-export-cloud" type="button">계정 기록 파일로 보관</button>':''}
    ${playing&&s.canUseCloud?'<button id="account-return-title" type="button">이 기기 진행 저장 후 첫 화면으로</button>':''}
    ${!s.user?'<a href="https://tcghub.kr/">TCG HUB에서 카카오 로그인</a>':''}
   </div>${playing&&s.canUseCloud?'<p class="notice">계정 기록을 불러오려면 현재 탐험을 저장하고 첫 화면으로 돌아와 주세요.</p>':''}`;
  const bind=(id,action)=>{const button=$(id);if(button)button.onclick=()=>this.run(action);};
  bind('#account-use-local',async()=>{
   this.controller.onStored(readAccountGameBundle(this.game));archiveAccountGameOriginal(this.game);
   if(s.record&&this.confirmedChoice!=='local'){this.confirmedChoice='local';this.problem='계정 기록 대신 이 기기 기록을 사용할까요? 내용을 확인한 뒤 같은 버튼을 한 번 더 눌러 주세요.';return;}
   this.confirmedChoice=null;await this.controller.useLocal();
  });
  bind('#account-use-cloud',async()=>{
   if(this.game.save.starter&&this.confirmedChoice!=='cloud'){this.confirmedChoice='cloud';this.problem='기기 기록은 백업에 보관하고 계정 기록을 불러옵니다. 확인 후 같은 버튼을 한 번 더 눌러 주세요.';return;}
   this.confirmedChoice=null;await this.restoreCloud();
  });
  bind('#account-sync-now',async()=>{if(!this.game.persist())throw Error('이 기기에 먼저 저장하지 못해 계정 저장을 보류했어요.');await this.controller.flush();});
  bind('#account-refresh',async()=>{this.localTabChanged=false;this.problem=null;await this.controller.refresh(readAccountGameBundle(this.game));if(this.controller.snapshot.status==='cloud-available'&&this.game.phase==='title')await this.restoreCloud();});
  bind('#account-return-title',async()=>{if(await returnToTitle(this.ui,$('#account-return-title')))this.open();});
  const importFile=$('#account-import-file');if(importFile)importFile.onclick=()=>{this.game.openPanel('settings');$('#save-file').click();};
  $('#account-export-local').onclick=()=>this.ui.exportSave();
  const exportCloud=$('#account-export-cloud');if(exportCloud)exportCloud.onclick=()=>{const url=URL.createObjectURL(new Blob([s.record.bundle.save],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='kanto151-account-backup.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
 }
 async run(action){
  if(this.busy)return;
  this.busy=true;this.problem=null;this.renderPanel();
  try{await action();}catch(error){this.problem=error.message;}
  finally{this.busy=false;this.changed();}
 }
 async restoreCloud(){
  this.applying=true;
  try{
   await this.controller.useCloud({apply:bundle=>applyAccountGameBundle(this.game,bundle)});
   this.game.audio.setVolume(this.game.save.settings.volume);this.game.world.setQuality(this.game.save.settings.quality);setLocale(this.game.save.settings.locale);
   if(this.game.showcase.length)this.ui.startScreen.ready();
  }finally{this.applying=false;}
 }
 dispose(){this.controller.dispose();window.removeEventListener('storage',this._storage);document.removeEventListener('visibilitychange',this._visibility);}
}
