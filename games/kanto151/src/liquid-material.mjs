import * as THREE from '../vendor/three.module.js';
export const LIQUID_PROFILES={water:{amplitude:.025,speed:.65,opacity:.94},ice:{amplitude:0,speed:0,opacity:1},lava:{amplitude:.012,speed:.16,opacity:1}};
export function liquidMesh(body,palette,time,light={value:1}){
 const profile=LIQUID_PROFILES[body.kind];if(!profile)throw Error('Unknown liquid profile '+body.kind);
 const rings=[body.polygon,...(body.holes||[]).map(h=>h.polygon||h)],points=rings.map(r=>r.map(([x,z])=>new THREE.Vector2(x,z))),all=points.flat(),faces=THREE.ShapeUtils.triangulateShape(points[0],points.slice(1)),vertices=[];
 for(const face of faces)for(const i of face)vertices.push(all[i].x,body.surfaceY,all[i].y);
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute(vertices,3));geometry.computeVertexNormals();
 const edges=rings.flatMap(r=>r.map((a,i)=>new THREE.Vector4(...a,...r[(i+1)%r.length])));
 const material=new THREE.ShaderMaterial({side:THREE.DoubleSide,transparent:profile.opacity<1,depthWrite:body.kind!=='water',uniforms:{time,ambientLight:body.kind==='lava'?{value:1}:light,amplitude:{value:body.amplitude??profile.amplitude},speed:{value:body.flowSpeed??profile.speed},opacity:{value:profile.opacity},baseColor:{value:new THREE.Color(palette[body.kind]||{water:'#3b9fae',ice:'#a5d9e5',lava:'#de4d18'}[body.kind])},edges:{value:edges},foam:{value:body.foam?1:0}},vertexShader:`uniform float time,amplitude,speed;varying vec2 waterXZ;void main(){waterXZ=position.xz;vec3 p=position;p.y+=amplitude*(sin(p.x*.65+p.z*.32+time*speed)+.4*sin(p.z*.87-time*speed*.8));gl_Position=projectionMatrix*modelViewMatrix*vec4(p,1.0);}`,
 fragmentShader:`uniform float time,speed,opacity,foam,ambientLight;uniform vec3 baseColor;uniform vec4 edges[${edges.length}];varying vec2 waterXZ;
float hash(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float noise(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.0-2.0*f);return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);}
void main(){vec2 p=waterXZ;float edge=1000.0;for(int i=0;i<${edges.length};i++){vec2 a=edges[i].xy,d=edges[i].zw-a;float t=clamp(dot(p-a,d)/max(dot(d,d),.001),0.0,1.0);edge=min(edge,length(p-a-t*d));}
float t=time*speed,n=noise(p*.6+vec2(t*.18,-t*.13));vec3 color;
${body.kind==='water'?`float depth=smoothstep(0.0,5.5,edge);float ripple=pow(max(0.0,sin(p.x*.82+p.y*.53+t+n*2.8)),14.0)*(.25+.75*noise(p*.23));color=mix(baseColor*1.35+vec3(.05,.1,.03),baseColor*.68,depth);color+=vec3(.06,.12,.13)*ripple;float rim=(1.0-smoothstep(.12,.7,edge))*(.45+.55*sin(p.x*1.2+p.y*.9+t));color=mix(color,vec3(.78,.91,.85),rim*.6*foam);`:
body.kind==='ice'?`float veins=pow(1.0-abs(sin(p.x*.7+noise(p*.4)*3.0)*cos(p.y*.6)),22.0);color=baseColor*(.83+noise(p*.18)*.2)+vec3(.22)*veins;`:
`float cells=noise(p*.48+vec2(t*.1));float crust=smoothstep(.37,.63,cells);float pulse=.92+.08*sin(t*2.0+p.x*.3);color=mix(baseColor*vec3(1.65,.8,.35)*pulse,vec3(.12,.055,.035),crust*.86);color+=vec3(.22,.04,0.0)*pow(1.0-abs(cells-.48)*2.0,12.0);`}
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
 return new THREE.Mesh(g,new THREE.ShaderMaterial({side:THREE.DoubleSide,transparent:true,depthWrite:false,uniforms:{time,color:{value:new THREE.Color(spec.color||'#b7e5e6')}},vertexShader:'varying vec2 vUV;void main(){vUV=uv;gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',fragmentShader:'uniform float time;uniform vec3 color;varying vec2 vUV;void main(){float streak=.5+.5*sin(vUV.x*37.0+sin(vUV.y*13.0+time*3.0));float edge=smoothstep(0.0,.12,vUV.x)*smoothstep(0.0,.12,1.0-vUV.x);gl_FragColor=vec4(color*(.8+streak*.2),edge*(.60+streak*.25));}'}));
}
