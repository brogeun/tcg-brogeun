"""Read-only KONAMI OCG product/member collector with resumable source caches.

Product identities and memberships come from the Japanese official database.
Printed set numbers are filled ONLY from official per-card printings tables.
The product list's row order is never interpreted as a printed number.
"""
from __future__ import annotations
import argparse, concurrent.futures, datetime, gzip, hashlib, html, json
import re, sys, threading, time, unicodedata, urllib.error, urllib.parse, urllib.request, http.client, io
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent/'deps'))
from bs4 import BeautifulSoup, SoupStrainer

ROOT=Path(__file__).resolve().parent
ORIGIN='https://www.db.yugioh-card.com'
INDEX=ORIGIN+'/yugiohdb/card_list.action?request_locale=ja'
UA='TCGHUB catalogue integrity audit (+https://tcghub.kr)'
LOCK=threading.Lock(); NEXT=0.0
STOP=threading.Event()
CONNECTIONS=threading.local()
MIN_INTERVAL=.34
NETWORK_LOCK=threading.Lock();REQUEST_TIMINGS=[];LATENCY_BASELINE=None;RATE_BACKOFF_REASON=None

def request_public(url):
    """Reuse a normal public HTTPS connection per worker; retain no cookies."""
    parts=urllib.parse.urlsplit(url)
    if parts.scheme!='https':raise ValueError('Public collector requires HTTPS')
    key=(parts.hostname,parts.port or 443)
    connection=getattr(CONNECTIONS,'connection',None)
    if connection is None or getattr(CONNECTIONS,'key',None)!=key:
        proxy=urllib.request.getproxies().get('https')
        proxy_parts=urllib.parse.urlsplit(proxy) if proxy and not urllib.request.proxy_bypass(parts.hostname) else None
        if proxy_parts and (proxy_parts.scheme!='http' or proxy_parts.username or proxy_parts.password):
            req=urllib.request.Request(url,headers={'User-Agent':UA,'Accept-Encoding':'gzip'})
            with urllib.request.urlopen(req,timeout=45) as response:
                return response.status,dict(response.headers),response.read()
        if proxy_parts:
            connection=http.client.HTTPSConnection(proxy_parts.hostname,proxy_parts.port or 80,timeout=45)
            connection.set_tunnel(parts.hostname,parts.port or 443)
        else:connection=http.client.HTTPSConnection(parts.hostname,parts.port or 443,timeout=45)
        CONNECTIONS.connection=connection;CONNECTIONS.key=key
    try:
        path=urllib.parse.urlunsplit(('','',parts.path,parts.query,''))
        connection.request('GET',path,headers={'User-Agent':UA,'Accept-Encoding':'gzip'})
        response=connection.getresponse();data=response.read()
        return response.status,dict(response.headers),data
    except Exception:
        connection.close();CONNECTIONS.connection=None;raise

class SourceBlocked(RuntimeError): pass

def preserve_failure(cache,data,status):
    destination=cache.parent/'failures'/f'{cache.name}.{time.time_ns()}.HTTP{status}.gz'
    destination.parent.mkdir(parents=True,exist_ok=True)
    destination.write_bytes(gzip.compress(data))
    return destination

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def norm(s): return re.sub(r'[^0-9a-z\u3040-\u30ff\u3400-\u9fff]','',unicodedata.normalize('NFKC',s).lower())
def clean(s): return ' '.join(s.split())
def fetch(url, cache, delay=None):
    global NEXT,MIN_INTERVAL,LATENCY_BASELINE,RATE_BACKOFF_REASON
    if cache.exists(): return gzip.decompress(cache.read_bytes()).decode('utf-8'),True
    if STOP.is_set(): raise SourceBlocked('Collection stopped after source access block')
    with LOCK:
        time.sleep(max(0,NEXT-time.monotonic()))
        NEXT=time.monotonic()+max(MIN_INTERVAL,delay or 0)
    if STOP.is_set(): raise SourceBlocked('Collection stopped after source access block')
    started=time.monotonic()
    try:
        status,headers,data=request_public(url)
        duration=time.monotonic()-started
        with NETWORK_LOCK:
            REQUEST_TIMINGS.append(duration)
            if len(REQUEST_TIMINGS)==100:LATENCY_BASELINE=sum(REQUEST_TIMINGS[20:100])/80
            if len(REQUEST_TIMINGS)>=200:
                recent=sum(REQUEST_TIMINGS[-100:])/100
                if LATENCY_BASELINE and recent>max(2.5,LATENCY_BASELINE*2):
                    MIN_INTERVAL=.55;RATE_BACKOFF_REASON='Mean request latency increased beyond baseline'
        retry_after=next((value for key,value in headers.items() if key.lower()=='retry-after'),None)
        if retry_after:
            MIN_INTERVAL=.55;RATE_BACKOFF_REASON='Server returned Retry-After: '+retry_after
        data=gzip.decompress(data) if any(k.lower()=='content-encoding' and v=='gzip' for k,v in headers.items()) else data
        if status!=200:raise urllib.error.HTTPError(url,status,'Official public source error',headers,io.BytesIO(data))
    except urllib.error.HTTPError as ex:
        MIN_INTERVAL=.55;RATE_BACKOFF_REASON='HTTP failure '+str(ex.code)
        data=ex.read(); preserve_failure(cache,data,ex.code)
        if ex.code in (401,403,429):
            STOP.set(); raise SourceBlocked(f'HTTP {ex.code}; raw response preserved; collection stopped') from ex
        raise
    text=data.decode('utf-8')
    lower=text.lower()
    if ('incapsula' in lower and 'card_list' not in lower) or any(x in lower for x in ('<title>access denied','<title>request unsuccessful','verify you are human','captcha-container')):
        preserve_failure(cache,data,200);STOP.set();raise SourceBlocked('Source access challenge; raw response preserved; collection stopped')
    cache.parent.mkdir(parents=True,exist_ok=True)
    temporary=cache.with_name(cache.name+'.tmp');temporary.write_bytes(gzip.compress(data));temporary.replace(cache)
    return text,False

def images(text):
    out={}
    for ids,url in re.findall(r"\$\('#([^']+)'\)\.attr\('src', '([^']+)'\)",text):
        for ident in ids.split(','):
            out[ident.lstrip('#')]=urllib.parse.urljoin(ORIGIN,html.unescape(url))
    return out

def parse_index(text):
    soup=BeautifulSoup(text,'html.parser');products=[];seen=set()
    for row in soup.select('.t_row'):
        link=row.select_one('input.link_value');name=row.select_one('.main p')
        if not link or not name:continue
        url=urllib.parse.urljoin(ORIGIN,html.unescape(link.get('value','')))
        q=urllib.parse.parse_qs(urllib.parse.urlsplit(url).query);pid=q.get('pid',[None])[0]
        if not pid:continue
        if pid in seen:raise ValueError('Duplicate official product ID '+pid)
        seen.add(pid);date=row.select_one('.time');category=row.select_one('.catergory')
        products.append({'id':pid,'name':clean(name.get_text(' ',strip=True)),
                         'releasedAt':clean(date.get_text(' ',strip=True)) if date else None,
                         'category':clean(category.get_text(' ',strip=True)) if category else None,
                         'url':url+'&request_locale=ja','classes':' '.join(row.get('class',[]))})
    if not products:raise ValueError('No official product index rows')
    return products

def load_index():
    path=ROOT/'products.json'
    if path.exists():return json.loads(path.read_text())
    text,_=fetch(INDEX,ROOT/'cache_index.html.gz');products=parse_index(text)
    path.write_text(json.dumps(products,ensure_ascii=False,indent=2));return products

def parse_product(meta,text):
    soup=BeautifulSoup(text,'html.parser'); image_map=images(text)
    rows=soup.select('#card_list .t_row'); expected=None
    for el in soup.select('.text'):
        m=re.fullmatch(r'全\s*([\d,]+)\s*枚',el.get_text(' ',strip=True))
        if m: expected=int(m.group(1).replace(',',''));break
    result={**meta,'parserVersion':2,'game':'yugioh','kind':'ocg','source':'KONAMI OCG Japanese card database','sourceUrl':meta['url'],
            'officialCardCount':expected,'memberCount':len(rows),'sourceSha256':hashlib.sha256(text.encode()).hexdigest(),
            'complete':expected is not None and expected==len(rows),'numberCompleteness':False,'cards':[]}
    seen=set()
    for row in rows:
        link=row.select_one('input.link_value'); name=row.select_one('.card_name');im=row.select_one('.cardimg img')
        if not link or not name: raise ValueError('Missing official row identity')
        url=urllib.parse.urljoin(ORIGIN,link.get('value',''))+'&request_locale=ja'
        q=urllib.parse.parse_qs(urllib.parse.urlsplit(url).query); cid=q['cid'][0];iid=q.get('iid',['1'])[0]
        rarities=row.select('.icon.rarity.pack_r .lr_icon') or row.select('.icon.rarity .lr_icon')
        if not rarities: rarities=[None]
        for rare in rarities:
            p=rare.select_one('p') if rare else None;sp=rare.select_one('span') if rare else None
            rarity=clean(p.get_text(' ',strip=True)) if p else 'unspecified'
            rid=next((x[4:] for x in rare.get('class',[]) if re.fullmatch(r'rid_\d+',x)),None) if rare else None
            identity=(cid,iid,rid or rarity)
            if identity in seen: raise ValueError('Duplicate official variant '+str(identity))
            seen.add(identity)
            result['cards'].append({'id':f"KONAMI:{meta['id']}:{cid}:{iid}:R{rid or rarity}",'cardId':cid,'artworkId':iid,
                                    'number':None,'name':clean(name.get_text(' ',strip=True)),'rarity':rarity,'rarityId':rid,
                                    'rarityLabel':clean(sp.get_text(' ',strip=True)) if sp else None,'variant':clean(sp.get_text(' ',strip=True)) if sp else None,
                                    'image':image_map.get(im.get('id')) if im else None,'url':url,'language':'ja',
                                    'numberVerified':False})
    result['printingCount']=len(result['cards'])
    if not result['complete']: result['incompleteReason']=f"Official total {expected}; parsed rows {len(rows)}"
    return result

def parse_detail(cid,text):
    # Only the published printing table is needed. lxml avoids parsing page
    # navigation and related-card panels for each of the 12,469 target CIDs.
    soup=BeautifulSoup(text,'lxml',parse_only=SoupStrainer(id='update_list')); image_map=images(text);out=[]
    for row in soup.select('#update_list .t_row'):
        number=row.select_one('.card_number');link=row.select_one('input.link_value');pack=row.select_one('.pack_name')
        if not number or not link or not pack: continue
        q=urllib.parse.parse_qs(urllib.parse.urlsplit(html.unescape(link.get('value',''))).query)
        pid=q.get('pid',[None])[0]
        if not pid:continue
        iid=next((x.rsplit('_',1)[-1] for x in row.get('class',[]) if x.startswith('pack_iid_')),'1')
        printed=clean(number.get_text(' ',strip=True));date=row.select_one('.time')
        for rare in row.select('.icon.rarity .lr_icon') or [None]:
            p=rare.select_one('p') if rare else None;sp=rare.select_one('span') if rare else None
            rarity=clean(p.get_text(' ',strip=True)) if p else 'unspecified'
            rid=next((x[4:] for x in rare.get('class',[]) if re.fullmatch(r'rid_\d+',x)),None) if rare else None
            image=next((v for k,v in image_map.items() if k=='update_list_card_image_'+iid),None)
            out.append({'productId':pid,'cardId':str(cid),'artworkId':iid,'number':printed,'rarity':rarity,'rarityId':rid,
                        'rarityLabel':clean(sp.get_text(' ',strip=True)) if sp else None,'image':image,
                        'productName':clean(pack.get_text(' ',strip=True)),
                        'releasedAt':clean(date.get_text(' ',strip=True)) if date else None,
                        'sourceUrl':ORIGIN+f'/yugiohdb/card_search.action?ope=2&cid={cid}&request_locale=ja'})
    if not out: raise ValueError('No official printing rows')
    return {'parserVersion':2,'cardId':str(cid),'sourceUrl':ORIGIN+f'/yugiohdb/card_search.action?ope=2&cid={cid}&request_locale=ja',
            'complete':True,'sourceSha256':hashlib.sha256(text.encode()).hexdigest(),'printings':out}

def aliases(products):
    by={}
    for p in products:
        for a in [p['name']]+re.findall(r'\[([^]]+)\]',p['name']): by.setdefault(norm(a),[]).append(p['id'])
    return by

def initial_mapping(boxes,products):
    by=aliases(products);out=[]
    for box in boxes:
        quoted=re.findall(r'"([^"]+)"',box['name'])
        name=re.sub(r'^Yu-Gi-Oh (?:OCG|TCG) (?:Duel Monsters )?','',box['name'],flags=re.I)
        name=re.sub(r' (?:JP Edition )?Box.*$','',name,flags=re.I)
        ids=list(dict.fromkeys(pid for a in quoted+[name] for pid in by.get(norm(a),[])))
        out.append({'boxId':box['id'],'name':box['name'],'code':box.get('code'),'setIds':box.get('setIds',[]),
                    'productIds':ids,'method':'exact-official-title' if ids else None})
    return out

def collect_one_product(meta):
    fn=ROOT/'parsed_products'/f"{meta['id']}.json"
    if fn.exists():
        try:
            saved=json.loads(fn.read_text())
            if saved.get('parserVersion')==2:return saved
        except json.JSONDecodeError:pass
    text,cached=fetch(meta['url'],ROOT/'cache_products'/f"{meta['id']}.html.gz")
    d=parse_product(meta,text);d['fetchedAt']=now();fn.parent.mkdir(exist_ok=True)
    temporary=fn.with_suffix('.json.tmp');temporary.write_text(json.dumps(d,ensure_ascii=False));temporary.replace(fn)
    return d

def collect_one_detail(cid):
    fn=ROOT/'parsed_details'/f'{cid}.json'
    if fn.exists():
        try:
            saved=json.loads(fn.read_text())
            if saved.get('parserVersion')==2:return saved
        except json.JSONDecodeError:pass
    url=ORIGIN+f'/yugiohdb/card_search.action?ope=2&cid={cid}&request_locale=ja'
    text,cached=fetch(url,ROOT/'cache_details'/f'{cid}.html.gz')
    canonical=re.search(r'<meta\s+property="og:url"\s+content="([^"]+)"',text)
    if not canonical or urllib.parse.parse_qs(urllib.parse.urlsplit(html.unescape(canonical.group(1))).query).get('cid')!=[str(cid)]:
        raise ValueError('Official response canonical CID differs from requested CID')
    d=parse_detail(cid,text);d['fetchedAt']=now();fn.parent.mkdir(exist_ok=True)
    temporary=fn.with_suffix('.json.tmp');temporary.write_text(json.dumps(d,ensure_ascii=False));temporary.replace(fn);return d

def build_output(products,mappings,errors):
    # Keep the legacy library entry point on the corrected, explicit native
    # printing exporter. Never fall back to one number per representative IID.
    import export_complete
    return export_complete.export_snapshot(products,mappings,errors)

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--repo',type=Path,default=ROOT.parent/'tcghub-official-rebuild')
    ap.add_argument('--products',choices=['matched','all-packages','none'],default='matched');ap.add_argument('--representatives',action='store_true')
    ap.add_argument('--detail-limit',type=int,default=0);ap.add_argument('--workers',type=int,default=3)
    args=ap.parse_args();products=load_index()
    game=next(g for g in json.loads((args.repo/'data/tcg-card-info.json').read_text())['games'] if g['id']=='yugioh')
    mappings=initial_mapping(game['boxes'],products);wanted={pid for m in mappings for pid in m['productIds']}
    if args.products=='all-packages':wanted.update(p['id'] for p in products if re.search(r'\bpackc[1234]\b',p['classes']))
    if args.products=='none':wanted=set()
    errors=[];todo=[p for p in products if p['id'] in wanted]
    print(json.dumps({'productsRequested':len(todo),'initialMappedBoxes':sum(bool(m['productIds']) for m in mappings)}),flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        fut={pool.submit(collect_one_product,p):p for p in todo}
        for i,f in enumerate(concurrent.futures.as_completed(fut),1):
            try:f.result()
            except Exception as ex:errors.append({'productId':fut[f]['id'],'error':str(ex)})
            if i%10==0:print(json.dumps({'productsFinished':i,'errors':len(errors)}),flush=True)
    parsed=[json.loads(p.read_text()) for p in (ROOT/'parsed_products').glob('*.json')] if (ROOT/'parsed_products').exists() else []
    cids=[]
    if args.representatives:cids=list(dict.fromkeys(p['cards'][0]['cardId'] for p in parsed if p['cards']))
    if args.detail_limit:
        seen=set(cids)
        for p in sorted(parsed,key=lambda p:p.get('releasedAt',''),reverse=True):
            for c in p['cards']:
                if c['cardId'] not in seen:cids.append(c['cardId']);seen.add(c['cardId'])
        cids=cids[:args.detail_limit]
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        fut={pool.submit(collect_one_detail,cid):cid for cid in cids}
        for i,f in enumerate(concurrent.futures.as_completed(fut),1):
            try:f.result()
            except Exception as ex:errors.append({'cardId':fut[f],'error':str(ex)})
            if i%10==0:print(json.dumps({'detailsFinished':i,'errors':len(errors)}),flush=True)
    result=build_output(products,mappings,errors);print(json.dumps(result['coverage']),flush=True)

if __name__=='__main__':main()
