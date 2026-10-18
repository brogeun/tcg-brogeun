// Runtime-painted combat masks. No downloads, fonts, canvas or per-frame texture allocations.
// The small colour paintings give energy a hot core, broken edges and readable silhouettes.
const clamp=(n,a=0,b=1)=>Math.max(a,Math.min(b,n));
const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
const segment=(x,y,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=clamp(((x-a[0])*dx+(y-a[1])*dy)/(dx*dx+dy*dy||1));return Math.hypot(x-a[0]-t*dx,y-a[1]-t*dy);};
const stroke=(x,y,points,width=.06)=>{let d=10;for(let i=1;i<points.length;i++)d=Math.min(d,segment(x,y,points[i-1],points[i]));return 1-smooth(width*.7,width+.028,d);};
function polygon(x,y,points){let inside=false,d=10;for(let i=0,j=points.length-1;i<points.length;j=i++){const a=points[i],b=points[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])inside=!inside;d=Math.min(d,segment(x,y,a,b));}return inside?1:1-smooth(0,.025,d);}
const disk=(x,y,cx=0,cy=0,rx=.65,ry=rx)=>1-smooth(.93,1.02,Math.hypot((x-cx)/rx,(y-cy)/ry));
const annulus=(x,y,r=.65,w=.07)=>Math.exp(-Math.pow((Math.hypot(x,y)-r)/w,2));
const noise=(x,y)=>clamp(.52+.20*Math.sin(x*13+y*19)+.15*Math.sin(x*31-y*23)+.10*Math.sin(x*59+y*41));
const paths={
 'sleep-z':[[[-.65,.65],[.55,.65],[-.6,-.6],[.65,-.6]]],
 anger:[[[-.75,.65],[-.35,.62],[-.25,.22]],[[-.1,.78],[.05,.3],[.55,.38]],[[-.6,-.3],[-.15,-.2],[-.1,-.7]],[[.3,-.05],[.7,-.15],[.65,-.65]]],
 bolt:[[[-.1,.92],[-.55,.05],[.05,.19],[-.24,-.92],[.62,.22],[.02,.02],[.38,.92]]],
 sword:[[[-.1,-.8],[.1,-.8]],[[0,-.65],[0,.8]],[[-.42,-.32],[.42,-.32]]],
 arrow:[[[-.7,-.4],[.55,.48]],[[.1,.55],[.6,.55],[.6,.05]]],
 'fire-glyph':[[[-.86,.25],[.86,.25]],[[.05,.95],[.02,.28],[-.77,-.83]],[[.04,.27],[.77,-.83]]],
 root:[[[0,.9],[.03,.4],[-.18,-.1],[-.8,-.75]],[[.02,.42],[.4,-.02],[.68,-.8]],[[-.15,-.12],[-.18,-.85]],[[.32,.05],[.72,-.2],[.9,-.55]]],
 crack:[[[-.85,-.15],[-.43,.12],[-.1,-.07],[.17,.29],[.49,.1],[.9,.55]],[[-.1,-.07],[-.24,-.6],[-.05,-.87]],[[.18,.3],[.04,.64],[.3,.91]]],
 bone:[[[-.58,-.58],[.58,.58]]],
 note:[[[.06,-.4],[.06,.72],[.58,.85],[.58,-.22]]],
 tongue:[[[-.78,.2],[-.25,.18],[.3,-.12],[.68,-.02]]],
 claw:[[[-.7,.8],[-.61,.35],[-.3,-.2],[.25,-.65]],[[-.3,.92],[-.21,.4],[.1,-.16],[.6,-.62]],[[.16,.87],[.22,.32],[.48,-.14],[.83,-.42]]]
};
const silhouettes={
 'shield-face':[[-.7,.7],[0,.92],[.7,.7],[.57,-.26],[0,-.9],[-.57,-.26]],
 fang:[[-.82,.63],[-.48,.52],[-.36,-.28],[-.12,.45],[.12,.45],[.36,-.28],[.48,.52],[.82,.63],[.68,-.55],[.3,-.76],[0,-.64],[-.3,-.76],[-.68,-.55]],
 fist:[[-.62,-.64],[-.64,-.05],[-.81,.22],[-.66,.49],[-.4,.49],[-.4,.72],[-.12,.8],[.03,.64],[.25,.72],[.46,.62],[.67,.44],[.65,-.28],[.36,-.73]],
 kick:[[-.38,.9],[.13,.87],[.13,-.18],[.7,-.35],[.81,-.64],[.52,-.79],[-.58,-.68],[-.61,-.36],[-.33,-.16]],
 gift:[[-.72,-.72],[.72,-.72],[.72,.25],[-.72,.25]],
 scale:[[0,.9],[-.65,.3],[-.64,-.2],[-.35,-.65],[0,-.89],[.35,-.65],[.64,-.2],[.65,.3]],
 shell:[[-.9,-.5],[-.8,.15],[-.55,.62],[0,.9],[.55,.62],[.8,.15],[.9,-.5],[0,-.75]],
 hex:[[0,.88],[.76,.44],[.76,-.44],[0,-.88],[-.76,-.44],[-.76,.44]],
 rock:[[-.8,-.44],[-.84,.16],[-.46,.75],[.05,.87],[.7,.5],[.88,-.15],[.41,-.76],[-.23,-.82]],
 feather:[[0,-.92],[-.47,-.35],[-.63,.19],[-.4,.7],[-.1,.94],[.36,.7],[.51,.24],[.37,-.35]]
};
function iconMask(shape,x,y){
 if(paths[shape]){
  let alpha=Math.max(...paths[shape].map(p=>stroke(x,y,p,shape==='fire-glyph'?.105:shape==='tongue'?.21:shape==='root'?.105:shape==='claw'?.075:.065)));
  if(shape==='note')alpha=Math.max(alpha,disk(x,y,-.11,-.42,.24,.18),disk(x,y,.41,-.25,.24,.18));
  if(shape==='bone')for(const s of [-1,1])for(const t of [-1,1])alpha=Math.max(alpha,disk(x,y,s*.58+t*.1,s*.58-t*.1,.22));
  if(shape==='sword')alpha=Math.max(alpha,polygon(x,y,[[-.13,-.24],[-.13,.6],[0,.92],[.13,.6],[.13,-.24]]));
  return alpha;
 }
 if(silhouettes[shape])return polygon(x,y,silhouettes[shape]);
 if(shape==='heart'){const xx=x*1.08,yy=y*1.13-.1;return 1-smooth(-.025,.025,Math.pow(xx*xx+yy*yy-.43,3)-xx*xx*yy*yy*yy);}
 if(shape==='eye'){const a=1-smooth(.95,1.03,Math.abs(y)/(.43*Math.sqrt(Math.max(.001,1-x*x/.85))));return a*(Math.abs(x)<.92?1:0);}
 if(shape==='sun'){let a=disk(x,y,0,0,.4);for(let i=0;i<12;i++){const t=i/12*Math.PI*2;a=Math.max(a,stroke(x,y,[[Math.cos(t)*.57,Math.sin(t)*.57],[Math.cos(t)*.88,Math.sin(t)*.88]],.045));}return a;}
 if(shape==='moon')return disk(x,y,0,0,.8)*(1-disk(x,y,.36,.15,.69));
 if(shape==='lock')return Math.max(polygon(x,y,[[-.57,.12],[.57,.12],[.57,-.72],[-.57,-.72]]),annulus(x,y-.25,.37,.085)*(y>0?1:0));
 if(shape==='footprint')return Math.max(disk(x,y,0,-.29,.36,.43),...[-.46,-.15,.18,.47].map((p,i)=>disk(x,y,p,.32+Math.sin(i/3*Math.PI)*.22,.16,.21)));
 if(shape==='coin')return disk(x,y,0,0,.79,.9);
 if(shape==='egg')return disk(x,y,0,-.07,.57*(1-y*.27),.85);
 if(shape==='petal'||shape==='leaf')return disk(x,y,Math.sin(y*2)*.12,0,.46*Math.sqrt(Math.max(0,1-y*y)),.95);
 if(shape==='star'){const pts=[];for(let i=0;i<10;i++){const t=i*Math.PI/5,r=i%2?.4:.91;pts.push([Math.sin(t)*r,Math.cos(t)*r]);}return polygon(x,y,pts);}
 return 0;
}
export const EFFECT_TEXTURE_NAMES=Object.freeze(['glow','flame','spirit-flame','plume','smoke','mist','halo','streak','ribbon','water','ice','spark','slash','shockwave','feather','leaf','fang','fist','bolt','energy-orb','rock','root','star','kick','claw','bone','coin','egg','gift','petal','crack','tongue','shell','scale','heart','note','sleep-z','anger','eye','shield-face','hex','sword','sun','moon','lock','arrow','footprint','fire-glyph']);
export function paintEffectTextures(THREE){
 const textures={};
 for(const shape of EFFECT_TEXTURE_NAMES){
  const width=128,height=['flame','spirit-flame','plume','streak','ribbon','root'].includes(shape)?256:128,data=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
   const u=(x+.5)/width,v=(y+.5)/height,px=u*2-1,py=v*2-1,r=Math.hypot(px,py),n=noise(px,py),edge=clamp(1-r);
   let alpha=0,lum=1,rgb=[1,1,1];
   if(shape==='glow')alpha=Math.exp(-r*r*5.5)*smooth(0,.13,edge);
   else if(shape==='flame'||shape==='spirit-flame'||shape==='plume'){
    const center=Math.sin(v*10+.4)*.15*(1-v)+Math.sin(v*21)*.055,radius=(shape==='plume'?.8:.68)*Math.pow(1-v,.66)+.025;
    const heat=clamp(1-Math.abs(px-center)/radius),body=Math.pow(Math.sin(Math.PI*v),.36),curl=.65+.35*Math.sin(v*27+px*11);
    alpha=Math.pow(heat,1.1)*body*clamp(.55+n*.6+curl*.2);alpha*=smooth(0,.07,v)*smooth(0,.03,1-v);
    const core=clamp(heat*heat*(1-v*.7));rgb=shape==='spirit-flame'?[.72+core*.28,.86+core*.14,1]:[1,.28+core*.7,.035+core*.52];
   }else if(shape==='mist'||shape==='smoke'){
    const lobes=Math.max(disk(px,py,-.25,-.2,.63,.6),disk(px,py,.31,.01,.57,.68),disk(px,py,-.03,.45,.53,.44));
    alpha=Math.pow(edge,.55)*lobes*(.38+n*.62);lum=.65+n*.35;
   }else if(shape==='halo'||shape==='shockwave'){
    const t=Math.atan2(py,px),wave=shape==='shockwave'?.035*Math.sin(t*13):0;
    alpha=Math.exp(-Math.pow((r-.7-wave)/.062,2))+.18*Math.exp(-Math.pow((r-.58-wave)/.15,2));alpha*=smooth(0,.05,edge);
   }else if(shape==='streak')alpha=Math.exp(-px*px*38)*Math.pow(Math.sin(Math.PI*v),.6);
   else if(shape==='ribbon'){alpha=Math.exp(-px*px*6.5)*Math.pow(Math.sin(Math.PI*v),.35)*(.6+.4*Math.pow(Math.sin(v*27+px*5),2));lum=.78+.22*Math.cos(px*5);}
   else if(shape==='water'){
    const t=Math.atan2(py,px),waves=Math.sin(r*31-t*4)+Math.sin(px*19+py*23);
    alpha=Math.pow(edge,.45)*clamp(.42+waves*.19+n*.3);lum=.65+.35*clamp(waves*.4+.6);rgb=[.48+lum*.48,.75+lum*.25,1];
   }else if(shape==='energy-orb'){
    const t=Math.atan2(py,px),swirl=.45+.55*Math.pow(Math.sin(t*3+r*14),2);
    alpha=Math.exp(-r*r*3.5)*smooth(0,.08,edge)*(.5+swirl*.5);lum=.7+.3*Math.exp(-r*r*10);
   }else if(shape==='ice'){
    alpha=polygon(px,py,[[0,.94],[-.38,.35],[-.3,-.5],[0,-.95],[.3,-.5],[.38,.35]]);
    const facet=px>0?.7:1;lum=facet;rgb=[.75,.92,1];alpha=Math.max(alpha,annulus(px,py,.64,.025)*.2);
   }else if(shape==='slash'){
    const points=Array.from({length:15},(_,i)=>{const t=i/14;return [-.86+t*1.7,.72*Math.sin(t*Math.PI)-.28];});
    alpha=stroke(px,py,points,.1)*smooth(0,.23,1-Math.abs(px));alpha=Math.max(alpha,stroke(px,py+.15,points,.025)*.4);
   }else if(shape==='spark'){
    alpha=Math.max(Math.exp(-px*px*500)*smooth(0,.05,1-Math.abs(py)),Math.exp(-py*py*500)*smooth(0,.05,1-Math.abs(px)))*(.6+.4*Math.exp(-r*3));
   }else{
    alpha=iconMask(shape,px,py);lum=.78+.22*clamp(.5+px*.3+py*.45);
    if(shape==='rock'||shape==='scale'){lum*=.65+.35*noise(px*2,py*2);lum*=px+py>0?1:.7;}
    if(shape==='leaf'||shape==='feather'||shape==='petal')lum*=.65+.35*Math.abs(Math.sin((px+py*.3)*25));
    if(shape==='eye')lum*=1-disk(px,py,0,0,.2,.32)*.8;
    if(shape==='fist')lum*=1-stroke(px,py,[[-.4,.45],[-.33,-.08],[.45,-.08]],.025)*.5;
    if(shape==='coin')lum*=.75+.25*annulus(px,py,.58,.055);
    if(shape==='shield-face'||shape==='hex')alpha*=.28+.72*Math.max(annulus(px,py,.7,.18),stroke(px,py,[[0,-.62],[0,.61]],.025));
    if(shape==='fire-glyph'){
     let distance=10,tongues=0;
     for(const path of paths['fire-glyph'])for(let i=1;i<path.length;i++)distance=Math.min(distance,segment(px,py,path[i-1],path[i]));
     for(let i=1;i<=4;i++){const rise=i*.065,warp=Math.sin(py*23+i*1.7)*.025;for(const path of paths['fire-glyph'])tongues=Math.max(tongues,stroke(px+warp,py-rise,path,.12-i*.018)*(.72-i*.11));}
     const heat=1-smooth(.025,.14,distance),fringe=Math.exp(-Math.pow(distance/.18,2))*.23;
     alpha=Math.max(alpha*(.82+n*.18),tongues,fringe);lum=.94+heat*.06;rgb=[1,.12+heat*.82,.015+heat*.45];
    }
    if(shape==='gift')alpha=Math.max(alpha,stroke(px,py,[[-.65,.31],[.65,.31]],.1),annulus(px-.23,py-.55,.25,.07),annulus(px+.23,py-.55,.25,.07));
   }
   const k=(y*width+x)*4;data[k]=255*clamp(rgb[0]*lum);data[k+1]=255*clamp(rgb[1]*lum);data[k+2]=255*clamp(rgb[2]*lum);data[k+3]=Math.round(255*clamp(alpha));
  }
  const texture=new THREE.DataTexture(data,width,height,THREE.RGBAFormat);texture.name='combat-'+shape;texture.magFilter=THREE.LinearFilter;texture.minFilter=THREE.LinearFilter;texture.generateMipmaps=false;texture.colorSpace=THREE.SRGBColorSpace;texture.needsUpdate=true;textures[shape]=texture;
 }
 return textures;
}
