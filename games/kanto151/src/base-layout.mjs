// Regional shelters share readable facilities while keeping their own setting.
const point=(x,z)=>Object.freeze([x,z]);
export const BASE_LABELS=Object.freeze({
 heal:{'ko-KR':'회복·친구 교체','en-US':'Recovery · Change friends'},
 research:{'ko-KR':'도감 연구','en-US':'Pokédex research'},
 save:{'ko-KR':'복귀 기록 저장','en-US':'Save return checkpoint'},
 shop:{'ko-KR':'물품 구매','en-US':'Buy supplies'},
 rations:{'ko-KR':'무료 음식 보충','en-US':'Free food refill'},
 drink:{'ko-KR':'보급소 · 식수대','en-US':'Supply shop · Drinking water'}
});
export const BASE_LAYOUT=Object.freeze({
 theme:'verdant',bounds:Object.freeze([-11.8,18.8,11.8,33.4]),
 facilities:Object.freeze([
  Object.freeze({id:'base-recovery',kind:'heal',x:-6,z:29.5,rotation:Math.PI/2}),
  Object.freeze({id:'base-research',kind:'research',x:-6,z:21.5,rotation:0}),
  Object.freeze({id:'base-supplies',kind:'shop',x:6,z:21.5,rotation:0})
 ]),
 points:Object.freeze({heal:point(-3.4,29.5),research:point(-7.2,24),save:point(-4.6,24),shop:point(4.6,24),rations:point(7.2,24),drink:point(9,26.3),pickup:point(-10.8,26.4)}),
 water:Object.freeze({x:9.8,z:25.1,sourceId:'verdant-spring'}),fire:Object.freeze({x:-1.65,z:25})
});

const regionalLabels=Object.freeze({
 heal:BASE_LABELS.heal,
 save:BASE_LABELS.save,
 rations:Object.freeze({'ko-KR':'음식 보충','en-US':'Refill food'}),
 drink:Object.freeze({'ko-KR':'물빛 해안 식수대','en-US':'Waterside drinking water'})
});
const regionalLayout=(id,x,z,water)=>Object.freeze({
 theme:id,labels:regionalLabels,bounds:Object.freeze([x-6,z-7,x+8,z+9]),
 facilities:Object.freeze([
  Object.freeze({id:`${id}-shelter`,kind:'heal',x:x+5,z:z+1,rotation:-Math.PI/2}),
  Object.freeze({id:`${id}-records`,kind:'save',x:x-3,z:z+5,rotation:0}),
  // The mountain's western edge meets the ascent ramp; keep supplies on the flat.
  Object.freeze({id:`${id}-rations`,kind:'rations',x:x+(id==='highlands'?7:5),z:z-5,rotation:0})
 ]),
 points:Object.freeze({heal:point(x+2.4,z+1),save:point(x-3,z+7.5),rations:point(x+(id==='highlands'?7:5),z-2.5)}),
 fire:Object.freeze({x:x+1.6,z:z+4.3}),
 decorations:Object.freeze([Object.freeze({id:`${id}-camp-dressing`,kind:'camp-dressing',x:x+5,z:z+6,rotation:0,theme:id})]),
 ...(water?{water:Object.freeze(water)}:{})
});
const regionalLayouts=Object.freeze({
 verdant:BASE_LAYOUT,
 waterside:regionalLayout('waterside',-18,28,{x:-17.2,z:14.8,sourceId:'waterside-spring'}),
 highlands:regionalLayout('highlands',-22,31),
 caldera:regionalLayout('caldera',-22,22),
 complex:regionalLayout('complex',-24,28)
});

export function containsBasePoint(x,z,region='verdant'){const b=regionalLayouts[region]?.bounds;return !!b&&x>=b[0]&&x<=b[2]&&z>=b[1]&&z<=b[3];}

// Do not splice props: apple trees and other authored bindings use their indices.
export function isBaseProp(p){return containsBasePoint(p.x,p.z)&&['nature/tent_detailedOpen','survival/workbench','survival/structure-canvas','survival/chest','nature/campfire_logs','survival/bedroll','nature/sign'].includes(p.rendererKey);}

export function baseComposition(composition){
 const layout=regionalLayouts[composition.id];if(!layout)return composition;
 const starting=composition.id==='verdant',paths=composition.paths.filter(p=>p.id!=='verdant-services'&&!p.id.startsWith('base-'));
 for(const [id,points,width] of starting?[
  ['base-recovery-approach',[[0,29.5],BASE_LAYOUT.points.heal],1.7],
  ['base-research-approach',[[0,24],BASE_LAYOUT.points.save,BASE_LAYOUT.points.research],1.7],
  ['base-supply-approach',[[0,24],BASE_LAYOUT.points.shop,BASE_LAYOUT.points.rations,BASE_LAYOUT.points.drink],1.7],
  ['base-cache-approach',[BASE_LAYOUT.points.research,BASE_LAYOUT.points.pickup],1.2]
 ]:[
  ['base-shelter-approach',[[composition.safePoint.position.x,layout.points.heal[1]],layout.points.heal],1.8],
  ['base-record-approach',[[composition.safePoint.position.x,composition.safePoint.position.z],[composition.safePoint.position.x,layout.points.save[1]],layout.points.save],1.7],
  ['base-rations-approach',[[composition.safePoint.position.x,layout.points.rations[1]],layout.points.rations],1.7]
 ])paths.push({id,points,width,surface:'soil'});
 return {...composition,paths,baseLayout:layout,...(starting?{services:{...composition.services,research:[...BASE_LAYOUT.points.research],shop:[...BASE_LAYOUT.points.shop]}}:{})};
}
