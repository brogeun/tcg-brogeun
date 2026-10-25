(function (root) {
  'use strict';
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const area = q => Math.abs(q.reduce((sum, p, i) => { const n=q[(i+1)%q.length]; return sum+p.x*n.y-n.x*p.y; },0))/2;
  function validQuad(q, width, height) {
    if (!Array.isArray(q) || q.length!==4 || !q.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&p.x>=0&&p.y>=0&&p.x<width&&p.y<height)) return false;
    let sign=0;
    for(let i=0;i<4;i++) { const a=q[i],b=q[(i+1)%4],c=q[(i+2)%4]; const cross=(b.x-a.x)*(c.y-b.y)-(b.y-a.y)*(c.x-b.x); if(cross<=1) return false; sign+=cross; }
    return sign>0 && area(q)>width*height*0.015;
  }
  function planRectification(quad, imageWidth, imageHeight) {
    if(!Number.isInteger(imageWidth)||!Number.isInteger(imageHeight)||imageWidth<1||imageHeight<1||!validQuad(quad,imageWidth,imageHeight))throw new Error('카드 네 모서리가 사진 안에서 서로 겹치지 않게 맞춰 주세요.');
    // Crop the original first: empty photo margins must not consume the processing limit.
    const x=Math.max(0,Math.floor(Math.min(...quad.map(p=>p.x)))-2),y=Math.max(0,Math.floor(Math.min(...quad.map(p=>p.y)))-2);
    const right=Math.min(imageWidth,Math.ceil(Math.max(...quad.map(p=>p.x)))+3),bottom=Math.min(imageHeight,Math.ceil(Math.max(...quad.map(p=>p.y)))+3);
    const crop={x,y,width:right-x,height:bottom-y},scale=Math.min(1,4096/Math.max(crop.width,crop.height));
    const processing={width:Math.max(1,Math.round(crop.width*scale)),height:Math.max(1,Math.round(crop.height*scale))};
    const scaleX=processing.width/crop.width,scaleY=processing.height/crop.height;
    const mapped=quad.map(p=>({x:clamp((p.x-x)*scaleX,0,processing.width-1),y:clamp((p.y-y)*scaleY,0,processing.height-1)}));
    if(!validQuad(mapped,processing.width,processing.height))throw new Error('카드 모서리 위치를 다시 맞춰 주세요.');
    const edge=(a,b)=>Math.hypot(mapped[a].x-mapped[b].x,mapped[a].y-mapped[b].y);
    const horizontal=Math.max(edge(0,1),edge(3,2)),vertical=Math.max(edge(0,3),edge(1,2))*63/88;
    // Keep the better observed edge detail; do not let one foreshortened edge shrink all sides.
    const width=Math.max(64,Math.round(Math.min(1466,horizontal,vertical))),height=Math.min(2048,Math.round(width*88/63));
    return {crop,processing,quad:mapped,width,height,scaleX,scaleY};
  }
  function detectOuter({data,width:w,height:h}) {
    // Background contrast proposes a boundary; the user must confirm all four corners.
    const samples=[];
    for(const [cx,cy] of [[0,0],[w-1,0],[w-1,h-1],[0,h-1]]) for(let a=0;a<5;a++)for(let b=0;b<5;b++) {
      const x=clamp(cx===0?a:w-1-a,0,w-1),y=clamp(cy===0?b:h-1-b,0,h-1),i=(y*w+x)*4;samples.push([data[i],data[i+1],data[i+2]]);
    }
    const median = values=>values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
    const bg=[0,1,2].map(c=>median(samples.map(p=>p[c])));
    const distances=samples.map(p=>Math.hypot(...p.map((v,c)=>v-bg[c])));
    const threshold=Math.max(32,median(distances)*3+18);
    const mask=new Uint8Array(w*h),seen=new Uint8Array(w*h),queue=new Int32Array(w*h);
    for(let n=0;n<mask.length;n++) { const i=n*4;mask[n]=Math.hypot(data[i]-bg[0],data[i+1]-bg[1],data[i+2]-bg[2])>threshold?1:0; }
    let best=null;
    for(let n=0;n<mask.length;n++) {
      if(!mask[n]||seen[n])continue;
      let head=0,tail=1;queue[0]=n;seen[n]=1;
      const extrema=[{v:Infinity},{v:-Infinity},{v:-Infinity},{v:Infinity}];let touches=0;
      while(head<tail) {
        const at=queue[head++],x=at%w,y=Math.floor(at/w),values=[x+y,x-y,x+y,x-y];
        if(x===0||y===0||x===w-1||y===h-1)touches++;
        for(let k=0;k<4;k++) if((k===0||k===3)?values[k]<extrema[k].v:values[k]>extrema[k].v)extrema[k]={x,y,v:values[k]};
        for(const next of [x>0?at-1:-1,x<w-1?at+1:-1,y>0?at-w:-1,y<h-1?at+w:-1])if(next>=0&&mask[next]&&!seen[next]){seen[next]=1;queue[tail++]=next;}
      }
      const q=extrema.map(({x,y})=>({x,y})),qa=area(q);
      if(tail<w*h*0.12||tail>w*h*0.92||touches>4||!validQuad(q,w,h)||tail/qa<0.72)continue;
      if(!best||tail>best.pixels)best={quad:q,pixels:tail,confidence:Math.min(0.9,tail/qa)};
    }
    return best;
  }
  function homography(q) {
    const unit=[[0,0],[1,0],[1,1],[0,1]],m=[];
    for(let i=0;i<4;i++){const [u,v]=unit[i],{x,y}=q[i];m.push([u,v,1,0,0,0,-u*x,-v*x,x],[0,0,0,u,v,1,-u*y,-v*y,y]);}
    for(let c=0;c<8;c++) {
      let pivot=c;for(let r=c+1;r<8;r++)if(Math.abs(m[r][c])>Math.abs(m[pivot][c]))pivot=r;
      [m[c],m[pivot]]=[m[pivot],m[c]];const div=m[c][c];if(Math.abs(div)<1e-10)throw new Error('카드 모서리 위치를 다시 맞춰 주세요.');
      for(let j=c;j<9;j++)m[c][j]/=div;
      for(let r=0;r<8;r++)if(r!==c){const t=m[r][c];for(let j=c;j<9;j++)m[r][j]-=t*m[c][j];}
    }
    return [...m.map(row=>row[8]),1];
  }
  function project(h,u,v){const z=h[6]*u+h[7]*v+1;return {x:(h[0]*u+h[1]*v+h[2])/z,y:(h[3]*u+h[4]*v+h[5])/z};}
  function planCornerDetails(quad,imageWidth,imageHeight){
    if(!Number.isInteger(imageWidth)||!Number.isInteger(imageHeight)||!validQuad(quad,imageWidth,imageHeight))throw new Error('카드 네 모서리를 원본 사진 안에 다시 맞춰 주세요.');
    const H=homography(quad),uSpan=.26,vSpan=uSpan*63/88;
    // Sheet order is TL, TR, BL, BR; each region covers a physical square on the card.
    const positions=[['top-left',0,0,0],['top-right',1,1-uSpan,0],['bottom-left',3,0,1-vSpan],['bottom-right',2,1-uSpan,1-vSpan]];
    const edgeMin=q=>Math.min(...q.map((p,i)=>Math.hypot(p.x-q[(i+1)%4].x,p.y-q[(i+1)%4].y)));
    const tiles=positions.map(([corner,sourceCorner,u,v])=>{
      const originalQuad=[[u,v],[u+uSpan,v],[u+uSpan,v+vSpan],[u,v+vSpan]].map(([x,y])=>project(H,x,y));
      const x=Math.max(0,Math.floor(Math.min(...originalQuad.map(p=>p.x)))-2),y=Math.max(0,Math.floor(Math.min(...originalQuad.map(p=>p.y)))-2);
      const right=Math.min(imageWidth,Math.ceil(Math.max(...originalQuad.map(p=>p.x)))+3),bottom=Math.min(imageHeight,Math.ceil(Math.max(...originalQuad.map(p=>p.y)))+3);
      const crop={x,y,width:right-x,height:bottom-y},scale=Math.min(1,4096/Math.max(crop.width,crop.height));
      const processing={width:Math.max(1,Math.round(crop.width*scale)),height:Math.max(1,Math.round(crop.height*scale))};
      const scaleX=processing.width/crop.width,scaleY=processing.height/crop.height;
      const mapped=originalQuad.map(p=>({x:clamp((p.x-x)*scaleX,0,processing.width-1),y:clamp((p.y-y)*scaleY,0,processing.height-1)}));
      const nativePixels=Math.floor(edgeMin(originalQuad)),size=Math.floor(Math.min(512,nativePixels,edgeMin(mapped)));
      if(size<16||!validQuad(mapped,processing.width,processing.height))throw new Error('모서리 세부 사진을 만들기에 원본의 카드가 너무 작습니다. 카드가 더 크게 나온 사진을 선택해 주세요.');
      return {corner,sourceCorner,originalQuad,crop,processing,quad:mapped,size,nativePixels,scaleX,scaleY};
    });
    const cellSize=Math.max(...tiles.map(tile=>tile.size)),labelHeight=16;
    return {version:1,cellSize,labelHeight,width:cellSize*2,height:(cellSize+labelHeight)*2,tiles:tiles.map((tile,i)=>({...tile,x:(i%2)*cellSize,y:Math.floor(i/2)*(cellSize+labelHeight)+labelHeight}))};
  }
  function warp(source,quad,width,height) {
    if(!validQuad(quad,source.width,source.height))throw new Error('카드 네 모서리가 사진 안에서 서로 겹치지 않게 맞춰 주세요.');
    const H=homography(quad),data=new Uint8ClampedArray(width*height*4),sw=source.width,sh=source.height,src=source.data;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const p=project(H,x/(width-1),y/(height-1)),px=clamp(p.x,0,sw-1),py=clamp(p.y,0,sh-1),x0=Math.floor(px),y0=Math.floor(py),fx=px-x0,fy=py-y0;
      const ids=[(y0*sw+x0)*4,(y0*sw+Math.min(x0+1,sw-1))*4,(Math.min(y0+1,sh-1)*sw+x0)*4,(Math.min(y0+1,sh-1)*sw+Math.min(x0+1,sw-1))*4],weights=[(1-fx)*(1-fy),fx*(1-fy),(1-fx)*fy,fx*fy],out=(y*width+x)*4;
      for(let c=0;c<3;c++)data[out+c]=ids.reduce((s,i,k)=>s+(src[i+c]*(src[i+3]/255)+255*(1-src[i+3]/255))*weights[k],0);
      data[out+3]=255;
    }
    return {data,width,height};
  }
  function detectInner({data,width:w,height:h}) {
    function scan(axis,reverse) {
      const length=axis==='x'?w:h,other=axis==='x'?h:w,values=[];
      for(let d=Math.max(1,Math.floor(length*0.003));d<length*0.18;d++) {
        const pos=reverse?length-1-d:d,step=reverse?-1:1,scores=[];
        for(let t=Math.round(other*0.2);t<other*0.8;t+=Math.max(1,Math.round(other/90))) {
          const a=(axis==='x'?t*w+pos:pos*w+t)*4,b=(axis==='x'?t*w+pos+step*2:(pos+step*2)*w+t)*4;
          scores.push(Math.hypot(data[a]-data[b],data[a+1]-data[b+1],data[a+2]-data[b+2]));
        }
        scores.sort((a,b)=>a-b);values.push({d,score:scores[Math.floor(scores.length*0.45)]});
      }
      const sorted=values.map(v=>v.score).sort((a,b)=>a-b),noise=sorted[Math.floor(sorted.length/2)]||0;
      const strongest=values.reduce((a,b)=>a.score>b.score?a:b,{d:0,score:0});
      const threshold=Math.max(24,noise*3,strongest.score*.25);
      // Choose the first sustained boundary from the card edge. A stronger
      // artwork frame farther inside must not replace an already visible border.
      let group=[];
      for(const value of [...values,{d:length,score:0}]){
        if(value.score>threshold){group.push(value);continue;}
        if(group.length>=2){const best=group.reduce((a,b)=>a.score>b.score?a:b);return {distance:(best.d+1)/length,signal:best.score};}
        group=[];
      }
      return null;
    }
    const edges=[scan('x',false),scan('x',true),scan('y',false),scan('y',true)];
    if(edges.some(e=>!e))return null;
    return {left:edges[0].distance,right:edges[1].distance,top:edges[2].distance,bottom:edges[3].distance};
  }
  function measure(insets,confirmed) {
    if(!confirmed||!insets)return null;
    if(!['left','right','top','bottom'].every(k=>Number.isFinite(insets[k])&&insets[k]>0&&insets[k]<0.3))return null;
    const {left:l,right:r,top:t,bottom:b}=insets;
    const round=x=>Math.round(x*10)/10;
    return {version:2,confirmed:true,method:'perspective-rectified',lPct:round(l/(l+r)*100),rPct:round(r/(l+r)*100),tPct:round(t/(t+b)*100),bPct:round(b/(t+b)*100),lMm:round(l*63),rMm:round(r*63),tMm:round(t*88),bMm:round(b*88)};
  }
  const api={clamp,area,validQuad,planRectification,planCornerDetails,detectOuter,homography,project,warp,detectInner,measure};
  if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.CenteringGeometry=api;
})(typeof window==='undefined'?globalThis:window);
