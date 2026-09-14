/**
 * Original Kanto151 Bedrock runtime adapter. No upstream runtime source is bundled.
 * Assets: Cobblemon team/contributors, CC BY-NC 3.0; see ASSET_CREDITS.md.
 * Coordinates and box UV semantics follow the documented Bedrock/Blockbench format.
 */
const DEG = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const expressions = new Map();
const diagnostics = new Set();

// Small arithmetic parser: asset expressions are data and are never evaluated as JS.
export function compileMolang(source) {
  if (typeof source === 'number') return () => source;
  if (source == null) return () => 0;
  const original = String(source);
  if (expressions.has(original)) return expressions.get(original);
  // Documented upstream defects: ath.sin, omitted operators and NaN constants.
  // Neutral zero constants and implicit multiplication keep transforms finite.
  const input = original.toLowerCase().replace(/\bath\./g, 'math.').replace(/\bnan\b/g,'0').replace(/(\d)(?=math\.)/g,'$1*').replace(/\)(?=\d|\()/g,')*');
  const tokens = input.match(/(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[a-z_][a-z_0-9.]*|[()+*/%,\-]/g) || [];
  if (tokens.join('') !== input.replace(/\s/g, '')) throw new Error(`Unsupported Molang: ${original}`);
  let index = 0;
  const primary = () => {
    const token = tokens[index++];
    if (token === '-') { const x = primary(); return c => -x(c); }
    if (token === '+') return primary();
    if (token === '(') { const x = additive(); if (tokens[index++] !== ')') throw new Error(`Molang parenthesis: ${original}`); return x; }
    if (token !== undefined && !Number.isNaN(Number(token))) { const n = Number(token); return () => n; }
    if (!token) throw new Error(`Molang value: ${original}`);
    if (tokens[index] === '(') {
      index++;
      const args = [];
      if (tokens[index] !== ')') do { args.push(additive()); } while (tokens[index] === ',' && ++index);
      if (tokens[index++] !== ')') throw new Error(`Molang call: ${original}`);
      if (token.startsWith('q.r.') || token.startsWith('query.r.')) {
        const key = token.split('.').pop();
        return c => c[key] ?? (key === 'input_forward' ? (c.moving ? 1 : 0) : 0);
      }
      const operations = {
        'math.sin': a => Math.sin(a * DEG), 'math.cos': a => Math.cos(a * DEG),
        'math.abs': Math.abs, 'math.clamp': clamp, 'math.mod': (a, b) => a % b,
        'math.round': Math.round, 'math.floor': Math.floor, 'math.ceil': Math.ceil,
        'math.min': Math.min, 'math.max': Math.max, 'math.sqrt': Math.sqrt,
        // Stable noise avoids random frame-to-frame vibration in authored transforms.
        'math.random': (a, b) => a + (b - a) * 0.5,
      };
      const operation = operations[token];
      if (!operation) { diagnostics.add(`Unknown expression function ${token}`); return () => 0; }
      return c => operation(...args.map(a => a(c)));
    }
    if (token === 'q.anim_time' || token === 'query.anim_time') return c => c.time;
    if (token === 'v.foot' || token === 'variable.foot') return c => c.foot ?? 15;
    if (token.startsWith('q.r.') || token.startsWith('query.r.')) return c => c[token.split('.').pop()] ?? 0;
    if (token === 'math.pi') return () => Math.PI;
    diagnostics.add(`Unknown expression variable ${token}`);
    return () => 0;
  };
  const multiply = () => {
    let left = primary();
    while (['*', '/', '%'].includes(tokens[index])) {
      const op = tokens[index++], a = left, b = primary();
      left = op === '*' ? c => a(c) * b(c) : op === '/' ? c => a(c) / (b(c) || 1e-9) : c => a(c) % (b(c) || 1e-9);
    }
    return left;
  };
  const additive = () => {
    let left = multiply();
    while (['+', '-'].includes(tokens[index])) {
      const op = tokens[index++], a = left, b = multiply();
      left = op === '+' ? c => a(c) + b(c) : c => a(c) - b(c);
    }
    return left;
  };
  const result = additive();
  if (index !== tokens.length) throw new Error(`Molang trailing input: ${original}`);
  expressions.set(original, result);
  return result;
}

function vectorSampler(value, fallback = 0) {
  if (!Array.isArray(value)) value = [value ?? fallback, value ?? fallback, value ?? fallback];
  const xyz = value.map(compileMolang);
  return context => xyz.map(f => { const n = f(context); return Number.isFinite(n) ? n : fallback; });
}

export function compileChannel(value, fallback = 0) {
  if (value == null || Array.isArray(value) || typeof value !== 'object') return vectorSampler(value, fallback);
  const keys = Object.entries(value).filter(([t]) => Number.isFinite(Number(t))).map(([time, frame]) => ({
    time: Number(time), mode: frame?.lerp_mode || 'linear',
    pre: vectorSampler(frame?.pre ?? frame?.post ?? frame, fallback),
    post: vectorSampler(frame?.post ?? frame?.pre ?? frame, fallback),
  })).sort((a, b) => a.time - b.time);
  if (!keys.length) return vectorSampler(fallback, fallback);
  return context => {
    const time = context.time;
    if (time < keys[0].time) return keys[0].pre(context);
    let next = 1;
    while (next < keys.length && time >= keys[next].time) next++;
    if (next >= keys.length) return keys[keys.length - 1].post(context);
    const left = keys[next - 1], right = keys[next];
    const t = clamp((time - left.time) / (right.time - left.time), 0, 1);
    const a = left.post(context), b = right.pre(context);
    if (left.mode !== 'catmullrom' && right.mode !== 'catmullrom') return a.map((v, i) => v + (b[i] - v) * t);
    const p0 = keys[Math.max(0, next - 2)].post(context);
    const p3 = keys[Math.min(keys.length - 1, next + 1)].pre(context);
    return a.map((p1, i) => 0.5 * ((2 * p1) + (-p0[i] + b[i]) * t + (2 * p0[i] - 5 * p1 + 4 * b[i] - p3[i]) * t * t + (-p0[i] + 3 * p1 - 3 * b[i] + p3[i]) * t * t * t));
  };
}

export function compileAnimations(input) {
  const result = {};
  for (const [name, data] of Object.entries(input)) {
    let length = data.animation_length || 0;
    const bones = [];
    for (const [bone, channels] of Object.entries(data.bones || {})) {
      const output = { name: bone, globalRotation: channels.relative_to?.rotation === 'entity' };
      for (const channel of ['rotation', 'position', 'scale']) if (channels[channel] !== undefined) {
        output[channel] = compileChannel(channels[channel], channel === 'scale' ? 1 : 0);
        if (channels[channel] && !Array.isArray(channels[channel]) && typeof channels[channel] === 'object')
          for (const t of Object.keys(channels[channel])) if (Number.isFinite(Number(t))) length = Math.max(length, Number(t));
      }
      bones.push(output);
    }
    result[name] = { name, bones, length, loop: data.loop === true, hold: data.loop === 'hold_on_last_frame' };
  }
  return result;
}

function compileGeometry(THREE, input) {
  const source = input['minecraft:geometry']?.[0];
  if (!source?.bones?.length) throw new Error('Invalid Bedrock geometry');
  const width = source.description.texture_width, height = source.description.texture_height;
  const bones = [];
  for (const bone of source.bones) {
    const pivot = bone.pivot || [0, 0, 0];
    const positions = [], normals = [], uvs = [];
    for (const cube of bone.cubes || []) {
      const [w, h, d] = cube.size;
      const inflate = cube.inflate ?? bone.inflate ?? 0;
      const box = new THREE.BoxGeometry(Math.max(0.001, w + 2 * inflate), Math.max(0.001, h + 2 * inflate), Math.max(0.001, d + 2 * inflate));
      const [u, v] = cube.uv || [0, 0];
      // Three BoxGeometry face order: east, west, up, down, south, north.
      let rects = [[0,d,d,h], [d+w,d,d,h], [d+w,d,-w,-d], [d+2*w,0,-w,d], [2*d+w,d,w,h], [d,d,w,h]];
      if (cube.mirror ?? bone.mirror ?? false) {
        rects = rects.map(([x,y,s,t]) => [x+s,y,-s,t]);
        [rects[0], rects[1]] = [rects[1], rects[0]];
      }
      for (let face = 0; face < 6; face++) {
        const [x,y,s,t] = rects[face];
        const epsU = Math.sign(s) / 128, epsV = Math.sign(t) / 128;
        const x0=(u+x+epsU)/width, x1=(u+x+s-epsU)/width;
        const y0=1-(v+y+epsV)/height, y1=1-(v+y+t-epsV)/height;
        box.attributes.uv.setXY(face*4, x0,y0); box.attributes.uv.setXY(face*4+1,x1,y0);
        box.attributes.uv.setXY(face*4+2,x0,y1); box.attributes.uv.setXY(face*4+3,x1,y1);
      }
      const c = cube.origin, cp = cube.pivot || pivot, rot = cube.rotation || [0, 0, 0];
      const center = new THREE.Vector3(-(c[0]+w/2),c[1]+h/2,c[2]+d/2);
      const convertedPivot = new THREE.Vector3(-cp[0],cp[1],cp[2]);
      const matrix = new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(-rot[0]*DEG,-rot[1]*DEG,rot[2]*DEG,'ZYX'));
      box.translate(center.x-convertedPivot.x,center.y-convertedPivot.y,center.z-convertedPivot.z);
      box.applyMatrix4(matrix);
      box.translate(convertedPivot.x+pivot[0],convertedPivot.y-pivot[1],convertedPivot.z-pivot[2]);
      const flat=box.toNonIndexed();
      positions.push(...flat.attributes.position.array); normals.push(...flat.attributes.normal.array); uvs.push(...flat.attributes.uv.array);
      flat.dispose(); box.dispose();
    }
    let geometry=null;
    if (positions.length) {
      geometry=new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.Float32BufferAttribute(positions,3));
      geometry.setAttribute('normal',new THREE.Float32BufferAttribute(normals,3));
      geometry.setAttribute('uv',new THREE.Float32BufferAttribute(uvs,2));
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
    }
    bones.push({name:bone.name,parent:bone.parent,pivot:[-pivot[0],pivot[1],pivot[2]],rotation:bone.rotation || [0,0,0],geometry});
  }
  return {bones,description:source.description};
}

/** Lazy species cache; active instances retain shared geometry/textures until released. */
export class PokemonResources {
  constructor(THREE, manifest, baseUrl, {maxSpecies=24,onProgress}={}) {
    this.THREE=THREE;
    this.manifest=new Map((Array.isArray(manifest)?manifest:manifest.pokemon).map(row=>[Number(row.id),row]));
    this.baseUrl=String(baseUrl).replace(/\/?$/,'/');
    this.maxSpecies=maxSpecies; this.onProgress=onProgress;
    this.cache=new Map(); this.requests=new Map(); this.errors=[]; this.loaded=0;
  }
  url(path) { return this.baseUrl+path; }
  async json(path) {
    const response=await fetch(this.url(path));
    if(!response.ok)throw new Error(`${response.status} ${this.url(path)}`);
    return response.json();
  }
  async load(id) {
    id=Number(id);
    const old=this.cache.get(id);
    if(old){old.used=performance.now();return old;}
    if(this.requests.has(id))return this.requests.get(id);
    const request=this._load(id).catch(error=>{this.errors.push({id,message:error.message});throw error;}).finally(()=>this.requests.delete(id));
    this.requests.set(id,request);return request;
  }
  async _load(id) {
    const info=this.manifest.get(id);
    if(!info)throw new Error(`Unknown Pokémon ${id}`);
    const THREE=this.THREE;
    const [model,animationData]=await Promise.all([this.json(info.model),Promise.all(info.animationFiles.map(path=>this.json(path)))]);
    // Some regional files reuse base clip names; preserve the primary definition.
    const data={};for(const a of animationData)for(const [name,clip] of Object.entries(a.animations))if(!(name in data))data[name]=clip;
    const textures=new Map();
    const paths=new Set([info.texture,info.shinyTexture]);
    for(const layer of [...(info.layers||[]),...(info.shinyLayers||[])]) {
      if(typeof layer.texture==='string')paths.add(layer.texture);
      else for(const path of layer.texture?.frames||[])paths.add(path);
    }
    const textureLoader=new THREE.TextureLoader();
    await Promise.all([...paths].filter(Boolean).map(async path=>{
      const texture=await textureLoader.loadAsync(this.url(path));
      texture.colorSpace=THREE.SRGBColorSpace;
      texture.magFilter=THREE.NearestFilter;texture.minFilter=THREE.NearestMipmapNearestFilter;
      texture.generateMipmaps=true; texture.anisotropy=2;
      textures.set(path,texture);
    }));
    const record={id,info,geometry:compileGeometry(THREE,model),animations:compileAnimations(data),textures,refs:0,used:performance.now()};
    this.cache.set(id,record);this.loaded++;this.onProgress?.({id,loaded:this.loaded});
    return record;
  }
  async preload(ids) {
    const queue=[...new Set(ids)].filter(id=>this.manifest.has(Number(id)));
    for(let i=0;i<queue.length;i+=3)await Promise.all(queue.slice(i,i+3).map(id=>this.load(id)));
    this.evict();
  }
  evict() {
    const unused=[...this.cache.values()].filter(v=>v.refs===0).sort((a,b)=>a.used-b.used);
    while(this.cache.size>this.maxSpecies&&unused.length) {
      const item=unused.shift();
      for(const bone of item.geometry.bones)bone.geometry?.dispose();
      for(const texture of item.textures.values())texture.dispose();
      this.cache.delete(item.id);
    }
  }
  async create(id,{shiny=false,scale=1,maxDimension=5.5,grounded=true}={}) {
    const record=await this.load(id);record.refs++;record.used=performance.now();
    const THREE=this.THREE,info=record.info;
    const group=new THREE.Group(),orientation=new THREE.Group(),rig=new THREE.Group();
    group.name=`pokemon-${id}`;group.add(orientation);orientation.add(rig);orientation.rotation.y=Math.PI;
    rig.scale.setScalar(1/16);
    const boneMap=new Map(),meshBones=[],materials=[],layers=[];
    const baseMaterial=new THREE.MeshStandardMaterial({map:record.textures.get(shiny?info.shinyTexture:info.texture),roughness:0.92,metalness:0,alphaTest:0.25,side:THREE.DoubleSide});
    materials.push(baseMaterial);
    for(const bone of record.geometry.bones) {
      const node=new THREE.Group();node.name=bone.name;node.rotation.order='ZYX';
      node.userData.bedrock=bone;boneMap.set(bone.name,node);
    }
    for(const bone of record.geometry.bones) {
      const node=boneMap.get(bone.name),parent=boneMap.get(bone.parent);
      const p=parent?.userData.bedrock.pivot||[0,0,0];
      node.position.set(bone.pivot[0]-p[0],bone.pivot[1]-p[1],bone.pivot[2]-p[2]);
      node.rotation.set(-bone.rotation[0]*DEG,-bone.rotation[1]*DEG,bone.rotation[2]*DEG,'ZYX');
      node.userData.restPosition=node.position.clone();node.userData.restRotation=node.rotation.clone();
      (parent||rig).add(node);
      if(bone.geometry) {
        const mesh=new THREE.Mesh(bone.geometry,baseMaterial);mesh.castShadow=true;mesh.receiveShadow=true;node.add(mesh);
        meshBones.push({node,geometry:bone.geometry});
      }
    }
    const changeLayers=()=>{
      for(const layer of layers){for(const mesh of layer.meshes)mesh.removeFromParent();layer.material.dispose();}
      layers.length=0;
      for(const definition of (shiny?info.shinyLayers:info.layers)||[]) {
        const frames=(typeof definition.texture==='string'?[definition.texture]:definition.texture?.frames||[]).map(path=>record.textures.get(path)).filter(Boolean);
        if(!frames.length)continue;
        const material=definition.emissive?new THREE.MeshBasicMaterial({map:frames[0],transparent:true,alphaTest:0.02,depthWrite:false,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1}):new THREE.MeshStandardMaterial({map:frames[0],transparent:true,alphaTest:0.02,depthWrite:false,side:THREE.DoubleSide,roughness:1,polygonOffset:true,polygonOffsetFactor:-1});
        const meshes=meshBones.map(({node,geometry})=>{const mesh=new THREE.Mesh(geometry,material);mesh.renderOrder=1;node.add(mesh);return mesh;});
        layers.push({material,meshes,frames,fps:definition.texture?.fps||10});
      }
    };
    changeLayers();
    let elapsed=0,actionElapsed=0,lastAction='',released=false;
    const context={time:0,moving:false};
    const apply=(name,time,state)=>{
      const clip=record.animations[name];if(!clip)return;
      context.time=clip.length>0?(clip.loop?time%clip.length:Math.min(time,clip.length)):time;
      context.moving=state.moving;
      context.velocity_y=state.velocityY||0;context.velocity_forward=state.moving?1:0;
      context.yaw_change=state.yawChange||0;context.pitch_change=0;context.dive=0;
      for(const channel of clip.bones) {
        const bone=boneMap.get(channel.name);if(!bone)continue;
        if(channel.position){const v=channel.position(context),rest=bone.userData.restPosition;bone.position.set(rest.x-v[0],rest.y+v[1],rest.z+v[2]);}
        if(channel.rotation){const v=channel.rotation(context),rest=bone.userData.restRotation;bone.rotation.set(rest.x-v[0]*DEG,rest.y-v[1]*DEG,rest.z+v[2]*DEG,'ZYX');}
        if(channel.scale){const v=channel.scale(context);bone.scale.set(v[0],v[1],v[2]);}
        if(channel.globalRotation&&bone.parent!==rig) {
          const parentRotation=new THREE.Quaternion();bone.parent.getWorldQuaternion(parentRotation);
          const desired=bone.quaternion.clone();bone.quaternion.copy(parentRotation.invert().multiply(desired));
        }
      }
    };
    const update=(dt=0,state={})=>{
      if(released)return;
      elapsed=Number.isFinite(state.time)?state.time:elapsed+Math.max(0,dt);
      const action=state.action||'';
      if(action!==lastAction){actionElapsed=0;lastAction=action;}else actionElapsed+=Math.max(0,dt);
      for(const bone of boneMap.values()){bone.position.copy(bone.userData.restPosition);bone.rotation.copy(bone.userData.restRotation);bone.scale.set(1,1,1);}
      const semantic=state.moving?'walk':state.battle?'battle':'idle';
      apply(info.clips[semantic]||info.clips.idle,elapsed,state);
      if(action)apply(record.animations[action]?action:(info.clips[action]||info.clips.attack),actionElapsed,state);
      for(const layer of layers)layer.material.map=layer.frames[Math.floor(elapsed*layer.fps)%layer.frames.length];
      const flash=state.hitFlash||0;baseMaterial.emissive.setHex(flash>0?0xffffff:0x000000);baseMaterial.emissiveIntensity=flash;
    };
    update(0,{time:0});group.updateMatrixWorld(true);
    let bounds=new THREE.Box3().setFromObject(rig),size=bounds.getSize(new THREE.Vector3());
    const fit=Math.min(1,maxDimension/Math.max(size.x,size.y,size.z,0.01));
    rig.scale.multiplyScalar(fit*scale);group.updateMatrixWorld(true);
    bounds=new THREE.Box3().setFromObject(rig);
    if(grounded)orientation.position.y=-bounds.min.y;
    group.updateMatrixWorld(true);bounds=new THREE.Box3().setFromObject(group);size=bounds.getSize(new THREE.Vector3());
    group.userData={
      id:Number(id),shiny,info,height:size.y,radius:Math.max(size.x,size.z)/2,bounds:bounds.clone(),dimensions:{x:size.x,y:size.y,z:size.z},groundOffset:orientation.position.y,
      animationNames:Object.keys(record.animations),bones:boneMap,materials,update,
      setShiny:async value=>{shiny=Boolean(value);group.userData.shiny=shiny;baseMaterial.map=record.textures.get(shiny?info.shinyTexture:info.texture);baseMaterial.needsUpdate=true;changeLayers();},
      release:()=>{if(released)return;released=true;group.removeFromParent();for(const material of materials)material.dispose();for(const layer of layers)layer.material.dispose();record.refs=Math.max(0,record.refs-1);record.used=performance.now();this.evict();},
    };
    this.evict();return group;
  }
  stats() {return {species:this.cache.size,active:[...this.cache.values()].reduce((n,v)=>n+v.refs,0),pending:this.requests.size,errors:this.errors,expressionWarnings:[...diagnostics]};}
  dispose() {for(const item of this.cache.values())item.refs=0;this.maxSpecies=0;this.evict();}
}

export function getMolangDiagnostics() {return [...diagnostics];}
export {compileGeometry};
