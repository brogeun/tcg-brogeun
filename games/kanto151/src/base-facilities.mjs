import * as THREE from '../vendor/three.module.js';

const COLORS = {
 wood: 0xaa784a, woodDark: 0x785035, woodLight: 0xc49662,
 canvas: 0xe8d3aa, cream: 0xf5e7c8, green: 0x798d53,
 greenDark: 0x566c40, yellow: 0xdfb465, blue: 0x6096a2,
 metal: 0x837e68, rations: 0xf0d391, drink: 0x6096a2,
 stone: 0xa1a294, stoneLight: 0xb8b7a6, ember: 0xd9733c, flame: 0xffa451,
 symbolCream: 0xf5e7c8, symbolDark: 0x785035,
};
const UP = new THREE.Vector3(0, 1, 0);

// Each facility becomes one mesh per material, including its small props.
// Geometry is local to its anchor, so the visual and collision rotations agree.
function workshop(world, spec, dimensions) {
 const {x, z, rotation = 0} = spec, y = world.height(x, z);
 const group = world.owned(new THREE.Group());
 group.name = `base-${spec.id}`;
 group.position.set(x, y, z);
 group.rotation.y = rotation;
 const tag = spec.decoration ? 'baseDecoration' : 'baseFacility';
 group.userData[tag] = spec.id;
 const buckets = new Map(), colliders = [];
 const add = (geometry, color, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) => {
  let g = geometry.index ? geometry.toNonIndexed() : geometry;
  if (g !== geometry) geometry.dispose();
  if (!g.attributes.normal) g.computeVertexNormals();
  for (const attribute of Object.keys(g.attributes)) if (attribute !== 'position' && attribute !== 'normal') g.deleteAttribute(attribute);
  const quaternion = rotation.isQuaternion ? rotation : new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation));
  g.applyMatrix4(new THREE.Matrix4().compose(new THREE.Vector3(...position), quaternion, new THREE.Vector3(...scale)));
  if (!buckets.has(color)) buckets.set(color, []);
  buckets.get(color).push(g);
 };
 const box = (color, size, position, rotation) => add(new THREE.BoxGeometry(...size), color, position, rotation);
 const beam = (color, from, to, radius = .065, sides = 6) => {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to), direction = b.clone().sub(a);
  add(new THREE.CylinderGeometry(radius, radius, direction.length(), sides), color, a.clone().add(b).multiplyScalar(.5).toArray(), new THREE.Quaternion().setFromUnitVectors(UP, direction.normalize()));
 };
 const collider = (cx, cz, width, depth, height, angle = 0, bottom = 0) => {
  const co = Math.cos(rotation), si = Math.sin(rotation);
  const c = {type: 'obb', baseFacility: spec.id, x: x + cx * co + cz * si, z: z - cx * si + cz * co,
   rotation: rotation + angle, halfWidth: width / 2, halfDepth: depth / 2,
   h: height, bottomY: y + bottom, topY: y + bottom + height, r: Math.min(width, depth) / 2};
  colliders.push(c);
  world.colliders.push(c);
 };
 const post = (px, pz, height, width = .18) => {
  box('wood', [width, height, width], [px, height / 2, pz]);
  box('woodLight', [width + .06, .14, width + .06], [px, height + .025, pz]);
  box('canvas', [width + .025, .09, width + .025], [px, height * .65, pz]);
  collider(px, pz, width, width, height);
 };
 const patch = (color, width, depth, heightAt, nx = 6, nz = 4, cx = 0, cz = 0) => {
  const vertices = [], indices = [];
  for (let iz = 0; iz <= nz; iz++) for (let ix = 0; ix <= nx; ix++) {
   const px = (ix / nx - .5) * width, pz = (iz / nz - .5) * depth;
   vertices.push(px + cx, heightAt(px, pz), pz + cz);
  }
  for (let iz = 0; iz < nz; iz++) for (let ix = 0; ix < nx; ix++) {
   const a = iz * (nx + 1) + ix, b = a + 1, c = a + nx + 1, d = c + 1;
   indices.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
  g.setIndex(indices); g.computeVertexNormals(); add(g, color);
 };
 const face = (color, vertices) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3));
  g.computeVertexNormals(); add(g, color);
 };
 const disc = (color, radius, thickness, position, scale = [1, 1, 1], sides = 16) => add(new THREE.CylinderGeometry(radius, radius, thickness, sides), color, position, [0, 0, 0], scale);
 const plaque = (px, py, pz, width, height) => {
  box('woodDark', [width + .08, height + .08, .10], [px, py, pz]);
  box('symbolCream', [width, height, .045], [px, py, pz + .072]);
 };
 const crate = (px, pz, py, width = .85, height = .68, depth = .8) => {
  box('wood', [width, height, depth], [px, py + height / 2, pz]);
  for (const side of [-1, 1]) {
   box('woodLight', [.09, height + .04, depth + .035], [px + side * (width / 2 - .11), py + height / 2, pz]);
   box('woodLight', [width + .04, .09, depth + .04], [px, py + height * (side < 0 ? .16 : .84), pz]);
  }
  box('woodDark', [width - .15, .018, .025], [px, py + height + .008, pz]);
  collider(px, pz, width, depth, py + height);
 };
 const finish = () => {
  const meshes = [], signs = {rations: [], drink: []};
  for (const [color, geometries] of buckets) {
   const count = geometries.reduce((n, g) => n + g.attributes.position.array.length, 0);
   const positions = new Float32Array(count), normals = new Float32Array(count);
   let offset = 0;
   for (const g of geometries) {
    positions.set(g.attributes.position.array, offset);
    normals.set(g.attributes.normal.array, offset);
    offset += g.attributes.position.array.length; g.dispose();
   }
   const merged = new THREE.BufferGeometry();
   merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
   merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
   merged.computeBoundingSphere();
   const cloth = ['canvas', 'cream', 'green', 'greenDark', 'yellow'].includes(color);
   const roughness = color === 'metal' ? .44 : color === 'blue' ? .62 : color.startsWith('wood') ? .82 : cloth ? .98 : .94;
   const material = new THREE.MeshStandardMaterial({color: COLORS[color], roughness, metalness: color === 'metal' ? .28 : 0, side: cloth ? THREE.DoubleSide : THREE.FrontSide});
   if (color.startsWith('symbol') || color === 'rations' || color === 'drink') {
    material.emissive.setHex(COLORS[color]);
    material.emissiveIntensity = color === 'symbolCream' ? .1 : .055;
   }
   if (color === 'ember' || color === 'flame') {
    material.emissive.setHex(color === 'flame' ? 0xff8c38 : 0xd9733c);
    material.emissiveIntensity = color === 'flame' ? .8 : .35;
   }
   const mesh = new THREE.Mesh(merged, material);
   mesh.name = `base-${spec.id}-${color}`;
   mesh.castShadow = true; mesh.receiveShadow = true;
   mesh.userData.owned = true; mesh.userData[tag] = spec.id;
   if (signs[color]) {mesh.userData.supplyKind = color; signs[color].push(mesh);}
   group.add(mesh); meshes.push(mesh);
  }
  const front = dimensions.depth / 2 + .65;
  return {...spec, rotation, y, ...dimensions, group, meshes, colliders, signs,
   entrance: {x: x + Math.sin(rotation) * front, z: z + Math.cos(rotation) * front}};
 };
 return {box, beam, collider, post, patch, face, disc, plaque, crate, add, finish};
}

function buildHealing(w) {
 const {box, beam, collider, post, patch, face} = w;
 for (const x of [-2.05, 2.05]) for (const z of [-1.55, 1.55]) post(x, z, 1.44, .21);
 for (const side of [-1, 1]) {
  patch('green', 2.3, 3.8, px => 3.04 - Math.abs(px + side * 1.15) / 2.3 * 1.74, 1, 4, side * 1.15);
  for (const z of [-1.86, 1.86]) beam('woodLight', [0, 3.06, z], [side * 2.28, 1.29, z], .06);
  beam('greenDark', [side * 2.29, 1.3, -1.86], [side * 2.29, 1.3, 1.86], .045);
  face('canvas', [[0, .06, -1.55], [side * 2.1, .06, -1.55], [0, 2.93, -1.55],
   [side * 2.1, .06, -1.55], [side * 2.1, 1.37, -1.55], [0, 2.93, -1.55]]);
  beam('canvas', [side * 2.05, 1.45, 1.55], [side * 2.28, .1, 1.78], .025, 5);
 }
 beam('woodDark', [0, 2.97, -1.76], [0, 2.97, 1.76], .08);
 face('greenDark', [[-1.12, 2.17, 1.865], [1.12, 2.17, 1.865], [0, 3.045, 1.865]]);
 box('symbolCream', [.66, .15, .07], [0, 2.53, 1.915]);
 box('symbolCream', [.16, .65, .07], [0, 2.53, 1.919]);
 // A broad bed sits inside; the full front edge stays open for approach.
 box('wood', [2.05, .17, 2.43], [0, .42, -.12]);
 for (const x of [-.86, .86]) for (const z of [-1.12, .88]) box('woodDark', [.17, .41, .17], [x, .205, z]);
 box('wood', [2.1, .36, .13], [0, .73, -1.35]);
 for (const x of [-1.02, 1.02]) box('woodLight', [.14, .34, 2.55], [x, .55, -.13]);
 box('cream', [1.87, .23, 2.25], [0, .635, -.1]);
 box('green', [1.88, .08, 1.15], [0, .79, .27]);
 box('greenDark', [1.88, .23, .085], [0, .675, .86]);
 box('canvas', [1.12, .18, .52], [0, .85, -.83], [-.08, 0, 0]);
 box('green', [1.13, .08, .52], [0, .955, -.87], [-.08, 0, 0]);
 collider(0, -.12, 2.1, 2.55, 1.0);
}

function book(w, px, py, pz, width = 1.45, depth = .93) {
 const {box} = w;
 // Two tilted page blocks, a spine and green maps make a real open field guide.
 for (const side of [-1, 1]) {
  const angle = side * .11, x = px + side * width * .248;
  box('woodDark', [width / 2 + .025, .075, depth + .055], [x, py, pz], [0, 0, angle]);
  box('cream', [width / 2 - .025, .09, depth], [x, py + .065, pz], [0, 0, angle]);
  for (const [dx, dz, sx, sz] of [[-.07, -.16, .23, .24], [.12, .07, .23, .31], [-.13, .2, .17, .12]])
   box('green', [sx, .016, sz], [x + dx, py + .14 + (dx + side * width * .24) * Math.sin(angle), pz + dz], [0, 0, angle]);
 }
 box('canvas', [.035, .085, depth], [px, py + .07, pz]);
}

function researchStation(w) {
 const {box, beam, collider, post, patch, plaque, add} = w;
 for (const x of [-2.0, 2.0]) for (const z of [-1.3, 1.3]) post(x, z, z < 0 ? 2.72 : 2.45, .2);
 patch('canvas', 4.5, 3.4, (x, z) => 2.62 - z * .104 - .09 * (1 - (x / 2.25) ** 2), 6, 3);
 for (const z of [-1.45, 1.45]) box('woodLight', [4.3, .13, .14], [0, 2.64 - z * .104, z]);
 for (const x of [-2, 2]) beam('woodDark', [x, 2.47, 1.3], [x, 2.74, -1.3], .06);
 // The solid front panel and central book leave two service points accessible.
 box('wood', [3.65, .16, 1.28], [0, 1.02, .5]);
 for (const x of [-1.64, 1.64]) box('woodDark', [.16, 1.0, .16], [x, .5, 1.02]);
 box('wood', [3.37, .75, .12], [0, .55, 1.055]);
 for (const y of [.27, .53, .79]) box('woodLight', [3.37, .045, .026], [0, y, 1.124]);
 box('wood', [3.6, .09, .65], [0, .3, -.05]);
 collider(0, .5, 3.65, 1.28, 1.13);
 book(w, -.15, 1.17, .48, 1.85, 1.04);
 for (let i = 0; i < 3; i++) {
  box(i === 1 ? 'canvas' : 'greenDark', [.62, .1, .52], [-1.32, 1.17 + i * .105, .38]);
  box('cream', [.5, .07, .49], [-1.32, 1.17 + i * .105, .404]);
 }
 box('wood', [.48, .38, .44], [1.27, 1.28, -.06]);
 box('woodLight', [.52, .06, .48], [1.27, 1.5, -.06]);
 plaque(0, .65, 1.16, 1.06, .62);
 for (const side of [-1, 1]) box('symbolDark', [.25, .29, .027], [side * .125 - .08, .66, 1.253], [0, 0, side * .08]);
 for (const side of [-1, 1]) box('symbolCream', [.2, .245, .028], [side * .123 - .08, .672, 1.271], [0, 0, side * .08]);
 box('symbolDark', [.025, .33, .035], [-.08, .66, 1.282]);
 add(new THREE.TorusGeometry(.123, .025, 5, 12), 'symbolDark', [.225, .77, 1.292]);
 beam('symbolDark', [.302, .674, 1.292], [.432, .504, 1.292], .03);
 // A second magnifier on the desk repeats the research symbol as a useful prop.
 add(new THREE.TorusGeometry(.17, .04, 5, 12), 'woodDark', [1.24, 1.38, .59], [-Math.PI / 3, 0, 0]);
 beam('woodDark', [1.36, 1.28, .68], [1.52, 1.13, .83], .045);
}

function supplyStation(w) {
 const {box, beam, collider, post, patch, plaque, crate, add} = w;
 for (const x of [-2.14, 2.14]) for (const z of [-1.31, 1.31]) post(x, z, z < 0 ? 2.65 : 2.4, .21);
 // Six broad cream/ochre stripes continue over the front valance.
 const stripeWidth = 5 / 6;
 for (let i = 0; i < 6; i++) {
  const color = i % 2 ? 'cream' : 'yellow', cx = (i - 2.5) * stripeWidth;
  patch(color, stripeWidth, 3.4, (x, z) => 2.66 - (z + 1.7) * .085 - .06 * (1 - (z / 1.7) ** 2), 1, 4, cx);
  box(color, [stripeWidth, .42, .065], [cx, 2.16, 1.715]);
 }
 for (const z of [-1.4, 1.4]) box('woodLight', [4.54, .14, .14], [0, z < 0 ? 2.65 : 2.41, z]);
 box('wood', [3.03, .16, 1.21], [.4, .99, .54]);
 for (const x of [-.99, 1.79]) for (const z of [.03, 1.02]) box('woodDark', [.15, .97, .15], [x, .485, z]);
 box('wood', [2.82, .69, .12], [.4, .55, 1.025]);
 for (const y of [.29, .54, .8]) box('woodLight', [2.82, .035, .025], [.4, y, 1.101]);
 collider(.4, .54, 3.03, 1.21, 1.1);
 crate(-1.47, .47, 0, .87, .67, .83);
 crate(-1.47, .47, .69, .79, .58, .76);
 for (const [x, z, color, h] of [[-.55, .56, 'yellow', .3], [.03, .44, 'greenDark', .25], [.74, .6, 'cream', .26], [1.18, .38, 'green', .32]]) {
  box(color, [.43, h, .43], [x, 1.08 + h / 2, z]);
  box('canvas', [.09, h + .025, .45], [x, 1.08 + h / 2, z]);
 }
 box('rations', [.14, .18, .025], [-.55, 1.23, .786]);
 // A simple sack and a fixed backpack badge keep the supply counter readable.
 add(new THREE.SphereGeometry(.23, 8, 6), 'canvas', [1.49, 1.29, .7], [0, 0, 0], [1, 1.1, .85]);
 box('woodDark', [.17, .07, .14], [1.49, 1.53, .7]);
 plaque(0, 2.17, 1.78, .66, .65);
 box('symbolDark', [.32, .39, .04], [0, 2.145, 1.87]);
 box('symbolDark', [.22, .15, .04], [0, 2.355, 1.87]);
 add(new THREE.TorusGeometry(.106, .029, 5, 12, Math.PI), 'symbolDark', [0, 2.377, 1.87]);
 box('symbolCream', [.24, .042, .035], [0, 2.24, 1.9]);
 box('symbolCream', [.23, .11, .036], [0, 2.045, 1.9]);
 for (const side of [-1, 1]) box('symbolCream', [.035, .09, .039], [side * .092, 2.032, 1.92]);
}

function companionShelter(w) {
 const {box, beam, collider, post, patch, disc, plaque, add} = w;
 const rx = 2.2, rz = 1.8, gap = .59, segments = 12;
 // The curved rail stops either side of a wide, unobstructed central entrance.
 const railPoints = [];
 for (let i = 0; i <= segments; i++) {
  const a = gap + (Math.PI * 2 - gap * 2) * i / segments;
  const x = Math.sin(a) * rx, z = Math.cos(a) * rz;
  railPoints.push([x, z]);
  box('wood', [.17, .88, .17], [x, .44, z]);
  box('woodLight', [.23, .09, .23], [x, .915, z]);
  collider(x, z, .17, .17, .96);
  if (i) {
   const [px, pz] = railPoints[i - 1], mx = (x + px) / 2, mz = (z + pz) / 2;
   const length = Math.hypot(x - px, z - pz), angle = Math.atan2(-(z - pz), x - px);
   box('wood', [length, .18, .11], [mx, .58, mz], [0, angle, 0]);
   box('woodLight', [length, .055, .12], [mx, .698, mz], [0, angle, 0]);
   box('woodDark', [length, .13, .09], [mx, .32, mz], [0, angle, 0]);
   collider(mx, mz, length, .12, .74, angle);
  }
 }
 const canopyDepth = 1.7, canopyBack = -.55;
 for (const x of [-1.73, 1.73]) for (const z of [-1.3, .2]) post(x, z, 2.37 + (z < 0 ? .1 : 0), .19);
 patch('canvas', 3.65, canopyDepth, (x, z) => 2.47 - .39 * (1 - (x / 1.825) ** 2) * (1 - (z / (canopyDepth / 2)) ** 2) - z * .045, 6, 4, 0, canopyBack);
 for (const z of [-canopyDepth / 2, canopyDepth / 2]) {
  for (let i = 0; i < 6; i++) {
   const x1 = (i / 6 - .5) * 3.65, x2 = ((i + 1) / 6 - .5) * 3.65;
   beam('cream', [x1, 2.47 - z * .045, z + canopyBack], [x2, 2.47 - z * .045, z + canopyBack], .024, 5);
  }
 }
 for (const x of [-.92, .92]) {
  disc('canvas', .9, .17, [x, .11, .12], [1, 1, .91]);
  disc('greenDark', .83, .14, [x, .25, .12], [1, 1, .91]);
  disc('green', .72, .025, [x, .33, .12], [1, 1, .91]);
 }
 // The front right rail faces the base camera; the badge stays outside the entry.
 plaque(1.47, .58, 1.43, .65, .55);
 add(new THREE.SphereGeometry(.125, 8, 5), 'symbolDark', [1.47, .515, 1.535], [0, 0, 0], [1.17, .85, .23]);
 for (const [x, y, r] of [[-.18, .11, .055], [-.067, .2, .067], [.067, .2, .067], [.18, .11, .055]])
  add(new THREE.SphereGeometry(r, 7, 5), 'symbolDark', [1.47 + x, .58 + y, 1.535], [0, 0, 0], [.8, 1.1, .35]);
}

function smallCampfire(w) {
 const {beam, add, disc} = w;
 // Eight pale faceted stones and three warm wooden logs fit a 0.6m radius.
 for (let i = 0; i < 8; i++) {
  const angle = i * Math.PI / 4;
  add(new THREE.DodecahedronGeometry(.15, 0), i % 3 ? 'stone' : 'stoneLight',
   [Math.sin(angle) * .38, .12, Math.cos(angle) * .38], [.12 * (i % 2), angle, .1], [1.2, .8, 1.05]);
 }
 disc('ember', .23, .045, [0, .08, 0], [1, 1, 1], 10);
 for (let i = 0; i < 3; i++) {
  const angle = i * Math.PI * 2 / 3 + .28;
  const a = [Math.sin(angle) * .28, .14, Math.cos(angle) * .28];
  const b = [-Math.sin(angle) * .16, .4, -Math.cos(angle) * .16];
  beam('wood', a, b, .064, 6);
  const end = a.map((value, j) => value + (b[j] - value) * .045);
  beam('woodLight', a, end, .066, 6);
 }
 add(new THREE.ConeGeometry(.14, .4, 5), 'flame', [0, .32, .025], [0, .2, .1]);
 add(new THREE.ConeGeometry(.085, .28, 5), 'flame', [-.12, .23, -.065], [0, -.3, -.2]);
 add(new THREE.ConeGeometry(.07, .23, 5), 'ember', [.105, .2, -.035], [0, .5, .18]);
}

function drinkingStation(w) {
 const {box, beam, collider, disc, plaque, face} = w;
 box('wood', [1.05, .14, .88], [0, .52, 0]);
 for (const x of [-.39, .39]) for (const z of [-.3, .3]) box('woodDark', [.11, .46, .11], [x, .23, z]);
 disc('blue', .34, .64, [0, .94, -.13], [1, 1, 1], 10);
 for (const y of [.65, 1.19]) disc('metal', .35, .06, [0, y, -.13], [1, 1, 1], 10);
 disc('cream', .27, .045, [0, 1.29, -.13], [1, 1, 1], 10);
 box('metal', [.14, .08, .12], [0, 1.345, -.13]);
 beam('metal', [0, .82, .18], [0, .82, .43], .043);
 beam('metal', [0, .82, .43], [0, .7, .43], .043);
 box('woodDark', [.17, .035, .05], [0, .9, .28]);
 plaque(0, .37, .46, .42, .38);
 // A blue drop is attached to the table instead of floating over the camp.
 face('drink', [[0, .505, .559], [-.105, .32, .559], [.105, .32, .559]]);
 // The circular part of the drop is vertical (cylinder axis faces the player).
 beam('drink', [0, .316, .545], [0, .316, .57], .105, 10);
 collider(0, 0, 1.05, .88, 1.4);
}

/** Build the base's fixed, readable facility models without changing interactions. */
export function buildBaseFacilities(world, layout) {
 const builders = {
  heal: [buildHealing, {width: 4.6, depth: 3.8, height: 3.1}],
  research: [researchStation, {width: 4.5, depth: 3.4, height: 2.8}],
  shop: [supplyStation, {width: 5, depth: 3.4, height: 2.8}],
  camp: [companionShelter, {width: 4.8, depth: 4, height: 2.6}],
 };
 const facilities = [];
 for (const spec of layout.facilities || []) {
  const entry = builders[spec.kind];
  if (!entry) throw new Error(`Unknown base facility: ${spec.kind}`);
  const w = workshop(world, spec, entry[1]);
  entry[0](w); facilities.push(w.finish());
 }
 if (layout.water) {
  const spec = {id: 'base-water', kind: 'drink', rotation: 0, ...layout.water};
  const w = workshop(world, spec, {width: 1.05, depth: .88, height: 1.4});
  drinkingStation(w); facilities.push(w.finish());
 }
 const decorations = [];
 if (layout.fire) {
  const point = Array.isArray(layout.fire) ? {x: layout.fire[0], z: layout.fire[1]} : layout.fire;
  const w = workshop(world, {id: 'base-fire', decoration: true, rotation: 0, ...point}, {width: 1.2, depth: 1.2, height: .55});
  smallCampfire(w);
  const fire = w.finish();
  const light = new THREE.PointLight(0xffae63, .65, 3, 2);
  light.position.set(0, .6, 0); light.userData.owned = true; light.userData.baseDecoration = 'base-fire';
  fire.group.add(light); decorations.push(fire);
 }
 const signs = {rations: facilities.flatMap(f => f.signs.rations), drink: facilities.flatMap(f => f.signs.drink)};
 world.baseFacilities = {facilities, signs, decorations};
 return world.baseFacilities;
}
