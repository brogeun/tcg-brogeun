import * as THREE from '../vendor/three.module.js';
import {createDetailBatches} from './environment-detail.mjs';

// These are world objects, not persistent UI rings or floating activation icons.
// Keep the authored approach position and physics unchanged for existing saves.
export function createFieldObject(world, interaction, parent = world.level) {
 const {kind, x, z} = interaction, root = new THREE.Group();
 root.name = 'field-object-' + kind;
 root.userData.fieldObject = kind;
 root.position.set(x + .8, world.height(x + .8, z + .6), z + .6);
 parent.add(root);
 const materials = new Map();
 const mesh = (geometry, color, px, py, pz, rotation = 0) => {
  if (!materials.has(color)) materials.set(color, new THREE.MeshStandardMaterial({color, roughness: .92}));
  const part = new THREE.Mesh(geometry, materials.get(color));
  part.position.set(px, py, pz); part.rotation.y = rotation;
  part.castShadow = true; part.receiveShadow = true; part.userData.owned = true;
  root.add(part); return part;
 };
 const box = (color, px, py, pz, w, h, d, rotation) => mesh(new THREE.BoxGeometry(w,h,d), color, px,py,pz,rotation);
 const stone = 0x7b8378, dark = 0x414d45, wood = 0x806145, cream = 0xd4c4a0;
 if (kind === 'rune') {
  const body = mesh(new THREE.DodecahedronGeometry(.72,0), stone, 0,.68,0); body.scale.set(.7,1.25,.55);
  box(dark,0,.12,0,.9,.24,.7);
  for(let n=0;n<=interaction.rune;n++)box(cream,(n-interaction.rune/2)*.16,.85,.38,.055,.38,.035);
 } else if (kind === 'dig') {
  const body = mesh(new THREE.DodecahedronGeometry(.72,0), stone,0,.3,0);body.scale.set(1.2,.65,.8);
  for(let n=0;n<5;n++){
   const fossil=mesh(new THREE.TorusGeometry(.1+n*.045,.025,5,12,Math.PI*1.55),cream,-.13,.62+n*.008,.02);
   fossil.rotation.x=-Math.PI/2;
  }
 } else if (kind === 'fishing') {
  for(const dx of [-.4,.4])box(wood,dx,.4,0,.12,.8,.12);
  box(wood,0,.65,0,1.1,.12,.2);
  const rod=box(dark,0,1.06,.08,.045,1.65,.045);rod.rotation.z=-.3;
  const line=box(cream,.27,1.02,.08,.012,1.35,.012);line.rotation.z=.03;
  box(wood,.35,.15,.3,.32,.3,.32);
 } else if (kind === 'travel' || kind === 'capability') {
  box(wood,0,.72,0,.13,1.44,.13);
  box(cream,0,1.25,0,1.05,.38,.12);
  const arrow=box(dark,.13,1.25,.07,.34,.06,.025);arrow.rotation.z=.1;
  for(const side of [-1,1]){const tip=box(dark,.27,1.25+side*.07,.075,.2,.05,.025);tip.rotation.z=side*Math.PI/4;}
  if(interaction.shortcut?.capability==='climb')for(let n=0;n<3;n++)box(dark,-.32,1.14+n*.1,.075,.12,.035,.025);
 } else if ((kind === 'special' && interaction.acquisition?.kind === 'boss') || kind === 'elite') {
  box(stone,0,.14,0,1.1,.28,1.1);
  box(dark,0,.48,0,.62,.4,.62);
  mesh(new THREE.OctahedronGeometry(.28,0),cream,0,.9,0);
 } else {
  // A survey station / field notebook gives optional tasks a visible target.
  for(const dx of [-.35,.35])box(wood,dx,.35,0,.1,.7,.5);
  box(wood,0,.73,0,1,.12,.7);
  box(cream,0,.81,.03,.5,.045,.4);
  for(let n=0;n<3;n++)box(dark,-.04,.837,-.09+n*.09,.28,.008,.018);
 }
 // Bake the small parts into one draw call, including the engraved symbols.
 const batches=createDetailBatches({owned(part){part.userData.owned=true;root.add(part);return part;}},{prefix:root.name});
 for(const part of [...root.children]) {
  batches.add(part.geometry,part.material.color,part.position.toArray(),part.rotation.toArray().slice(0,3),part.scale.toArray());
  root.remove(part);
 }
 for(const material of materials.values())material.dispose();
 batches.flush();
 interaction.object = root;
 interaction.anchor = {x:root.position.x,z:root.position.z};
 return root;
}

export function bindShortcutObjects(world) {
 for(const i of world.interactions || []) {
  if(i.kind!=='capability'||i.object||!i.shortcut?.blockerAsset)continue;
  const placements=world.shortcutSnapshot(i.shortcut);
  const nearest=placements.sort((a,b)=>Math.hypot(a.p.x-i.x,a.p.z-i.z)-Math.hypot(b.p.x-i.x,b.p.z-i.z))[0];
  if(nearest)i.anchor={x:nearest.p.x,z:nearest.p.z};
 }
}
