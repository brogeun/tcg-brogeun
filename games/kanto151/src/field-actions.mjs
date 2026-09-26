import {THREE} from './world.mjs';
import {t,currentLocale} from './i18n.mjs';

const label=s=>s.name[currentLocale()]||s.name['en-US'];
const traversal=s=>['climb','surf'].includes(s.capability);
export function cancelFieldAction(g,reason='input'){
 const a=g.fieldAction;if(!a)return;
 if(g.world.region===a.shortcut.regionId)g.world.restoreShortcutPreview?.(a.snapshot);
 if(g.player===a.actor&&g.regionEpoch===a.epoch){g.player.model.position.copy(a.start);g.player.action=null;g.player.actionTime=0;g.player.moving=false;}
 g.fieldAction=null;
 if(reason==='input'||reason==='damage')g.notify(t('exp.fieldCancelled'));
}
export function beginFieldAction(g,s){
 if(g.fieldAction||!g.player||g.player.hp<=0||g.player.recoil||['sleep','freeze','stun','trap'].includes(g.player.status))return false;
 const completed=g.expedition.state.shortcuts.includes(s.id),travel=traversal(s);
 if(completed&&!travel){g.notify(t('exp.fieldCleared'));return true;}
 const start=g.player.model.position.clone(),reverse=Math.hypot(start.x-s.to[0],start.z-s.to[1])<Math.hypot(start.x-s.from[0],start.z-s.from[1]);
 const end=reverse?s.from:s.to;
 if(!g.canStandAt(start.x,start.z)||travel&&!g.canStandAt(...end)){g.notify(t('exp.fieldUnsafe'));return false;}
 let points=travel?(s.traversalPoints||s.polyline.map(([x,z])=>[x,g.standingHeight(x,z),z])).map(p=>new THREE.Vector3(...p)):[];
 if(reverse)points.reverse();if(travel)points.unshift(start.clone());
 const segments=points.slice(1).map((p,i)=>p.distanceTo(points[i])),length=segments.reduce((a,b)=>a+b,0);
 const snapshot=completed?[]:(g.world.shortcutSnapshot?.(s)||[]);
 if(s.blockerAsset&&!completed&&!snapshot.length){g.notify(t('exp.fieldUnsafe'));return false;}
 g.walkTarget=null;g.walkRoute=[];g.player.dash=null;g.player.recoil=null;
 g.fieldAction={shortcut:s,actor:g.player,epoch:g.regionEpoch,start,hp:g.player.hp,snapshot,points,segments,length,travel,end,time:0,duration:travel?Math.max(1.8,length/6):s.capability==='strength'?1.5:s.capability==='flash'?.8:1.1};
 g.notify(t('exp.fieldWorking',{skill:label(s)}),t('exp.fieldInterrupt'));
 return true;
}
export function updateFieldAction(g,dt){
 const a=g.fieldAction;if(!a)return false;
 if(g.regionEpoch!==a.epoch||g.player!==a.actor){cancelFieldAction(g,'region');return false;}
 if(g.player.hp<a.hp||g.player.recoil||g.player.hp<=0){cancelFieldAction(g,'damage');return false;}
 if(Math.hypot(g.touchMove?.x||0,g.touchMove?.z||0)>.1||['w','a','s','d','arrowup','arrowdown','arrowleft','arrowright'].some(k=>g.keys.has(k))){cancelFieldAction(g);return false;}
 a.time+=dt;const f=Math.min(1,a.time/a.duration),ease=f*f*(3-2*f),p=g.player;
 g.world.previewShortcut?.(a.shortcut,a.snapshot,ease);
 if(a.travel){let distance=ease*a.length;for(let i=0;i<a.segments.length;i++){if(distance<=a.segments[i]||i===a.segments.length-1){p.model.position.copy(a.points[i]).lerp(a.points[i+1],a.segments[i]?Math.min(1,distance/a.segments[i]):1);p.model.rotation.y=Math.atan2(a.points[i+1].x-a.points[i].x,a.points[i+1].z-a.points[i].z);break;}distance-=a.segments[i];}}
 else {p.model.rotation.y=Math.atan2(a.shortcut.to[0]-p.model.position.x,a.shortcut.to[1]-p.model.position.z);p.action='attack';p.actionTime=.12;}
 if(f<1)return true;
 if(a.travel&&!g.canStandAt(...a.end)){cancelFieldAction(g,'unsafe');g.notify(t('exp.fieldUnsafe'));return false;}
 g.world.restoreShortcutPreview?.(a.snapshot);g.world.clearShortcut?.(a.shortcut);
 const fresh=!g.expedition.state.shortcuts.includes(a.shortcut.id);
 if(fresh){g.expedition.state.shortcuts.push(a.shortcut.id);g.expedition.state.tokens++;}
 if(a.travel)p.model.position.set(a.end[0],g.standingHeight(...a.end),a.end[1]);
 p.action=null;p.actionTime=0;g.fieldAction=null;
 g.world.ring(p.model.position,0xc9dfb5,1.4,.5);g.audio.play('success');g.notify(fresh?t('exp.shortcut'):t('exp.fieldArrived'),label(a.shortcut));g.persist();return true;
}
