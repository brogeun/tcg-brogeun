// Input geometry is in CSS pixels, independent of viewport offset and DPR.
export const TARGET_TAP_SLOP=5;
export const TARGET_TAP_MAX_MS=450;
function visibleSurface(hit){for(let node=hit.object;node;node=node.parent)if(node.visible===false)return false;const material=Array.isArray(hit.object.material)?hit.object.material[hit.face?.materialIndex||0]:hit.object.material;return material?.visible!==false&&(material?.opacity??1)>.05;}
function opaqueSurface(hit){if(!visibleSurface(hit))return false;const material=Array.isArray(hit.object.material)?hit.object.material[hit.face?.materialIndex||0]:hit.object.material;return !material?.transparent||(material.opacity??1)>=.95;}
export function pickWildTargetAt(g,x,y,ray){
 if(g.phase!=='playing'||g.panel||g.transitioning||g.restoring||g.survivalDying||g.partnerChanging||g.capture||!(g.player?.hp>0)||!g.world.camera)return null;
 const rect=g.world.renderer?.domElement?.getBoundingClientRect?.();if(!rect||!(rect.width>0&&rect.height>0)||!Number.isFinite(x+y)||x<rect.left||y<rect.top||x>rect.left+rect.width||y>rect.top+rect.height)return null;
 const actors=(g.wild||[]).filter(a=>a.model),owners=new Map(actors.map(a=>[a.model,a])),roots=[...owners.keys(),g.player.model];g.world.camera.updateMatrixWorld(true);for(const root of roots)root.updateMatrixWorld(true);
 ray.setFromCamera({x:(x-rect.left)/rect.width*2-1,y:-(y-rect.top)/rect.height*2+1},g.world.camera);
 const hit=ray.intersectObjects(roots,true).find(visibleSurface);if(!hit)return null;let node=hit.object;while(node&&!owners.has(node))node=node.parent;const actor=owners.get(node);
 if(!actor||actor.hp<=0||actor.capturing||actor.model.visible===false||actor.model.position.distanceTo(g.player.model.position)>=30)return null;
 // Solid scenery owns the foreground; translucent water and guide rings do not.
 if(g.world.level){g.world.level.updateMatrixWorld(true);const blocker=ray.intersectObject(g.world.level,true).find(h=>h.distance<hit.distance-.02&&opaqueSurface(h));if(blocker)return null;}
 return actor;
}

// Keep individual order while enemies move; new arrivals join after the retained cycle.
export function cycleWildTarget(g,direction=1){
 if(g.phase!=='playing'||g.panel||g.transitioning||g.restoring||g.survivalDying||g.partnerChanging||g.capture||!(g.player?.hp>0))return undefined;
 const eligible=(g.wild||[]).filter(a=>a.hp>0&&!a.capturing&&a.model?.visible!==false&&a.model?.position.distanceTo(g.player.model.position)<30);
 const valid=new Set(eligible),order=g.targetCycle?.epoch===g.regionEpoch?[...g.targetCycle.actors]:[];
 const newcomers=eligible.filter(a=>!order.includes(a)).sort((a,b)=>a.model.position.distanceTo(g.player.model.position)-b.model.position.distanceTo(g.player.model.position));
 order.push(...newcomers);const step=direction<0?-1:1,current=order.indexOf(g.target||(g.targetCycle?.epoch===g.regionEpoch?g.targetCycle.selected:null));let selected=null;
 // Retain the old anchor for this turn so a defeated/removed target advances to its successor.
 for(let n=1;n<=order.length;n++){const i=(current<0?(step>0?n-1:order.length-n):current+step*n+order.length)%order.length;if(valid.has(order[i])){selected=order[i];break;}}
 g.targetCycle={epoch:g.regionEpoch,actors:order.filter(a=>valid.has(a)),selected};return selected;
}
