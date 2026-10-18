// A small overlay on the existing model animation. It never moves the actor or
// touches attack/status poses. The model animator resets bones before each call.
export function applyWildEcologyPose(actor){
 const pose=actor.ecologyPose;
 if(actor.faction!=='wild'||!pose||actor.moving||actor.angry||actor.capturing||actor.action||actor.recoil||actor.hp<=0||actor.status)return;
 const bones=actor.model.userData.bones;if(!bones?.size)return;
 let head=null;for(const [name,bone]of bones)if(/(^|_)(head|neck)(\d|_|$)/i.test(name)){head=bone;break;}
 if(head){head.rotation.x+=Math.max(-.3,Math.min(.3,pose.headPitch||0));head.rotation.y+=Math.max(-.22,Math.min(.22,pose.headYaw||0));}
 // Top-level bones are in model pixels. Breathing/dipping stays within the rig,
 // leaving the grounded root, hit tests and movement direction unchanged.
 for(const bone of bones.values())if(!bone.parent?.userData?.bedrock){
  const dip=Math.max(-.06,Math.min(.06,pose.bodyDip||0));
  bone.position.y+=dip*16;
  bone.scale.y*=Math.max(.98,Math.min(1.02,pose.breath||1));
 }
}
