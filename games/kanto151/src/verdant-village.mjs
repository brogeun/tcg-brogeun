import * as THREE from '../vendor/three.module.js';
import {attachBaseWayfinding} from './base-wayfinding.mjs';

// The first camp is an authored ranger village. These local models use the
// original service points; the other expedition bases retain their own models.
const UP = new THREE.Vector3(0, 1, 0);
const C = {
 timber: 0x9c704c, edge: 0xc49869, endgrain: 0xd5b17b, dark: 0x513f31,
 plank: 0xb58a5f, plankAlt: 0xa77b53, stone: 0x8a8979, stoneLight: 0xaaa995,
 roof: 0x536b59, roofAlt: 0x617761, roofDark: 0x344b41, canvas: 0xded4ad,
 cream: 0xf1e3bd, glass: 0x729b98, shadow: 0x253a36, metal: 0x565e53,
 yellow: 0xd1a452, food: 0xe5ba68, water: 0x78afb3, warm: 0xffcf81,
 medical: 0xb95743, medicalDark: 0x854235,
};

// One batched surface attribute adds material-scale detail without extra draw
// meshes, image requests or resources outside the level's normal lifecycle.
const SURFACE = {
 timber: 1, edge: 1, endgrain: 1, dark: 1, plank: 1, plankAlt: 1,
 stone: 2, stoneLight: 2, roof: 3, roofAlt: 3, roofDark: 3,
 canvas: 4, cream: 4, yellow: 4, medical: 4, medicalDark: 4, metal: 5,
};
function villageSurface(material) {
 material.customProgramCacheKey = () => 'verdant-authored-surfaces-v1';
 material.onBeforeCompile = shader => {
  shader.vertexShader = 'attribute vec4 villageSurface; varying vec4 vVillageSurface;\n' + shader.vertexShader;
  shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvVillageSurface = villageSurface;');
  shader.fragmentShader = `varying vec4 vVillageSurface;
float villageHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float villageNoise(vec2 p) {
 vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
 return mix(mix(villageHash(i), villageHash(i + vec2(1., 0.)), f.x), mix(villageHash(i + vec2(0., 1.)), villageHash(i + vec2(1.)), f.x), f.y);
}
` + shader.fragmentShader;
  shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
vec2 surfaceUv = vVillageSurface.xy;
float surfaceKind = vVillageSurface.z;
float surfaceSeed = vVillageSurface.w;
float surfaceCloud = villageNoise(surfaceUv * 4.0 + surfaceSeed);
float surfaceFootprint = max(length(dFdx(surfaceUv)), length(dFdy(surfaceUv)));
float surfaceTone = 1.0;
if (surfaceKind > .5 && surfaceKind < 1.5) {
 float fibre = sin(surfaceUv.y * 112.0 + sin(surfaceUv.x * 2.8 + surfaceSeed) * 1.9 + surfaceCloud * 2.4);
 float grain = smoothstep(.68, .97, fibre);
 float knot = villageNoise(vec2(surfaceUv.x * 2.0, surfaceUv.y * 16.0) + surfaceSeed);
 surfaceTone = .90 + surfaceCloud * .13 - grain * .13 * (1.0 - smoothstep(.02, .055, surfaceFootprint)) - smoothstep(.73, .91, knot) * .075;
} else if (surfaceKind < 3.5 && surfaceKind > 1.5) {
 float fleck = villageNoise(surfaceUv * (surfaceKind < 2.5 ? 32.0 : 49.0) + surfaceSeed);
 surfaceTone = .84 + surfaceCloud * .18 + mix(.5, fleck, 1.0 - smoothstep(.012, .045, surfaceFootprint)) * .09;
} else if (surfaceKind > 3.5 && surfaceKind < 4.5) {
 float weave = sin(surfaceUv.x * 184.0) * sin(surfaceUv.y * 184.0);
 surfaceTone = .93 + surfaceCloud * .08 + weave * .025 * (1.0 - smoothstep(.008, .02, surfaceFootprint));
} else if (surfaceKind > 4.5) {
 surfaceTone = .87 + surfaceCloud * .16;
}
diffuseColor.rgb *= surfaceTone;
`);
  shader.fragmentShader = shader.fragmentShader.replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = clamp(roughnessFactor + (surfaceCloud - .5) * .09, .38, 1.0);
`);
 };
}

function workshop(world, spec, dimensions) {
 const rotation = spec.rotation || 0, y = world.height(spec.x, spec.z);
 const group = world.owned(new THREE.Group()), buckets = new Map(), colliders = [];
 const tag = spec.decoration ? 'baseDecoration' : 'baseFacility';
 group.name = `verdant-${spec.id}`;
 group.position.set(spec.x, y, spec.z); group.rotation.y = rotation;
 Object.assign(group.userData, {[tag]: spec.id, regionTheme: 'verdant', villageArchitecture: true});
 const add = (geometry, color, p = [0, 0, 0], r = [0, 0, 0], scale = [1, 1, 1], bucket = 'solid') => {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  if (!g.attributes.normal) g.computeVertexNormals();
  for (const attribute of Object.keys(g.attributes)) if (!['position', 'normal'].includes(attribute)) g.deleteAttribute(attribute);
  g.computeBoundingBox();
  const extent = g.boundingBox.getSize(new THREE.Vector3()).toArray(), axes = [0, 1, 2];
  axes.sort((a, b) => extent[b] - extent[a]);
  const colors = new Float32Array(g.attributes.position.count * 3), surface = new Float32Array(g.attributes.position.count * 4), base = new THREE.Color(C[color] ?? color);
  const seed = (p[0] * 17.19 + p[1] * 31.7 + p[2] * 9.73) % 91;
  for (let i = 0; i < g.attributes.position.count; i++) {
   // Subtle baked face tones keep the foundation and eaves legible in shade.
   const shade = .88 + Math.max(0, g.attributes.normal.getY(i)) * .12 + Math.min(0, g.attributes.normal.getY(i)) * .11;
   colors[i * 3] = base.r * shade; colors[i * 3 + 1] = base.g * shade; colors[i * 3 + 2] = base.b * shade;
   const normal = [g.attributes.normal.getX(i), g.attributes.normal.getY(i), g.attributes.normal.getZ(i)];
   const face = normal.map(Math.abs).indexOf(Math.max(...normal.map(Math.abs))), visibleAxes = axes.filter(axis => axis !== face);
   const point = [g.attributes.position.getX(i), g.attributes.position.getY(i), g.attributes.position.getZ(i)];
   surface[i * 4] = point[visibleAxes[0]]; surface[i * 4 + 1] = point[visibleAxes[1]];
   surface[i * 4 + 2] = SURFACE[color] || 0; surface[i * 4 + 3] = seed;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setAttribute('villageSurface', new THREE.BufferAttribute(surface, 4));
  const q = r.isQuaternion ? r : new THREE.Quaternion().setFromEuler(new THREE.Euler(...r));
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...p), q, new THREE.Vector3(...scale)));
  if (!buckets.has(bucket)) buckets.set(bucket, []);
  buckets.get(bucket).push(g);
 };
 const box = (color, size, p, r = [0, 0, 0], bucket = 'solid') => add(new THREE.BoxGeometry(...size), color, p, r, [1, 1, 1], bucket);
 const beam = (color, a, b, width = .12, bucket = 'solid') => {
  const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b), direction = to.clone().sub(from);
  add(new THREE.BoxGeometry(width, direction.length(), width), color, from.add(to).multiplyScalar(.5).toArray(), new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize()), [1, 1, 1], bucket);
 };
 const disc = (color, radius, height, p, bucket = 'solid') => add(new THREE.CylinderGeometry(radius, radius, height, 10), color, p, [0, 0, 0], [1, 1, 1], bucket);
 const collider = (x, z, width, depth, height, bottom = 0) => {
  const co = Math.cos(rotation), si = Math.sin(rotation);
  const c = {type: 'obb', baseFacility: spec.id, x: spec.x + x * co + z * si, z: spec.z - x * si + z * co,
   rotation, halfWidth: width / 2, halfDepth: depth / 2, h: height, bottomY: y + bottom, topY: y + bottom + height, r: Math.min(width, depth) / 2};
  world.colliders.push(c); colliders.push(c);
 };
 const finish = () => {
  const meshes = [], signs = {rations: [], drink: []};
  for (const [kind, pieces] of buckets) {
   const count = pieces.reduce((n, g) => n + g.attributes.position.array.length, 0), geometry = new THREE.BufferGeometry();
   for (const name of ['position', 'normal', 'color', 'villageSurface']) {
    const size = name === 'villageSurface' ? 4 : 3, merged = new Float32Array(count / 3 * size); let offset = 0;
    for (const g of pieces) {merged.set(g.attributes[name].array, offset); offset += g.attributes[name].array.length;}
    geometry.setAttribute(name, new THREE.BufferAttribute(merged, size));
   }
   for (const g of pieces) g.dispose();
   geometry.computeBoundingSphere();
   const material = new THREE.MeshStandardMaterial({vertexColors: true, roughness: kind === 'glass' ? .48 : .94, side: THREE.DoubleSide});
   villageSurface(material);
   if (kind === 'glass') {material.emissive.setHex(0x4b6756); material.emissiveIntensity = .16;}
   if (kind === 'flame') {material.emissive.setHex(0xff8b37); material.emissiveIntensity = .7;}
   const mesh = new THREE.Mesh(geometry, material);
   mesh.name = `verdant-${spec.id}-${kind}`; mesh.castShadow = true; mesh.receiveShadow = true;
   Object.assign(mesh.userData, {owned: true, [tag]: spec.id, villageArchitecture: true});
   if (signs[kind]) {mesh.userData.supplyKind = kind; signs[kind].push(mesh);}
   group.add(mesh); meshes.push(mesh);
  }
  return {...spec, ...dimensions, y, rotation, group, meshes, colliders, signs,
   entrance: {x: spec.x + Math.sin(rotation) * (dimensions.depth / 2 + .65), z: spec.z + Math.cos(rotation) * (dimensions.depth / 2 + .65)}};
 };
 return {world, spec, y, box, beam, disc, add, collider, finish};
}

function post(w, x, z, height) {
 w.box('stone', [.42, .25, .42], [x, .125, z]);
 w.box('dark', [.31, height - .15, .31], [x, height / 2 + .1, z]);
 w.box('edge', [.35, .13, .35], [x, height - .05, z]);
 w.box('timber', [.33, .12, .33], [x, .36, z]);
 w.collider(x, z, .34, .34, height);
}

function foundation(w, width, depth, front, cz = 0) {
 w.box('dark', [width, .15, depth], [0, .045, cz]);
 // The stone skirt follows the actual terrain rather than hovering as one
 // uniform plinth. Everything remains below the existing walking deck.
 const rotation = w.spec.rotation || 0, co = Math.cos(rotation), si = Math.sin(rotation);
 const groundedStone = (x, z, sx, sz, i) => {
  const ground = w.world.height(w.spec.x + x * co + z * si, w.spec.z - x * si + z * co) - w.y;
  const top = .115, bottom = Math.min(-.14, ground - .045), height = top - bottom;
  w.box(i % 4 ? 'stone' : 'stoneLight', [sx, height, sz], [x, bottom + height / 2, z], [0, (i % 3 - 1) * .012, 0]);
  if (i % 3 === 1) w.box('roofDark', [sx * .66, .035, sz + .012], [x + sx * .08, ground + .015, z]);
 };
 for (const side of [-1, 1]) {
  const count = Math.ceil(depth / .65);
  for (let i = 0; i < count; i++) groundedStone(side * (width / 2 - .095), cz + (i + .5) * depth / count - depth / 2, .24, depth / count - .025, i + (side + 1) * 3);
 }
 for (let i = 0; i < Math.ceil(width / .66); i++) {
  const count = Math.ceil(width / .66), x = (i + .5) * width / count - width / 2;
  groundedStone(x, cz - depth / 2 + .09, width / count - .025, .25, i);
  if (Math.abs(x) > 1.0) groundedStone(x, cz + depth / 2 - .09, width / count - .025, .25, i + 2);
 }
 for (let i = 0; i < Math.ceil(width / .75); i++) {
  const count = Math.ceil(width / .75), x = (i + .5) * width / count - width / 2;
  w.box(i % 3 ? 'stone' : 'stoneLight', [width / count - .025, .18, .3], [x, .08, -depth / 2 + cz]);
 }
 for (const side of [-1, 1]) for (let i = 0; i < 6; i++) w.box(i % 2 ? 'stone' : 'stoneLight', [.26, .18, depth / 6 - .02], [side * (width / 2 - .08), .08, (i + .5) * depth / 6 - depth / 2 + cz]);
 for (let i = 0; i < Math.ceil(width / .42); i++) {
  const count = Math.ceil(width / .42);
  w.box(i % 3 ? 'plank' : 'edge', [width / count - .017, .075, depth - .14], [(i + .5) * width / count - width / 2, .17, cz]);
  // Two rows of nail heads bind the floor to its joists.
  for (const side of [-1, 1]) w.disc('metal', .018, .009, [(i + .5) * width / count - width / 2, .212, cz + side * (depth / 2 - .26)]);
 }
 // Shallow steps are visual only; a blended walking surface follows the deck.
 w.box('stone', [1.7, .09, .43], [0, .025, front + .38]);
 w.box('edge', [1.62, .12, .44], [0, .08, front + .13]);
 const r = w.spec.rotation || 0;
 w.world.walkSurfaces?.push({kind: 'village-platform', x: w.spec.x + Math.sin(r) * cz, z: w.spec.z + Math.cos(r) * cz, rotation: r, width, length: depth, y: w.y + .205, blend: .65});
}

function wall(w, x, z, width, height, side = false) {
 const depth = .22;
 w.box('dark', side ? [depth, height, width] : [width, height, depth], [x, .22 + height / 2, z]);
 const count = Math.ceil(height / .27);
 for (let i = 0; i < count; i++) w.box(i % 3 ? 'plank' : 'plankAlt', side ? [.25, height / count - .016, width] : [width, height / count - .016, .25], [x, .22 + (i + .5) * height / count, z]);
 w.collider(x, z, side ? depth : width, side ? width : depth, height + .22);
}

function window(w, x, y, z, width = 1.05, height = .95, side = 0) {
 const rotate = [0, side, 0], co = Math.cos(side), si = Math.sin(side);
 const pane = (color, size, dx, dy, dz, bucket = 'solid') => w.box(color, size, [x + dx * co + dz * si, y + dy, z - dx * si + dz * co], rotate, bucket);
 pane('shadow', [width + .21, height + .2, .105], 0, 0, .01);
 pane('glass', [width - .12, height - .1, .05], 0, 0, .08, 'glass');
 for (const sign of [-1, 1]) {
  pane('edge', [.115, height + .2, .16], sign * width / 2, 0, .15);
  pane('edge', [width + .2, .11, .18], 0, sign * height / 2, .15);
 }
 pane('cream', [.055, height - .06, .09], 0, 0, .16);
 pane('cream', [width - .06, .055, .09], 0, .02, .16);
 pane('endgrain', [width + .34, .12, .35], 0, -height / 2 - .09, .17);
}

function roof(w, width, depth, eave, ridge) {
 const half = width / 2, rise = ridge - eave, angle = Math.atan2(rise, half), slope = Math.hypot(half, rise);
 for (const side of [-1, 1]) {
  w.box('roofDark', [slope, .18, depth], [side * half / 2, (eave + ridge) / 2, 0], [0, 0, side * -angle], 'roof');
  // Overlapping individual cedar shingles break the broad roof into a roof
  // that was assembled, with staggered joints and a worn lower lip.
  for (let row = 0; row < 5; row++) {
   const t = (row + .5) / 5, sx = side * half * t, py = ridge - rise * t + .10, unit = .72;
   for (let column = -1; column <= Math.ceil(depth / unit); column++) {
    const from = Math.max(-depth / 2, -depth / 2 + column * unit + (row % 2) * unit / 2);
    const to = Math.min(depth / 2, -depth / 2 + (column + 1) * unit + (row % 2) * unit / 2);
    if (to - from < .025) continue;
    const shade = Math.abs(column * 7 + row * 3 + side) % 5;
    w.box(shade === 0 ? 'roofDark' : shade < 3 ? 'roof' : 'roofAlt', [slope / 5 + .075, .075, to - from - .014], [sx, py + (shade % 2) * .009, (from + to) / 2], [0, 0, side * -angle], 'roof');
   }
  }
  for (const z of [-depth / 2, depth / 2]) w.beam('endgrain', [0, ridge + .01, z], [side * half, eave, z], .16);
  w.box('dark', [.16, .23, depth + .12], [side * half, eave - .04, 0]);
  for (let z = -depth / 2 + .2; z < depth / 2; z += .62) w.box('edge', [.36, .12, .105], [side * (half - .09), eave - .16, z], [0, 0, side * -angle]);
 }
 w.box('roofDark', [.22, .18, depth + .16], [0, ridge + .08, 0], [0, 0, 0], 'roof');
 for (let z = -depth / 2 + .3; z < depth / 2; z += .62) w.box('roofAlt', [.28, .095, .57], [0, ridge + .14, z], [0, 0, 0], 'roof');
 // Wooden triangles close the gable under the roof rather than leaving a sheet.
 for (const z of [-depth / 2 + .23, depth / 2 - .23]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-half + .28, eave - .04, z, half - .28, eave - .04, z, 0, ridge - .13, z], 3));
  geometry.computeVertexNormals(); w.add(geometry, 'plankAlt');
  w.box('dark', [width - .45, .17, .15], [0, eave - .1, z + .05]);
  w.beam('edge', [0, eave, z + .09], [0, ridge - .16, z + .09], .12);
 }
}

function lantern(w, x, y, z) {
 w.beam('metal', [x, y + .29, z], [x, y + .49, z], .04);
 w.box('metal', [.32, .07, .27], [x, y + .22, z]);
 w.box('warm', [.21, .29, .19], [x, y + .045, z], [0, 0, 0], 'glass');
 w.box('metal', [.29, .07, .25], [x, y - .13, z]);
 for (const side of [-1, 1]) w.box('metal', [.035, .31, .035], [x + side * .12, y + .04, z + .11]);
}

function crate(w, x, z, y = .2, size = .75) {
 w.box('timber', [size, size * .78, size * .85], [x, y + size * .39, z]);
 for (const side of [-1, 1]) {
  w.box('edge', [.08, size * .8, size * .9], [x + side * size * .37, y + size * .39, z]);
  w.box('edge', [size + .03, .08, size * .9], [x, y + size * (side < 0 ? .1 : .69), z]);
 }
 w.beam('dark', [x - size * .35, y + .08, z + size * .44], [x + size * .35, y + size * .69, z + size * .44], .065);
 w.collider(x, z, size, size * .87, y + size * .79);
}

function counter(w, x, z, width, kind, depth = .82) {
 w.box('dark', [width, .83, depth * .707], [x, .625, z]);
 for (let i = 0; i < 5; i++) w.box(i % 2 ? 'plank' : 'plankAlt', [width / 5 - .02, .76, .09], [x + (i - 2) * width / 5, .62, z + depth * .378]);
 w.box('endgrain', [width + .18, .13, depth + .01], [x, 1.105, z]);
 w.box('dark', [width + .19, .05, depth + .02], [x, 1.02, z]);
 w.collider(x, z, width + .14, depth, 1.18);
 if (kind === 'research') {
  for (const side of [-1, 1]) {
   w.box('dark', [.4, .06, .55], [x + side * .2, 1.22, z], [0, 0, side * .09]);
   w.box('cream', [.36, .055, .51], [x + side * .2, 1.267, z], [0, 0, side * .09]);
   w.box('roof', [.18, .012, .23], [x + side * .19, 1.301, z - .04], [0, 0, side * .09]);
  }
 } else if (kind === 'save') {
  for (let i = 0; i < 3; i++) w.box(i === 1 ? 'canvas' : 'roof', [.65, .08, .49], [x, 1.22 + i * .09, z]);
  w.box('cream', [.055, .25, .51], [x - .22, 1.32, z]);
 } else {
  for (const [dx, dz, h] of [[-.38, 0, .31], [.14, -.08, .38], [.44, .12, .25]]) {
   w.box('canvas', [.33, h, .36], [x + dx, 1.17 + h / 2, z + dz]);
   w.box('food', [.055, h + .025, .38], [x + dx, 1.17 + h / 2, z + dz], [0, 0, 0], 'rations');
  }
 }
}

function researchCabin(w) {
 foundation(w, 5.25, 6.25, 3.575, .45);
 wall(w, 0, -2.12, 4.8, 2.73);
 for (const side of [-1, 1]) {
  wall(w, side * 2.3, -.45, 3.5, 2.73, true);
  wall(w, side * 1.56, 1.22, 1.58, 2.73);
  window(w, side * 1.52, 1.85, 1.38, 1.06, .95);
  post(w, side * 2.32, 3.25, 2.77);
  w.beam('timber', [side * 2.32, 2.04, 3.25], [side * 1.65, 2.74, 3.25], .16);
  w.box('dark', [.2, 2.69, .27], [side * .79, 1.56, 1.23]);
  w.box('edge', [.12, 2.6, .3], [side * .69, 1.52, 1.27]);
  counter(w, side * 1.48, 3.25, 1.25, side < 0 ? 'research' : 'save');
 }
 w.box('dark', [1.5, .31, .28], [0, 2.74, 1.23]);
 w.box('edge', [1.47, .13, .3], [0, 2.55, 1.26]);
 w.box('shadow', [1.25, 2.21, .06], [0, 1.31, -.26]);
 w.box('plankAlt', [1.14, 2.04, .07], [0, 1.26, -.21]);
 for (let i = 0; i < 5; i++) w.box('dark', [.018, 2.0, .085], [(i - 2) * .22, 1.26, -.17]);
 w.box('metal', [.06, .2, .08], [.39, 1.25, -.10]);
 w.collider(0, -.23, 1.3, .13, 2.4);
 window(w, -2.47, 1.78, -.55, 1.12, .98, -Math.PI / 2);
 roof(w, 5.65, 5.45, 3.02, 4.45);
 w.box('roofDark', [5.5, .14, 2.56], [0, 2.9, 2.39], [.119, 0, 0], 'roof');
 for (let i = 0; i < 5; i++) w.box(i % 2 ? 'roof' : 'roofAlt', [5.51, .065, .55], [0, 3.064 - i * .061, 1.34 + i * .51], [.119, 0, 0], 'roof');
 w.box('edge', [5.52, .19, .15], [0, 2.73, 3.67]);
 for (const side of [-1, 1]) w.box('dark', [.16, .18, 2.62], [side * 2.69, 2.87, 2.4], [.119, 0, 0]);
 w.box('stone', [.62, 1.75, .65], [-1.65, 3.77, -1.48]);
 for (let i = 0; i < 5; i++) w.box(i % 2 ? 'stone' : 'stoneLight', [.64, .08, .67], [-1.65, 3.15 + i * .31, -1.48]);
 w.box('dark', [.84, .13, .86], [-1.65, 4.72, -1.48]);
 w.box('stoneLight', [.76, .07, .78], [-1.65, 4.8, -1.48]);
 // Two signs share one timber lintel and clearly face the original service path.
 w.box('roofDark', [2.08, .48, .16], [0, 2.67, 3.7]);
 w.box('cream', [1.72, .035, .04], [0, 2.5, 3.8]);
 w.box('cream', [.28, .27, .04], [-.43, 2.69, 3.8]);
 w.box('roofDark', [.028, .28, .045], [-.43, 2.69, 3.825]);
 w.add(new THREE.TorusGeometry(.13, .027, 5, 12), 'cream', [.38, 2.73, 3.815]);
 w.beam('cream', [.46, 2.62, 3.815], [.61, 2.48, 3.815], .05);
 lantern(w, 2.25, 2.03, 3.42);
 crate(w, -1.72, -1.35, .21, .72);
}

function supplyCabin(w) {
 foundation(w, 5.25, 4.75, 2.375);
 // An open market has a low stock enclosure, not a third closed cabin. Keep
 // the original enclosure obstacles and the service/encounter lanes intact.
 w.box('dark', [4.75, .94, .22], [0, .69, -1.96]);
 w.box('plank', [4.77, .13, .3], [0, 1.21, -1.96]);
 w.collider(0, -1.96, 4.75, .22, 2.62);
 for (const side of [-1, 1]) {
  w.box('plankAlt', [.25, .86, 3], [side * 2.28, .65, -.55]);
  w.box('edge', [.3, .12, 3.08], [side * 2.28, 1.14, -.55]);
  w.collider(side * 2.28, -.55, .22, 3, 2.62);
  w.box('plankAlt', [1.35, .86, .25], [side * 1.62, .65, .4]);
  w.box('endgrain', [1.43, .12, .32], [side * 1.62, 1.14, .4]);
  w.collider(side * 1.62, .4, 1.35, .22, 2.62);
  post(w, side * 2.28, 2.18, 2.61);
  w.beam('timber', [side * 2.28, 1.98, 2.18], [side * 1.7, 2.57, 2.18], .14);
  // The dojo encounter at (8,22) remains in the open porch, behind the counter.
  counter(w, side < 0 ? -2.2 : .45, 2.1, side < 0 ? .95 : 1.24, side < 0 ? 'shop' : 'rations', .55);
 }
 // Shallow, stocked rear shelving reads through the entire open facade.
 for (const x of [-2.28, 2.28]) w.box('dark', [.22, 3.04, .22], [x, 1.74, -1.96]);
 for (const sy of [.48, 1.32, 2.12]) {
  w.box('edge', [4.28, .1, .54], [0, sy, -1.54]);
  for (const [i, x] of [-1.48, -.52, .48, 1.45].entries()) {
   w.box(i % 2 ? 'canvas' : 'food', [.56, .47, .42], [x, sy + .285, -1.54]);
   w.box('yellow', [.08, .49, .435], [x, sy + .285, -1.54], [0, 0, 0], 'rations');
  }
 }
 // The old door obstacle is occupied by a storage chest rather than a door.
 w.box('timber', [1.68, .94, .12], [0, .69, -.34]);
 w.box('edge', [1.72, .12, .28], [0, 1.22, -.34]);
 w.collider(0, -.34, 1.69, .12, 2.3);
 // Broad cloth stripes cover the roof itself, so the supply stall is legible
 // from the elevated play camera even when the counter is partly occluded.
 const awningSlope = .14, awningAngle = Math.atan(awningSlope);
 for (let i = 0; i < 10; i++) {
  const x = (i - 4.5) * .582;
  const positions = [], point = (u, v) => {
   const px = x + u, z = v;
   return [px, 3.0 - awningSlope * z - .17 * Math.sin((z + 2.65) / 5.3 * Math.PI) + .023 * Math.cos(px * 21) * Math.sin((z + 2.65) / 5.3 * Math.PI), z];
  };
  for (let j = 0; j < 14; j++) {
   const a = -2.65 + j * 5.3 / 14, b = a + 5.3 / 14, p0 = point(-.292, a), p1 = point(.292, a), p2 = point(.292, b), p3 = point(-.292, b);
   positions.push(...p0, ...p2, ...p1, ...p0, ...p3, ...p2);
   if (i > 0) w.beam('canvas', [p0[0], p0[1] + .014, p0[2]], [p3[0], p3[1] + .014, p3[2]], .018, 'roof');
  }
  const cloth = new THREE.BufferGeometry(); cloth.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); cloth.computeVertexNormals();
  w.add(cloth, i % 2 ? 'cream' : 'yellow', [0, 0, 0], [0, 0, 0], [1, 1, 1], 'roof');
  w.box(i % 2 ? 'cream' : 'yellow', [.584, .3, .08], [x, 2.48, 2.62]);
 }
 for (const side of [-1, 1]) w.box('dark', [.14, .15, 5.29], [side * 2.8, 2.92, 0], [awningAngle, 0, 0]);
 w.box('dark', [5.7, .15, .13], [0, 2.63, 2.57]);
 w.box('dark', [5.7, .15, .13], [0, 3.36, -2.57]);
 // Canvas is tensioned directly to the corner posts, with sleeve seams at
 // the rods; ropes do not project into the market's walking approaches.
 for (const side of [-1, 1]) {
  w.beam('canvas', [side * 2.8, 2.63, 2.57], [side * 2.28, 2.52, 2.18], .04);
  w.beam('metal', [side * 2.28, 2.43, 2.18], [side * 2.28, 2.66, 2.18], .055);
  w.beam('timber', [side * 2.28, 1.87, -1.96], [side * 1.58, 3.32, -1.96], .12);
 }
 // Three tied sacks and stacked crates make the function clear at ground level.
 for (const [x, z, sy] of [[-1.65, -.98, .76], [-1.08, -1.0, .63], [-1.45, -.44, .57]]) {
  w.add(new THREE.SphereGeometry(.35, 8, 6), 'canvas', [x, .21 + sy / 2, z], [0, .1, -.08], [1, sy / .7, .85]);
  w.disc('dark', .12, .06, [x, .21 + sy, z]);
  w.disc('canvas', .13, .13, [x, .27 + sy, z]);
 }
 lantern(w, -2.22, 1.99, 2.33);
 crate(w, 1.48, -1.15, .21, .74); crate(w, 1.48, -1.15, .82, .6);
}

function recoveryPavilion(w) {
 foundation(w, 4.75, 4.55, 2.275);
 for (const side of [-1, 1]) {
  post(w, side * 2.03, 1.87, 2.82); post(w, side * 2.03, -1.86, 2.82);
  w.beam('timber', [side * 2.03, 2.12, 1.87], [side * 1.35, 2.79, 1.87], .16);
  w.box('dark', [.17, .18, 3.78], [side * 2.03, 2.7, 0]);
  w.box('timber', [.15, .74, 1.65], [side * 2.03, .68, -.78]);
  w.box('edge', [.24, .12, 1.78], [side * 2.03, 1.06, -.78]);
  w.collider(side * 2.03, -.78, .2, 1.78, 1.1);
 }
 // Low partitions and a rounded canvas cover distinguish a treatment pavilion
 // from the ranger's pitched-roof cabin. The front and sides stay visibly open.
 w.box('plankAlt', [3.95, .92, .25], [0, .68, -1.84]);
 w.box('edge', [4.03, .12, .3], [0, 1.2, -1.84]);
 w.collider(0, -1.84, 3.95, .22, 2.7);
 const canopyY = x => 3.55 - .68 * (x / 2.675) ** 2;
 for (let i = 0; i < 12; i++) {
  const a = -2.675 + i * 5.35 / 12, b = -2.675 + (i + 1) * 5.35 / 12;
  const ya = canopyY(a), yb = canopyY(b), dx = b - a, dy = yb - ya;
  w.box(i % 3 ? 'cream' : 'canvas', [Math.hypot(dx, dy) + .015, .09, 5.2], [(a + b) / 2, (ya + yb) / 2, 0], [0, 0, Math.atan2(dy, dx)], 'roof');
  for (const z of [-2.6, 2.6]) w.beam('medical', [a, ya - .025, z], [b, yb - .025, z], .12);
 }
 // A broad red cross on the canvas is readable from the normal high camera.
 w.box('medical', [.38, .035, 1.65], [0, 3.623, .06], [0, 0, 0], 'roof');
 for (let i = 0; i < 6; i++) {
  const a = -.825 + i * .275, b = a + .275, x = (a + b) / 2;
  w.box('medical', [.28, .035, .38], [x, canopyY(x) + .074, .06], [0, 0, Math.atan2(canopyY(b) - canopyY(a), b - a)], 'roof');
 }
 w.box('dark', [1.88, .33, 2.16], [.48, .41, -.57]);
 w.box('cream', [1.75, .23, 1.99], [.48, .69, -.57]);
 w.box('medical', [1.77, .075, 1.12], [.48, .847, -.18]);
 w.box('cream', [.55, .015, .16], [.48, .893, -.18]);
 w.box('cream', [.16, .015, .55], [.48, .893, -.18]);
 w.box('canvas', [1.13, .21, .49], [.48, .86, -1.19]);
 w.box('edge', [2.0, .62, .16], [.48, .73, -1.63]);
 w.collider(.48, -.58, 2.0, 2.22, 1.1);
 w.box('plank', [.73, .15, .8], [-1.17, .75, -.62]);
 for (const x of [-1.43, -.92]) w.box('dark', [.11, .56, .57], [x, .45, -.62]);
 w.collider(-1.17, -.62, .8, .85, .9);
 w.disc('canvas', .24, .1, [-1.17, .87, -.62]);
 w.disc('water', .17, .015, [-1.17, .933, -.62], 'glass');
 for (const x of [-1.5, 1.5]) {
  w.disc('canvas', .35, .13, [x, .29, 1.1]);
  w.disc('roof', .3, .06, [x, .39, 1.1]);
 }
 lantern(w, 1.94, 2.0, 2.02);
}

function waterStation(w) {
 w.box('stone', [1.3, .15, 1.05], [0, .075, 0]);
 for (const side of [-1, 1]) w.box('stoneLight', [.19, .59, .78], [side * .4, .4, -.04]);
 w.box('edge', [1.1, .14, .9], [0, .74, 0]);
 w.disc('roofDark', .4, .91, [0, 1.26, -.17]);
 for (const y of [.84, 1.63]) w.disc('metal', .42, .07, [0, y, -.17]);
 w.disc('endgrain', .43, .1, [0, 1.73, -.17]);
 w.beam('metal', [0, 1.22, .18], [0, 1.22, .48], .075);
 w.beam('metal', [0, 1.22, .48], [0, 1.09, .48], .075);
 w.disc('stone', .29, .15, [0, .88, .23]);
 w.disc('water', .22, .025, [0, .97, .23], 'glass');
 w.box('cream', [.43, .39, .05], [0, .46, .59]);
 w.add(new THREE.SphereGeometry(.105, 8, 6), 'water', [0, .44, .63], [0, 0, 0], [1, 1, .22], 'drink');
 w.add(new THREE.ConeGeometry(.104, .19, 8), 'water', [0, .56, .63], [0, 0, 0], [1, 1, .23], 'drink');
 w.collider(0, 0, 1.1, .9, 1.8);
}

function hearth(w) {
 for (let i = 0; i < 9; i++) {
  const a = i / 9 * Math.PI * 2;
  w.add(new THREE.DodecahedronGeometry(.13, 0), i % 3 ? 'stone' : 'stoneLight', [Math.cos(a) * .35, .12, Math.sin(a) * .35], [0, a, .1], [1.1, .8, 1.2]);
 }
 w.disc('dark', .29, .03, [0, .045, 0]);
 for (let i = 0; i < 3; i++) {const a = i * Math.PI / 3; w.beam('timber', [Math.cos(a) * -.3, .16, Math.sin(a) * -.3], [Math.cos(a) * .3, .21, Math.sin(a) * .3], .11);}
 w.add(new THREE.ConeGeometry(.16, .43, 6), 'yellow', [0, .36, 0], [0, 0, .12], [1, 1, 1], 'flame');
 w.add(new THREE.ConeGeometry(.085, .27, 5), 'warm', [.09, .28, -.04], [0, 0, -.2], [1, 1, 1], 'flame');
}

function villageEdges(w) {
 // One color-batched group dresses the edges of the clearing. Every object is
 // grounded independently; the service lane and encounter positions stay open.
 const ground = (x, z) => w.world.height(w.spec.x + x, w.spec.z + z) - w.y;
 const at = (x, z) => {
  const y = ground(x, z), point = p => [p[0] + x, p[1] + y, p[2] + z];
  return {
   box: (color, size, p, r, bucket) => w.box(color, size, point(p), r, bucket),
   add: (geometry, color, p, r, scale, bucket) => w.add(geometry, color, point(p), r, scale, bucket),
   beam: (color, a, b, width, bucket) => w.beam(color, point(a), point(b), width, bucket),
   disc: (color, radius, height, p, bucket) => w.disc(color, radius, height, point(p), bucket),
   collider: (cx, cz, width, depth, height, bottom = 0) => w.collider(cx + x, cz + z, width, depth, height, y + bottom),
  };
 };
 const fence = (x, z, length, alongZ) => {
  const point = (offset, height) => {
   const px = x + (alongZ ? 0 : offset), pz = z + (alongZ ? offset : 0);
   return [px, ground(px, pz) + height, pz];
  };
  for (const [i, offset] of [-length / 2, 0, length / 2].entries()) {
   const p = point(offset, 0), h = .88 + (i % 2) * .09;
   w.box('dark', [.2, h, .2], [p[0], p[1] + h / 2, p[2]], [alongZ ? .035 : 0, 0, alongZ ? 0 : -.035]);
   w.box('endgrain', [.21, .045, .21], [p[0], p[1] + h, p[2]]);
   w.box('stone', [.3, .12, .3], [p[0], p[1] + .04, p[2]]);
  }
  for (const h of [.34, .69]) {
   w.beam('plankAlt', point(-length / 2, h), point(-.12, h - .055), .115);
   w.beam('plank', point(.04, h - .035), point(length / 2, h + .015), .115);
  }
  w.beam('edge', point(-length / 2 + .08, .25), point(-.14, .76), .07);
  const levels = [ground(x, z), point(-length / 2, 0)[1], point(length / 2, 0)[1]], low = Math.min(...levels);
  w.collider(x, z, alongZ ? .24 : length + .22, alongZ ? length + .22 : .24, Math.max(...levels) - low + 1.05, low);
 };
 fence(-6, -9.9, 4.8, false);
 fence(-12.2, 1.7, 3.5, true);
 fence(12.1, 3.5, 4.5, true);

 const logs = at(-11.2, 5.5);
 for (let row = 0; row < 3; row++) for (let column = 0; column < 3 - row; column++) {
  const z = (column - (2 - row) / 2) * .3, y = .18 + row * .245, length = 2.15 - row * .12;
  logs.add(new THREE.CylinderGeometry(.145, .145, length, 7), row % 2 ? 'dark' : 'timber', [0, y, z], [0, 0, Math.PI / 2]);
  for (const side of [-1, 1]) logs.add(new THREE.CylinderGeometry(.125, .125, .018, 7), 'endgrain', [side * length / 2, y, z], [0, 0, Math.PI / 2]);
 }
 for (const x of [-.7, .7]) logs.box('metal', [.045, .74, 1.0], [x, .4, 0]);
 logs.collider(0, 0, 2.25, 1.0, .83);

 for (const [x, z] of [[11.2, 1.6], [12.0, .8]]) {
  const barrel = at(x, z);
  barrel.add(new THREE.CylinderGeometry(.34, .31, .87, 10), 'timber', [0, .455, 0]);
  for (let i = 0; i < 10; i++) {
   const a = i * Math.PI / 5;
   barrel.box('dark', [.018, .8, .025], [Math.sin(a) * .337, .46, Math.cos(a) * .337], [0, a, 0]);
  }
  for (const y of [.17, .72]) barrel.add(new THREE.TorusGeometry(.337, .024, 4, 10), 'metal', [0, y, 0], [Math.PI / 2, 0, 0]);
  barrel.disc('endgrain', .334, .055, [0, .915, 0]);
  for (const z of [-.13, .13]) barrel.box('plank', [.53, .033, .05], [0, .952, z]);
  barrel.collider(0, 0, .7, .7, .99);
 }

 // A roofed trail map faces the village, attached to the eastern fence line.
 const board = at(11.45, 4.2);
 for (const z of [-.78, .78]) {
  board.box('dark', [.19, 2.3, .19], [0, 1.15, z]);
  board.box('stone', [.3, .17, .3], [0, .075, z]);
 }
 board.box('timber', [.18, 1.34, 1.84], [0, 1.64, 0]);
 board.box('dark', [.04, 1.13, 1.61], [-.112, 1.64, 0]);
 board.box('canvas', [.025, 1.02, 1.48], [-.145, 1.64, 0]);
 for (const [y, z, sy, sz] of [[1.87, -.36, .29, .39], [1.38, .4, .34, .38], [1.72, .31, .18, .26]]) board.box('roof', [.015, sy, sz], [-.163, y, z], [.13, 0, 0]);
 board.beam('yellow', [-.18, 1.23, -.5], [-.18, 1.59, -.12], .045);
 board.beam('yellow', [-.18, 1.59, -.12], [-.18, 2.0, .49], .045);
 for (const [y, z] of [[1.23, -.5], [1.59, -.12], [2.0, .49]]) board.add(new THREE.SphereGeometry(.05, 6, 4), 'cream', [-.2, y, z]);
 for (const y of [1.02, 2.28]) board.box('edge', [.21, .1, 1.98], [-.02, y, 0]);
 board.box('roofDark', [.85, .13, 2.14], [0, 2.48, 0], [0, 0, -.13], 'roof');
 board.box('endgrain', [.07, .14, 2.17], [-.43, 2.53, 0]);
 board.collider(0, 0, .44, 1.98, 2.58);

 // Low worn slabs extend the existing service paths without raising the route.
 for (const [i, [x, z]] of [[-1.95, 3.53], [-2.6, 3.45], [-3.25, 3.56], [2.2, -1.94], [2.85, -2.04], [3.5, -1.93]].entries()) {
  const stone = at(x, z);
  stone.add(new THREE.CylinderGeometry(.32, .35, .045, 6), i % 2 ? 'stone' : 'stoneLight', [0, .016, 0], [0, i * .53, 0], [1.15, 1, .86]);
 }
}

/** Build only the starting village, preserving every existing service binding. */
export function buildVerdantVillage(world, layout) {
 if (layout.theme !== 'verdant') throw new Error('Verdant village requires the starting region layout');
 const facilities = [], decorations = [];
 const builders = {
  research: [researchCabin, {z: 19.2, width: 5.65, depth: 6.5, height: 4.85}],
  shop: [supplyCabin, {x: 7, z: 20.9, width: 5.82, depth: 5.25, height: 4.05}],
  heal: [recoveryPavilion, {x: -6.3, width: 5.35, depth: 5.2, height: 4.22}],
 };
 for (const facility of layout.facilities) {
  const [build, dimensions] = builders[facility.kind] || [];
  if (!build) throw new Error(`Unknown village facility: ${facility.kind}`);
  const spec = {...facility, ...(dimensions.x !== undefined ? {x: dimensions.x} : {}), ...(dimensions.z !== undefined ? {z: dimensions.z} : {}), theme: 'verdant'};
  const w = workshop(world, spec, dimensions); build(w); facilities.push(w.finish());
 }
 if (layout.water) {
  const w = workshop(world, {id: 'base-water', kind: 'drink', theme: 'verdant', ...layout.water}, {width: 1.3, depth: 1.05, height: 1.8});
  waterStation(w); facilities.push(w.finish());
 }
 if (layout.fire) {
  const point = Array.isArray(layout.fire) ? {x: layout.fire[0], z: layout.fire[1]} : layout.fire;
  const w = workshop(world, {id: 'base-fire', kind: 'fire', decoration: true, ...point}, {width: 1.0, depth: 1.0, height: .6});
  hearth(w); decorations.push(w.finish());
 }
 const edges = workshop(world, {id: 'base-village-edges', kind: 'village-edges', decoration: true, x: 0, z: 26}, {width: 26, depth: 17, height: 2.6});
 villageEdges(edges); decorations.push(edges.finish());
 world.baseFacilities = {facilities, decorations, signs: {rations: facilities.flatMap(f => f.signs.rations), drink: facilities.flatMap(f => f.signs.drink)}};
 attachBaseWayfinding(world, world.baseFacilities);
 return world.baseFacilities;
}
