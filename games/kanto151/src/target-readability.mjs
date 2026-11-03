const finite = n => Number.isFinite(n);
const overlapArea = (a,b) => Math.max(0,Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x)) * Math.max(0,Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y));

// Selected labels may shift around the HUD without moving the camera or actor.
export function positionSelectedLabel(anchor,size,obstacles=[],viewport={}) {
 const width=Number(viewport.width),height=Number(viewport.height),w=Number(size.w),h=Number(size.h),edge=8;
 if(![anchor?.x,anchor?.y,w,h,width,height].every(finite)||w<=0||h<=0||w>width-edge*2||h>height-edge*2)return null;
 const gap=12,left=anchor.x-w/2,top=anchor.y-h;
 const choices=[{x:left,y:top},{x:left,y:anchor.y+gap},{x:anchor.x+gap,y:anchor.y-h/2},{x:anchor.x-w-gap,y:anchor.y-h/2}];
 let best=null;
 for(const p of choices){
  const c={x:Math.max(edge,Math.min(width-w-edge,p.x)),y:Math.max(edge,Math.min(height-h-edge,p.y)),w,h};
  const overlap=obstacles.reduce((sum,o)=>sum+overlapArea(c,{x:o.x-5,y:o.y-4,w:o.w+10,h:o.h+8}),0);
  const distance=Math.hypot(c.x-left,c.y-top),score=overlap*100+distance;
  if(!best||score<best.score)best={...c,score,clear:overlap===0};
 }
 return best;
}

export function selectedTargetDetail(actor,distance,locale='ko-KR') {
 const hp=Math.max(0,Math.ceil(Number(actor?.hp)||0)),max=Math.max(0,Math.ceil(Number(actor?.maxHp)||0));
 const metres=Math.max(0,Math.round(Number(distance)||0));
 return {label:locale==='ko-KR'?'선택 대상':'Selected target',detail:`${metres}m · HP ${hp}/${max}`};
}
