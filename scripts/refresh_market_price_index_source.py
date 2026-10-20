"""Refresh public grade-chart observations for the complete admitted catalogue.
No authentication or source-history edits. Writes a separate auditable snapshot.
"""
from __future__ import annotations
import argparse,hashlib,json,math,threading,time,urllib.error,urllib.request
from collections import Counter,defaultdict
from concurrent.futures import ThreadPoolExecutor,as_completed
from datetime import datetime,timedelta,timezone
from pathlib import Path
from build_market_price_index import foreign,BRANDS,SINGLE_KINDS

try:
    import requests
except ImportError:
    requests=None
HTTP_LOCAL=threading.local()
ROOT=Path(__file__).resolve().parents[1]
JST=timezone(timedelta(hours=9));OPTIONS={'raw':18,'psa10':22}
BACKOFF_LOCK=threading.Lock();BACKOFF_UNTIL=0.0

def utcnow():return datetime.now(timezone.utc).isoformat()
def wait_backoff():
    while True:
        with BACKOFF_LOCK:wait=BACKOFF_UNTIL-time.monotonic()
        if wait<=0:return
        time.sleep(min(wait,1.0))
def pause_for(seconds):
    global BACKOFF_UNTIL
    with BACKOFF_LOCK:BACKOFF_UNTIL=max(BACKOFF_UNTIL,time.monotonic()+seconds)

def targets(root):
    raw=(root/'data/cards-meta.json').read_bytes();catalog=json.loads(raw)
    groups=defaultdict(list)
    for c in catalog['cards']:
        if isinstance(c,dict) and type(c.get('id')) in (str,int):groups[str(c['id'])].append(c)
    admitted={}
    for cid,rows in groups.items():
        if not cid.isdigit() or len(rows)!=1:continue
        c=rows[0]
        if c.get('brand') in BRANDS and str(c.get('kind','')).lower() in SINGLE_KINDS and not foreign(c):admitted[cid]=c['brand']
    return admitted,hashlib.sha256(raw).hexdigest()

def fetch_condition(cid,brand,grade,day,delay):
    option=OPTIONS[grade]
    url=f'https://snkrdunk.com/v1/apparels/{cid}/sales-chart/used?range=all&salesChartOptionId={option}'
    record={'id':cid,'brand':brand,'grade':grade,'conditionCode':option,'url':url,'range':'all'}
    for attempt in range(3):
        wait_backoff()
        try:
            req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Accept':'application/json','Referer':'https://snkrdunk.com/'})
            if requests is None:
                with urllib.request.urlopen(req,timeout=20) as response:payload=json.load(response)
            else:
                if not hasattr(HTTP_LOCAL,'session'):
                    HTTP_LOCAL.session=requests.Session()
                    HTTP_LOCAL.session.trust_env=False
                    HTTP_LOCAL.session.headers.update(dict(req.header_items()))
                with HTTP_LOCAL.session.get(url,timeout=20) as response:
                    if not response.ok:raise urllib.error.HTTPError(url,response.status_code,response.reason,response.headers,None)
                    payload=response.json()
                HTTP_LOCAL.session.cookies.clear()
            points=payload.get('points')
            if not isinstance(points,list):raise ValueError('Missing grade-chart points')
            rows={};conflicts=set();future=invalid=0
            for point in points:
                if not isinstance(point,list) or len(point)<2:raise ValueError('Malformed chart point')
                stamp,price=point[:2]
                if type(stamp) not in (int,float) or not math.isfinite(stamp):raise ValueError('Invalid chart timestamp')
                if type(price) not in (int,float) or not math.isfinite(price):raise ValueError('Invalid chart amount')
                if price<=0:invalid+=1;continue
                observed=datetime.fromtimestamp(stamp/1000,JST).date()
                if observed>day:future+=1;continue
                key=observed.isoformat()
                if key in conflicts:continue
                if key in rows and rows[key]['price']!=price:rows.pop(key);conflicts.add(key);continue
                rows[key]={'date':key,'price':price,'sourceTimestampMs':stamp}
            history=[rows[d] for d in sorted(rows)]
            return {**record,'status':'ok','history':history,'fetchedAt':utcnow(),'latestDate':history[-1]['date'] if history else None,'pointCount':len(points),'acceptedPoints':len(history),'conflictingDays':len(conflicts),'futurePointsExcluded':future,'nonpositivePointsExcluded':invalid}
        except urllib.error.HTTPError as exc:
            error={'kind':'http','statusCode':exc.code,'message':str(exc)}
            if exc.code in (400,401,403,404):break
            if exc.code==429:
                try:retry=max(2.0,float(exc.headers.get('Retry-After','5')))
                except (ValueError,TypeError):retry=5.0
                pause_for(min(retry,60))
            else:pause_for(1+attempt*2)
        except Exception as exc:
            error={'kind':type(exc).__name__,'message':str(exc)}
            if isinstance(exc,(ValueError,OverflowError)):break
            pause_for(1+attempt*2)
        finally:
            if delay:time.sleep(delay)
    return {**record,'status':'failed','history':[],'fetchedAt':utcnow(),'latestDate':None,'error':error}

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root',type=Path,default=ROOT);ap.add_argument('--workers',type=int,default=4)
    ap.add_argument('--delay',type=float,default=.04);ap.add_argument('--resume',action='store_true')
    ap.add_argument('--journal',type=Path);ap.add_argument('--output',type=Path)
    args=ap.parse_args()
    if not 1<=args.workers<=4 or args.delay<0:ap.error('Invalid concurrency/delay')
    today=datetime.now(JST).date();admitted,fingerprint=targets(args.root)
    journal=args.journal or args.root/'artifacts'/f'market-price-index-refresh-{today.isoformat()}.jsonl'
    output=args.output or args.root/'data/market-price-index-live-history.json'
    journal.parent.mkdir(parents=True,exist_ok=True);saved={}
    if args.resume and journal.exists():
        for line in journal.read_text(encoding='utf-8').splitlines():
            try:r=json.loads(line)
            except json.JSONDecodeError:continue
            key=(r.get('id'),r.get('grade'))
            if key[0] in admitted and key[1] in OPTIONS and r.get('status')=='ok' and datetime.fromisoformat(r.get('fetchedAt','')).astimezone(JST).date()==today:saved[key]=r
    if not args.resume and journal.exists():ap.error('Existing journal; use --resume or a new journal')
    if args.resume and journal.exists() and journal.stat().st_size:
        with journal.open('rb') as stream:stream.seek(-1,2);terminated=stream.read(1)==b'\n'
        if not terminated:
            with journal.open('a',encoding='utf-8') as stream:stream.write('\n')
    all_tasks=[(cid,brand,g) for cid,brand in sorted(admitted.items(),key=lambda x:int(x[0])) for g in OPTIONS]
    tasks=[x for x in all_tasks if (x[0],x[2]) not in saved]
    start=time.monotonic();print(f'Public grade-chart refresh: {len(admitted)} products / {len(all_tasks)} conditions; pending {len(tasks)}, workers {args.workers}',flush=True)
    done=len(saved);counts=Counter(r['status'] for r in saved.values());latest=max((r['latestDate'] for r in saved.values() if r.get('latestDate')),default=None)
    with journal.open('a',encoding='utf-8') as log,ThreadPoolExecutor(max_workers=args.workers) as pool:
        jobs={pool.submit(fetch_condition,cid,brand,g,today,args.delay):(cid,g) for cid,brand,g in tasks}
        for future in as_completed(jobs):
            key=jobs[future]
            try:r=future.result()
            except Exception as exc:r={'id':key[0],'brand':admitted[key[0]],'grade':key[1],'conditionCode':OPTIONS[key[1]],'status':'failed','history':[],'fetchedAt':utcnow(),'error':{'kind':type(exc).__name__,'message':str(exc)}}
            saved[key]=r;log.write(json.dumps(r,ensure_ascii=False,separators=(',',':'))+'\n')
            done+=1;counts[r['status']]+=1
            if r.get('latestDate'):latest=max(latest or r['latestDate'],r['latestDate'])
            if done%200==0 or done==len(all_tasks):
                log.flush();print(f'{done}/{len(all_tasks)} conditions; ok {counts["ok"]}; failed {counts["failed"]}; latest actual {latest}; elapsed {int(time.monotonic()-start)}s',flush=True)
    records=[saved[(cid,g)] for cid,brand,g in all_tasks]
    statuses=Counter(r['status'] for r in records)
    errors=Counter(str(r.get('error',{}).get('statusCode',r.get('error',{}).get('kind'))) for r in records if r['status']!='ok')
    payload={'schemaVersion':1,'reportKind':'market-price-index-live-history','source':'SNKRDUNK','currency':'JPY','timezone':'Asia/Tokyo','fetchedAt':utcnow(),'collectionAsOfJST':today.isoformat(),'grades':list(OPTIONS),'targetFingerprint':fingerprint,'scopeSummary':{'attemptedProducts':len(admitted),'attemptedConditions':len(records),'succeededConditions':statuses['ok'],'failedConditions':statuses['failed'],'emptyConditions':sum(r['status']=='ok' and not r['history'] for r in records),'complete':statuses['failed']==0,'errorCounts':dict(errors),'sourceAsOf':latest},'records':records}
    output.parent.mkdir(parents=True,exist_ok=True);temp=output.with_suffix('.tmp')
    with temp.open('w',encoding='utf-8') as stream:json.dump(payload,stream,ensure_ascii=False,separators=(',',':'),allow_nan=False);stream.write('\n')
    temp.replace(output)
    print(json.dumps({'output':str(output),'scopeSummary':payload['scopeSummary'],'elapsedSeconds':round(time.monotonic()-start,1)},ensure_ascii=False),flush=True)
    return 0 if statuses['failed']==0 else 2
if __name__=='__main__':raise SystemExit(main())