import {waterAt,deckAt} from './region-world.mjs';
// Small bounded grid search, only on explicit click/goal selection; no per-frame search.
export function fieldPath(game,point){const world=game.world,start=game.player.model.position,step=2,key=(x,z)=>`${x},${z}`,toCell=n=>Math.round(n/step),goal={x:toCell(point.x),z:toCell(point.z)},origin={x:toCell(start.x),z:toCell(start.z)},open=[{...origin,g:0,h:Math.hypot(goal.x-origin.x,goal.z-origin.z),parent:null}],seen=new Map();let reached=null,iterations=0;
 const walkable=(x,z)=>game.canStandAt(x,z);
 // Grid endpoints can sit on opposite sides of a thin rail or cliff. Validate
 // the whole movement segment with the same ground/collision rules as WASD.
 const edge=(a,b)=>{const distance=Math.hypot(b.x-a.x,b.z-a.z),samples=Math.ceil(distance/.1);let previous=a;for(let i=1;i<=samples;i++){const p={x:a.x+(b.x-a.x)*i/samples,z:a.z+(b.z-a.z)*i/samples};if(!walkable(p.x,p.z)||!game.canStepTo(p.x,p.z,previous))return false;previous=p;}return true;};
 const exact=walkable(point.x,point.z);
 if(exact&&edge(start,point))return Math.hypot(point.x-start.x,point.z-start.z)<.18?[]:[{x:point.x,z:point.z}];
 // Near a goal, accept a node only when the final segment is also usable.
 // A nearby grid cell can otherwise end the search before an available detour.
 while(open.length&&iterations++<6500){open.sort((a,b)=>a.g+a.h-b.g-b.h);const n=open.shift(),id=key(n.x,n.z);if(seen.has(id))continue;seen.set(id,n);const current=n.parent?{x:n.x*step,z:n.z*step}:start;if(n.h<1.5&&(exact?edge(current,point):Math.hypot(current.x-point.x,current.z-point.z)<=4.5)){reached=n;break;}for(const [dx,dz] of [[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,1],[1,-1],[-1,-1]]){const x=n.x+dx,z=n.z+dz;if(seen.has(key(x,z))||!walkable(x*step,z*step))continue;if(dx&&dz&&(!walkable(n.x*step,z*step)||!walkable(x*step,n.z*step)))continue;if(!edge(current,{x:x*step,z:z*step}))continue;open.push({x,z,g:n.g+Math.hypot(dx,dz),h:Math.hypot(goal.x-x,goal.z-z),parent:n});}}
 if(!reached)return [];
 const path=[];for(let n=reached;n?.parent;n=n.parent)path.push({x:n.x*step,z:n.z*step});path.reverse();if(exact)path.push({x:point.x,z:point.z});return path;
}
