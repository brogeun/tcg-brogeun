/* Load feature code in its established order when a screen needs it. */
(() => {
  'use strict';
  const root = window;
  if (root.AppRouteLoader) return;
  const local = (file, version) => '/assets/' + file + '?v=' + version;
  const assets = {
    referencesStyle: {href:local('market-references.css','20261113-hubperf1')},
    references: {src:local('market-references.js','20261113-hubperf1'),ready:()=>typeof root.MarketReferences?.mountEnglishCard==='function'},
    portfolioStyle: {href:local('portfolio-screen.css','20261113-hubperf1')},
    portfolio: {src:local('portfolio-screen.js','20261113-hubperf1'),ready:()=>typeof root.PortfolioScreen?.holdings==='function'&&typeof root.PortfolioScreen?.status==='function'&&!!document.getElementById('pfxStatus')},
    centeringStyle: {href:local('centering-tool.css','20261025-grade-range-v1')},
    geometry: {src:local('centering-geometry.js','20261108-card-boundary1'),ready:()=>!!root.CenteringGeometry},
    resultCache: {src:local('centering-result-cache.js','20261025-grade-range-v1'),ready:()=>!!root.CenteringResultCache},
    centering: {src:local('centering-tool.js','20261108-card-boundary1'),ready:()=>typeof root.CenteringTool?.setup==='function'},
    adminStyle: {href:local('admin-editor.css','20260907-admin2')},
    quillStyle: {href:'https://cdn.jsdelivr.net/npm/quill@2.0.2/dist/quill.snow.css'},
    sortable: {src:'https://cdn.jsdelivr.net/npm/sortablejs@1.15.6/Sortable.min.js',ready:()=>typeof root.Sortable?.create==='function'},
    admin: {src:local('admin-editor.js','20260907-admin2'),ready:()=>typeof root.AdminEditorUI?.enter==='function'},
    englishStyle: {href:local('english-catalog.css','20261104-vintage-sets2')},
    chineseStyle: {href:local('chinese-catalog.css','20261012-cn-release1')},
    riftboundStyle: {href:local('riftbound-catalog.css','20260909-rb1')},
    chiikawaStyle: {href:local('chiikawa-catalog.css','38b07b90dbdf')},
    cardinfoStyle: {href:local('tcg-card-info.css','20261112-roster-size1')},
    collectionsStyle: {href:local('collections.css','20261030-collections1')},
    koreanStyle: {href:local('korean-promos.css','20261101-responsive-image1')},
    chinese: {src:local('chinese-catalog.js','20261112-roster-size1'),ready:()=>!!root.ChineseCatalog},
    english: {src:local('english-catalog.js','20261113-hubperf-r1'),ready:()=>typeof root.EnglishCatalog?.ensureData==='function'},
    englishSearch: {src:local('english-search.js','20260908-search1'),ready:()=>!!root.EnglishSearch},
    riftbound: {src:local('riftbound-catalog.js','20261030-rarity1'),ready:()=>!!root.RiftboundCatalog},
    chiikawa: {src:local('chiikawa-catalog.js','20261112-menu1'),ready:()=>!!root.ChiikawaCatalog},
    aliases: {src:local('tcg-search-aliases.js','20261101-ko1'),ready:()=>!!root.TCGSearchAliases},
    cardinfo: {src:local('tcg-card-info.js','20261112-roster-size1'),ready:()=>!!root.TCGCardInfo},
    codec: {src:local('collection-catalog-codec.js','20261030-collections1'),ready:()=>!!root.CollectionCatalogCodec},
    collections: {src:local('collections.js','20261112-menu1'),ready:()=>!!root.TCGCollections},
    korean: {src:local('korean-promos.js','20261106-partial1'),ready:()=>!!root.KoreanPromos},
  };
  const profiles = {
    portfolio: {styles:['portfolioStyle'],scripts:['portfolio']},
    centering: {styles:['centeringStyle'],scripts:['geometry','resultCache','centering']},
    admin: {styles:['adminStyle','quillStyle'],scripts:['admin'],background:['sortable']},
    cardinfo: {
      lookahead:2,
      styles:['referencesStyle','englishStyle','chineseStyle','riftboundStyle','chiikawaStyle','cardinfoStyle','collectionsStyle','koreanStyle'],
      // These adapters wrap shared functions, so their existing order is significant.
      scripts:['references','chinese','english','riftbound','chiikawa','aliases','cardinfo','codec','collections','korean'],
    },
    'search-en': {styles:['referencesStyle','englishStyle','chineseStyle'],scripts:['references','chinese','english','englishSearch']},
    'search-zh': {styles:['chineseStyle'],scripts:['chinese']},
  };
  const requests = new Map(), profileRequests = new Map(), preloads = new Map();
  function failure(message, code, requiresReload=false) {
    const error=new Error(message);error.code=code;error.requiresReload=requiresReload;return error;
  }
  function existing(descriptor) {
    const selector=descriptor.src?'script[src]':'link[rel="stylesheet"]',attribute=descriptor.src?'src':'href';
    const expected=new URL(descriptor[attribute],location.href).href;
    return [...document.querySelectorAll(selector)].find(node=>{
      try{return new URL(node.getAttribute(attribute),location.href).href===expected;}catch{return false;}
    });
  }
  function loadAsset(key) {
    if(requests.has(key))return requests.get(key);
    const descriptor=assets[key];
    if(descriptor.ready?.())return Promise.resolve();
    let node=existing(descriptor);
    if(descriptor.href&&node?.sheet)return Promise.resolve();
    let pending;
    pending=new Promise((resolve,reject)=>{
      const created=!node;
      if(!node){
        node=document.createElement(descriptor.src?'script':'link');
        if(descriptor.src){node.src=descriptor.src;node.async=false;}
        else{node.rel='stylesheet';node.href=descriptor.href;node.media='all';}
        node.dataset.appRouteAsset=key;
      }
      const cleanup=()=>{node.removeEventListener('load',loaded);node.removeEventListener('error',failed);};
      const loaded=()=>{
        cleanup();clearPreload(key);
        if(descriptor.ready&&!descriptor.ready()){
          // An executed but incomplete adapter must not be evaluated a second time.
          reject(failure('화면을 준비하지 못했습니다. 앱을 다시 열어 주세요.','FEATURE_INIT',true));
        }else resolve();
      };
      const failed=()=>{
        cleanup();clearPreload(key);node.remove();
        if(requests.get(key)===pending)requests.delete(key);
        reject(failure('화면을 불러오지 못했습니다. 다시 시도해 주세요.','FEATURE_NETWORK'));
      };
      node.addEventListener('load',loaded,{once:true});node.addEventListener('error',failed,{once:true});
      if(created)document.head.appendChild(node);
    });
    requests.set(key,pending);
    return pending;
  }
  function clearPreload(key) {
    const node=preloads.get(key);
    if(node){node.remove();preloads.delete(key);}
  }
  function preloadScript(key) {
    const descriptor=assets[key];
    if(!descriptor?.src||requests.has(key)||preloads.has(key)||descriptor.ready?.())return;
    // Older WebViews retain the normal ordered loader. Hints never execute code.
    const node=document.createElement('link');
    if(!node.relList?.supports?.('preload'))return;
    node.rel='preload';node.as='script';node.href=descriptor.src;node.dataset.appRoutePreload=key;
    node.addEventListener('error',()=>{if(preloads.get(key)===node)clearPreload(key);},{once:true});
    preloads.set(key,node);document.head.appendChild(node);
  }
  function demanded(job) {
    return [...job.callers].some(caller=>caller.active&&caller.current());
  }
  function preloadNext(spec,job,start) {
    if(!spec.lookahead||!demanded(job))return;
    for(const key of spec.scripts.slice(start,start+spec.lookahead))preloadScript(key);
  }
  async function loadProfile(profile,job) {
    const spec=profiles[profile];
    if(!spec)return true;
    if(!demanded(job))return false;
    // Insert styles together in their declared cascade order before route rendering.
    preloadNext(spec,job,0);
    await Promise.all(spec.styles.map(loadAsset));
    for(const [index,key] of spec.scripts.entries()){
      if(!demanded(job))return false;
      preloadNext(spec,job,index+1);
      await loadAsset(key);
    }
    return true;
  }
  function loadBackground(profile) {
    for(const key of profiles[profile]?.background||[])void loadAsset(key).then(()=>{
      if(key==='sortable'&&document.body?.dataset?.page==='admin'&&typeof _initAdminSortable==='function')_initAdminSortable();
    }).catch(()=>{});
  }
  function budget(work, milliseconds) {
    let timer;
    const timeout=new Promise((resolve,reject)=>{
      timer=setTimeout(()=>reject(failure('화면을 불러오는 데 시간이 걸리고 있습니다. 다시 시도해 주세요.','FEATURE_TIMEOUT')),milliseconds);
    });
    return Promise.race([work,timeout]).finally(()=>clearTimeout(timer));
  }
  async function ensure(profile, options={}) {
    const current=()=>typeof options.isCurrent!=='function'||options.isCurrent();
    const cancelled=()=>({ready:false,cancelled:true,profile});
    if(!current())return cancelled();
    let job=profileRequests.get(profile);
    if(!job){job={callers:new Set(),pending:null};profileRequests.set(profile,job);}
    const caller={current,active:true};job.callers.add(caller);
    if(!job.pending){
      job.pending=loadProfile(profile,job).then(complete=>{
        if(!complete&&profileRequests.get(profile)===job)profileRequests.delete(profile);
        return complete;
      }).catch(error=>{
        if(profileRequests.get(profile)===job)profileRequests.delete(profile);
        throw error;
      });
    }
    const milliseconds=Number.isFinite(options.timeoutMs)&&options.timeoutMs>0?Math.min(options.timeoutMs,60000):25000;
    try{
      let complete;
      try{complete=await budget(job.pending,milliseconds);}catch(error){if(!current())return cancelled();throw error;}
      if(!current())return cancelled();
      // A new visit can arrive just as the previous unneeded chain pauses.
      if(!complete)return ensure(profile,options);
      loadBackground(profile);
      if(typeof options.activate==='function')await options.activate();
      return current()?{ready:true,cancelled:false,profile}:cancelled();
    }finally{caller.active=false;job.callers.delete(caller);}
  }
  const manifest=Object.freeze(Object.fromEntries(Object.entries(profiles).map(([name,spec])=>[name,Object.freeze({
    styles:Object.freeze(spec.styles.map(key=>assets[key].href)),
    scripts:Object.freeze(spec.scripts.map(key=>assets[key].src)),
    background:Object.freeze((spec.background||[]).map(key=>assets[key].src)),
  })])));
  root.AppRouteLoader=Object.freeze({ensure,manifest,ensureSearch(language,options){
    return ensure(language==='en'?'search-en':language==='zh-CN'||language==='zh'?'search-zh':'home',options);
  }});
})();
