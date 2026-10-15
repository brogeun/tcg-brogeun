// Only the starting camp uses this layout; regional shelters keep their own design.
const point=(x,z)=>Object.freeze([x,z]);
export const BASE_LABELS=Object.freeze({
 heal:{'ko-KR':'회복 쉼터','en-US':'Recovery shelter'},
 research:{'ko-KR':'연구·기록소','en-US':'Research station'},
 save:{'ko-KR':'연구·기록소 · 기록 저장','en-US':'Research station · Save record'},
 shop:{'ko-KR':'보급소','en-US':'Supply shop'},
 rations:{'ko-KR':'보급소 · 기본 식량','en-US':'Supply shop · Camp food'},
 drink:{'ko-KR':'보급소 · 식수대','en-US':'Supply shop · Drinking water'},
 camp:{'ko-KR':'친구 쉼터','en-US':'Companion shelter'}
});
export const BASE_LAYOUT=Object.freeze({
 facilities:Object.freeze([
  Object.freeze({id:'base-recovery',kind:'heal',x:-6,z:29.5,rotation:Math.PI/2}),
  Object.freeze({id:'base-research',kind:'research',x:-6,z:21.5,rotation:0}),
  Object.freeze({id:'base-supplies',kind:'shop',x:6,z:21.5,rotation:0}),
  Object.freeze({id:'base-companions',kind:'camp',x:6,z:30,rotation:-Math.PI/4})
 ]),
 points:Object.freeze({heal:point(-3.4,29.5),research:point(-7.2,24),save:point(-4.6,24),shop:point(4.6,24),rations:point(7.2,24),camp:point(4.2,31.8),drink:point(9,26.3),pickup:point(-10.8,26.4)}),
 water:Object.freeze({x:9.8,z:25.1}),fire:Object.freeze({x:-1.65,z:25})
});

export function containsBasePoint(x,z){return x>=-11.8&&x<=11.8&&z>=18.8&&z<=33.4;}

// Do not splice props: apple trees and other authored bindings use their indices.
export function isBaseProp(p){return containsBasePoint(p.x,p.z)&&['nature/tent_detailedOpen','survival/workbench','survival/structure-canvas','survival/chest','nature/campfire_logs','survival/bedroll','nature/sign'].includes(p.rendererKey);}

export function baseComposition(composition){
 if(composition.id!=='verdant')return composition;
 const paths=composition.paths.filter(p=>p.id!=='verdant-services'&&!p.id.startsWith('base-'));
 for(const [id,points,width] of [
  ['base-recovery-approach',[[0,29.5],BASE_LAYOUT.points.heal],1.7],
  ['base-research-approach',[[0,24],BASE_LAYOUT.points.save,BASE_LAYOUT.points.research],1.7],
  ['base-supply-approach',[[0,24],BASE_LAYOUT.points.shop,BASE_LAYOUT.points.rations,BASE_LAYOUT.points.drink],1.7],
  ['base-companion-approach',[[0,30],BASE_LAYOUT.points.camp],1.7],
  ['base-cache-approach',[BASE_LAYOUT.points.research,BASE_LAYOUT.points.pickup],1.2]
 ])paths.push({id,points,width,surface:'soil'});
 return {...composition,paths,services:{...composition.services,research:[...BASE_LAYOUT.points.research],shop:[...BASE_LAYOUT.points.shop]}};
}
