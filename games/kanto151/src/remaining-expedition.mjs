import {verdantExpeditionComposition,verdantExpeditionPlan,buildVerdantExpedition} from './verdant-expedition.mjs';
import {watersideExpeditionComposition,watersideExpeditionPlan,buildWatersideExpedition} from './waterside-expedition.mjs';
import {calderaExpeditionComposition,calderaExpeditionPlan,buildCalderaExpedition,CALDERA_REPLACED_PROPS} from './caldera-expedition.mjs';
import {highlandsOutdoorPlan,buildHighlandsOutdoor} from './highlands-outdoor.mjs';

const regions={verdant:[verdantExpeditionComposition,verdantExpeditionPlan,buildVerdantExpedition],waterside:[watersideExpeditionComposition,watersideExpeditionPlan,buildWatersideExpedition],caldera:[calderaExpeditionComposition,calderaExpeditionPlan,buildCalderaExpedition],highlands:[c=>c,highlandsOutdoorPlan,buildHighlandsOutdoor]};
export const expeditionComposition=c=>regions[c.id]?{...regions[c.id][0](c),expeditionRebuilt:true}:c;
export const remainingExpeditionPlan=c=>regions[c.id]?.[1](c)||[];
export const buildRemainingExpedition=(world,c)=>regions[c.id]?.[2](world,c)||null;
export const expeditionReplacesProp=(id,index)=>id==='caldera'&&CALDERA_REPLACED_PROPS.includes(index);
