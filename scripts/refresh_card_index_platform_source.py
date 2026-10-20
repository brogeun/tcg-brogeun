"""Public SNKRDUNK all-language single-card discovery and grade-chart refresh.
Creates only dated platform snapshots and an append-only source log. Keeps all
old catalog/history snapshots. Listed prices are metadata-only and never used.
"""
from __future__ import annotations
import argparse,gzip,hashlib,json,math,re,threading,time
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from datetime import date,datetime,timedelta,timezone
from pathlib import Path
import requests
from build_market_price_index import extract,foreign
from refresh_market_price_index_source import wait_backoff,pause_for
ROOT=Path(__file__).resolve().parents[1];JST=timezone(timedelta(hours=9));BRANDS=('pokemon','onepiece');GRADES={'raw':18,'psa10':22};SINGLE={'card','single','single-card','single_card','single card'}
HTTP_LIMIT=threading.Semaphore(8);PRICE_LIMIT=threading.Semaphore(7);HTTP_STATS=Counter();RATE_LOCK=threading.Lock();RATE_NEXT=0.0;LOCK=threading.RLock();LOG_LOCK=threading.Lock();LOCAL=threading.local()
MAX_REQUESTS_PER_SECOND=8;MAX_DISCOVERY_PAGES=600
def now():return datetime.now(timezone.utc).isoformat()
def rate_limit():
 global RATE_NEXT
 with RATE_LOCK:
  pause=RATE_NEXT-time.monotonic()
  if pause>0:time.sleep(pause)
  RATE_NEXT=time.monotonic()+1/MAX_REQUESTS_PER_SECOND
def sha(body):return hashlib.sha256(body).hexdigest()
def pid(value):return str(int(value)) if type(value) in (int,str) and re.fullmatch(r'[0-9]{1,20}',str(value)) and int(value)>0 else None
def decode_json(body,path):return json.loads(gzip.decompress(body) if path.name.endswith('.gz') else body)

def read_json(path):return decode_json(path.read_bytes(),path)

def compress_source_copy(source,target):
 body=source.read_bytes()
 # A compressed archive contains the exact source bytes, including all price records.
 json.loads(body)
 packed=gzip.compress(body,compresslevel=6,mtime=0)
 if gzip.decompress(packed)!=body:raise ValueError('Gzip round-trip changed source bytes')
 if target.exists():
  if gzip.decompress(target.read_bytes())!=body:raise ValueError('Preserve an existing different compressed source')
  return {'path':str(target),'sha256':sha(target.read_bytes()),'uncompressedSha256':sha(body),'bytes':target.stat().st_size}
 tmp=target.with_suffix(target.suffix+'.tmp');tmp.write_bytes(packed);tmp.replace(target)
 return {'path':str(target),'sha256':sha(packed),'uncompressedSha256':sha(body),'bytes':len(packed)}

def atomic(path,payload):
 body=(json.dumps(payload,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n').encode('utf-8');body=gzip.compress(body,compresslevel=6,mtime=0) if path.name.endswith('.gz') else body;tmp=path.with_suffix(path.suffix+'.tmp');tmp.write_bytes(body);tmp.replace(path);return sha(body)
def safe_meta(row,cid,brand):return {'id':cid,'brand':brand,'kind':'card',**{key:row.get(key) for key in ('name','productNumber','releasedAt','thumbnailUrl') if key in row},'evidence':{'catalogDeclaredSingle':False,'category25Observed':False,'listingSources':[]}}
def fetch_chart(cid,brand,grade,cutoff,delay):
 rate_limited=0;error={'kind':'HTTPRateLimit','message':'all attempts rate limited'}
 option=GRADES[grade];expected={'raw':'A','psa10':'PSA10'}[grade];url=f'https://snkrdunk.com/v1/apparels/{cid}/sales-chart/used?range=all&salesChartOptionId={option}';base={'id':cid,'brand':brand,'grade':grade,'conditionCode':option,'conditionLabel':expected,'url':url,'range':'all','unitPriceVerified':False,'languageRestriction':False}
 for attempt in range(3):
  wait_backoff();rate_limit()
  try:
   if not hasattr(LOCAL,'session'):
    LOCAL.session=requests.Session();LOCAL.session.trust_env=False;LOCAL.session.headers.update({'User-Agent':'Mozilla/5.0','Accept':'application/json','Referer':'https://snkrdunk.com/'})
   with LOCAL.session.get(url,timeout=20) as response:
    body=response.content;status=response.status_code
    if status==429:
     with LOCK:HTTP_STATS['http429']+=1
     rate_limited+=1;print('HTTP429 graded chart; shared backoff active',flush=True);pause_for(min(60,max(5,float(response.headers.get('Retry-After','5')))));continue
    if not response.ok:raise ValueError('HTTP '+str(status))
    payload=response.json()
   LOCAL.session.cookies.clear();points=payload.get('points');choices=payload.get('salesChartOption');labels={choice.get('id'):choice.get('localizedName') for choice in choices or [] if isinstance(choice,dict)}
   if not isinstance(points,list) or not isinstance(choices,list):raise ValueError('Missing chart points or option list')
   verified=labels.get(option)==expected
   if points and not verified:raise ValueError('Nonempty chart without matching condition label')
   rows={};conflicts=set();future=invalid=0
   for point in points:
    if not isinstance(point,list) or len(point)<2:raise ValueError('Malformed chart point')
    stamp,price=point[:2]
    if type(stamp) not in (float,int) or not math.isfinite(stamp) or type(price) not in (float,int) or not math.isfinite(price):raise ValueError('Nonfinite chart point')
    if price<=0:invalid+=1;continue
    day=datetime.fromtimestamp(stamp/1000,JST).date()
    if day>cutoff:future+=1;continue
    key=day.isoformat()
    if key in conflicts:continue
    if key in rows and rows[key]['price']!=price:rows.pop(key);conflicts.add(key);continue
    rows[key]={'date':key,'price':price,'sourceTimestampMs':stamp}
   history=[rows[key] for key in sorted(rows)]
   return {**base,'status':'ok','httpStatus':status,'history':history,'fetchedAt':now(),'latestDate':history[-1]['date'] if history else None,'pointCount':len(points),'acceptedPoints':len(history),'conditionLabelVerified':verified,'conditionAvailable':option in labels,'emptyConditionResponse':not points and not choices,'rateLimitedResponses':rate_limited,'responseSha256':sha(body) if body else None,'responseJsonSha256':sha(json.dumps(payload,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()),'responseDigestKind':'raw-http-response' if body else 'canonical-response-json','conflictingDays':len(conflicts),'futurePointsExcluded':future,'nonpositivePointsExcluded':invalid}
  except Exception as exc:
   error={'kind':type(exc).__name__,'message':str(exc)}
   if 'HTTP 4' in str(exc) and '429' not in str(exc) or isinstance(exc,(ValueError,OverflowError)):break
   pause_for(1+attempt*2)
  finally:time.sleep(delay)
 return {**base,'status':'failed','history':[],'fetchedAt':now(),'latestDate':None,'conditionLabelVerified':False,'rateLimitedResponses':rate_limited,'error':error}
def listing_request(url):
 for attempt in range(3):
  wait_backoff();rate_limit()
  try:
   if not hasattr(LOCAL,'session'):
    LOCAL.session=requests.Session();LOCAL.session.trust_env=False;LOCAL.session.headers.update({'User-Agent':'Mozilla/5.0','Accept':'application/json','Accept-Language':'ja-JP,ja;q=0.9','Referer':'https://snkrdunk.com/'})
   with HTTP_LIMIT,LOCAL.session.get(url,timeout=20) as response:
    body=response.content;status=response.status_code
    if status==429:
     with LOCK:HTTP_STATS['http429']+=1
     print('HTTP429 public listing; shared backoff active',flush=True);pause_for(min(60,max(5,float(response.headers.get('Retry-After','5')))));continue
    if not response.ok:raise ValueError('HTTP '+str(status))
    result=response.json()
   LOCAL.session.cookies.clear()
   # Some transports supply decoded JSON without raw bytes; label that digest honestly.
   if not isinstance(result,dict) or not isinstance(result.get('tradingCards'),list):raise ValueError('Missing tradingCards list')
   return result,sha(body) if body else sha(json.dumps(result,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())
  except Exception:
   if attempt==2:raise
   pause_for(1+attempt*2)
  finally:time.sleep(.08)
def main():
 ap=argparse.ArgumentParser(description=__doc__);ap.add_argument('--root',type=Path,default=ROOT);ap.add_argument('--day',type=date.fromisoformat,default=datetime.now(JST).date());ap.add_argument('--workers',type=int,default=4);ap.add_argument('--delay',type=float,default=.08);ap.add_argument('--checkpoint-conditions',type=int,default=5000);ap.add_argument('--checkpoint-seconds',type=float,default=120);ap.add_argument('--resume',action='store_true');ap.add_argument('--refresh',action='store_true');ap.add_argument('--universe-output',type=Path);ap.add_argument('--history-output',type=Path);ap.add_argument('--log-output',type=Path);ap.add_argument('--archive-history',type=Path,action='append',default=[]);ap.add_argument('--archive-universe',type=Path,action='append',default=[]);args=ap.parse_args()
 if not 1<=args.workers<=8 or args.delay<.04 or args.checkpoint_conditions<1 or args.checkpoint_seconds<30:ap.error('Use 1..8 workers, delay at least .04, positive checkpoint count and at least 30 seconds')
 root=args.root.resolve();suffix=args.day.strftime('%Y%m%d');universe_path=(args.universe_output or root/'data/card-index-platform-universe.json').resolve();history_path=(args.history_output or root/'data/card-index-platform-history.json').resolve();log_path=(args.log_output or root/'artifacts'/f'card-index-platform-source-{suffix}.jsonl').resolve()
 if any(path.exists() for path in (universe_path,history_path,log_path)) and not (args.resume or args.refresh):ap.error('Preserve existing sources; use --resume for interrupted conditions or --refresh for a complete new current refresh')
 if not universe_path.is_relative_to(root/'data') or not history_path.is_relative_to(root/'data') or not log_path.is_relative_to(root/'artifacts'):ap.error('Keep new source snapshots and logs inside intended workspace')
 previous_history=read_json(history_path) if history_path.exists() else None
 previous_universe=read_json(universe_path) if universe_path.exists() else None
 archived_universes=[];archive_universe_refs={}
 for supplied in args.archive_universe:
  path=supplied.resolve()
  if not path.is_relative_to(root/'data') or path in (universe_path,history_path):ap.error('Archive universe must be a separate preserved source inside data')
  body=path.read_bytes();payload=decode_json(body,path)
  if payload.get('source')!='SNKRDUNK' or payload.get('reportKind')!='card-index-platform-universe' or not isinstance(payload.get('products'),list):ap.error('Invalid archive universe contract')
  reference=path.relative_to(root).as_posix();archive_universe_refs[reference]={'sha256':sha(body),'historicalUniverseOnly':True,'absenceIsDeletion':False};archived_universes.append(payload)
 log_path.parent.mkdir(parents=True,exist_ok=True);log=log_path.open('a' if log_path.exists() else 'x',encoding='utf-8')
 def emit(event):
  with LOG_LOCK:log.write(json.dumps({'at':now(),**event},ensure_ascii=False,separators=(',',':'))+'\n');log.flush()
 catalog_path=root/'data/cards-meta.json';catalog_raw=catalog_path.read_bytes();catalog=json.loads(catalog_raw);catalog_sha=sha(catalog_raw);groups=defaultdict(list);products={};exclusions=[]
 for position,row in enumerate(catalog.get('cards',[])):
  if not isinstance(row,dict):exclusions.append({'position':position,'reason':'invalid-record'});continue
  cid=pid(row.get('id'))
  if cid is None:exclusions.append({'position':position,'reason':'invalid-numeric-product-id'});continue
  groups[cid].append(row)
 for cid,rows in groups.items():
  if len(rows)!=1:exclusions.append({'id':cid,'reason':'duplicate-or-conflicting-catalog-id'});continue
  row=rows[0];brand=row.get('brand');kind=str(row.get('kind','')).casefold()
  if brand not in BRANDS:exclusions.append({'id':cid,'reason':'outside-pokemon-onepiece'});continue
  if kind not in SINGLE:exclusions.append({'id':cid,'reason':'non-single-or-unverified-kind','declaredKind':kind});continue
  item=safe_meta(row,cid,brand);item['evidence']['catalogDeclaredSingle']=True;products[cid]=item
 catalog_ids=set(products)
 same_day_resume=bool(args.resume and not args.refresh and previous_history and previous_history.get('collectionAsOfJST')==args.day.isoformat())
 source_universes=[*archived_universes,*([previous_universe] if previous_universe and previous_universe.get('source')=='SNKRDUNK' else [])]
 for source_universe in source_universes:
  for old in source_universe.get('products',[]):
   cid=pid(old.get('id'))
   if cid and old.get('brand') in BRANDS and old.get('kind')=='card':
    if cid not in products:products[cid]={**old,'evidence':dict(old.get('evidence',{}))}
    if products[cid]['brand']==old['brand']:
     previous_evidence=old.get('evidence',{});evidence=products[cid]['evidence'];evidence['category25Observed']=bool(evidence.get('category25Observed') or previous_evidence.get('category25Observed'))
     historical=list(evidence.get('historicalListingSources',[]))+list(previous_evidence.get('historicalListingSources',[]))
     if same_day_resume and source_universe is previous_universe:evidence['listingSources']=list(previous_evidence.get('listingSources',[]))
     else:historical.extend(previous_evidence.get('listingSources',[]));evidence['listingSources']=list(evidence.get('listingSources',[])) if cid in catalog_ids else []
     evidence['historicalListingSources']=list({json.dumps(row,sort_keys=True,separators=(',',':')):dict(row) for row in historical}.values())

 started=now();source_run=((previous_universe or {}).get('discovery',{}).get('sourceRun') or (previous_universe or {}).get('generatedAt') or started) if same_day_resume else started
 for item in products.values():
  for source in item['evidence'].get('listingSources',[]):source['sourceRun']=source_run
 discovery={'sourceRun':source_run,'currentListingProductIds':{brand:{} for brand in BRANDS},'complete':False,'pageTraversalComplete':False,'platformUniverseVerified':False,'status':'in-progress','categoryId':25,'orders':['popular','new'],'streams':[],'listingPricesUsed':False,'limitations':['Public category pagination has no advertised universe total; unavailable, hidden and discontinued products may be absent.','A terminal empty page proves traversal of that public listing, not every platform SKU.']};universe_sha=None;records={};archive={};archive_fingerprints={catalog_path.relative_to(root).as_posix():catalog_sha};source_errors=Counter();arch_counts=Counter();archive_scope={}
 archive_fingerprints.update({path:ref['sha256'] for path,ref in archive_universe_refs.items()})
 for cid,item in products.items():
  path=root/'data/history'/f'{cid}.json'
  if not path.exists():continue
  body=path.read_bytes();archive_fingerprints[path.relative_to(root).as_posix()]=sha(body)
  try:
   payload=decode_json(body,path)
   if str(payload.get('id'))!=cid:continue
   grades=extract(payload,args.day,arch_counts)
   for grade,history in grades.items():
    target=archive.setdefault((cid,grade),{})
    for day,price in history.items():target[day.isoformat()]={'date':day.isoformat(),'price':price,'sourceArchive':path.relative_to(root).as_posix(),'sourceDatePolicy':'JST normalized; known legacy chart dates shifted +1 only where declared contract requires'}
  except Exception:source_errors['invalid-history-archive']+=1
 for filename in ('market-price-index-live-history-20261011.json','market-price-index-live-history-20261012.json',*[str(path.resolve().relative_to(root/'data')) for path in args.archive_history if path.resolve().is_relative_to(root/'data')]):
  path=root/'data'/filename
  if not path.exists():continue
  body=path.read_bytes();archive_fingerprints[path.relative_to(root).as_posix()]=sha(body);snapshot=decode_json(body,path);archive_scope[path.relative_to(root).as_posix()]={'targetFingerprint':snapshot.get('targetFingerprint'),'matchesCurrentCatalog':snapshot.get('targetFingerprint')==catalog_sha,'historicalEchoOnly':True}
  for record in snapshot.get('records',[]):
   cid=pid(record.get('id'));grade=record.get('grade')
   if cid not in products or grade not in GRADES or record.get('status')!='ok' or record.get('conditionCode')!=GRADES[grade] or record.get('brand')!=products[cid]['brand']:continue
   target=archive.setdefault((cid,grade),{})
   for row in record.get('history',[]):
    try:day=date.fromisoformat(row['date']);price=row['price']
    except Exception:continue
    if day>args.day or type(price) not in (float,int) or not math.isfinite(price) or price<=0:continue
    target[row['date']]={**row,'sourceArchive':path.relative_to(root).as_posix()}
 if previous_history and previous_history.get('source')=='SNKRDUNK':
  emit({'type':'previous-own-partial-source','path':history_path.relative_to(root).as_posix(),'sha256':sha(history_path.read_bytes()),'meaning':'prior run digest only; current output never self-certifies an old input fingerprint'})
  for record in previous_history.get('records',[]):
   cid=pid(record.get('id'));grade=record.get('grade')
   if cid not in products or grade not in GRADES or record.get('status')!='ok':continue
   target=archive.setdefault((cid,grade),{})
   for row in record.get('history',[]):
    if date.fromisoformat(row['date'])<=args.day:target[row['date']]={**row,'sourceArchive':history_path.relative_to(root).as_posix()}
   if args.resume and not args.refresh and datetime.fromisoformat(record['fetchedAt']).astimezone(JST).date()==args.day:
    resumed=dict(record);resumed['history']=[target[key] for key in sorted(target)];resumed['mergedHistoryPoints']=len(target);resumed['latestDate']=resumed['history'][-1]['date'] if resumed['history'] else None;records[(cid,grade)]=resumed
 def publish_universe():
  nonlocal universe_sha
  with LOCK:
   payload={'schemaVersion':1,'reportKind':'card-index-platform-universe','source':'SNKRDUNK','generatedAt':started,'scope':{'brands':list(BRANDS),'languages':'all','currency':'JPY','productTypes':['single-card'],'rankingSelection':False,'maximumProducts':None},'catalogReference':{'path':'data/cards-meta.json','sha256':catalog_sha},'products':[products[cid] for cid in sorted(products,key=int)],'exclusions':exclusions,'discovery':discovery,'unitPriceVerified':False,'singleCardIndividuallyVerified':False,'languageRestriction':False}
   universe_sha=atomic(universe_path,payload)
 def publish_history(final=False):
  checkpoint_started=time.monotonic()
  with LOCK:
   publish_universe()
   current=[record for key,record in sorted(records.items(),key=lambda item:(int(item[0][0]),item[0][1])) if key[0] in products];statuses=Counter(record['status'] for record in current);requested=len(products)*2;complete=final and len(current)==requested and statuses['failed']==0 and discovery['pageTraversalComplete'];latest=max((record.get('latestDate') for record in current if record.get('latestDate')),default=None)
   payload={'schemaVersion':1,'reportKind':'market-price-index-live-history','source':'SNKRDUNK','currency':'JPY','timezone':'Asia/Tokyo','fetchedAt':now(),'collectionAsOfJST':args.day.isoformat(),'currentDate':args.day.isoformat(),'grades':list(GRADES),'targetFingerprint':catalog_sha,'universeFingerprint':universe_sha,'universePath':universe_path.relative_to(root).as_posix(),'inputFingerprints':archive_fingerprints,'unitPriceVerified':False,'languageRestriction':False,'platformUniverseVerified':False,'collectionPolicy':{'maxConcurrentRequests':8,'configuredPriceWorkers':args.workers,'maxRequestsPerSecond':MAX_REQUESTS_PER_SECOND,'maxDiscoveryPagesPerStream':MAX_DISCOVERY_PAGES,'rateLimitAppliesToEveryAttempt':True,'shared429Backoff':True,'checkpointConditions':args.checkpoint_conditions,'checkpointSeconds':args.checkpoint_seconds},'scopeSummary':{'attemptedProducts':len({r['id'] for r in current}),'attemptedConditions':len(current),'succeededConditions':statuses['ok'],'failedConditions':statuses['failed'],'emptyConditions':sum(r['status']=='ok' and not r['history'] for r in current),'complete':complete,'priceCollectionComplete':final and len(current)==requested and statuses['failed']==0,'discoveryComplete':discovery['complete'],'requestedProducts':len(products),'requestedConditions':requested,'sourceAsOf':latest,'countsByBrand':dict(Counter(products[cid]['brand'] for cid in products)),'requestStatistics':dict(HTTP_STATS),'errorCounts':dict(Counter(str(r.get('error',{}).get('statusCode',r.get('error',{}).get('kind'))) for r in current if r['status']!='ok'))},'archivePolicy':'previous accepted SNKRDUNK graded observations retained; new successful matching condition/date values override; no absence-as-deletion, zero or cross-grade fill','archiveScopeReferences':archive_scope,'archiveUniverseReferences':archive_universe_refs,'archiveNormalizationCounters':dict(arch_counts),'archiveReadErrors':dict(source_errors),'records':current}
   atomic(history_path,payload)
   emit({'type':'checkpoint','universeFingerprint':universe_sha,'conditions':len(current),'requested':requested,'complete':complete,'sourceAsOf':latest,'writeSeconds':round(time.monotonic()-checkpoint_started,3)})
 archive_loaded=set(products)
 def ensure_archive(cid):
  # Discovery may admit a product absent from cards-meta that still has an old chart file.
  with LOCK:
   if cid in archive_loaded:return
   archive_loaded.add(cid);path=root/'data/history'/f'{cid}.json'
   if not path.exists():return
   body=path.read_bytes();archive_fingerprints[path.relative_to(root).as_posix()]=sha(body)
   try:
    payload=decode_json(body,path)
    if str(payload.get('id'))!=cid:raise ValueError('archive product id mismatch')
    grades=extract(payload,args.day,arch_counts)
    for grade,history in grades.items():
     target=archive.setdefault((cid,grade),{})
     for day,price in history.items():target[day.isoformat()]={'date':day.isoformat(),'price':price,'sourceArchive':path.relative_to(root).as_posix(),'sourceDatePolicy':'JST normalized; known legacy chart dates shifted +1 only where declared contract requires'}
   except Exception:source_errors['invalid-history-archive']+=1
 def one(cid,brand,grade):
  ensure_archive(cid)
  # Reserve one of the eight HTTP slots until public listing discovery finishes.
  with PRICE_LIMIT,HTTP_LIMIT:record=fetch_chart(cid,brand,grade,args.day,args.delay)
  old=archive.get((cid,grade),{});merged=dict(old);fresh=record.get('history',[])
  if record['status']=='ok':
   for row in fresh:merged[row['date']]={**row,'sourceObservation':'current-public-graded-chart'}
  record['history']=[merged[key] for key in sorted(merged)];record['mergedHistoryPoints']=len(merged);record['archivePoints']=len(old);record['freshAcceptedPoints']=len(fresh);record['freshLatestDate']=fresh[-1]['date'] if fresh else None;record['latestDate']=record['history'][-1]['date'] if record['history'] else None;record['archiveAvailable']=bool(old);return record
 def save(record):
  with LOCK:records[(record['id'],record['grade'])]=record
  emit({'type':'grade-chart','id':record['id'],'brand':record['brand'],'grade':record['grade'],'status':record['status'],'responseSha256':record.get('responseSha256'),'freshAcceptedPoints':record.get('freshAcceptedPoints'),'mergedHistoryPoints':record.get('mergedHistoryPoints'),'freshLatestDate':record.get('freshLatestDate'),'error':record.get('error')})
 publish_universe()
 if '146897' in products:
  for grade in GRADES:
   if ('146897',grade) not in records:save(one('146897','pokemon',grade))
 publish_history();print('EARLY GOGH CHECKPOINT ready '+str(history_path),flush=True)
 initial=dict(products)
 resume_pages=defaultdict(set);resume_ids=defaultdict(set);resume_fingerprints=defaultdict(set);resume_streams={}
 if same_day_resume:
  for cid,item in products.items():
   for source in item.get('evidence',{}).get('listingSources',[]):
    key=(source.get('brand'),source.get('order'));page=source.get('page')
    if key[0] in BRANDS and key[1] in ('popular','new') and type(page) is int and page>0:
     resume_pages[key].add(page);resume_ids[key].add(cid)
  for stream in (previous_universe or {}).get('discovery',{}).get('streams',[]):
   key=(stream.get('brand'),stream.get('order'))
   if stream.get('terminalEmpty') and not stream.get('errors'):resume_streams[key]=stream
  for line in log_path.read_text(encoding='utf-8').splitlines():
   try:event=json.loads(line)
   except Exception:continue
   key=(event.get('brand'),event.get('order'))
   if event.get('type')!='discovery-page' or key[0] not in BRANDS or key[1] not in ('popular','new') or event.get('terminalEmpty'):continue
   ids=event.get('ids',[]);page=event.get('page')
   if not ids or type(page) is not int or not all(cid in products and products[cid]['brand']==key[0] for cid in ids):continue
   resume_pages[key].add(page);resume_ids[key].update(ids);resume_fingerprints[key].add(tuple(ids))
   source={'url':event['url'],'brand':key[0],'categoryId':25,'order':key[1],'page':page,'sourceRun':source_run}
   for cid in ids:
    evidence=products[cid]['evidence'];evidence['category25Observed']=True
    if not any(old.get('url')==source['url'] for old in evidence['listingSources']):evidence['listingSources'].append(source)
 def discover():
  try:
   for brand in BRANDS:
    for order in ('popular','new'):
     key=(brand,order)
     if key in resume_streams:
      stream={**resume_streams[key],'resumed':True};discovery['currentListingProductIds'][brand][order]=sorted(resume_ids[key],key=int);discovery['streams'].append(stream);print('DISCOVERY resumed completed stream '+json.dumps(stream),flush=True);continue
     seen_ids=set(resume_ids[key]);seen_pages=set(resume_fingerprints[key]);page=1
     while page in resume_pages[key]:page+=1
     stream={'brand':brand,'order':order,'categoryId':25,'pages':page-1,'uniqueIDs':len(seen_ids),'terminalEmpty':False,'errors':[],'potentialCap':False,'resumedThroughPage':page-1}
     print(f'DISCOVERY starting {brand} {order} at page {page}',flush=True)
     while page<=MAX_DISCOVERY_PAGES:
      url=f'https://snkrdunk.com/en/v1/trading-cards?brandId={brand}&categoryId=25&page={page}&perPage=100&order={order}'
      try:payload,response_sha=listing_request(url)
      except Exception as exc:stream['errors'].append({'page':page,'error':str(exc)});break
      rows=payload['tradingCards'];ids=[pid(row.get('id')) if isinstance(row,dict) else None for row in rows];fingerprint=tuple(ids);stream['pages']=page
      emit({'type':'discovery-page','sourceRun':source_run,'brand':brand,'order':order,'page':page,'url':url,'count':len(rows),'ids':ids,'responseJsonOrHttpSha256':response_sha,'digestMeaning':'raw body when exposed; otherwise canonical decoded JSON','terminalEmpty':not rows})
      if not rows:stream['terminalEmpty']=True;break
      if fingerprint in seen_pages:stream['errors'].append({'page':page,'error':'repeated-id-page'});break
      seen_pages.add(fingerprint)
      for row,cid in zip(rows,ids):
       if cid is None:stream['errors'].append({'page':page,'error':'invalid-product-id'});continue
       seen_ids.add(cid)
       declared=row.get('kind') or row.get('productType');category=row.get('categoryId')
       if declared and str(declared).casefold() not in SINGLE or category is not None and str(category)!='25':
        with LOCK:exclusions.append({'id':cid,'reason':'listing-explicit-non-single-or-other-category','kind':declared,'categoryId':category,'url':url})
        continue
       with LOCK:
        if cid in products and products[cid]['brand']!=brand:exclusions.append({'id':cid,'reason':'conflicting-listing-brand','url':url});continue
        item=products.setdefault(cid,safe_meta(row,cid,brand));item['evidence']['category25Observed']=True;item['evidence']['listingSources'].append({'url':url,'brand':brand,'categoryId':25,'order':order,'page':page,'sourceRun':source_run})
      if page%25==0:print(f'DISCOVERY {brand} {order}: page {page}, unique {len(seen_ids)}',flush=True)
      page+=1
     if page>MAX_DISCOVERY_PAGES and not stream['terminalEmpty']:
      stream['errors'].append({'page':page,'error':'discovery-page-limit'})
     stream['uniqueIDs']=len(seen_ids);discovery['currentListingProductIds'][brand][order]=sorted(seen_ids,key=int);stream['potentialCap']=len(seen_ids) in (9999,10000) or any(error.get('error')=='repeated-id-page' for error in stream['errors']);discovery['streams'].append(stream);print('DISCOVERY stream '+json.dumps(stream,ensure_ascii=False),flush=True)
   discovery['pageTraversalComplete']=len(discovery['streams'])==4 and all(stream['terminalEmpty'] and not stream['errors'] for stream in discovery['streams']);discovery['complete']=discovery['pageTraversalComplete'];discovery['status']='completed' if discovery['complete'] else 'partial';discovery['newProductsBeyondCatalog']=len(set(products)-catalog_ids);discovery['potentialServerRankingCap']=any(stream['potentialCap'] for stream in discovery['streams']);publish_universe();publish_history()
  except Exception as exc:discovery['status']='error';discovery['error']=str(exc);publish_universe();emit({'type':'discovery-failed','error':str(exc)})
  finally:PRICE_LIMIT.release()
 discovery_thread=threading.Thread(target=discover,daemon=True);discovery_thread.start();start=time.monotonic()
 def priority(cid):return (0 if cid=='146897' else 1 if foreign(initial[cid]) else 2,int(cid))
 def collect(tasks):
  checkpoint_count=len(records);checkpoint_time=time.monotonic()
  with ThreadPoolExecutor(max_workers=args.workers) as pool:
   jobs={pool.submit(one,cid,brand,grade):(cid,grade) for cid,brand,grade in tasks}
   for future in as_completed(jobs):
    cid,grade=jobs[future]
    try:record=future.result()
    except Exception as exc:record={'id':cid,'brand':products[cid]['brand'],'grade':grade,'conditionCode':GRADES[grade],'range':'all','status':'failed','history':[],'latestDate':None,'fetchedAt':now(),'error':{'kind':type(exc).__name__,'message':str(exc)}}
    save(record);count=len(records)
    if count%200==0:print(f'PRICES {count}/{len(products)*2}; failed {sum(record["status"]!="ok" for record in records.values())}; elapsed {round(time.monotonic()-start)}s',flush=True)
    if count-checkpoint_count>=args.checkpoint_conditions or time.monotonic()-checkpoint_time>=args.checkpoint_seconds:
     publish_history();checkpoint_count=count;checkpoint_time=time.monotonic()
 tasks=[(cid,initial[cid]['brand'],grade) for cid in sorted(initial,key=priority) for grade in GRADES if (cid,grade) not in records];collect(tasks);publish_history();discovery_thread.join()
 extra=[(cid,item['brand'],grade) for cid,item in products.items() for grade in GRADES if (cid,grade) not in records]
 if extra:print(f'NEW DISCOVERED grade conditions pending {len(extra)}',flush=True);collect(extra)
 publish_universe();publish_history(final=True);emit({'type':'complete','products':len(products),'records':len(records),'discovery':discovery});log.close();print(json.dumps({'universe':str(universe_path),'history':str(history_path),'products':len(products),'conditions':len(records),'discoveryComplete':discovery['complete'],'platformUniverseVerified':False,'sourceAsOf':max((r.get('latestDate') for r in records.values() if r.get('latestDate')),default=None),'elapsedSeconds':round(time.monotonic()-start,2)},ensure_ascii=False),flush=True)
 return 0 if all(r['status']=='ok' for r in records.values()) and discovery['complete'] else 2
if __name__=='__main__':raise SystemExit(main())
