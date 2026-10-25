/** Read JPEG frame dimensions before sending paid image inputs. This is not a pixel decoder. */
const MAX_BASE64_LENGTH=8*1024*1024;
const fail=reason=>{throw new Error('Invalid JPEG: '+reason);};

export function inspectJpeg(value){
  if(typeof value!=='string'||value.length<8||value.length>MAX_BASE64_LENGTH||value.length%4===1||!/^[A-Za-z0-9+/]+={0,2}$/.test(value)||(value.includes('=')&&value.length%4!==0))fail('base64');
  let bytes;try{bytes=atob(value);}catch{fail('base64');}
  const size=bytes.length,at=index=>bytes.charCodeAt(index),word=index=>(at(index)<<8)|at(index+1);
  if(size<4||at(0)!==0xff||at(1)!==0xd8)fail('start marker');
  let position=2,frame=null,scans=0,segments=0,restartInterval=0;
  const scanned=new Set(),quantization=new Set(),huffman=new Set();
  while(position<size){
    if(++segments>4096)fail('too many segments');
    if(at(position++)!==0xff)fail('marker');
    while(position<size&&at(position)===0xff)position++;
    if(position>=size)fail('truncated marker');
    const marker=at(position++);
    if(marker===0xd9){
      if(!frame||!scans||position!==size||[...frame.components].some(id=>!scanned.has(id)))fail('end marker');
      return {width:frame.width,height:frame.height,patches:Math.ceil(frame.width/32)*Math.ceil(frame.height/32)};
    }
    if(marker===0x00||marker===0xd8||(marker>=0xd0&&marker<=0xd7)||marker===0x01)fail('unexpected standalone marker');
    if(position+2>size)fail('truncated segment length');
    const length=word(position),start=position+2,end=position+length;
    if(length<2||end>size)fail('truncated segment');
    if([0xc0,0xc1,0xc2].includes(marker)){
      if(frame||length<11||at(start)!==8)fail('frame');
      const height=word(start+1),width=word(start+3),count=at(start+5),components=new Set(),componentTables=new Map();
      if(!width||!height||count<1||count>4||length!==8+3*count)fail('frame dimensions or components');
      let blocks=0;
      for(let index=0;index<count;index++){
        const offset=start+6+3*index,id=at(offset),sampling=at(offset+1),horizontal=sampling>>4,vertical=sampling&15;
        if(components.has(id)||horizontal<1||horizontal>4||vertical<1||vertical>4||at(offset+2)>3)fail('frame component');
        components.add(id);componentTables.set(id,at(offset+2));blocks+=horizontal*vertical;
      }
      if(blocks>10)fail('frame sampling');
      frame={width,height,components,componentTables,progressive:marker===0xc2};
    }else if(marker===0xda){
      if(!frame||length<8)fail('scan before frame');
      const count=at(start),ids=new Set(),scanTables=[];
      if(count<1||count>frame.components.size||length!==6+2*count)fail('scan components');
      for(let index=0;index<count;index++){
        const offset=start+1+2*index,id=at(offset),tables=at(offset+1);
        if(!frame.components.has(id)||ids.has(id)||(tables>>4)>3||(tables&15)>3)fail('scan component');
        ids.add(id);scanned.add(id);scanTables.push(tables);
      }
      const spectralStart=at(start+1+2*count),spectralEnd=at(start+2+2*count),successive=at(start+3+2*count);
      if(frame.progressive){
        if(spectralStart>spectralEnd||spectralEnd>63||(spectralStart===0&&spectralEnd!==0)||(spectralStart>0&&count!==1)||(successive>>4)>13||(successive&15)>13||((successive>>4)!==0&&(successive>>4)!==(successive&15)+1))fail('progressive scan');
      }else if(spectralStart!==0||spectralEnd!==63||successive!==0)fail('sequential scan');
      if([...ids].some(id=>!quantization.has(frame.componentTables.get(id)))||scanTables.some(tables=>(!frame.progressive||spectralStart===0)&&!huffman.has(tables>>4)||(!frame.progressive||spectralStart>0)&&!huffman.has(0x10|(tables&15))))fail('missing coding table');
      scans++;position=end;
      let entropy=false,ended=false;
      while(position<size){
        if(at(position)!==0xff){entropy=true;position++;continue;}
        const markerStart=position++;
        while(position<size&&at(position)===0xff)position++;
        if(position>=size)fail('truncated scan marker');
        const code=at(position++);
        if(code===0x00){entropy=true;continue;}
        if(code>=0xd0&&code<=0xd7){if(!restartInterval)fail('restart without interval');continue;}
        position=markerStart;ended=true;break;
      }
      if(!entropy||!ended)fail('truncated scan');
      continue;
    }else if(marker===0xdb){
      if(start===end)fail('empty quantization table');
      let cursor=start;
      while(cursor<end){
        const table=at(cursor++),precision=table>>4;if(precision>1||(table&15)>3)fail('quantization table');
        if(cursor+64*(precision+1)>end)fail('truncated quantization table');
        for(let index=0;index<64;index++){if(!(precision?word(cursor):at(cursor)))fail('zero quantization value');cursor+=precision+1;}
        quantization.add(table&15);
      }
    }else if(marker===0xc4){
      if(start===end)fail('empty Huffman table');
      let cursor=start;
      while(cursor<end){
        const table=at(cursor++);if((table>>4)>1||(table&15)>3||cursor+16>end)fail('Huffman table');
        let symbols=0,slots=1;for(let index=0;index<16;index++){const count=at(cursor++);symbols+=count;slots=2*slots-count;if(slots<=0)fail('oversubscribed Huffman table');}
        if(!symbols||symbols>256||cursor+symbols>end)fail('Huffman symbols');cursor+=symbols;huffman.add(table);
      }
    }else if(marker===0xdd){
      if(length!==4)fail('restart interval');restartInterval=word(start);
    }else if(!((marker>=0xe0&&marker<=0xef)||marker===0xfe))fail('unsupported marker');
    position=end;
  }
  fail('missing end marker');
}
