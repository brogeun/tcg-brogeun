const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const ctx={window:{},URLSearchParams,fetch(){throw Error('Unexpected eager fetch')}};
vm.createContext(ctx);vm.runInContext(fs.readFileSync(path.join(root,'assets/english-search.js'),'utf8'),ctx);
const api=ctx.window.EnglishSearch;
const data=JSON.parse(fs.readFileSync(path.join(root,'data/english-search.json'),'utf8'));
const rows=api.decode(data);
assert.equal(rows.filter(c=>c.kind==='card').length,26030);
assert.equal(rows.filter(c=>c.kind==='box').length,348);
assert.equal(new Set(rows.map(c=>c.id)).size,rows.length,'Reprints in different sets retain distinct identities');
assert(rows.every(c=>c.language==='en'));
const find=q=>api.search(rows,q,'card');
for(const q of ['메가 개굴닌자 116/086','Mega Greninja 116/086','CRI 116/086']){
  const matches=find(q);assert.equal(matches.length,1,q);
  assert.equal(matches[0].sourceId,'66079');
  assert.equal(api.href(matches[0]),'/?set=EN-TCG11803&card=66079#cardinfo');
}
assert.equal(api.search(rows,'Chaos Rising','box').length,1);
assert.equal(api.href(api.search(rows,'Chaos Rising','box')[0]),'/?set=EN-TCG11803#cardinfo');
assert.equal(api.search(rows,'','all').length,0);
assert.equal(api.search(rows,'존재하지않는카드','all').length,0);
// The compact sheet references must still identify the exact card image.
for(const set of data.sets){
  const original=JSON.parse(fs.readFileSync(path.join(root,'data/english-sets',set.code+'.json'),'utf8'));
  const decoded=rows.filter(c=>c.setCode===set.code&&c.kind==='card');
  original.cards.forEach((c,i)=>{assert.equal(decoded[i].image,c.image);assert.equal(decoded[i].sprite.col,c.sprite.col);assert.equal(decoded[i].sprite.row,c.sprite.row)});
}
console.log('PASS: 26,030 cards, 348 sets, Korean/English searches, kind filtering, unique IDs, correct detail routes and all thumbnails');
