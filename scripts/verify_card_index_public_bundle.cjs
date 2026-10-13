/* Stop a full-site deployment if it would remove the approved home card index. */
'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const {createHash,webcrypto}=require('node:crypto');
const sha=raw=>createHash('sha256').update(raw).digest('hex');
const required=['index.html','assets/market-price-index.js','assets/market-price-index.css',
 'data/market-price-index.json','data/market-price-index-validation.json','data/market-price-index-independent-verification.json'];

function htmlTags(html){
 // Ignore comments and inline script/style text: a JS string containing a mount is not a DOM mount.
 const stripped=html.replace(/<!--[\s\S]*?-->/g,'').replace(/<(script|style)\b((?:[^"'>]|"[^"]*"|'[^']*')*)>[\s\S]*?<\/\1\s*>/gi,(_,name,attrs)=>'<'+name+attrs+'>');
 return [...stripped.matchAll(/<([a-z][a-z0-9:-]*)\b((?:[^"'>]|"[^"]*"|'[^']*')*)>/gi)].map(match=>{
  const attrs={};
  for(const item of match[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g))attrs[item[1].toLowerCase()]=item[2]??item[3]??item[4]??'';
  return {name:match[1].toLowerCase(),attrs};
 });
}

function localReference(ref,expected){
 if(typeof ref!=='string')return false;
 const url=new URL(ref.replace(/&amp;/g,'&'),'https://card-index-bundle.invalid/index.html');
 return url.origin==='https://card-index-bundle.invalid'&&url.pathname===expected;
}

function functionFiles(directory){
 const files=[];
 const visit=relative=>{
  for(const item of fs.readdirSync(path.join(directory,relative),{withFileTypes:true})){
   assert.ok(!item.isSymbolicLink(),'Function source must not include symbolic links: '+item.name);
   const name=path.join(relative,item.name);
   if(item.isDirectory())visit(name);else if(item.isFile()&&name.endsWith('.js'))files.push(name.replace(/\\/g,'/'));
  }
 };
 visit('');return files.sort();
}

function verifyFunctions(bundleRoot,sourceDirectory){
 const source=path.resolve(sourceDirectory),target=path.join(bundleRoot,'functions');
 assert.ok(fs.existsSync(source)&&fs.statSync(source).isDirectory(),'Function source directory missing');
 assert.ok(fs.existsSync(target)&&fs.statSync(target).isDirectory(),'Bundled function directory missing');
 const expected=functionFiles(source),actual=functionFiles(target);
 assert.ok(expected.length,'Function source directory has no JavaScript files');
 for(const name of expected){
  assert.ok(actual.includes(name),'Required function file missing from deployment: '+name);
  assert.equal(sha(fs.readFileSync(path.join(target,name))),sha(fs.readFileSync(path.join(source,name))),'Bundled function differs from source: '+name);
 }
 assert.deepEqual(actual,expected,'Deployment must contain exactly the source function JavaScript files');
 return {sourceDirectory:source,requiredJavaScriptFiles:expected.length,allFunctionFilesAndHelpersPreserved:true};
}

async function verifyPublicBundle(bundleDirectory,options={}){
 const root=path.resolve(bundleDirectory),files={};
 for(const name of required){
  const filename=path.join(root,name);
  assert.ok(fs.existsSync(filename)&&fs.statSync(filename).isFile(),'Required card index file missing: '+name);
  files[name]=fs.readFileSync(filename);assert.ok(files[name].length,'Required card index file is empty: '+name);
 }
 const tags=htmlTags(files['index.html'].toString('utf8'));
 const mounts=tags.filter(tag=>tag.attrs.id==='marketFlowRoot');
 assert.equal(mounts.length,1,'Home must contain exactly one marketFlowRoot mount');
 assert.ok(!Object.hasOwn(mounts[0].attrs,'hidden')&&mounts[0].attrs['aria-hidden']!=='true'&&!/(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(mounts[0].attrs.style||''),'Home card index mount must not be hidden');
 for(const [kind,attribute,asset]of [['script','src','/assets/market-price-index.js'],['link','href','/assets/market-price-index.css']]){
  const references=tags.filter(tag=>tag.name===kind&&localReference(tag.attrs[attribute],asset));
  assert.equal(references.length,1,'Home must reference exactly one local '+asset);
  if(kind==='link')assert.ok((references[0].attrs.rel||'').toLowerCase().split(/\s+/).includes('stylesheet'),'Card index CSS must be a stylesheet');
 }
 const source=files['assets/market-price-index.js'].toString('utf8');
 assert.ok(!/^\s*(?:<!doctype\s+html\b|<html\b)/i.test(source),'Card index JavaScript is an HTML fallback');
 new vm.Script(source,{filename:'assets/market-price-index.js'});
 assert.match(source,/window\.TCGMarketPriceIndex\s*=/,'Card index public API is missing');
 assert.match(source,/<details\s+class=["']mpi-extra-details["']\s*>/,'Card index details must be initially closed');
 assert.ok(!/<details\b[^>]*class=["']mpi-extra-details["'][^>]*\bopen\b/i.test(source),'Card index details must not open by default');
 assert.match(source,/extra\.querySelector\(\s*['"]summary['"]\s*\)\.after\(\s*root\.querySelector\(\s*['"]\.mpi-selected-view['"]\s*\)\s*\)/,'Selected date panel must remain inside the existing details disclosure');

 const payloads={};
 for(const name of required.filter(name=>name.endsWith('.json'))){
  try{payloads[name]=JSON.parse(files[name].toString('utf8'));}catch{throw new Error('Card index JSON is invalid: '+name);}
 }
 // Execute the deployed UI's own validators instead of maintaining a weaker, drifting copy.
 // Only the validator function declarations are evaluated; the app, DOM and fetch are never run.
 const start=/\bfunction\s+validatePriceEvidence\s*\(/.exec(source),end=/\basync\s+function\s+load\s*\(/.exec(source);
 assert.ok(start&&end&&start.index<end.index,'Card index data validation functions are missing');
 const validators=source.slice(start.index,end.index);
 const context=vm.createContext({
  data:payloads['data/market-price-index.json'],validation:payloads['data/market-price-index-validation.json'],
  proofPayload:{value:payloads['data/market-price-index-independent-verification.json'],bytes:files['data/market-price-index-independent-verification.json']},
  indexBytes:files['data/market-price-index.json'],crypto:webcrypto,window:{crypto:webcrypto},
 });
 new vm.Script(`
  const BRANDS={pokemon:'포켓몬',onepiece:'원피스'};
  const finite=value=>typeof value==='number'&&Number.isFinite(value),positive=value=>finite(value)&&value>0;
  const validDate=value=>typeof value==='string'&&/^\\d{4}-\\d{2}-\\d{2}$/.test(value)&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
  const offset=(value,days)=>new Date(Date.parse(value+'T00:00:00Z')+days*86400000).toISOString().slice(0,10);
  ${validators}
 `,{filename:'card-index-deployed-validators.cjs'}).runInContext(context,{timeout:10000});
 assert.equal(new vm.Script('validateData(data)').runInContext(context,{timeout:10000}),true,'Card index data is rejected by the deployed UI validator');
 const reason=await new vm.Script('validateReport(validation,indexBytes,proofPayload)').runInContext(context,{timeout:10000});
 assert.equal(reason,'','Card index verification is rejected by the deployed UI validator: '+reason);
 const functions=options.functionsSourceDirectory?verifyFunctions(root,options.functionsSourceDirectory):null;
 return {ok:true,bundleDirectory:root,homeMounts:mounts.length,approvedDisplayStructurePreserved:true,
  deployedUiValidatorsPassed:true,sourceAsOf:context.data.sourceAsOf,
  ...(functions?{functions}:{}),
  sha256:Object.fromEntries(required.map(name=>[name,sha(files[name])]))};
}

module.exports={verifyPublicBundle};
if(require.main===module){
 const args=process.argv.slice(2),options={};let valid=args.length>0&&args.length%2===0;
 for(let index=0;index<args.length;index+=2){
  const key=args[index];if(!['--bundle-dir','--functions-source-dir'].includes(key)||Object.hasOwn(options,key)||!args[index+1])valid=false;
  options[key]=args[index+1];
 }
 if(!valid||!options['--bundle-dir']){
  console.error('Usage: node scripts/verify_card_index_public_bundle.cjs --bundle-dir <deployment-directory> [--functions-source-dir <original-functions-directory>]');process.exitCode=1;
 }else verifyPublicBundle(options['--bundle-dir'],{functionsSourceDirectory:options['--functions-source-dir']}).then(report=>console.log(JSON.stringify(report,null,2))).catch(error=>{
  console.error('Card index deployment blocked: '+error.message);process.exitCode=1;
 });
}
