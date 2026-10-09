// Offline, in-memory SQLite integration tests. Never contacts PSA/BGS or production D1.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { normalizeCert,parseGrade,normalizeRecord,matchCard,ensureCertificateTables,submitCertificate,claimJob,completeJob,getRequest,LEASE_MS } from '../functions/_shared/certificates.js';
import { onRequestPost as acceptResult } from '../functions/api/psa/cache.js';
import { onRequestGet as statusEndpoint } from '../functions/api/certifications/status.js';
import { signJwt } from '../functions/_shared/jwt.js';
import { onRequestPost as legacyBgsCert } from '../functions/api/bgs/cert.js';

class Statement {
  constructor(db,sql,args=[]) { this.db=db;this.sql=sql;this.args=args; }
  bind(...args) { return new Statement(this.db,this.sql,args); }
  async first() { return this.db.prepare(this.sql).get(...this.args) || null; }
  async all() { return {results:this.db.prepare(this.sql).all(...this.args)}; }
  async run() { const r=this.db.prepare(this.sql).run(...this.args);return {success:true,meta:{changes:Number(r.changes),last_row_id:Number(r.lastInsertRowid)}}; }
}
class D1 {
  constructor() { this.sqlite=new DatabaseSync(':memory:'); }
  prepare(sql) { return new Statement(this.sqlite,sql); }
  async batch(items) {
    this.sqlite.exec('BEGIN');
    try { const out=[];for(const item of items)out.push(await item.run());this.sqlite.exec('COMMIT');return out; }
    catch(e) { this.sqlite.exec('ROLLBACK');throw e; }
  }
}
const card={name:'Charizard VMAX HR: PROMO[S-P 104](S-P Promotional cards)',code:'pkmn-tcg-1',brand:'pokemon'};
const record=(cert='23483296',grade='GEM MT 10')=>({cert_number:cert,grade_text:grade,subject:'CHARIZARD VMAX',brand:'POKEMON JAPANESE S-P PROMO',year:'2020',card_number:'104',variety:'',label:'',pop_total:null,pop_higher:null,source_url:`https://www.psacard.com/cert/${cert}`});
// Public PSA record and catalogue entry used to reproduce a naming mismatch.
const zekromCard={name:'Zekrom: PROMO[S8a-P 021/025](Promo Card Pack 25th Anniversary Edition)',code:'pkmn-tcg-1711',brand:'pokemon'};
const zekromRecord={cert_number:'127270226',grade_text:'GEM MT 10',subject:'FA/ZEKROM',brand:'POKEMON JAPANESE PROMO CARD PACK 25TH ANNIVERSARY EDITION',year:'2021',card_number:'021',variety:'PCP 25TH ANNIVERSARY ED.',label:'w/ fugitive ink technology',pop_total:16952,pop_higher:0,source_url:'https://www.psacard.com/cert/127270226/psa'};
async function fixture() {
  const DB=new D1();
  DB.sqlite.exec(`CREATE TABLE holdings(id INTEGER PRIMARY KEY,user_id INTEGER,card_id TEXT,grade TEXT,qty INTEGER,buy_price INTEGER); INSERT INTO holdings VALUES(1,1,'91103','psa10',1,10000),(2,2,'91103','psa10',1,10000),(3,1,'91103','psa10',2,10000);`);
  const env={DB,PSA_WORKER_KEY:'test-only-worker-key',JWT_SECRET:'test-only-jwt-key',ASSETS:{fetch:async()=>new Response(JSON.stringify({'91103':card,'22222':{name:'Nami SR[OP07-051]',code:'OP07-051',brand:'onepiece'}}))}};
  await ensureCertificateTables(env);return env;
}
async function submit(env,body={},userId=1,provider='psa') {
  const request=new Request(`https://example.test/api/${provider}/cert`,{method:'POST',body:JSON.stringify({cert_number:'23483296',card_id:'91103',holding_id:provider==='psa'?1:undefined,...body})});
  const response=await submitCertificate({env,request,user:{id:userId}},provider);
  return {http:response.status,...await response.json()};
}
const finish=(env,job,rec,extra={})=>completeJob(env,{job_id:job.id,lease_token:job.lease_token,provider:job.provider,cert_number:job.cert_number,outcome:'success',record:rec,...extra});

test('normalization preserves zeroes and rejects letters',()=>{
  assert.equal(normalizeCert('0016097088'),'0016097088');
  assert.equal(normalizeCert('ABC23483296'),null);
  assert.equal(normalizeCert('23 483 296'),'23483296');
});
test('grade parsing keeps 9.5 and rejects ambiguity/qualifiers',()=>{
  assert.equal(parseGrade('GEM MT 10'),10);assert.equal(parseGrade('9.5'),9.5);
  for(const v of ['AUTO 10 CARD 9','AUTHENTIC','MINT 9 (OC)','11','9.7'])assert.equal(parseGrade(v),null);
});
test('actual result cert and required fields are mandatory',()=>{
  assert.throws(()=>normalizeRecord(record('24031556'),'psa','23483296'),/cert_number_mismatch/);
  assert.throws(()=>normalizeRecord({...record(),grade_text:''},'psa','23483296'),/unsupported_grade/);
  assert.throws(()=>normalizeRecord({...record(),source_url:'https://evil.example/cert/23483296'},'psa','23483296'),/invalid_source/);
});
test('PSA source validation accepts existing web sources and exact official API cert URLs',()=>{
  for(const cert of ['23483296','0016097088']) {
    for(const source_url of [`https://www.psacard.com/cert/${cert}`,`https://psacard.com/cert/${cert}/psa`,`https://api.psacard.com/publicapi/cert/GetByCertNumber/${cert}`]) {
      const normalized=normalizeRecord({...record(cert),source_url},'psa',cert);
      assert.equal(normalized.cert_number,cert);
      assert.equal(normalized.source_url,source_url);
    }
  }
});
test('official API sources reject changed identity, endpoint and URL authority',()=>{
  const path='/publicapi/cert/GetByCertNumber/23483296';
  const invalidSources=[
    `http://api.psacard.com${path}`,
    `https://api.psacard.com.evil.example${path}`,
    `https://www.api.psacard.com${path}`,
    `https://www.psacard.com${path}`,
    'https://api.psacard.com/cert/23483296',
    'https://api.psacard.com/publicapi/cert/GetBySpecNumber/23483296',
    'https://api.psacard.com/publicapi/cert/getbycertnumber/23483296',
    'https://api.psacard.com/publicapi/cert/GetByCertNumber/24031556',
    'https://api.psacard.com/publicapi/cert/GetByCertNumber/023483296',
    `https://api.psacard.com${path}/psa`,
    `https://api.psacard.com${path}/`,
    `https://api.psacard.com${path}?cert=23483296`,
    `https://api.psacard.com${path}#23483296`,
    `https://user@api.psacard.com${path}`,
    `https://user:password@api.psacard.com${path}`,
    `https://api.psacard.com:8443${path}`,
    `https://api.psacard.com:443${path}`,
    'https://api.psacard.com/publicapi/cert/GetByCertNumber/%323483296',
    'https://api.psacard.com/publicapi/cert/other/../GetByCertNumber/23483296',
    `https://api.psacard.com/${path}`,
    ` https://api.psacard.com${path}`,
  ];
  for(const source_url of invalidSources) assert.throws(()=>normalizeRecord({...record(),source_url},'psa','23483296'),/invalid_source/,source_url);
  assert.throws(()=>normalizeRecord({...record(),source_url:`https://api.psacard.com${path}`},'bgs','23483296'),/invalid_source/);
});

test('card matching rejects substring numbers and empty codes',()=>{
  const rec=normalizeRecord(record(),'psa','23483296');assert.equal(matchCard(rec,card).ok,true);
  assert.equal(matchCard({...rec,card_number:'4'},card).ok,false);
  assert.equal(matchCard({...rec,card_number:'7'},{name:'CHARIZARD VMAX[S10b 074/071]',code:''}).ok,false);
  assert.equal(matchCard(rec,{name:'CHARIZARD VMAX',code:''}).ok,false);
});
test('set-prefixed card numbers preserve zeroes across separator variants',()=>{
  const local={name:'Nami SR[OP07-051]',code:'OP07-051',brand:'onepiece'};
  const rec={subject:'NAMI',brand:'ONE PIECE OP07',card_number:'OP07051',variety:'',year:'2024'};
  for(const number of ['OP07-051','OP07051']) assert.equal(matchCard({...rec,card_number:number},local).ok,true,number);
  for(const number of ['OP07-052','OP07052','OP08051','OP07-51','OP0751','051','51']) {
    assert.equal(matchCard({...rec,card_number:number},local).ok,false,number);
  }
  assert.equal(matchCard({...rec,subject:'ROBIN'},local).ok,false);
  assert.equal(matchCard({...rec,variety:'first edition'},local).ok,false);
});
test('numeric PSA card numbers retain leading-zero and fraction matching',()=>{
  const rec=normalizeRecord(record(),'psa','23483296');
  const local={name:'CHARIZARD VMAX[S10b 074/071]',code:'pkmn-tcg-1'};
  for(const number of ['74','074','074/071']) assert.equal(matchCard({...rec,card_number:number},local).ok,true,number);
  for(const number of ['7','4','174','075','074/072']) assert.equal(matchCard({...rec,card_number:number},local).ok,false,number);
});
test('PSA Pokemon FA prefix matches the complete remaining subject',()=>{
  const rec=normalizeRecord(zekromRecord,'psa','127270226');
  assert.equal(matchCard(rec,zekromCard).ok,true);
  assert.equal(matchCard({...rec,subject:'fa/ZEKROM'},zekromCard).ok,true);
  assert.equal(rec.subject,'FA/ZEKROM','matching must preserve the official record');
  for(const subject of ['ZEKROM/FA','FA /ZEKROM','SA/ZEKROM','FAFA/ZEKROM','FA/ZEKROM/PIKACHU','FA/ZEKROM-EX','FA/ZEKROM GX','FA/']) {
    assert.equal(matchCard({...rec,subject},zekromCard).ok,false,subject);
  }
});

test('FA normalization is restricted to official PSA Pokemon records and cards',()=>{
  const rec=normalizeRecord(zekromRecord,'psa','127270226');
  for(const source_url of ['https://www.beckett.com/api/grading/lookup','https://psacard.com.evil.example/cert/127270226','https://evil.example/','http://www.psacard.com/cert/127270226','']) {
    assert.equal(matchCard({...rec,source_url},zekromCard).reason,'card_subject_mismatch',source_url);
  }
  assert.equal(matchCard({...rec,brand:'ONE PIECE'},zekromCard).reason,'card_subject_mismatch');
  assert.equal(matchCard(rec,{...zekromCard,brand:'onepiece'}).reason,'card_subject_mismatch');
});

test('FA naming normalization retains number, edition, language and year rejection',()=>{
  const rec=normalizeRecord(zekromRecord,'psa','127270226');
  assert.equal(matchCard({...rec,card_number:'022'},zekromCard).reason,'card_number_mismatch');
  assert.equal(matchCard({...rec,variety:'MASTER BALL'},zekromCard).reason,'card_variant_mismatch');
  assert.equal(matchCard(rec,{...zekromCard,name:'English '+zekromCard.name}).reason,'card_language_mismatch');
  assert.equal(matchCard(rec,{...zekromCard,name:zekromCard.name+' (2020)'}).reason,'card_year_mismatch');
});

test('official API Pokemon FA naming uses the same exact source and card checks',()=>{
  const source_url='https://api.psacard.com/publicapi/cert/GetByCertNumber/127270226';
  const rec=normalizeRecord({...zekromRecord,source_url},'psa','127270226');
  assert.equal(matchCard(rec,zekromCard).ok,true);
  assert.equal(rec.subject,'FA/ZEKROM');
  for(const invalidSource of [source_url.replace('127270226','23483296'),source_url+'?cert=127270226',source_url.replace('api.psacard.com','user@api.psacard.com'),source_url.replace('api.psacard.com','api.psacard.com:443'),source_url.replace('GetByCertNumber','GetBySpecNumber')]) {
    assert.equal(matchCard({...rec,source_url:invalidSource},zekromCard).reason,'card_subject_mismatch',invalidSource);
  }
  assert.equal(matchCard({...rec,cert_number:'23483296'},zekromCard).reason,'card_subject_mismatch');
  assert.equal(matchCard({...rec,brand:'ONE PIECE'},zekromCard).reason,'card_subject_mismatch');
  assert.equal(matchCard(rec,{...zekromCard,brand:'onepiece'}).reason,'card_subject_mismatch');
  assert.equal(matchCard({...rec,card_number:'022'},zekromCard).reason,'card_number_mismatch');
  assert.equal(matchCard({...rec,variety:'MASTER BALL'},zekromCard).reason,'card_variant_mismatch');
  assert.equal(matchCard(rec,{...zekromCard,name:'English '+zekromCard.name}).reason,'card_language_mismatch');
  assert.equal(matchCard(rec,{...zekromCard,name:zekromCard.name+' (2020)'}).reason,'card_year_mismatch');
});
test('official PSA API record completes registration with its cert identity and POP intact',async()=>{
  const env=await fixture();
  const apiRecord={...record(),subject:'FA/CHARIZARD VMAX',pop_total:1234,pop_higher:0,source_url:'https://api.psacard.com/publicapi/cert/GetByCertNumber/23483296'};
  const req=await submit(env);
  const job=await claimJob(env);
  assert.equal((await finish(env,job,apiRecord)).status,200);
  assert.equal((await getRequest(env,req.request_id,1)).status,'registered');
  const saved=await env.DB.prepare("SELECT * FROM psa_certs WHERE cert_number='23483296'").first();
  assert.equal(saved.subject,apiRecord.subject);
  assert.equal(saved.psa_total_pop,1234);
  assert.equal(saved.psa_pop_higher,0);
  assert.equal(JSON.parse(saved.raw_payload).source_url,apiRecord.source_url);
});

test('actual PSA FA Zekrom record completes registration and preserves POP and source naming',async()=>{
  const env=await fixture();
  env.ASSETS.fetch=async()=>new Response(JSON.stringify({'98530':zekromCard}));
  await env.DB.prepare("INSERT INTO holdings VALUES (4,1,'98530','psa10',1,10000)").run();
  const req=await submit(env,{cert_number:'127270226',card_id:'98530',holding_id:4});
  assert.equal(req.http,202);
  const job=await claimJob(env);
  assert.equal((await finish(env,job,zekromRecord)).status,200);
  assert.equal((await getRequest(env,req.request_id,1)).status,'registered');
  const saved=await env.DB.prepare("SELECT * FROM psa_certs WHERE cert_number='127270226'").first();
  assert.equal(saved.subject,'FA/ZEKROM');
  assert.equal(saved.psa_total_pop,16952);
  assert.equal(saved.psa_pop_higher,0);
  assert.equal(JSON.parse(saved.raw_payload).subject,'FA/ZEKROM');
});

test('missing population is null, explicit zero is retained',()=>{
  assert.equal(normalizeRecord(record(),'psa','23483296').pop_higher,null);
  assert.equal(normalizeRecord({...record(),pop_higher:0},'psa','23483296').pop_higher,0);
});
test('registration completes without any frontend polling and grade is authoritative',async()=>{
  const env=await fixture();const accepted=await submit(env);assert.equal(accepted.http,202);
  const job=await claimJob(env);assert.equal(job.cert_number,'23483296');
  assert.equal((await finish(env,job,record('23483296','MINT 9'))).status,200);
  const status=await getRequest(env,accepted.request_id,1);assert.equal(status.status,'registered');
  const holding=await env.DB.prepare('SELECT grade FROM holdings WHERE id=1').first();assert.equal(holding.grade,'psa9');
  assert.equal((await env.DB.prepare('SELECT grade FROM psa_certs').first()).grade,9);
});
test('duplicate submits share one request and one lookup job',async()=>{
  const env=await fixture();const a=await submit(env);const b=await submit(env);
  assert.equal(a.request_id,b.request_id);assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM cert_lookup_jobs').first()).n,1);
});
test('cross-user holding cannot be queued',async()=>{
  const env=await fixture();const res=await submit(env,{holding_id:2});assert.equal(res.http,403);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM cert_lookup_jobs').first()).n,0);
});
test('status API is owner scoped',async()=>{
  const env=await fixture();const req=await submit(env);assert.equal(await getRequest(env,req.request_id,2),null);
  const token=await signJwt({sub:2,exp:Math.floor(Date.now()/1000)+60},env.JWT_SECRET);
  const response=await statusEndpoint({env,request:new Request(`https://example.test/api/certifications/status?id=${req.request_id}`,{headers:{cookie:`session=${token}`}})});
  assert.equal(response.status,404);
});
test('a currently leased job cannot be claimed again',async()=>{
  const env=await fixture();await submit(env);assert.ok(await claimJob(env));assert.equal(await claimJob(env),null);
});
test('failed job backs off while later jobs are processed',async()=>{
  const env=await fixture();await submit(env);await submit(env,{cert_number:'24031556',holding_id:3});
  const first=await claimJob(env);await finish(env,first,null,{outcome:'temporary_error',error_code:'source_network_error'});
  const second=await claimJob(env);assert.ok(second);assert.notEqual(second.id,first.id);
  const old=await env.DB.prepare('SELECT status,next_attempt_at FROM cert_lookup_jobs WHERE id=?').bind(first.id).first();assert.equal(old.status,'retry_wait');assert.ok(old.next_attempt_at>Date.now());
});
test('provider block pauses the provider but not other providers',async()=>{
  const env=await fixture();await submit(env);await submit(env,{cert_number:'0016097088',card_id:'22222',holding_id:undefined},1,'bgs');
  const job=await claimJob(env);assert.equal(job.provider,'psa');
  await finish(env,job,null,{outcome:'blocked',error_code:'source_access_restricted',retry_after_seconds:7200});
  const next=await claimJob(env);assert.equal(next.provider,'bgs');
  const state=await env.DB.prepare("SELECT paused_until FROM cert_worker_state WHERE name='psa'").first();assert.ok(state.paused_until>=Date.now()+7100000);
});
test('stale worker result cannot overwrite a renewed lease',async()=>{
  const env=await fixture();await submit(env);const first=await claimJob(env);
  const next=await claimJob(env,Date.now()+LEASE_MS+1000);assert.equal(first.id,next.id);assert.notEqual(first.lease_token,next.lease_token);
  const res=await finish(env,first,record());assert.equal(res.status,409);assert.equal(res.data.error,'stale_lease');
});
test('parse failures become review, never not-found or a poisoned cache',async()=>{
  const env=await fixture();const req=await submit(env);const job=await claimJob(env);
  await finish(env,job,{...record(),grade_text:''});
  assert.equal((await getRequest(env,req.request_id,1)).status,'needs_review');
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM cert_lookup_cache').first()).n,0);
});
test('wrong result number cannot register or change a holding',async()=>{
  const env=await fixture();const req=await submit(env);const job=await claimJob(env);await finish(env,job,record('24031556','MINT 9'));
  assert.equal((await getRequest(env,req.request_id,1)).status,'needs_review');assert.equal((await env.DB.prepare('SELECT grade FROM holdings WHERE id=1').first()).grade,'psa10');
});
test('multi-quantity holding cannot silently change all cards grade',async()=>{
  const env=await fixture();const req=await submit(env,{holding_id:3});const job=await claimJob(env);await finish(env,job,record('23483296','MINT 9'));
  assert.equal((await getRequest(env,req.request_id,1)).status,'needs_review');assert.equal((await env.DB.prepare('SELECT grade FROM holdings WHERE id=3').first()).grade,'psa10');
});
test('deleted holding is not resurrected during finalization',async()=>{
  const env=await fixture();const req=await submit(env);const job=await claimJob(env);await env.DB.prepare('DELETE FROM holdings WHERE id=1').run();await finish(env,job,record());
  assert.equal((await getRequest(env,req.request_id,1)).status,'rejected');assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM psa_certs').first()).n,0);
});
test('unsupported PSA grade is not rounded into PSA9',async()=>{
  const env=await fixture();const req=await submit(env);const job=await claimJob(env);await finish(env,job,record('23483296','NM-MT 8'));
  assert.equal((await getRequest(env,req.request_id,1)).status,'needs_review');
});
test('BGS decimal grade and label are saved through the same offline queue',async()=>{
  const env=await fixture();const req=await submit(env,{cert_number:'0016097088',card_id:'22222',holding_id:undefined},1,'bgs');const job=await claimJob(env);
  await finish(env,job,{cert_number:'0016097088',grade_text:'9.5',subject:'NAMI',brand:'ONE PIECE OP07',card_number:'OP07051',label:'gold',source_url:'https://www.beckett.com/api/grading/lookup?category=BGS&serialNumber=0016097088'});
  assert.equal((await getRequest(env,req.request_id,1)).status,'registered');const saved=await env.DB.prepare('SELECT * FROM bgs_certs').first();assert.equal(saved.cert_number,'0016097088');assert.equal(saved.final_grade,'9.5');
});
test('BGS10 needs an explicit recognized label',()=>{
  assert.throws(()=>normalizeRecord({...record('0016097088'),source_url:'https://www.beckett.com/api/grading/lookup',label:''},'bgs','0016097088'),/unknown_label/);
});
test('completed cache recovers finalization after a server crash',async()=>{
  const env=await fixture();const req=await submit(env);const job=await claimJob(env);const normalized=normalizeRecord(record(),'psa','23483296');
  await env.DB.prepare('INSERT INTO cert_lookup_cache VALUES (?,?,?,?)').bind('psa','23483296',JSON.stringify(normalized),Date.now()).run();
  await env.DB.prepare("UPDATE cert_lookup_jobs SET status='complete' WHERE id=?").bind(job.id).run();
  await claimJob(env);assert.equal((await getRequest(env,req.request_id,1)).status,'registered');
});
test('acknowledgement retry is idempotent',async()=>{
  const env=await fixture();await submit(env);const job=await claimJob(env);await finish(env,job,record());const again=await finish(env,job,record());
  assert.equal(again.data.already_completed,true);assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM psa_certs').first()).n,1);
});
test('unknown or unauthenticated workers cannot submit arbitrary HTML',async()=>{
  const env=await fixture();const response=await acceptResult({env,request:new Request('https://example.test/api/psa/cache',{method:'POST',body:JSON.stringify({html:'fake'})})});assert.equal(response.status,401);
  const legacy=await acceptResult({env,request:new Request('https://example.test/api/psa/cache',{method:'POST',headers:{'x-psa-worker-key':env.PSA_WORKER_KEY},body:JSON.stringify({html:'fake',cert_number:'23483296'})})});assert.equal(legacy.status,400);
});
test('old PSA schema receives additive POP columns',async()=>{
  const DB=new D1();DB.sqlite.exec('CREATE TABLE psa_certs(id INTEGER PRIMARY KEY,cert_number TEXT,card_id TEXT,grade INTEGER,user_id INTEGER,holding_id INTEGER)');
  await ensureCertificateTables({DB});const cols=await DB.prepare('PRAGMA table_info(psa_certs)').all();assert.ok(cols.results.some(c=>c.name==='psa_total_pop'));assert.ok(cols.results.some(c=>c.name==='psa_pop_higher'));
});


test('PSA accepts and verifies repeated same-day submissions beyond the former pending limit',async()=>{
  const env=await fixture();
  for(let i=0;i<25;i++) {
    const cert=String(30000000+i);
    const holdingId=100+i;
    await env.DB.prepare("INSERT INTO holdings VALUES (?,1,'91103','psa10',1,10000)").bind(holdingId).run();
    const accepted=await submit(env,{cert_number:cert,holding_id:holdingId});
    assert.equal(accepted.http,202,`submission ${i+1} must be accepted`);
    assert.equal(accepted.status,'pending');
  }
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM cert_lookup_jobs').first()).n,25);
  for(let i=0;i<25;i++) {
    const job=await claimJob(env);assert.ok(job);
    assert.equal((await finish(env,job,{...record(job.cert_number),pop_total:1234,pop_higher:0})).status,200);
  }
  assert.equal(await claimJob(env),null);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM cert_registration_requests WHERE status='registered'").first()).n,25);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM psa_certs WHERE psa_total_pop=1234 AND psa_pop_higher=0').first()).n,25);
  assert.equal((await submit(env,{cert_number:'30000025',holding_id:3})).http,202,'recent registrations must not block another cert');
});

test('PSA shares one lookup beyond the former subscriber limit and preserves exclusive registration',async()=>{
  const env=await fixture();
  for(let userId=1;userId<=21;userId++) {
    const accepted=await submit(env,{holding_id:undefined},userId);
    assert.equal(accepted.http,202,`subscriber ${userId} must be accepted`);
  }
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM cert_lookup_jobs').first()).n,1);
  const job=await claimJob(env);await finish(env,job,record());
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM psa_certs').first()).n,1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM cert_registration_requests WHERE status='registered'").first()).n,1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM cert_registration_requests WHERE status='rejected'").first()).n,20);
});

const bgsRecord=cert=>({cert_number:cert,grade_text:'9.5',subject:'NAMI',brand:'ONE PIECE OP07',card_number:'OP07051',label:'gold',pop_total:1234,pop_bl10:2,pop_gl10:30,pop_95:1202,source_url:'https://www.beckett.com/api/grading/lookup'});

test('BGS accepts and completes same-user submissions beyond the former pending limit',async()=>{
  const env=await fixture();
  for(let i=0;i<25;i++) {
    const accepted=await submit(env,{cert_number:String(40000000+i),card_id:'22222',holding_id:undefined},1,'bgs');
    assert.equal(accepted.http,202,`submission ${i+1} must be accepted`);
    assert.equal(accepted.status,'pending');
  }
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM cert_lookup_jobs').first()).n,25);
  for(let i=0;i<25;i++) {
    const job=await claimJob(env);assert.ok(job);assert.equal(job.provider,'bgs');
    assert.equal((await finish(env,job,bgsRecord(job.cert_number))).status,200);
  }
  assert.equal(await claimJob(env),null);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM cert_registration_requests WHERE status='registered'").first()).n,25);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM bgs_certs WHERE pop_total=1234 AND pop_bl10=2 AND pop_gl10=30 AND pop_95=1202').first()).n,25);
  assert.equal((await submit(env,{cert_number:'40000025',card_id:'22222',holding_id:undefined},1,'bgs')).http,202,'recent completed registrations must not block another cert');
  assert.equal((await submit(env)).http,202,'BGS requests must not block PSA');
});

test('BGS shares one lookup beyond the former subscriber limit and preserves exclusive registration',async()=>{
  const env=await fixture();
  for(let userId=1;userId<=21;userId++) {
    const accepted=await submit(env,{cert_number:'0016097088',card_id:'22222',holding_id:undefined},userId,'bgs');
    assert.equal(accepted.http,202,`subscriber ${userId} must be accepted`);
  }
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM cert_lookup_jobs').first()).n,1);
  const job=await claimJob(env);await finish(env,job,bgsRecord(job.cert_number));
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM bgs_certs').first()).n,1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM cert_registration_requests WHERE status='registered'").first()).n,1);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) n FROM cert_registration_requests WHERE status='rejected'").first()).n,20);
});

test('legacy BGS public route has no submission quota and still rejects duplicate ownership',async t=>{
  const env=await fixture();
  let lookupCalls=0;
  t.mock.method(globalThis,'fetch',async input=>{
    const url=new URL(typeof input==='string'?input:input.url);
    if(url.origin==='https://beckett.com' && url.pathname==='/api/grading/lookup') {
      lookupCalls++;
      assert.equal(url.searchParams.get('category'),'BGS');
      return new Response(JSON.stringify({item_id:url.searchParams.get('serialNumber'),final_grade:'9.5',label:'gold',player_name:'NAMI',card_key:'OP07051',set_name:'ONE PIECE OP07',pop_report:'1234',fgB100:'2',fg100:'30',fg95:'1202'}));
    }
    assert.equal(url.href,'https://example.test/data/cards-meta-index.json','unexpected outbound request');
    return new Response(JSON.stringify({'22222':{name:'Nami SR[OP07-051]',code:'OP07-051'}}));
  });
  const session=await signJwt({sub:1,exp:Math.floor(Date.now()/1000)+60},env.JWT_SECRET);
  const call=async(cert,token=session)=>{
    const request=new Request('https://example.test/api/bgs/cert',{method:'POST',headers:{cookie:`session=${token}`,'Content-Type':'application/json'},body:JSON.stringify({cert_number:cert,card_id:'22222'})});
    const response=await legacyBgsCert({env,request});
    return {http:response.status,...await response.json()};
  };
  for(let i=0;i<25;i++) {
    const response=await call(String(50000000+i));
    assert.equal(response.http,200,`legacy submission ${i+1} must succeed`);
    assert.equal(response.ok,true);
    assert.deepEqual(response.cert.pop,{total:1234,bl10:2,gl10:30,g95:1202});
  }
  assert.equal(lookupCalls,25);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM bgs_certs').first()).n,25);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) n FROM cert_lookup_jobs').first()).n,0,'legacy route must remain synchronous');
  const ownDuplicate=await call('50000000');
  assert.equal(ownDuplicate.http,409);assert.equal(ownDuplicate.error,'already_registered');
  const otherSession=await signJwt({sub:2,exp:Math.floor(Date.now()/1000)+60},env.JWT_SECRET);
  const otherDuplicate=await call('50000000',otherSession);
  assert.equal(otherDuplicate.http,409);assert.equal(otherDuplicate.error,'already_registered');
  assert.equal(lookupCalls,25,'duplicate certs must not trigger another external lookup');
  assert.equal((await env.DB.prepare("SELECT user_id FROM bgs_certs WHERE cert_number='50000000'").first()).user_id,1);
});
