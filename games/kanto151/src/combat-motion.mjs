import {movePresentation} from './move-presentation.mjs';

const clamp=(n,a,b)=>Math.max(a,Math.min(b,Number.isFinite(n)?n:a));
const smooth=n=>{n=clamp(n,0,1);return n*n*(3-2*n);};
const floating=new Set([81,82,92,93,94,109,110,151]);
const serpentine=new Set([10,11,13,14,23,24,95,129,130,147,148]);
const aquatic=new Set([72,73,86,87,90,91,116,117,118,119,131,138,139,140,141]);
const quadruped=new Set([1,2,3,19,20,27,28,29,30,31,32,33,34,37,38,50,51,52,53,58,59,77,78,111,128,133,134,135,136]);
const heavy=new Set([3,9,31,34,76,80,95,111,112,130,131,143]);
const contact=new Set(['contact','rush','slash','bite','punch','kick','vine']);
const breath=new Set(['jet','flame','ember','frost','beam','solar','sound','sludge','powder']);
const psychic=new Set(['psychic','shadow','drain','star','spark']);
const support=new Set(['heal','shield','buff','status']);

// Roles are discovered once from each actual rig. Decorative/locator bones and
// repeated child joints stay untouched, so unusual bodies keep their own shape.
export function createCombatProfile(info={},boneNames=[]){
 const names=[...boneNames],find=pattern=>names.filter(n=>pattern.test(n));
 const first=patterns=>{for(const p of patterns){const result=find(p);if(result.length)return result.slice(0,3);}return [];};
 const roles={
  torso:first([/^torso$/i,/^(upper_torso|chest)$/i,/^body$/i,/^allbodies$/i]),
  head:first([/^head\d*$/i,/^upperhead$/i]),
  jaw:first([/^jaw$/i,/^(lower_jaw|beak_lower)$/i]),
  armLeft:find(/^(arm_(?:back_)?left|left_upper_arm)$/i),
  armRight:find(/^(arm_(?:back_)?right|right_upper_arm)$/i),
  legLeft:find(/^(leg_(?:(?:front|back)_)?left|left_upper_leg)$/i),
  legRight:find(/^(leg_(?:(?:front|back)_)?right|right_upper_leg)$/i),
  wingLeft:first([/^wing_left_base$/i,/^(wing_left|left_wing)$/i,/^wing_(?:open|air)_left$/i]),
  wingRight:first([/^wing_right_base$/i,/^(wing_right|right_wing)$/i,/^wing_(?:open|air)_right$/i]),
  tail:first([/^tail$/i,/^tail_?1$/i,/^segment1$/i]),
  vineLeft:find(/^vine_left$/i),vineRight:find(/^vine_right$/i)
 };
 const id=Number(info.id),winged=roles.wingLeft.length+roles.wingRight.length>0;
 const stance=floating.has(id)||/\.air_idle$/.test(info.clips?.idle||'')?'floating':serpentine.has(id)?'serpentine':aquatic.has(id)?'aquatic':winged?'winged':quadruped.has(id)||names.some(n=>/^leg_(front|back)_/i.test(n))?'quadruped':roles.legLeft.length+roles.legRight.length?'biped':'compact';
 return {id,stance,heavy:heavy.has(id),roles};
}

// Manifest "attack" entries used to include hurt/cry clips. Only explicitly
// authored attacks of the requested class may be layered over the shared pose.
export function selectCombatClip(info={},animations={},move={}){
 const expected=move.damageClass==='physical'?'physical':'special';
 const available=Object.keys(animations);
 const exact=available.find(name=>new RegExp(`\\.${expected}(?:_attack)?$`,'i').test(name));
 if(exact)return exact;
 const attack=info.clips?.attack;
 if(attack&&available.includes(attack)&&/\.attack$/i.test(attack))return attack;
 return null;
}

const neutral=()=>({forward:0,lift:0,pitch:0,yaw:0,roll:0,squash:0,roles:{},weight:0,clipProgress:0,phase:'rest',family:'contact'});

// Timing and rotations are plain numbers: no Three dependency and no actor
// position mutation. Every family has a safe root pose even without any limbs.
export function sampleCombatMotion(profile,motion,{reducedMotion=false,height=1}={}){
 const pose=neutral();if(!motion?.move)return pose;
 const move=motion.move,duration=clamp(motion.duration,.08,8),time=clamp(motion.elapsed,0,8);
 if(time>=duration)return pose;
 const cast=clamp(motion.castTime,0,Math.max(0,duration-.025)),peak=Math.min(duration*.94,cast+.035),launch=Math.max(0,cast-.045);
 const wind=time<cast?smooth(time/Math.max(.001,cast)):1-smooth((time-cast)/.09);
 let strike=time<peak?smooth((time-launch)/Math.max(.001,peak-launch)):1-smooth((time-peak)/Math.max(.001,duration-peak));
 const hits=move.engine?.template==='multi-hit'?Math.round(clamp(move.engine.hitCount||2,1,12)):1;
 if(hits>1){
  strike=0;
  for(let i=0;i<hits;i++){
   const at=cast+i*.14,p=Math.min(duration-.01,at+.02),start=Math.max(0,at-.04),end=i===hits-1?duration:at+.105;
   const pulse=time<p?smooth((time-start)/Math.max(.001,p-start)):1-smooth((time-p)/Math.max(.001,end-p));
   strike=Math.max(strike,pulse);
  }
 }
 const envelope=Math.sin(Math.PI*clamp(time/duration,0,1));
 const family=movePresentation(move),isContact=contact.has(family),isBreath=breath.has(family),isPsychic=psychic.has(family),isSupport=support.has(family);
 const hitIndex=hits>1?clamp(Math.floor((time-cast+.025)/.14),0,hits-1):0;
 const sign=((Number(motion.serial)||0)+hitIndex)%2===0?1:-1;
 const amount=(motion.basic?.72:1)*(profile.heavy?.8:1),bodyScale=clamp(height,.7,3.5),motionScale=reducedMotion?.2:1,limbScale=reducedMotion?.45:1;
 pose.family=family;pose.phase=time<cast?'windup':time<cast+(hits-1)*.14+.1?'release':'recovery';
 pose.weight=envelope;pose.clipProgress=time<cast?.4*time/Math.max(.001,cast):.4+.6*(time-cast)/Math.max(.001,duration-cast);
 pose.forward=(-wind*.065+strike*(isContact?.18:isBreath?-.035:.035))*bodyScale*amount*motionScale;
 pose.lift=(isSupport?.045*envelope:isPsychic?.075*envelope:family==='kick'?.065*strike:0)*bodyScale*motionScale;
 pose.pitch=(wind*-.065+strike*(isBreath?-.035:isContact?.11:.035))*amount*motionScale;
 pose.yaw=(isContact?sign*(-wind*.09+strike*.14):0)*amount*motionScale;
 pose.roll=(family==='slash'?sign*strike*.06:family==='kick'?-sign*strike*.07:0)*motionScale;
 pose.squash=(-wind*.035+strike*.012)*motionScale;
 const r=pose.roles,limb=n=>n*amount*limbScale;
 r.torso=[limb(wind*-.1+strike*(isBreath?-.07:isContact?.14:.04)),limb(isContact?sign*(-wind*.12+strike*.22):0),0];
 r.head=[limb(wind*-.08+strike*(family==='bite'?.28:isBreath?-.14:.04)),0,0];
 r.tail=[0,limb(sign*(wind*.12-strike*.22)),0];
 r.jaw=[limb((family==='bite'?wind*.42+strike*.1:isBreath?(wind*.12+strike*.32):0)),0,0];
 let left=-wind*.16-strike*.2,right=left,spread=isPsychic?envelope*.25:isSupport?envelope*.2:.05*strike;
 if(family==='punch'||family==='slash'){right=wind*.3-strike*.95;left=-wind*.2-strike*.15;}
 else if(isPsychic){left=right=-wind*.3-strike*.65;}
 else if(isSupport){left=right=-envelope*.48;}
 else if(isBreath){left=right=wind*.12-strike*.1;}
 if(sign<0&&isContact)[left,right]=[right,left];
 r.armLeft=[limb(left),0,limb(-spread)];r.armRight=[limb(right),0,limb(spread)];
 r.legLeft=[0,0,0];r.legRight=[0,0,0];
 if(family==='kick')r[sign>0?'legRight':'legLeft']=[limb(wind*.3-strike*1.05),0,limb(sign*strike*.1)];
 else if(profile.stance==='quadruped'&&isContact){r.legLeft=[limb(wind*.06-strike*.14),0,0];r.legRight=[limb(wind*.06-strike*.14),0,0];}
 const flap=(family==='gust'?wind*.2-strike*.65:isContact?wind*.1-strike*.3:envelope*.16);
 r.wingLeft=[0,limb(-flap*.2),limb(flap)];r.wingRight=[0,limb(flap*.2),limb(-flap)];
 r.vineLeft=[limb(-strike*.35),limb(wind*.2-strike*.4),0];r.vineRight=[limb(-strike*.35),limb(-wind*.2+strike*.4),0];
 // Named technique accents are visual-only: actor collision, reach and damage stay unchanged.
 const slug=move.slug||'',accent=motionScale*amount,flight=Math.sin(Math.PI*clamp(time/duration,0,1));
 if(['sky-uppercut','jump-kick','high-jump-kick','bounce','fly'].includes(slug)){
  pose.lift+=flight*bodyScale*(slug==='fly'||slug==='bounce'?.27:.12)*accent;
  if(slug==='sky-uppercut'){r.armRight[0]-=limb(strike*.55);r.torso[0]-=limb(strike*.13);}
  if(slug==='fly')r.wingLeft[2]-=limb(strike*.35),r.wingRight[2]+=limb(strike*.35);
 }
 if(['dig','dive'].includes(slug)){pose.lift-=flight*bodyScale*.16*accent;pose.pitch-=flight*.08*accent;}
 if(['cross-chop','brick-break','karate-chop'].includes(slug)){r.armRight[0]-=limb(strike*.25);r.armRight[2]-=limb(strike*.3);if(slug==='cross-chop'){r.armLeft[0]=r.armRight[0];r.armLeft[2]=-r.armRight[2];}}
 if(['focus-punch','dynamic-punch','mega-punch'].includes(slug)){r.torso[1]+=limb(sign*(wind*.12-strike*.13));r.armRight[0]-=limb(strike*.18);pose.squash-=wind*.025*motionScale;}
 if(['rollout','ice-ball','rapid-spin','gyro-ball'].includes(slug))pose.roll+=Math.sin(time*18)*strike*.12*accent;
 if(['withdraw','protect','detect','endure','stockpile','iron-defense','harden'].includes(slug)){pose.squash-=flight*.065*motionScale;r.armLeft[2]-=limb(flight*.22);r.armRight[2]+=limb(flight*.22);}
 if(['meditate','calm-mind','cosmic-power','psychic','future-sight'].includes(slug)){pose.lift+=flight*bodyScale*.08*motionScale;r.armLeft[2]-=limb(flight*.18);r.armRight[2]+=limb(flight*.18);}
 if(['swords-dance','dragon-dance','teeter-dance','petal-dance','rain-dance'].includes(slug)){pose.yaw+=Math.sin(time/duration*Math.PI*2)*.18*motionScale;pose.lift+=flight*.08*bodyScale*motionScale;}
 if(profile.stance==='serpentine'){pose.yaw*=.65;r.torso[1]+=limb(sign*(-wind*.12+strike*.16));r.tail[1]*=1.5;}
 if(profile.stance==='floating'){pose.lift+=envelope*.06*bodyScale*motionScale;pose.squash*=.3;}
 if(profile.stance==='aquatic'){pose.pitch*=.55;pose.lift*=.4;}
 if(profile.stance==='compact'){pose.roll+=sign*strike*.08*motionScale;pose.squash-=wind*.025*motionScale;}
 return pose;
}

export function sampleRecoilMotion(elapsed,duration=.25,{reducedMotion=false,height=1}={}){
 const pose=neutral(),t=clamp(elapsed,0,2)/clamp(duration,.08,2);
 if(t>=1)return pose;
 const kick=smooth(t/.2)*(1-smooth((t-.2)/.8)),scale=reducedMotion?.3:1;
 pose.weight=kick;pose.pitch=-kick*.12*scale;pose.forward=-kick*.045*clamp(height,.7,3.5)*scale;
 pose.roles={head:[-kick*.12*scale,0,0],torso:[-kick*.06*scale,0,0],armLeft:[kick*.14*scale,0,0],armRight:[kick*.14*scale,0,0]};
 return pose;
}

export function applyCombatBonePose(bones,profile,pose){
 for(const [role,rotation] of Object.entries(pose.roles)){
  const names=profile.roles[role]||[],weight=names.length>1?1/Math.sqrt(names.length):1;
  for(const name of names){const bone=bones.get(name);if(!bone)continue;bone.rotation.x+=rotation[0]*weight;bone.rotation.y+=rotation[1]*weight;bone.rotation.z+=rotation[2]*weight;}
 }
}
