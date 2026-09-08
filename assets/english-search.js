/* IDs are scoped to a set and language; TCG Collector IDs are never SNKRDUNK IDs. */
(() => {
  let ready;
  const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  function decode(data) {
    if (data.schemaVersion !== 1 || !Array.isArray(data.sets) || !Array.isArray(data.images)) throw Error('Invalid English search index');
    return data.sets.flatMap(set => {
      const shared = {language:'en', setCode:set.code, setName:set.name};
      const box = {...shared, id:set.code, kind:'box', name:set.name, displayName:set.name, thumbnailUrl:set.image};
      const cards = set.cards.map(([id,name,ko,number,sheet,col,row]) => ({
        ...shared, id:set.code+':'+id, sourceId:id, kind:'card', name, displayName:ko||name, number,
        image:data.images[sheet], sprite:{col,row,cols:5,rows:4,width:320,height:448}
      }));
      return [box,...cards].map(c => ({...c, searchText:normalize([c.name,c.displayName,c.number,c.sourceId,set.name,set.code,set.displayCode].join(' '))}));
    });
  }
  function ensureData() {
    if (!ready) ready=fetch('/data/english-search.json?v=20260908-search1').then(r=>{if(!r.ok)throw Error('Search unavailable');return r.json()}).then(decode).catch(e=>{ready=null;throw e});
    return ready;
  }
  function search(rows, query, kind) {
    const words=String(query).trim().split(/\s+/).map(normalize).filter(Boolean);
    return words.length ? rows.filter(c=>(kind==='all'||c.kind===kind)&&words.every(w=>c.searchText.includes(w))) : [];
  }
  function href(c) {
    const query=new URLSearchParams({set:c.setCode});
    if(c.kind==='card')query.set('card',c.sourceId);
    return '/?'+query+'#cardinfo';
  }
  window.EnglishSearch={ensureData,search,href,decode};
})();
