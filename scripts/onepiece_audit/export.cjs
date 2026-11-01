'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=path.resolve(__dirname,'../..'),read=p=>JSON.parse(fs.readFileSync(path.join(root,p),'utf8'));
const bridge=require('../../assets/contained-card-prices.js'),match=require('../../assets/contained-card-match.js'),repairs=require('../../assets/card-catalog-repairs.js');
repairs.configure(read('data/card-catalog-repairs.json'));
function numbers(p){const t=[p.productNumber,p.name].filter(Boolean).join(' ').normalize('NFKC').toUpperCase();return [...new Set([...t.matchAll(/\b(PRB|OP|EB|ST)[ -]?(\d{1,3})[ -](\d{1,3})(?!\d)|\b(P)[ -](\d{1,3})(?!\d)/g)].map(m=>m[4]?'P-'+m[5].padStart(3,'0'):m[1]+m[2].padStart(2,'0')+'-'+m[3].padStart(3,'0')))];}
function rejected(p){return match.foreign(p)||/\bChina\s+(?:Ver|Version|Edition)\b/i.test(p.name||'')||numbers(p).length>1||/\b\d+[- ]cards?\s+set\b|\bbundle\b/i.test(p.name||'');}
const catalogue=read('data/onepiece-official-search.json'),manifest=read('data/onepiece-official-manifest.json');
const products=bridge.mergeSetProducts(repairs.products(read('data/all-cards.json').details),read('data/onepiece-eb05-market.json').products).filter(p=>p.brand==='onepiece'&&p.kind==='card');
const byNumber={};for(const p of products)if(!rejected(p))for(const n of numbers(p))(byNumber[n]??=[]).push({...p,id:String(p.id)});
const sources=[];for(const set of manifest.sets)for(const c of read('data/cards-by-set/'+(set.fileCode||set.code)+'.json').cards)if(c.officialId){const card={...c,brand:'onepiece',language:'ja',boxCode:set.code},target=bridge.targetFor(card);sources.push({officialId:c.officialId,boxCode:set.code,fileCode:set.fileCode||set.code,card,target,printedNumber:target.fullNumber,candidates:byNumber[target.fullNumber]||[]});}
const index=read('data/yuyutei-market/onepiece.json'),shop=[];for(const s of index.sets||[]){const file='data/yuyutei-market/onepiece/'+s.sourceSetCode+'.json';if(fs.existsSync(path.join(root,file)))for(const r of read(file).records||[])shop.push({...r,sourceSetName:s.name});}
const baseline={schemaVersion:1,generatedAt:new Date().toISOString(),baselineSHA256:crypto.createHash('sha256').update(JSON.stringify(catalogue)).digest('hex'),catalogue,marketProducts:products.length,sources,yuyutei:shop,shopCoverage:index.coverage};
fs.mkdirSync(path.join(root,'.cache/onepiece-audit'),{recursive:true});fs.writeFileSync(path.join(root,'.cache/onepiece-audit/input.json'),JSON.stringify(baseline));
console.log(JSON.stringify({official:sources.length,linked:catalogue.linkedProducts,pending:catalogue.cards.filter(c=>!c.productId).length,marketProducts:products.length,shopProducts:shop.length,shopCoverage:index.coverage}));
module.exports={numbers,rejected};
