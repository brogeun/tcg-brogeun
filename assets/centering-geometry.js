(function(root){
  'use strict';
  const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
  const polygonArea=q=>Math.abs(q.reduce((s,p,i)=>{const n=q[(i+1)%4];return s+p.x*n.y-n.x*p.y;},0))/2;
  // A small, local detector. It does not load recognition/OCR models or identify
  // a card. Separate side proposals prevent text, slabs and bright backgrounds
  // from being treated as one foreground component.
  function detect(image,{maxCandidates=4}={}){
    const scale=Math.min(1,360/Math.max(image.width,image.height)),w=Math.max(3,Math.round(image.width*scale)),h=Math.max(3,Math.round(image.height*scale));
    const gray=new Float32Array(w*h),smooth=new Float32Array(w*h),mag=new Float32Array(w*h),gx=new Float32Array(w*h),gy=new Float32Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(Math.min(image.height-1,Math.round(y/scale))*image.width+Math.min(image.width-1,Math.round(x/scale)))*4;
      gray[y*w+x]=image.data[i]*.299+image.data[i+1]*.587+image.data[i+2]*.114;
    }
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;smooth[i]=(gray[i]*4+(gray[i-1]+gray[i+1]+gray[i-w]+gray[i+w])*2+gray[i-w-1]+gray[i-w+1]+gray[i+w-1]+gray[i+w+1])/16;}
    const strengths=[];
    for(let y=2;y<h-2;y++)for(let x=2;x<w-2;x++){
      const i=y*w+x,a=smooth[i+1]-smooth[i-1],b=smooth[i+w]-smooth[i-w];gx[i]=a;gy[i]=b;mag[i]=Math.hypot(a,b);if(mag[i]>8)strengths.push(mag[i]);
    }
    strengths.sort((a,b)=>a-b);const threshold=Math.max(10,strengths[Math.floor(strengths.length*.55)]||10);
    const slopes=41,step=.02,offset=Math.ceil(Math.max(w,h)*.45)+3,stride=Math.max(w,h)+offset*2+4;
    const votes=[new Float32Array(slopes*stride),new Float32Array(slopes*stride)];
    for(let y=2;y<h-2;y++)for(let x=2;x<w-2;x++){
      const i=y*w+x,m=mag[i];if(m<threshold)continue;
      for(let axis=0;axis<2;axis++){
        const normal=axis?gy[i]:gx[i],tangent=axis?gx[i]:gy[i];if(Math.abs(normal)<Math.abs(tangent)*1.5)continue;
        const expected=-tangent/normal;if(Math.abs(expected)>.52)continue;
        const center=Math.round((expected+.4)/step),weight=Math.sqrt(m);
        for(let s=Math.max(0,center-4);s<=Math.min(slopes-1,center+4);s++){
          const a=s*step-.4,b=(axis?y:x)-a*(axis?x:y),bi=Math.round(b)+offset;
          if(bi>1&&bi<stride-2)votes[axis][s*stride+bi]+=weight;
        }
      }
    }
    function lines(axis){
      const peaks=[],v=votes[axis],dim=axis?h:w;
      for(let s=0;s<slopes;s++)for(let b=2;b<stride-2;b++){
        const i=s*stride+b,score=v[i-1]+v[i]*2+v[i+1];if(score<40)continue;
        if(score<(v[i-2]+v[i-1]*2+v[i])||score<(v[i]+v[i+1]*2+v[i+2]))continue;
        const a=s*step-.4,intercept=b-offset,mid=intercept+a*(axis?w:h)/2;if(mid<0||mid>=dim)continue;
        peaks.push({a,b:intercept,mid,score});
      }
      const kept=[];for(const p of peaks.sort((a,b)=>b.score-a.score)){
        if(kept.some(k=>Math.abs(k.mid-p.mid)<4&&Math.abs(k.a-p.a)<.07))continue;
        kept.push(p);if(kept.length===20)break;
      }return kept.sort((a,b)=>a.mid-b.mid);
    }
    const vs=lines(0),hs=lines(1),meet=(v,l)=>{const y=(l.a*v.b+l.b)/(1-l.a*v.a);return{x:v.a*y+v.b,y};};
    function edgeSupport(a,b){
      const n=Math.max(20,Math.round(Math.hypot(a.x-b.x,a.y-b.y)/2)),dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy);let sum=0,signal=0;
      for(let k=2;k<n-2;k++){
        const x=Math.round(a.x+dx*k/n),y=Math.round(a.y+dy*k/n);let best=0;
        for(let oy=-2;oy<=2;oy++)for(let ox=-2;ox<=2;ox++){
          const xx=x+ox,yy=y+oy;if(xx<2||xx>=w-2||yy<2||yy>=h-2)continue;
          const i=yy*w+xx,alignment=Math.abs(gx[i]*dy-gy[i]*dx)/Math.max(1,mag[i]*len);
          best=Math.max(best,mag[i]*Math.pow(alignment,3));
        }
        sum+=Math.min(1,best/Math.max(12,threshold*.7));signal+=Math.min(100,best);
      }return{coverage:sum/Math.max(1,n-4),strength:signal/Math.max(1,n-4)};
    }
    // Compute edge evidence once per line. Thousands of quadrilaterals can then
    // share prefix sums instead of resampling every candidate side.
    function prepare(line,axis){
      const size=axis?w:h,cover=new Float32Array(size+1),strength=new Float32Array(size+1),length=Math.hypot(1,line.a);
      for(let at=0;at<size;at++){
        const x=Math.round(axis?at:line.a*at+line.b),y=Math.round(axis?line.a*at+line.b:at);let best=0;
        for(let oy=-2;oy<=2;oy++)for(let ox=-2;ox<=2;ox++){
          const xx=x+ox,yy=y+oy;if(xx<2||xx>=w-2||yy<2||yy>=h-2)continue;const i=yy*w+xx;
          const normal=axis?gy[i]-gx[i]*line.a:gx[i]-gy[i]*line.a,alignment=Math.abs(normal)/Math.max(1,mag[i]*length);
          best=Math.max(best,mag[i]*Math.pow(alignment,3));
        }
        cover[at+1]=cover[at]+Math.min(1,best/Math.max(12,threshold*.7));strength[at+1]=strength[at]+Math.min(100,best);
      }line.profile={cover,strength,size};
    }
    vs.forEach(l=>prepare(l,0));hs.forEach(l=>prepare(l,1));
    function supported(line,a,b,axis){
      const p=line.profile,lo=clamp(Math.ceil(Math.min(axis?a.x:a.y,axis?b.x:b.y))+3,0,p.size-1),hi=clamp(Math.floor(Math.max(axis?a.x:a.y,axis?b.x:b.y))-2,lo+1,p.size),n=hi-lo;
      return{coverage:(p.cover[hi]-p.cover[lo])/n,strength:(p.strength[hi]-p.strength[lo])/n};
    }
    const proposals=[],dist=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
    for(let l=0;l<vs.length;l++)for(let r=l+1;r<vs.length;r++){
      if(vs[r].mid-vs[l].mid<w*.12)continue;
      for(let t=0;t<hs.length;t++)for(let b=t+1;b<hs.length;b++){
        if(hs[b].mid-hs[t].mid<h*.12)continue;
        const q=[meet(vs[l],hs[t]),meet(vs[r],hs[t]),meet(vs[r],hs[b]),meet(vs[l],hs[b])];
        if(q.some(p=>p.x<0||p.y<0||p.x>=w||p.y>=h))continue;
        const a=polygonArea(q)/(w*h);if(a<.045||a>.997)continue;
        const widths=[dist(q[0],q[1]),dist(q[2],q[3])],heights=[dist(q[0],q[3]),dist(q[1],q[2])];
        if(Math.max(...widths)/Math.min(...widths)>1.7||Math.max(...heights)/Math.min(...heights)>1.7)continue;
        const ratio=(widths[0]+widths[1])/(heights[0]+heights[1]),portrait=Math.abs(Math.log(ratio/(63/88))),landscape=Math.abs(Math.log(ratio/(88/63))),error=Math.min(portrait,landscape);
        if(error>.27)continue;
        const sides=[supported(hs[t],q[0],q[1],1),supported(vs[r],q[1],q[2],0),supported(hs[b],q[2],q[3],1),supported(vs[l],q[3],q[0],0)],minimum=Math.min(...sides.map(s=>s.coverage)),mean=sides.reduce((s,v)=>s+v.coverage/4,0);
        if(minimum<.42||mean<.68)continue;
        const shape=Math.exp(-error*5),parallel=Math.exp(-(Math.abs(vs[l].a-vs[r].a)+Math.abs(hs[t].a-hs[b].a))*.6),strength=sides.reduce((s,v)=>s+v.strength/4,0);
        const score=(mean*.65+minimum*.35)*shape*parallel*Math.pow(a,.10)*(1+Math.min(.12,strength/400));
        proposals.push({quad:q,score,confidence:Math.min(.95,mean*shape),coverage:a,method:'four-supported-edges',edgeSupport:minimum});
      }
    }
    // Image-edge card scans need their missing outside edge represented explicitly.
    const ratio=w/h,frameShape=Math.min(Math.abs(Math.log(ratio/(63/88))),Math.abs(Math.log(ratio/(88/63))));
    if(frameShape<.075){
      const q=[{x:2,y:2},{x:w-3,y:2},{x:w-3,y:h-3},{x:2,y:h-3}],edge=q.map((p,i)=>edgeSupport(p,q[(i+1)%4]));
      const mean=edge.reduce((s,v)=>s+v.coverage/4,0);
      if(mean>.45)proposals.push({quad:[{x:0,y:0},{x:w-1,y:0},{x:w-1,y:h-1},{x:0,y:h-1}],score:.64*Math.exp(-frameShape*4)+mean*.16,confidence:.7,coverage:1,method:'card-at-image-edges'});

    }
    const selected=[];for(const c of proposals.sort((a,b)=>b.score-a.score)){
      if(selected.some(other=>c.quad.reduce((s,p,i)=>s+dist(p,other.quad[i])/4,0)<Math.min(w,h)*.025))continue;
      selected.push(c);if(selected.length>=maxCandidates)break;
    }
    if(!selected.length)return null;
    const mapped=selected.map(c=>({...c,quad:c.quad.map(p=>({x:clamp(p.x*image.width/w,0,image.width-1),y:clamp(p.y*image.height/h,0,image.height-1)}))}));
    return{...mapped[0],alternatives:mapped.slice(1)};
  }
  const api={detect};if(typeof module!=='undefined'&&module.exports)module.exports=api;root.CardBoundary=api;
})(typeof window==='undefined'?globalThis:window);

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
  function detectOuter(image) {
    const edge=root.CardBoundary.detect(image),contrast=detectOuterContrast(image);
    if(contrast&&edge&&area(contrast.quad)<area(edge.quad)*.97)return edge;
    if(contrast){const q=contrast.quad,dist=(a,b)=>Math.hypot(q[a].x-q[b].x,q[a].y-q[b].y),ratio=(dist(0,1)+dist(2,3))/(dist(0,3)+dist(1,2)),shape=Math.min(Math.abs(Math.log(ratio/(63/88))),Math.abs(Math.log(ratio/(88/63))));
      if(shape<.075&&contrast.confidence>=.75){return {...contrast,method:'background-and-card-shape',alternatives:edge?[edge,...(edge.alternatives||[])]:[]};}
    }
    return edge||contrast;
  }
  function detectOuterContrast({data,width:w,height:h}) {
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
      if(tail<w*h*0.12||tail>w*h*.995||!validQuad(q,w,h)||tail/qa<0.72)continue;
      const distance=(a,b)=>Math.hypot(q[a].x-q[b].x,q[a].y-q[b].y),ratio=(distance(0,1)+distance(2,3))/(distance(0,3)+distance(1,2)),shapeError=Math.min(Math.abs(Math.log(ratio/(63/88))),Math.abs(Math.log(ratio/(88/63))));
      if(touches>4&&(tail<w*h*.84||shapeError>.1))continue;
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

