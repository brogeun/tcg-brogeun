import * as THREE from '../vendor/three.module.js';
export const LIQUID_PROFILES={water:{amplitude:.025,speed:.65,opacity:.94},ice:{amplitude:0,speed:0,opacity:1},lava:{amplitude:.012,speed:.16,opacity:1}};

// Infer a steady current along the body without changing its authored banks.
function liquidFlow(body){
 const direction=body.flowDirection;
 if(Array.isArray(direction)&&direction.length===2&&direction.every(Number.isFinite)&&Math.hypot(...direction)>.001)return new THREE.Vector2(...direction).normalize();
 const xs=body.polygon.map(p=>p[0]),zs=body.polygon.map(p=>p[1]);
 return Math.max(...xs)-Math.min(...xs)>Math.max(...zs)-Math.min(...zs)?new THREE.Vector2(1,0):new THREE.Vector2(0,1);
}

const waterShader=`
vec2 across=vec2(flowDirection.y,-flowDirection.x);
vec2 q=vec2(dot(p,across),dot(p,flowDirection));
float bend=noise(q*.29+vec2(0.0,-t*.08));
float crossBend=noise(q*.43+vec2(t*.07,8.4));
float a=q.x*.91+q.y*.38-t*.72+(bend-.5)*1.5;
float b=q.x*1.67-q.y*.63+t*.49+(crossBend-.5)*1.8;
float c=q.x*4.7+q.y*2.4-t*1.63+bend*2.7;
float d=-q.x*3.2+q.y*5.3+t*1.31+crossBend*2.4;
// Analytic slopes keep fine ripples independent of the polygon's vertex count.
vec2 slope=vec2(.031*.91*cos(a)+.018*1.67*cos(b)+.0045*4.7*cos(c)-.0035*3.2*cos(d),.031*.38*cos(a)-.018*.63*cos(b)+.0045*2.4*cos(c)+.0035*5.3*cos(d));
vec2 worldSlope=across*slope.x+flowDirection*slope.y;
vec3 normal=normalize(vec3(-worldSlope.x,1.0,-worldSlope.y));
vec3 view=normalize(cameraPosition-surfacePosition);
float facing=clamp(dot(normal,view),0.0,1.0);
float fresnel=.035+.42*pow(1.0-facing,4.0);
float shoreNoise=noise(p*.56+flowDirection*t*.06);
float depth=smoothstep(0.0,waterDepthScale,edge+(shoreNoise-.5)*.32);
vec3 shallow=baseColor*.91+vec3(.018,.022,.006);
vec3 deep=baseColor*.43+vec3(.006,.020,.026);
color=mix(shallow,deep,depth);
color*=.96+.043*sin(a)+.026*sin(b);
float smallCrest=pow(.5+.5*sin(b),4.0)*smoothstep(.32,.77,bend);
color+=vec3(.008,.017,.014)*smallCrest;
vec3 reflected=reflect(-view,normal);
vec3 sky=mix(vec3(.10,.16,.17),vec3(.22,.31,.32),smoothstep(.0,.9,reflected.y));
float cloud=noise(reflected.xz*3.4+flowDirection*t*.025);
sky+=vec3(.025,.027,.023)*smoothstep(.48,.8,cloud);
color=mix(color,sky,fresnel);
vec3 halfLight=normalize(view+normalize(vec3(.32,.88,-.34)));
float sheen=pow(max(0.0,dot(normal,halfLight)),48.0);
float glimmer=smoothstep(.44,.78,noise(q*1.8+vec2(-t*.19,t*.23)));
color+=vec3(.085,.10,.085)*sheen*(.3+glimmer*.7);
// Short foam patches sit against the bank, rather than outlining the polygon.
float bank=1.0-smoothstep(.035,.48,edge);
float broken=smoothstep(.55,.78,noise(p*2.15-flowDirection*t*.24));
float wash=.5+.5*sin(edge*12.0-t*1.7+shoreNoise*4.0);
float froth=bank*broken*(.16+.19*wash)*foam;
color=mix(color,vec3(.43,.55,.48),froth);
`;

const lavaShader=`
vec2 across=vec2(flowDirection.y,-flowDirection.x);
vec2 current=vec2(dot(p,across),dot(p,flowDirection));
vec2 drift=vec2(0.0,t*.27);
vec2 warp=vec2(noise(current*.43+vec2(4.7,-t*.04)),noise(current*.39+vec2(-t*.05,13.1)))-.5;
vec2 fineWarp=vec2(noise(current*1.17+vec2(9.2,-t*.13)),noise(current*1.31+vec2(t*.11,3.7)))-.5;
vec2 q=current*vec2(.42,.33)-drift+warp*1.35+fineWarp*.19;
vec2 cell=floor(q),local=fract(q),cellId=cell;
float nearest=10.0,second=10.0;
for(int x=-1;x<=1;x++)for(int y=-1;y<=1;y++){
 vec2 offset=vec2(float(x),float(y));
 vec2 center=offset+.16+hash2(cell+offset)*.68;
 float distanceToCell=length(center-local);
 if(distanceToCell<nearest){second=nearest;nearest=distanceToCell;cellId=cell+offset;}
 else second=min(second,distanceToCell);
}
float seam=max(0.0,second-nearest);
float rough=noise(current*2.4+vec2(0.0,-t*.64));
float width=mix(.018,.19,pow(noise(current*.29-vec2(0.0,t*.10)),1.6));
width+=.065*smoothstep(.56,.79,noise(current*.73+vec2(3.4,-t*.16)));
float fracture=1.0-smoothstep(width*.12,width,seam+(rough-.5)*.035);
float core=1.0-smoothstep(.0,width*.34,seam);
float bank=1.0-smoothstep(.22,1.35,edge+(noise(p*.74)-.5)*.42);
float pulse=.82+.18*sin(t*1.8+hash(cellId)*6.283+current.y*.23);
float heatActivity=.28+.72*smoothstep(.25,.72,noise(current*.61+vec2(t*.09,4.3)));
fracture*=heatActivity;
core*=heatActivity*heatActivity;
float hotPocket=smoothstep(.53,.76,noise(current*.17-vec2(0.0,t*.12)))*smoothstep(.36,.69,noise(current*.54+vec2(2.8,t*.07)));
float rivulet=1.0-smoothstep(.035,.13,abs(noise(current*.24+warp*.65-drift*.35)-.52));
rivulet*=smoothstep(.49,.78,noise(current*.18+vec2(8.4,t*.05)));
float heat=max(fracture*pulse,max(hotPocket*.88,rivulet*.60))*(1.0-bank*.93);
float grain=noise(current*3.8-vec2(0.0,t*.88));
vec3 crust=vec3(.027,.024,.021)*(.72+noise(q*2.1)*.45+grain*.18);
crust+=vec3(.018,.008,.003)*pow(max(0.0,1.0-seam*5.0),3.0)*(1.0-bank)*pulse;
vec3 molten=mix(vec3(.34,.027,.003),vec3(.96,.205,.012),clamp(core*.77+hotPocket*.42+rivulet*.10,0.0,1.0));
color=mix(crust,molten,heat);
color+=vec3(.075,.009,.001)*core*fracture*pulse*(1.0-bank);
`;

export function liquidMesh(body,palette,time,light={value:1}){
 const profile=LIQUID_PROFILES[body.kind];if(!profile)throw Error('Unknown liquid profile '+body.kind);
 const rings=[body.polygon,...(body.holes||[]).map(h=>h.polygon||h)],points=rings.map(r=>r.map(([x,z])=>new THREE.Vector2(x,z))),all=points.flat(),faces=THREE.ShapeUtils.triangulateShape(points[0],points.slice(1)),vertices=[];
 for(const face of faces)for(const i of face)vertices.push(all[i].x,body.surfaceY,all[i].y);
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.computeVertexNormals();
 const edges=rings.flatMap(r=>r.map((a,i)=>new THREE.Vector4(...a,...r[(i+1)%r.length])));
 const material=new THREE.ShaderMaterial({side:THREE.DoubleSide,transparent:profile.opacity<1,depthWrite:body.kind!=='water',uniforms:{time,ambientLight:body.kind==='lava'?{value:1}:light,amplitude:{value:body.amplitude??profile.amplitude},speed:{value:body.flowSpeed??profile.speed},opacity:{value:profile.opacity},waterDepthScale:{value:Math.max(.2,Number(body.depthScale)||5.5)},baseColor:{value:new THREE.Color(body.color||palette[body.kind]||{water:'#3b9fae',ice:'#a5d9e5',lava:'#de4d18'}[body.kind])},edges:{value:edges},foam:{value:body.foam?1:0},flowDirection:{value:liquidFlow(body)}},vertexShader:`uniform float time,amplitude,speed;varying vec2 waterXZ;varying vec3 surfacePosition;void main(){waterXZ=position.xz;vec3 p=position;p.y+=amplitude*(sin(p.x*.65+p.z*.32+time*speed)+.4*sin(p.z*.87-time*speed*.8));surfacePosition=(modelMatrix*vec4(p,1.0)).xyz;gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
 fragmentShader:`uniform float time,speed,opacity,foam,ambientLight,waterDepthScale;uniform vec3 baseColor;uniform vec2 flowDirection;uniform vec4 edges[${edges.length}];varying vec2 waterXZ;varying vec3 surfacePosition;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
vec2 hash2(vec2 p){return fract(sin(vec2(dot(p,vec2(127.1,311.7)),dot(p,vec2(269.5,183.3))))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
void main(){vec2 p=waterXZ;float edge=1000.0;for(int i=0;i<${edges.length};i++){vec2 a=edges[i].xy,d=edges[i].zw-a;float t=clamp(dot(p-a,d)/max(dot(d,d),.001),0.0,1.0);edge=min(edge,length(p-a-t*d));}
float t=time*speed;vec3 color;
${body.kind==='water'?waterShader:body.kind==='ice'?`float veins=pow(1.0-abs(sin(p.x*.7+noise(p*.4)*3.0)*cos(p.y*.6)),22.0);color=baseColor*(.83+noise(p*.18)*.2)+vec3(.22)*veins;`:lavaShader}
color*=ambientLight;
gl_FragColor=vec4(color,opacity);
#include <tonemapping_fragment>
#include <colorspace_fragment>
}`});
 const mesh=new THREE.Mesh(geometry,material);mesh.userData.liquidKind=body.kind;return mesh;
}
export function waterfallMesh(spec,time){
 const [x,y,z]=spec.from,[tx,ty,tz]=spec.to,w=spec.width/2;
 const g=new THREE.BufferGeometry();g.setAttribute('position',new THREE.Float32BufferAttribute([x-w,y,z,x+w,y,z,tx-w,ty,tz,tx-w,ty,tz,x+w,y,z,tx+w,ty,tz],3));g.setAttribute('uv',new THREE.Float32BufferAttribute([0,1,1,1,0,0,0,0,1,1,1,0],2));
 return new THREE.Mesh(g,new THREE.ShaderMaterial({side:THREE.DoubleSide,transparent:true,depthWrite:false,uniforms:{time,color:{value:new THREE.Color(spec.color||'#b7e5e6')}},vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:`uniform float time;uniform vec3 color;varying vec2 vUV;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
void main(){
 float flow=noise(vec2(vUV.x*17.0,vUV.y*2.7+time*1.6));
 float threads=.5+.5*sin(vUV.x*72.0+noise(vec2(vUV.x*8.0,vUV.y*1.5+time*.9))*2.8);
 float edge=smoothstep(.0,.14,vUV.x)*smoothstep(.0,.14,1.0-vUV.x);
 float spray=(1.0-smoothstep(.0,.23,vUV.y))*(.55+.45*flow);
 gl_FragColor=vec4(color*(.64+flow*.22+threads*.08+spray*.09),edge*(.45+flow*.23+spray*.12));
}` }));
}
