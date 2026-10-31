"""Resume all CIDs for the reviewed 297 products; never infer printing numbers.

Six workers share collect_konami.fetch's >=0.34-second request-start interval,
falling back to0.55 seconds after source failures or sustained latency growth.
Successful HTML and parsed records are atomic and resumable. Explicit blocks
stop collection, without challenge bypass or alternative identities.
"""
from __future__ import annotations
import concurrent.futures, json, time, urllib.error, http.client, gzip, hashlib, shutil
from pathlib import Path
import collect_konami as c

ROOT=Path(__file__).resolve().parent

def atomic_json(path,value):
    tmp=path.with_name(path.name+'.tmp')
    tmp.write_text(json.dumps(value,ensure_ascii=False,indent=2));tmp.replace(path)

def task(cid):
    for attempt in range(1,4):
        try:
            detail=c.collect_one_detail(cid)
            return {'cardId':cid,'ok':True,'printingRows':len(detail['printings']),'attempts':attempt}
        except c.SourceBlocked:
            raise
        except (OSError,urllib.error.URLError,http.client.HTTPException) as ex:
            c.MIN_INTERVAL=.55;c.RATE_BACKOFF_REASON='Transient public request failure'
            if attempt==3:return {'cardId':cid,'ok':False,'error':repr(ex),'attempts':attempt}
            time.sleep(3*attempt)
        except Exception as ex:
            c.MIN_INTERVAL=.55;c.RATE_BACKOFF_REASON='Source validation failure'
            return {'cardId':cid,'ok':False,'error':repr(ex),'attempts':attempt}

def main():
    index={p['id']:p for p in c.load_index()};product_repairs=[]
    for path in (ROOT/'parsed_products').glob('*.json'):
        raw_path=ROOT/'cache_products'/(path.stem+'.html.gz')
        try:
            saved=json.loads(path.read_text());raw=gzip.decompress(raw_path.read_bytes()).decode()
            if not raw or hashlib.sha256(raw.encode()).hexdigest()!=saved['sourceSha256']:raise ValueError('Cached product HTML hash mismatch or empty source')
        except Exception as ex:
            archive=ROOT/'invalid_cached_sources';archive.mkdir(exist_ok=True);token=str(time.time_ns())
            shutil.move(path,archive/(path.name+'.product.'+token))
            if raw_path.exists():shutil.move(raw_path,archive/(raw_path.name+'.product.'+token))
            c.collect_one_product(index[path.stem]);product_repairs.append({'productId':path.stem,'reason':repr(ex)})
    if product_repairs:atomic_json(ROOT/'invalid_cached_sources'/'product_repair_report.json',{'preservedAt':c.now(),'invalidRecords':product_repairs})
    products=[json.loads(p.read_text()) for p in sorted((ROOT/'parsed_products').glob('*.json'))]
    weights={}
    for p in products:
        for card in p['cards']:weights[card['cardId']]=weights.get(card['cardId'],0)+1
    cached=set();invalid=[]
    for path in (ROOT/'parsed_details').glob('*.json'):
        if path.stem not in weights:continue
        raw_path=ROOT/'cache_details'/(path.stem+'.html.gz')
        try:
            saved=json.loads(path.read_text());raw=gzip.decompress(raw_path.read_bytes()).decode()
            if not raw or hashlib.sha256(raw.encode()).hexdigest()!=saved['sourceSha256']:raise ValueError('Cached HTML hash mismatch or empty source')
            cached.add(path.stem)
        except Exception as ex:
            archive=ROOT/'invalid_cached_sources';archive.mkdir(exist_ok=True)
            token=str(time.time_ns());shutil.move(path,archive/(path.name+'.'+token))
            if raw_path.exists():shutil.move(raw_path,archive/(raw_path.name+'.'+token))
            invalid.append({'cardId':path.stem,'reason':repr(ex)})
    if invalid:atomic_json(ROOT/'invalid_cached_sources'/'repair_report.json',{'preservedAt':c.now(),'invalidRecords':invalid})
    wanted=sorted(weights,key=lambda cid:(-weights[cid],int(cid)))
    selected=[cid for cid in wanted if cid not in cached]
    start=time.monotonic();last=start;done=0;errors=[];blocked=None
    atomic_json(ROOT/'collection_plan.json',{'startedAt':c.now(),'products':len(products),'uniqueTargetCids':len(wanted),'cachedAtStart':len(cached&set(wanted)),'remainingAtStart':len(selected),'minimumSeconds':len(selected)*c.MIN_INTERVAL,'requestStartIntervalSeconds':c.MIN_INTERVAL,'workers':6,'targetCids':wanted})
    def report(final=False):
        elapsed=time.monotonic()-start
        d={'updatedAt':c.now(),'targetCids':len(wanted),'cachedAtStart':len(cached&set(wanted)),'completedThisRun':done,'totalCompleted':len(cached&set(wanted))+done-len(errors),'remaining':len(selected)-done,'errors':errors,'blocked':blocked,'elapsedSeconds':round(elapsed,1),'requestsPerSecond':round(done/elapsed,3) if elapsed else 0,'etaSeconds':round((len(selected)-done)*elapsed/done) if done else None,'requestStartIntervalSeconds':c.MIN_INTERVAL,'recentMeanRequestSeconds':round(sum(c.REQUEST_TIMINGS[-100:])/len(c.REQUEST_TIMINGS[-100:]),3) if c.REQUEST_TIMINGS else None,'rateBackoffReason':c.RATE_BACKOFF_REASON,'finished':final}
        atomic_json(ROOT/'collection_progress.json',d);print(json.dumps(d,ensure_ascii=False),flush=True)
    report()
    iterator=iter(selected)
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        pending={}
        def fill():
            while len(pending)<12 and not c.STOP.is_set():
                cid=next(iterator,None)
                if cid is None:break
                pending[pool.submit(task,cid)]=cid
        fill()
        while pending:
            finished,_=concurrent.futures.wait(pending,timeout=5,return_when=concurrent.futures.FIRST_COMPLETED)
            for f in finished:
                cid=pending.pop(f)
                try:
                    result=f.result();done+=1
                    if not result['ok']:errors.append(result)
                except c.SourceBlocked as ex:
                    blocked={'cardId':cid,'error':str(ex)};c.STOP.set()
            if c.STOP.is_set():
                for f in pending:f.cancel()
                break
            fill()
            if time.monotonic()-last>=55:report();last=time.monotonic()
    report(True)
    if blocked or errors:raise SystemExit(2)

if __name__=='__main__':main()
