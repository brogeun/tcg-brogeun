// The title needs local metadata, not a rendered field or an account response.
// AccountSaveUI protects against a late cloud response replacing a new session.
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
