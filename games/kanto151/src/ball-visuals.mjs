import * as THREE from '../vendor/three.module.js';

// Shape references: official BDSP Trainer's Guide ball_great.jpg/ball_ultra.jpg.
// Shared colours for the HUD and physical thrown ball; capture rules stay in core.
export const BALL_VISUALS={
 'poke-ball':{shell:'#eb454b',accent:null},
 'great-ball':{shell:'#2f80c9',accent:'#e7414c'},
 'ultra-ball':{shell:'#252b34',accent:'#f6c846'},
};
export function ballArtwork(kind){
 const visual=BALL_VISUALS[kind]||BALL_VISUALS['poke-ball'];
 const marking=kind==='great-ball'?'<path d="M4 9Q6 5 10 4L9 7 9 14 6 17 3 14Z M24 5 29 10 29 14 23 19 20 16 23 10Z" fill="'+visual.accent+'" stroke="#23436b" stroke-width=".7" stroke-linejoin="round"/><path d="M24 6 23 10 21 15" fill="none" stroke="#ffa5a8" stroke-width=".9" opacity=".7"/>':kind==='ultra-ball'?'<path d="M5 16Q3 8 9 5Q19 0 27 7L24 9Q24 14 21 19L17 20Q19 15 20 10Q18 5 14 6Q9 6 9 11L9 19Z" fill="'+visual.accent+'"/>':'';
 return '<svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg" data-ball-kind="'+kind+'" aria-hidden="true" focusable="false"><circle cx="16" cy="16" r="14" fill="'+visual.shell+'"/>'+marking+'<path d="M2 18Q16 24 30 18A14 14 0 0 1 2 18Z" fill="#fafbf4"/><path d="M5 23Q17 30 28 23Q24 30 16 30Q9 29 5 23Z" fill="#79849f" opacity=".28"/><path d="M24 7Q28 11 28 15L24 18Q21 16 24 7Z" fill="#061322" opacity=".18"/><circle cx="11" cy="10" r="2.2" fill="#fff" opacity=".9"/><path d="M2 18Q16 24 30 18" fill="none" stroke="#18212a" stroke-width="3"/><circle cx="16" cy="16" r="14" fill="none" stroke="#171f28" stroke-width="1.5"/><circle cx="14.4" cy="21.2" r="4.7" fill="#18212a"/><circle cx="14.4" cy="21.2" r="3.4" fill="#fffef8"/><circle cx="14.4" cy="21.2" r="1.8" fill="none" stroke="#29323b" stroke-width=".8"/></svg>';
}

// Two shared, bounded procedural textures. Material disposal after each capture
// deliberately leaves these reusable maps alive; throws never allocate new maps.
const shellTextures=new Map();
function shellTexture(kind){
 if(shellTextures.has(kind))return shellTextures.get(kind);
 const width=256,height=128,data=new Uint8Array(width*height*4),visual=BALL_VISUALS[kind],shell=new THREE.Color(visual.shell),accent=new THREE.Color(visual.accent),rim=new THREE.Color('#20426b');
 const rgb=color=>{const c=color.clone().convertLinearToSRGB();return [c.r,c.g,c.b].map(v=>Math.round(v*255));},baseRGB=rgb(shell),accentRGB=rgb(accent),rimRGB=rgb(rim);
 for(let row=0;row<height;row++)for(let col=0;col<width;col++){
  const theta=(1-row/(height-1))*Math.PI/2,phi=col/(width-1)*Math.PI*2,x=-Math.sin(theta)*Math.cos(phi),z=Math.sin(theta)*Math.sin(phi);let color=baseRGB;
  if(kind==='ultra-ball'){
   // Two front-to-back rails joined across the crown form the canonical H.
   if(Math.abs(x)>=.32&&Math.abs(x)<=.66||Math.abs(z)<.18&&Math.abs(x)<=.66)color=accentRGB;
  }else{
   // Broad red shoulders, with a blue bevel; the face centre remains blue.
   const azimuth=Math.abs(Math.atan2(x,z)),t=(theta-.38)/.98,bevel=Math.max(0,(t-.82)/.18)*.10,inner=.43+.09*t+bevel,outer=1.18-.08*t-bevel;
   if(theta>=.36&&theta<=1.39&&azimuth>=inner-.035&&azimuth<=outer+.035)color=rimRGB;
   if(t>=0&&t<=1&&azimuth>=inner&&azimuth<=outer)color=accentRGB;
  }
  const i=(row*width+col)*4;data.set([...color,255],i);
 }
 const texture=new THREE.DataTexture(data,width,height);texture.name='capture-shell-'+kind;texture.colorSpace=THREE.SRGBColorSpace;texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearMipmapLinearFilter;texture.generateMipmaps=true;texture.needsUpdate=true;shellTextures.set(kind,texture);return texture;
}
export function createCaptureBall(kind,radius=.2){
 const visual=BALL_VISUALS[kind]||BALL_VISUALS['poke-ball'],ball=new THREE.Group();ball.name='capture-ball-'+kind;
 const topMaterial=new THREE.MeshStandardMaterial({color:kind==='poke-ball'?visual.shell:0xffffff,roughness:.3,metalness:0});if(kind==='great-ball'||kind==='ultra-ball')topMaterial.map=shellTexture(kind);
 const dark=new THREE.MeshStandardMaterial({color:0x18212a,roughness:.32}),white=new THREE.MeshStandardMaterial({color:0xf8f8ef,roughness:.26});
 const top=new THREE.Mesh(new THREE.SphereGeometry(radius,32,16,0,Math.PI*2,0,Math.PI/2),topMaterial);top.name='upper-shell';
 const bottom=new THREE.Mesh(new THREE.SphereGeometry(radius,32,16,0,Math.PI*2,Math.PI/2,Math.PI/2),white);bottom.name='lower-shell';
 const band=new THREE.Mesh(new THREE.TorusGeometry(radius*.99,radius*.075,8,32),dark);band.name='equator-band';band.rotation.x=Math.PI/2;
 const disc=(name,r,depth,z,material)=>{const mesh=new THREE.Mesh(new THREE.CylinderGeometry(r,r,depth,24),material);mesh.name=name;mesh.rotation.x=Math.PI/2;mesh.position.z=z;return mesh;};
 const outer=disc('button-rim',radius*.25,radius*.10,radius+.004,dark),face=disc('button-face',radius*.175,radius*.08,radius+.019,white);
 const inner=new THREE.Mesh(new THREE.TorusGeometry(radius*.095,radius*.014,6,24),dark);inner.name='button-inner-ring';inner.position.z=radius+.029;
 ball.add(top,bottom,band,outer,face,inner);ball.userData.kind=kind;return ball;
}
