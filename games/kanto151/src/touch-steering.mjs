// Each finger owns one action until released; gestures never synthesize attack taps.
export function installTouchSteering(g,canvas){
 let move=null,look=null;g.touchMove={x:0,z:0,run:false};
 const stick=document.querySelector('#touch-stick'),knob=stick?.querySelector('i');
 const release=p=>{if(p&&canvas.hasPointerCapture(p.id))canvas.releasePointerCapture(p.id);};
 const finish=id=>{if(move?.id===id){const p=move;move=null;g.touchMove={x:0,z:0,run:false};stick?.classList.add('hidden');release(p);}if(look?.id===id){const p=look;look=null;release(p);}};
 const clear=()=>{if(move)finish(move.id);if(look)finish(look.id);};
 const active=()=>g.phase==='playing'&&!g.panel&&!g.transitioning&&!g.restoring&&!g.survivalDying&&!g.partnerChanging;
 canvas.addEventListener('pointerdown',e=>{if(e.pointerType!=='touch'||!active())return;e.preventDefault();g.audio.start();const p={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,moved:false};if(e.clientX<innerWidth*.5){if(move)return;move=p;if(stick){stick.style.left=p.x+'px';stick.style.top=p.y+'px';stick.classList.remove('hidden');knob.style.transform='translate(-50%,-50%)';}}else{if(look)return;look=p;}canvas.setPointerCapture(e.pointerId);});
 canvas.addEventListener('pointermove',e=>{if(e.pointerType!=='touch')return;if(!active()){clear();return;}if(move?.id===e.pointerId){const dx=e.clientX-move.x,dy=e.clientY-move.y,r=Math.hypot(dx,dy),power=Math.min(1,Math.max(0,(r-8)/48));g.touchMove={x:r?dx/r*power:0,z:r?-dy/r*power:0,run:r>=88};if(knob)knob.style.transform=`translate(calc(-50% + ${r?dx/r*Math.min(42,r):0}px),calc(-50% + ${r?dy/r*Math.min(42,r):0}px))`;g.expedition?.mark('move');}else if(look?.id===e.pointerId){if(!look.moved&&Math.hypot(e.clientX-look.x,e.clientY-look.y)<5)return;look.moved=true;g.world.encounterFocus=null;g.world.orbit.yaw-=(e.clientX-look.lastX)*.005*g.save.settings.camera;g.world.orbit.pitch=Math.max(.27,Math.min(1.18,g.world.orbit.pitch+(e.clientY-look.lastY)*.003));look.lastX=e.clientX;look.lastY=e.clientY;g.expedition?.mark('camera');}});
 for(const type of ['pointerup','pointercancel','lostpointercapture'])canvas.addEventListener(type,e=>finish(e.pointerId));
 window.addEventListener('blur',clear);window.addEventListener('resize',clear);document.addEventListener('visibilitychange',()=>{if(document.hidden)clear();});
 return clear;
}
