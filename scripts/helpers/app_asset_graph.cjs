'use strict';
// Read the production loader itself, rather than duplicating its feature lists
// in regression tests. This module never calls ensure() or performs I/O at run time.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function assetGraph(base,{html=fs.readFileSync(path.join(base,'index.html'),'utf8')}={}){
  const origin='https://tcghub.kr';
  const pathname=value=>{
    const url=new URL(value,origin);
    return url.origin===origin?url.pathname:url.href;
  };
  const scriptTags=[...html.matchAll(/<script\b[^>]*\bsrc\s*=\s*(["'])([^"']+)\1[^>]*>/gi)];
  const scripts=scriptTags.map(match=>pathname(match[2]));
  const styles=[...html.matchAll(/<link\b[^>]*>/gi)].filter(match=>/\brel\s*=\s*(["'])stylesheet\1/i.test(match[0])).map(match=>{
    const href=match[0].match(/\bhref\s*=\s*(["'])([^"']+)\1/i);assert(href,'Stylesheet has an href');return pathname(href[2]);
  });
  const loader='/assets/app-route-loader.js',tag=scriptTags.find(match=>pathname(match[2])===loader);
  assert(tag,'Feature loader is linked by the core bootstrap');
  assert.equal(scripts.filter(value=>value===loader).length,1,'Core bootstrap loads one feature loader');
  assert(!/\b(?:async|defer)\b/i.test(tag[0]),'Route loader is ready before inline navigation calls');
  const navigation=html.lastIndexOf('go(initialPage)');
  assert(navigation>=0&&tag.index<navigation,'Core loader precedes the initial route activation');
  assert(html.includes('AppRouteLoader.ensure('),'App routes use the linked loader');
  const context={window:{},URL,location:{href:origin+'/#home'},document:{readyState:'complete',
    addEventListener(){throw Error('Reading the feature manifest must not install page listeners');},
    querySelectorAll(){throw Error('Reading the feature manifest must not scan the page');},
  }};
  vm.runInNewContext(fs.readFileSync(path.join(base,'assets/app-route-loader.js'),'utf8'),context,{filename:'app-route-loader.js'});
  assert.equal(typeof context.window.AppRouteLoader?.ensure,'function');
  const manifest=JSON.parse(JSON.stringify(context.window.AppRouteLoader.manifest));
  const asset=value=>value.startsWith('/')?value:'/assets/'+value;
  function profile(name){assert(manifest[name],'Declared feature profile '+name);return manifest[name];}
  function paths(name,kind){return profile(name)[kind].map(pathname);}
  function checkFile(name){if(name.startsWith('/'))assert(fs.statSync(path.join(base,name.slice(1))).size>0,'Asset exists: '+name);}
  function position(name,values){
    name=asset(name);const index=values.indexOf(name);assert(index>=0,'Linked asset '+name);
    assert.equal(values.filter(value=>value===name).length,1,'Asset runs once in this route: '+name);checkFile(name);return index;
  }
  function assertScript(name,feature){return position(name,feature?[...scripts,...paths(feature,'scripts')]:scripts);}
  function assertStyle(name,feature){return position(name,feature?[...styles,...paths(feature,'styles')]:styles);}
  function assertOrder(before,after,feature){
    const values=feature?[...scripts,...paths(feature,'scripts')]:scripts;
    assert(position(before,values)<position(after,values),'Dependency order: '+before+' before '+after+(feature?' in '+feature:''));
  }
  return {manifest,scripts,styles,assertScript,assertStyle,assertOrder};
}
module.exports={assetGraph};
