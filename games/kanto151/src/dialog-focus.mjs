const candidates='button,input,select,textarea,a[href],area[href],summary,iframe,[tabindex],[contenteditable="true"]';

export function dialogTabStops(panel){
 return [...panel.querySelectorAll(candidates)].filter(el=>{
  if(el.tabIndex<0||el.disabled||el.matches(':disabled')||el.closest('[hidden],[inert]'))return false;
  if(!el.getClientRects().length)return false;
  const style=el.ownerDocument.defaultView.getComputedStyle(el);
  return style.visibility!=='hidden'&&style.visibility!=='collapse';
 }).map((el,index)=>({el,index})).sort((a,b)=>{
  const aOrder=a.el.tabIndex>0?a.el.tabIndex:Infinity,bOrder=b.el.tabIndex>0?b.el.tabIndex:Infinity;
  return aOrder-bOrder||a.index-b.index;
 }).map(({el})=>el);
}

export function trapDialogTab(panel,event){
 if(event.key!=='Tab'||event.ctrlKey||event.metaKey||event.altKey)return false;
 const stops=dialogTabStops(panel),active=panel.ownerDocument.activeElement,index=stops.indexOf(active);
 if(!stops.length){event.preventDefault();panel.setAttribute('tabindex','-1');panel.focus();return true;}
 if(index<0||event.shiftKey&&index===0||!event.shiftKey&&index===stops.length-1){
  event.preventDefault();stops[event.shiftKey?stops.length-1:0].focus();return true;
 }
 return false;
}
