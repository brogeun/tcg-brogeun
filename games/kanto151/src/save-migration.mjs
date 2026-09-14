import {parseSave} from './core.mjs';
import {REGION_IDS,LEGACY_REGION,LEGACY_LANDMARK_ROLE,SHORTCUT_IDS,FIVE_WORLD,mapRegion} from './five-regions.mjs';
const unique=list=>[...new Set(list)];
const oldPrefix=id=>Object.keys(LEGACY_REGION).find(old=>id.startsWith(old+'-'));
export const mapLandmark=id=>LEGACY_LANDMARK_ROLE[oldPrefix(id)]||id;
function array(value,name){if(value===undefined)return [];if(!Array.isArray(value)||value.some(v=>typeof v!=='string'))throw Error('Invalid expedition '+name);return value;}
// Pure, transactional conversion: parse/validate first, mutate only the parsed copy,
// never award rewards, and never touch storage. Geometry is checked by enterRegion.
export function migrateFiveSave(text,compositions){
 const raw=typeof text==='string'?text:JSON.stringify(text),sourceVersion=JSON.parse(raw)?.version;
 const save=parseSave(raw);
 if(save.expedition!==undefined){const e=save.expedition;if(!e||typeof e!=='object'||Array.isArray(e))throw Error('Invalid expedition record');for(const k of ['landmarks','safePoints','openedRoutes','shortcuts','exits','capabilities'])array(e[k],k);if(e.claimedMilestones!==undefined&&(!Array.isArray(e.claimedMilestones)||e.claimedMilestones.some(n=>!Number.isInteger(n))))throw Error('Invalid reward claims');for(const k of ['research','activeGoals','tutorial','pickupClaims'])if(e[k]!==undefined&&(!e[k]||typeof e[k]!=='object'||Array.isArray(e[k])))throw Error('Invalid '+k);for(const r of Object.values(e.research||{}))if(!r||!Array.isArray(r.caught)||r.caught.some(id=>!Number.isInteger(id)||id<1||id>151)||typeof r.done!=='boolean')throw Error('Invalid research progress');}
 if(save.worldId===FIVE_WORLD){if(!REGION_IDS.includes(save.region))throw Error('Invalid five-region identity');return save;}
 const original=structuredClone(save),region=mapRegion(save.region);
 if(!REGION_IDS.includes(region))throw Error('Unmapped saved region');
 const entry=compositions?.regions[region]?.safePoint?.position;
 if(!entry||![entry.x,entry.z].every(Number.isFinite))throw Error('New region has no safe-entry contract');
 save.version=3;save.worldId=FIVE_WORLD;save.region=region;save.position=[entry.x,entry.z];
 save.discovered=unique(save.discovered.map(id=>{const mapped=mapRegion(id);if(!REGION_IDS.includes(mapped))throw Error('Unknown discovered region');return mapped;}));
 const e=save.expedition??={};
 if(typeof e!=='object'||Array.isArray(e))throw Error('Invalid expedition record');
 // Keep exact original per-site records as audit/progress history; remapped claims
 // below suppress replay at merged landmarks, research desks and rest points.
 save.migration={version:1,fromVersion:sourceVersion,fromRegion:original.region,fromPosition:original.position,legacyDiscovered:original.discovered,legacyLabAccess:original.region==='laboratory'||original.discovered.includes('laboratory'),legacyExpedition:original.expedition||{},legacyPickupClaims:original.flags};
 e.landmarks=unique(array(e.landmarks,'landmarks').map(mapLandmark));
 e.safePoints=unique(array(e.safePoints,'safePoints').map(id=>{const old=oldPrefix(id);return old?mapRegion(old)+'-rest':id;}));
 e.openedRoutes=unique(array(e.openedRoutes,'openedRoutes').map(mapRegion));
 e.shortcuts=unique(array(e.shortcuts,'shortcuts').map(id=>SHORTCUT_IDS[id]||id));
 e.exits=unique(array(e.exits,'exits').map(id=>id.split(':').map(mapRegion).join(':')).filter(id=>{const [a,b]=id.split(':');return a!==b;}));
 e.capabilities=array(e.capabilities,'capabilities');
 if(e.research!==undefined&&(!e.research||typeof e.research!=='object'||Array.isArray(e.research)))throw Error('Invalid research records');
 const research={};for(const [old,r] of Object.entries(e.research||{})){
  if(!r||!Array.isArray(r.caught)||r.caught.some(id=>!Number.isInteger(id)||id<1||id>151)||typeof r.done!=='boolean')throw Error('Invalid research progress');
  const key=mapRegion(old);if(!REGION_IDS.includes(key))throw Error('Unknown research region');
  const out=research[key]??={caught:[],done:false};out.caught=unique([...out.caught,...r.caught]);out.done||=r.done;
 }
 e.research=research;e.activeGoals=Object.fromEntries(Object.entries(e.activeGoals||{}).map(([id,goal])=>[mapRegion(id),mapLandmark(goal)]));
 if(e.claimedMilestones!==undefined&&(!Array.isArray(e.claimedMilestones)||e.claimedMilestones.some(n=>!Number.isInteger(n))))throw Error('Invalid reward claims');
 // A save predating expedition rewards must not replay old collection milestones.
 e.claimedMilestones??=[5,10,20,30,50,75,100,125,150,151].filter(n=>Object.values(save.dex).filter(d=>d.caught).length>=n);
 e.pickupClaims={...(e.pickupClaims||{})};for(const [key,value] of Object.entries(save.flags))if(/-landmark-\d+$/.test(key)){
  const old=oldPrefix(key);if(old){const target=LEGACY_LANDMARK_ROLE[old];e.pickupClaims[target]=value;}
 }
 return save;
}
