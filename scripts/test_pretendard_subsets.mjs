import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';

const css=readFileSync(new URL('../assets/fonts/pretendard-subset.css',import.meta.url),'utf8');
const index=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source='https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.css';
const faces=[...css.matchAll(/@font-face\s*\{([^}]+)\}/g)].map(match=>match[1]);
const urls=faces.map(face=>face.match(/src:\s*url\(([^)]+)\)/)?.[1]);
const online=process.env.TCGHUB_FONT_NETWORK_CHECK==='1';
const curl=url=>execFileSync('curl',['-fsSL','--max-time','25',url],{maxBuffer:2_000_000});

test('Pretendard keeps its existing family and all weights with 92 unicode-ranged pinned faces',()=>{
 assert.equal(faces.length,92);assert.equal(new Set(urls).size,92);
 for(const [i,face] of faces.entries()){
  assert.match(face,/font-family:\s*'Pretendard';/);
  assert.match(face,/font-weight:\s*45 920;/);
  assert.match(face,/font-style:\s*normal;/);assert.match(face,/font-display:\s*swap;/);
  const range=face.match(/unicode-range:\s*([^;]+);/)[1];
  for(const token of range.split(/,\s*/))assert.match(token,/^U\+[0-9a-f]+(?:-[0-9a-f]+)?$/i);
  assert.equal(urls[i],`https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/packages/pretendard/dist/web/variable/woff2-dynamic-subset/PretendardVariable.subset.${i}.woff2`);
 }
 assert.match(css,/Copyright \(c\) 2021 Kil Hyung-jin/);assert.match(css,/SIL Open Font License, Version 1\.1/);
 assert.ok(css.includes(source));
});

test('only the Pretendard static stylesheet changes; Noto and existing family stacks remain',()=>{
 assert.match(index,/<link href="\/assets\/fonts\/pretendard-subset\.css\?v=[^"]+" rel="stylesheet" media="print" onload="this\.media='all'">/);
 assert.match(index,/Noto\+Sans\+KR:wght@400;500;600;700;800&display=swap/);
 assert.doesNotMatch(index,/dist\/web\/static\/pretendard\.css/);
 assert.match(index,/font-family:\s*Pretendard, -apple-system/);
 assert.match(index,/font-family:\s*'Noto Sans KR'/);
});

test('live pinned CSS matches the local alias and URL rewrite exactly',{skip:!online},()=>{
 const upstream=curl(source).toString('utf8');
 const expected=upstream.replaceAll("font-family: 'Pretendard Variable';","font-family: 'Pretendard';").replace(/url\(([^)]+)\)/g,(_,url)=>'url('+new URL(url.replace(/^["']|["']$/g,''),source).href+')');
 assert.equal(css.slice(css.indexOf('/*\nCopyright')),expected);
});

test('live common Korean and Latin font samples are valid WOFF2 responses',{skip:!online},()=>{
 for(const i of [90,91]){
  const bytes=curl(urls[i]);assert.equal(bytes.subarray(0,4).toString(),'wOF2');
  assert.equal(bytes.readUInt32BE(8),bytes.length);assert.ok(bytes.length>1000&&bytes.length<300_000);
  console.log(`Pretendard subset ${i}: ${bytes.length} bytes, sha256 ${createHash('sha256').update(bytes).digest('hex')}`);
 }
});
