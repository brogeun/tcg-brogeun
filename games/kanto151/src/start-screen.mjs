import {t,entity} from './i18n.mjs';
import {caughtCount,TYPE_COLORS} from './core.mjs';

const $ = selector => document.querySelector(selector);
const STARTERS = [1,4,7,25];
const DESCRIPTIONS = {1:'starter.bulbasaur',4:'starter.charmander',7:'starter.squirtle',25:'starter.pikachu'};
const number = id => String(id).padStart(3,'0');
const departKey = name => {
 const last = name.codePointAt(name.length-1);
 return last>=0xac00 && last<=0xd7a3 && (last-0xac00)%28 ? 'start.departConsonant':'start.depart';
};

// Only startup presentation lives here. Collection, checkpoints and field input remain in Game.
export class StartScreen {
 constructor(ui) {
  this.ui=ui;this.game=ui.game;this.selected=1;this.busy=false;this.previewTicket=0;this.titleSave=null;
  $('#starter-back').onclick=()=>this.back();
  $('#starter-prev').onclick=()=>this.next(-1);
  $('#starter-next').onclick=()=>this.next(1);
  $('#choose-starter').onclick=()=>this.confirm();
  const surface=$('#starter-preview');let drag=null;
  surface.onpointerdown=e=>{
   if(this.busy||this.game.panel||e.isPrimary===false||e.button!==0)return;
   drag={id:e.pointerId,x:e.clientX,y:e.clientY};surface.setPointerCapture(e.pointerId);
  };
  surface.onpointerup=e=>{
   if(drag?.id!==e.pointerId)return;
   const dx=e.clientX-drag.x,dy=e.clientY-drag.y;drag=null;
   if(surface.hasPointerCapture(e.pointerId))surface.releasePointerCapture(e.pointerId);
   if(Math.abs(dx)>=40&&Math.abs(dx)>Math.abs(dy)*1.2)this.next(dx<0?1:-1);
  };
  surface.onpointercancel=surface.onlostpointercapture=()=>{drag=null;};
  $('#starter').onkeydown=e=>{
   if(!this.game.panel&&(e.key==='ArrowLeft'||e.key==='ArrowRight')) {
    e.preventDefault();this.next(e.key==='ArrowLeft'?-1:1);
   }
  };
  this.resizeObserver=new ResizeObserver(()=>this.fitPreview());this.resizeObserver.observe(surface);
 }
 translate() {
  document.querySelectorAll('[data-start-text]').forEach(el=>el.textContent=t(el.dataset.startText));
  document.querySelectorAll('[data-start-label]').forEach(el=>el.setAttribute('aria-label',t(el.dataset.startLabel)));
 }
 setBusy(value) {
  this.busy=value;
  document.querySelectorAll('#title button,#starter button').forEach(el=>el.disabled=value||(el.id==='continue'&&!this.game.save.starter));
  $('#starter').setAttribute('aria-busy',String(value));
  $('#title').setAttribute('aria-busy',String(value));
 }
 ready() {
  this.suspend();this.setBusy(false);this.translate();
  this.titleSave=this.game.save;
  $('#starter').classList.add('hidden');$('#title').classList.remove('hidden');
  const has=!!this.titleSave.starter;
  $('#continue').classList.remove('hidden');
  $('#continue').classList.toggle('start-primary',has);$('#continue').classList.toggle('start-secondary',!has);
  $('#continue').disabled=!has;
  $('#start-save').classList.toggle('hidden',!has);$('#start-lineup').classList.toggle('hidden',has);
  $('#start-heading').textContent=t(has?'start.saved':'start.first');
  $('#start-description').textContent=t(has?'start.savedDescription':'start.firstDescription');
  $('#new-game').classList.toggle('start-primary',!has);$('#new-game').classList.toggle('start-secondary',has);
  $('#new-game').textContent=t(has?'start.new':'start.begin');$('#continue').textContent=t('start.continue');
  $('#start-region').textContent=this.game.biomeById.get(this.titleSave.region)?.name||'';
  $('#title-count').replaceChildren(document.createTextNode(number(caughtCount(this.titleSave))+' '));
  const small=document.createElement('small');small.textContent='/ 151';$('#title-count').append(small);
 }
 showStarter() {
  this.setBusy(false);this.translate();
  $('#title').classList.add('hidden');$('#starter').classList.remove('hidden');
  this.select(STARTERS.includes(this.game.starterId)?this.game.starterId:1);
  $('#choose-starter').focus({preventScroll:true});
 }
 next(delta) {
  if(this.busy||this.game.phase!=='starter'||this.game.panel)return;
  this.select(STARTERS[(STARTERS.indexOf(this.selected)+delta+STARTERS.length)%STARTERS.length]);
  this.game.audio.play('ui');
 }
 select(id) {
  if(!STARTERS.includes(id))return;
  this.selected=id;this.game.focusStarter(id);
  const species=this.game.byId.get(id);
  $('#starter-name').textContent=species.name;$('#starter-number').textContent='No. '+number(id);
  $('#starter-category').textContent=species.genus;$('#starter-description').textContent=t(DESCRIPTIONS[id]);
  $('#starter-count').textContent=(STARTERS.indexOf(id)+1)+' / '+STARTERS.length;
  $('#choose-starter').textContent=t(departKey(species.name),{name:species.name});
  $('#starter-types').replaceChildren(...species.types.map(type=>{
   const el=document.createElement('span');el.textContent=entity('types',type);el.style.setProperty('--type',TYPE_COLORS[type]);return el;
  }));
  $('#starter-fallback').src='./assets/dex/'+number(id)+'.png';$('#starter-fallback').alt=species.name;
  this.resume();
 }
 suspend() {
  this.previewTicket++;
  this.ui.cleanupPreviews();
  $('#starter-preview').classList.remove('model-ready');
 }
 resume() {
  if(this.game.phase!=='starter'||this.game.panel||$('#starter').classList.contains('hidden'))return;
  this.suspend();const ticket=this.previewTicket,id=this.selected;
  // A fresh canvas avoids reusing a deliberately disposed WebGL context after changing partners.
  const old=$('#starter-model'),canvas=document.createElement('canvas');
  canvas.id='starter-model';canvas.setAttribute('aria-hidden','true');old.replaceWith(canvas);
  this.ui.preview(canvas,id,false,{interactive:false,modelSize:2.35}).then(preview=>{
   if(ticket!==this.previewTicket||this.game.phase!=='starter'||this.game.panel||!preview?.model)return;
   canvas.dataset.species=String(id);$('#starter-preview').classList.add('model-ready');this.fitPreview();
  }).catch(()=>{
   // The existing local portrait remains visible if this device cannot create another 3D context.
   if(ticket===this.previewTicket)$('#starter-preview').classList.remove('model-ready');
  });
 }
 fitPreview() {
  for(const preview of this.ui.previews) {
   const canvas=preview.renderer.domElement;if(canvas.id!=='starter-model')continue;
   const width=canvas.clientWidth,height=canvas.clientHeight;
   if(width&&height){preview.renderer.setSize(width,height,false);preview.camera.aspect=width/height;preview.camera.updateProjectionMatrix();}
  }
 }
 back() {
  if(this.busy||this.game.phase!=='starter'||this.game.panel)return;
  const settings={...this.game.save.settings};
  if(this.titleSave){this.game.save=this.titleSave;this.game.save.settings=settings;}
  this.game.phase='title';this.game.world.starterFocus=null;this.game.world.camera?.clearViewOffset?.();
  this.game.showcase.forEach(model=>{model.visible=true;model.userData.selected=false;});
  this.ready();$('#new-game').focus({preventScroll:true});
 }
 async confirm() {
  if(this.busy||this.game.phase!=='starter'||this.game.panel)return;
  this.setBusy(true);
  try{await this.game.chooseStarter(this.selected);}catch(error){this.game.fail(error);}
  finally{this.setBusy(false);}
 }
 async continue() {
  if(this.busy||this.game.phase!=='title'||this.game.panel)return;
  if(!this.game.save.starter){
   if(this.ui.accountSave)this.ui.accountSave.open();else this.game.openPanel('settings');
   return;
  }
  this.setBusy(true);
  try{await this.game.continueGame();}catch(error){this.game.fail(error);}
  finally{this.setBusy(false);}
 }
}
