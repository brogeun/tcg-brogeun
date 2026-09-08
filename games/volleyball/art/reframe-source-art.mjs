// Reframes existing repository vector paths; does not create or alter character artwork.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const destination = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(destination, '../../jigglypuff/sprites');

function boundsForPaths(paths) {
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  const add=(x,y)=>{minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);};
  for(const data of paths) {
    const tokens=data.match(/[MLQZmlqz]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g);
    let i=0,cmd='',x=0,y=0,startX=0,startY=0;
    while(i<tokens.length) {
      if(/^[A-Za-z]$/.test(tokens[i])) cmd=tokens[i++];
      if(cmd==='M'||cmd==='L') {
        x=Number(tokens[i++]); y=Number(tokens[i++]); add(x,y);
        if(cmd==='M'){startX=x;startY=y;cmd='L';}
      } else if(cmd==='Q') {
        const cx=Number(tokens[i++]),cy=Number(tokens[i++]),nx=Number(tokens[i++]),ny=Number(tokens[i++]);
        add(x,y);add(nx,ny);
        const tx=(x-cx)/(x-2*cx+nx),ty=(y-cy)/(y-2*cy+ny);
        for(const t of [tx,ty]) if(t>0&&t<1) add((1-t)**2*x+2*(1-t)*t*cx+t*t*nx,(1-t)**2*y+2*(1-t)*t*cy+t*t*ny);
        x=nx;y=ny;
      } else if(cmd==='Z'||cmd==='z') {x=startX;y=startY;add(x,y);cmd='';}
      else throw new Error(`Unsupported path command ${cmd}`);
    }
  }
  return {minX,minY,maxX,maxY,width:maxX-minX,height:maxY-minY};
}

const manifest=JSON.parse(fs.readFileSync(path.join(destination,'manifest.json'),'utf8'));
for(const character of ['pikachu','squirtle']) {
  const input=fs.readFileSync(path.join(source,`${character}.svg`),'utf8');
  const group=input.match(/<svg width="512" height="512" viewBox="[^"]+" preserveAspectRatio="none">([\s\S]*)<\/svg><\/g><\/svg>/)?.[1];
  if(!group) throw new Error(`Missing source group for ${character}`);
  const paths=[...group.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(match=>match[1]);
  if(!paths.length)throw new Error('No artwork paths');
  const b=boundsForPaths(paths),padding=4,viewW=b.width+padding*2,viewH=b.height+padding*2;
  const vb=`${b.minX-padding} ${b.minY-padding} ${viewW} ${viewH}`;
  const scale=512/Math.max(viewW,viewH);
  const crop=[Math.floor((512-b.width*scale)/2)-1,Math.floor((512-b.height*scale)/2)-1,Math.ceil(b.width*scale)+2,Math.ceil(b.height*scale)+2];
  const mirrored=character==='pikachu';
  const artwork=mirrored?`<g transform="translate(${b.minX+b.maxX} 0) scale(-1 1)">${group}</g>`:group;
  const output=`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="${vb}" preserveAspectRatio="xMidYMid meet"><title>${character} full-body ready artwork</title>${artwork}</svg>\n`;
  const file=`${character}-ready-v1.svg`;
  fs.writeFileSync(path.join(destination,file),output);
  const sourcePathList=paths.join('\n');
  const outputPathList=[...output.matchAll(/<path\b[^>]*\bd="([^"]+)"/g)].map(match=>match[1]).join('\n');
  if(sourcePathList!==outputPathList)throw new Error('Artwork path changed');
  manifest.characters[character]={file,width:512,height:512,alpha:true,poses:{idle:crop},source:`../../jigglypuff/sprites/${character}.svg`,sourceArtwork:'Pokémon Dream World artwork distributed by PokeAPI/sprites',sourcePathCount:paths.length,mirroredForRightFacing:mirrored,notes:'Existing vector path data is unchanged. Removed circular portrait crop/background and reframed full body. Only the ready pose is available; use the legacy PMD slide for sliding.'};
  console.log(JSON.stringify({character,file,paths:paths.length,sourceBounds:b,crop,verifiedUnchangedPathData:true}));
}
fs.writeFileSync(path.join(destination,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
