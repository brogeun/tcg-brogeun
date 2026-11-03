// The title needs local metadata, not a rendered field or an account response.
// AccountSaveUI protects against a late cloud response replacing a new session.
export async function readStartupData(base,names,{fetcher=globalThis.fetch,timeoutMs=15000}={}){
 const controller=new AbortController();let timer;
 const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{
  reject(new Error('탐험 데이터 응답 시간이 초과되었습니다. 연결을 확인하고 다시 불러와 주세요.'));
  controller.abort();
 },timeoutMs);});
 try{
  return await Promise.race([Promise.all(names.map(async name=>{
   const response=await fetcher(new URL(`../data/${name}.json`,base),{signal:controller.signal});
   if(!response.ok)throw new Error(`Could not load ${name}: HTTP ${response.status}`);
   return response.json();
  })),deadline]);
 }finally{clearTimeout(timer);controller.abort();}
}

export async function startRuntime(game,ui,account){
 if(account)void account.init().catch(error=>console.error(error));
 await game.intro();
 ui.ready();
}

// Fetch independent scenery in bounded groups; scene placement remains ordered.
export async function preloadScenery(world,batches,concurrency=6,onProgress=()=>{}){
 const paths=[...new Set([...batches].map(batch=>batch.path))];
 let completed=0;
 for(let i=0;i<paths.length;i+=concurrency){
  await Promise.all(paths.slice(i,i+concurrency).map(async path=>{await world.template(path);onProgress(++completed/paths.length);}));
 }
}
