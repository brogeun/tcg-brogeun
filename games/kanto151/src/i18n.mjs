let locale='ko-KR',messages={},entities={},literals={},patterns=[],exact=new Map(),reverseLiterals=new Map();
const origins=new WeakMap(),supplemental={};
const language=()=>locale==='en-US'?'en':'ko';
export function configureLocale(data,selected='ko-KR'){messages={...data.messages,...supplemental};entities=data.entities;literals=data.literals||{};reverseLiterals=new Map(Object.entries(literals).map(([en,ko])=>[ko,en]));patterns=[];for(const [key,entry] of Object.entries(messages)){if(!entry.en.includes('{'))continue;const names=[];const escaped=entry.en.replace(/[.*+?^$()|[\]\\]/g,'\\$&').replace(/\{(\w+)\}/g,(_,name)=>{names.push(name);return '(.+?)';});patterns.push({key,names,re:new RegExp('^'+escaped+'$')});}exact=new Map(Object.entries(messages).flatMap(([k,v])=>[[v.en,k],[v.ko,k]]));setLocale(selected);}
export function setLocale(value){locale=value==='en-US'?'en-US':'ko-KR';if(globalThis.document){document.documentElement.lang=locale;document.title=t('app.title');}}
export const currentLocale=()=>locale;
export function t(key,values={}){const entry=messages[key];const text=entry?.[language()]??entry?.en??key;return text.replace(/\{(\w+)\}/g,(_,name)=>String(values[name]??''));}
export function addMessages(more){Object.assign(messages,more);Object.assign(supplemental,more);for(const [key,v] of Object.entries(more)){exact.set(v.en,key);exact.set(v.ko,key);}}
export function entity(group,id,fallback=id){return entities[group]?.[id]?.[language()]??String(fallback);}
// Legacy templates are resolved through the same catalog keys. New UI uses t()
// directly; this adapter keeps existing credit/import/export templates intact.
export function tx(value){const text=String(value??'');const normalized=text.trim().replace(/\s+/g,' ');if(!normalized)return text;if(locale==='en-US'){const key=exact.get(normalized);if(key)return text.replace(text.trim(),t(key));const old=reverseLiterals.get(normalized);return old?text.replace(text.trim(),old):text;}
 if(exact.has(normalized))return text.replace(text.trim(),t(exact.get(normalized)));
 if(literals[normalized])return text.replace(text.trim(),literals[normalized]);
 for(const p of patterns){const match=normalized.match(p.re);if(match)return t(p.key,Object.fromEntries(p.names.map((name,i)=>[name,match[i+1]])));}
 return text;
}
export function localizeDOM(root=document.body){if(!root)return;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;while((node=walker.nextNode())){if(['SCRIPT','STYLE','CODE','PRE'].includes(node.parentElement?.tagName))continue;const old=origins.get(node),source=old&&node.nodeValue===old.rendered?old.source:node.nodeValue;const rendered=tx(source);if(rendered!==node.nodeValue)node.nodeValue=rendered;origins.set(node,{source,rendered});}for(const el of root.querySelectorAll('[aria-label],[title],[placeholder]'))for(const attr of ['aria-label','title','placeholder'])if(el.hasAttribute(attr)){const key='i18n-'+attr,source=el.getAttribute('data-'+key)||el.getAttribute(attr);el.setAttribute('data-'+key,source);el.setAttribute(attr,tx(source));}}
export function localizeData(data){for(const s of data.species){const localized=data.speciesLocalized[s.id];for(const field of ['name','genus','habitatHint','description']){const fallback=s[field];if(field==='name')s.englishName=fallback;Object.defineProperty(s,field,{configurable:true,enumerable:true,get:()=>localized?.[field]?.[language()]??(field==='name'?entity('species',s.id,fallback):fallback)});}}
 for(const m of data.moves){for(const field of ['description','effectDescription']){const old=m[field];Object.defineProperty(m,field,{configurable:true,enumerable:true,get:()=>data.movesLocalized?.[m.id]?.[field]?.[language()]??old});}const fallback=m.name;m.englishName=fallback;Object.defineProperty(m,'name',{configurable:true,enumerable:true,get:()=>entity('moves',m.id,fallback)});}
 for(const b of data.biomes)for(const field of ['name','description']){const fallback=b[field];Object.defineProperty(b,field,{configurable:true,enumerable:true,get:()=>data.regionsLocalized[b.id]?.[field]?.[language()]??fallback});}
}

export function niceLocal(value){for(const group of ['items','statuses','weather','themes','quests','types','methods','stats'])if(entities[group]?.[value])return entity(group,value);return tx(String(value??'').replace(/-/g,' ').replace(/\b\w/g,c=>c.toUpperCase()));}
