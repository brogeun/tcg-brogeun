#!/usr/bin/env python3
"""Bounded read-only official metadata audit; immutable source bytes, no market data.

Run once with --collect, then rerun without it to rebuild from cached source bytes.
No card title, row order, or image suffix determines a rarity.
"""
import argparse,asyncio,collections,copy,gzip,hashlib,json,os,re,shutil,time
from datetime import datetime,timezone
from pathlib import Path
from urllib.parse import urljoin,urlsplit,urlunsplit,parse_qs
import aiohttp
from lxml import html

ROOT=Path(__file__).resolve().parent
INPUT=ROOT/'input'
CACHE=ROOT/'cache'
OUT=ROOT/'final-complete'
GAMES=('dragon_ball_fusion_world','digimon')
MANUFACTURER_HOSTS={'dragon_ball_fusion_world':'www.dbs-cardgame.com','digimon':'digimoncard.com'}

def now():return datetime.now(timezone.utc).isoformat()
def sha(b):return hashlib.sha256(b).hexdigest()
def txt(e):return re.sub(r'\s+',' ',e.text_content()).strip() if e is not None else ''
def first(es):return es[0] if es else None
def tok(s):return 'contains(concat(" ",normalize-space(@class)," ")," '+s+' ")'
def canon(u):
    p=urlsplit(u);return urlunsplit((p.scheme,p.netloc,p.path,'',''))
def writejson(p,d):
    p.parent.mkdir(parents=True,exist_ok=True);t=p.with_suffix('.tmp');t.write_text(json.dumps(d,ensure_ascii=False,separators=(',',':')));t.replace(p)
def cachepaths(game,key):
    p=CACHE/game/(key+'.html.gz');return p,p.with_suffix('.json')
def readcache(game,key):
    p,m=cachepaths(game,key);b=gzip.decompress(p.read_bytes());meta=json.loads(m.read_text())
    if sha(b)!=meta['sha256'] or len(b)!=meta['bytes']:raise ValueError('cache integrity '+str(p))
    return b,meta
def detailkey(u):return 'detail-'+sha(u.encode())[:20]

def initialize(source):
    """Snapshot only the two assigned games, never mutate upstream collectors."""
    if INPUT.exists():return
    INPUT.mkdir(parents=True)
    for game in GAMES:
        original=source/'final-complete'/(game+'.json')
        shutil.copyfile(original,INPUT/(game+'.json'))
        upstream=source/'cache'/game
        if not upstream.is_dir():upstream=source/'cache'/(game+'.held')
        (CACHE/game).mkdir(parents=True,exist_ok=True)
        for p in upstream.glob('*.html.gz'):
            m=p.with_suffix('.json')
            if m.exists():
                shutil.copyfile(p,CACHE/game/p.name);shutil.copyfile(m,CACHE/game/m.name)
    writejson(INPUT/'manifest.json',{'createdAt':now(),'sourceRoot':str(source),'files':[{'file':g+'.json','sha256':sha((INPUT/(g+'.json')).read_bytes())} for g in GAMES]})

async def collect(workers):
    db=json.loads((INPUT/(GAMES[0]+'.json')).read_text());dm=json.loads((INPUT/'digimon.json').read_text())
    jobs=[]
    for p in db['products']:
        for c in p['cards']:
            if not c.get('rarity'):jobs.append((GAMES[0],detailkey(c['url']),c['url'],'text/html'))
    for p in dm['products']:
        if any(not c.get('rarity') for c in p['cards']):jobs.append(('digimon','live-'+p['id'],p['url'],'text/html'))
        for c in p['cards']:
            if not c.get('rarity'):jobs.append(('digimon','image-'+c['id'],c['image'],'image/png'))
    jobs=list(dict.fromkeys(jobs));pending=[]
    for j in jobs:
        try:readcache(j[0],j[1])
        except FileNotFoundError:pending.append(j)
    queue=asyncio.Queue()
    for j in pending:queue.put_nowait(j)
    progress={'requested':len(jobs),'cached':len(jobs)-len(pending),'new':len(pending),'done':0,'failures':[],'startedAt':now()}
    print(json.dumps(progress),flush=True)
    async def worker():
        async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=1),timeout=aiohttp.ClientTimeout(total=60),headers={'User-Agent':'TCGHUB official catalogue integrity audit (+https://tcghub.kr)','Accept-Encoding':'identity'}) as s:
            while not queue.empty():
                try:game,key,url,expected=queue.get_nowait()
                except asyncio.QueueEmpty:return
                try:
                    assert urlsplit(url).hostname==MANUFACTURER_HOSTS[game]
                    async with s.get(url,proxy=os.environ.get('HTTPS_PROXY') or os.environ.get('https_proxy'),allow_redirects=True) as r:
                        body=await r.read();status=r.status;final=str(r.url);ctype=r.headers.get('Content-Type','')
                    if status!=200:raise RuntimeError('HTTP '+str(status)+' (not retried)')
                    if urlsplit(final).hostname!=MANUFACTURER_HOSTS[game]:raise RuntimeError('Non-manufacturer redirect')
                    if expected not in ctype:raise RuntimeError('Unexpected content type '+ctype)
                    if not body:raise RuntimeError('Empty response')
                    p,m=cachepaths(game,key);p.parent.mkdir(parents=True,exist_ok=True)
                    info={'url':url,'finalUrl':final,'method':'GET','parameters':{},'status':status,'contentType':ctype,'fetchedAt':now(),'bytes':len(body),'sha256':sha(body)}
                    p.write_bytes(gzip.compress(body,mtime=0));writejson(m,info)
                    await asyncio.sleep(.15)
                except Exception as e:progress['failures'].append({'game':game,'key':key,'url':url,'error':str(e)})
                finally:
                    progress['done']+=1;queue.task_done()
                    if progress['done']%10==0 or queue.empty():
                        writejson(ROOT/'collection-progress.json',progress);print(json.dumps({'done':progress['done'],'new':progress['new'],'failures':len(progress['failures'])}),flush=True)
    await asyncio.gather(*(worker() for _ in range(min(4,max(1,workers)))))
    progress['finishedAt']=now();writejson(ROOT/'collection-progress.json',progress)

def parse_fw_detail(c):
    b,meta=readcache(GAMES[0],detailkey(c['url']));t=html.fromstring(b)
    images=[canon(urljoin(meta['finalUrl'],u)) for u in t.xpath('//div['+tok('cardImage')+']//img/@src')]
    if images!=[canon(c['image'])]:raise ValueError('Exact detail image mismatch '+c['id'])
    raritynodes=t.xpath('//div['+tok('rarity')+']');number=txt(first(t.xpath('//div['+tok('cardNo')+']')))
    values={txt(first(e.xpath('./h6'))):txt(first(e.xpath('./div['+tok('data')+']'))) for e in t.xpath('//div['+tok('cardDataCell')+']')}
    rarity=txt(first(raritynodes));literal_type=values.get('カードタイプ')
    if number!=c['number']:raise ValueError('Exact number mismatch '+c['id'])
    if not rarity and literal_type!='ENERGY MARKER':raise ValueError('Blank rarity has no literal marker classification '+c['id'])
    return {'id':c['id'],'image':images[0],'number':number,'cardType':literal_type,'rarity':rarity or None,'rarityNodeCount':len(raritynodes),'rarityStatus':'verified' if rarity else 'not_applicable','numberStatus':'verified','acquisition':values.get('入手情報'),'provenance':meta}

def build():
    OUT.mkdir(exist_ok=True);audit={'generatedAt':now(),'games':{},'policy':{'rarityStatus':{'verified':'Literal manufacturer rarity or visually transcribed exact manufacturer printing image','not_applicable':'Literal auxiliary token/energy-marker evidence and manufacturer rarity absent','unavailable':'No sufficient manufacturer evidence / failed request'},'numberStatus':{'verified':'Literal manufacturer identifier confirmed in exact source row/detail','unprinted':'Manufacturer does not assign a card identifier','unavailable':'Not confirmed'},'noInference':'Names, row order, and filename suffixes never supply rarity.'}}
    problems=[];raw_count=0;raw_bytes=0
    manual_path=ROOT/'image-observations.json';observations=json.loads(manual_path.read_text()) if manual_path.exists() else {}
    for game in GAMES:
        original=json.loads((INPUT/(game+'.json')).read_text());data=copy.deepcopy(original)
        inventory_body,inventory_meta=readcache(game,'inventory');inventory_tree=html.fromstring(inventory_body)
        if game=='digimon':
            inventory_ids=list(dict.fromkeys(x for x in inventory_tree.xpath('//select[@name="category"]/option/@value') if x))
        else:inventory_ids=list(dict.fromkeys(x for x in inventory_tree.xpath('//a/@data-val') if re.fullmatch(r'\d{6}',x)))
        if inventory_ids!=[p['id'] for p in original['products']]:problems.append([game,'official_inventory_mismatch'])
        if original.get('inventoryProvenance',{}).get('sha256')!=inventory_meta['sha256']:problems.append([game,'inventory_provenance_mismatch'])
        records=[];category_records=[];exact={};rarity_index={}
        if game==GAMES[0]:
            for rarity in original['rarityFilterCounts']:
                b,meta=readcache(game,'rarity-'+rarity);t=html.fromstring(b);imgs=t.xpath('//li['+tok('cardItem')+']//img')
                for img in imgs:
                    u=canon(urljoin(meta['finalUrl'],img.get('data-src') or img.get('src')))
                    if u in rarity_index and rarity_index[u]['rarity']!=rarity:problems.append([game,'ambiguous-filter-rarity',u])
                    rarity_index[u]={'rarity':rarity,'provenance':meta}
            for p in original['products']:
                for c in p['cards']:
                    if not c.get('rarity'):
                        try:exact[canon(c['image'])]=parse_fw_detail(c)
                        except Exception as e:problems.append([game,p['id'],c['id'],str(e)])
        for p,op in zip(data['products'],original['products']):
            b,meta=readcache(game,p['id']);t=html.fromstring(b)
            if meta['sha256']!=p['provenance']['sha256']:problems.append([game,p['id'],'original_provenance_hash_mismatch'])
            parsed={}
            if game=='digimon':
                for node in t.xpath('//div['+tok('cardDetailCol')+']'):
                    img=first(node.xpath('.//div['+tok('cardImg')+']//img'))
                    if img is None:continue
                    u=canon(urljoin(meta['finalUrl'],img.get('src')))
                    anc=first(node.xpath('ancestor::*[@id][1]'));ident=anc.get('id')
                    rn=node.xpath('.//li['+tok('cardRarity')+']')
                    parsed[(ident,u)]={'number':txt(first(node.xpath('.//li['+tok('cardNo')+']'))),'rarity':txt(first(rn)) or None,'rarityNodeCount':len(rn),'cardType':txt(first(node.xpath('.//li['+tok('cardType')+']'))),'literalTokenText':next((txt(e) for e in node.xpath('.//dd') if 'トークンとして使うことができる' in txt(e)),None)}
                reported=len(t.xpath('//a['+tok('card_img')+']'))
            else:
                for item in t.xpath('//li['+tok('cardItem')+']'):
                    a=first(item.xpath('.//a'));img=first(item.xpath('.//img'))
                    if a is None or img is None:continue
                    u=canon(urljoin(meta['finalUrl'],img.get('data-src') or img.get('src')))
                    detail=urljoin(meta['finalUrl'],a.get('data-src') or a.get('href') or '')
                    literal=(parse_qs(urlsplit(detail).query).get('card_no') or [''])[0]
                    parsed[u]={'number':literal,'imageAlt':img.get('alt'),'detailUrl':detail}
                m=re.search(r'検索結果\s*([\d,]+)\s*件',txt(t));reported=int(m.group(1).replace(',','')) if m else None
            if reported!=p['expectedCardCount'] or len(parsed)!=len(p['cards']):problems.append([game,p['id'],'source_count',reported,len(parsed),len(p['cards'])])
            category_records.append({'categoryId':p['id'],'sourceRowCount':len(parsed),'reportedCount':reported,'snapshotRowCount':len(p['cards']),'provenance':meta})
            for c,oc in zip(p['cards'],op['cards']):
                key=(c['id'],canon(c['image'])) if game=='digimon' else canon(c['image']);row=parsed.get(key)
                if row is None:problems.append([game,p['id'],c['id'],'exact_source_row_missing']);c['rarityStatus']='unavailable';c['numberStatus']='unavailable';continue
                c['numberStatus']='verified' if row['number']==c['number'] and row['number'] else 'unavailable'
                if c['numberStatus']=='unavailable':problems.append([game,p['id'],c['id'],'number_mismatch',row['number'],c['number']])
                c['numberOrigin']='official-cardlist-identifier';c['numberProvenance']=meta
                if game=='digimon':
                    if row['rarity']!=oc.get('rarity'):problems.append([game,p['id'],c['id'],'embedded_rarity_mismatch'])
                    c['cardType']=row['cardType'] or None
                    if row['rarity']:c['rarityStatus']='verified';c['rarityOrigin']='official-embedded-card-detail';c['rarityProvenance']=meta
                    else:
                        obs=observations.get(c['id']);image_body,image_meta=readcache(game,'image-'+c['id'])
                        live_b,live_meta=readcache(game,'live-'+p['id']);live_tree=html.fromstring(live_b);live_node=live_tree.get_element_by_id(c['id'])
                        live_image=canon(urljoin(live_meta['finalUrl'],first(live_node.xpath('.//div['+tok('cardImg')+']//img')).get('src')))
                        if live_image!=canon(c['image']):problems.append([game,p['id'],c['id'],'live_exact_image_mismatch'])
                        live_rarity=txt(first(live_node.xpath('.//li['+tok('cardRarity')+']')))
                        if live_rarity:
                            c['rarity']=live_rarity;c['rarityStatus']='verified';c['rarityOrigin']='official-live-embedded-card-detail';c['rarityProvenance']=live_meta
                        elif obs and obs['sha256']==sha(image_body):
                            if obs.get('rarity'):
                                c['rarity']=obs['rarity'];c['rarityStatus']='verified';c['rarityOrigin']='official-exact-printing-image-literal';c['rarityProvenance']=image_meta
                            elif row['literalTokenText'] and obs.get('rarityAbsent'):
                                c['rarityStatus']='not_applicable';c['rarityNotApplicable']=True;c['rarityNotApplicableOrigin']='official-token-text-and-exact-printing-image';c['rarityProvenance']=meta
                            else:c['rarityStatus']='unavailable'
                        else:c['rarityStatus']='unavailable'
                        records.append({'categoryId':p['id'],'id':c['id'],'image':canon(c['image']),'number':row['number'],'rarityNodeCount':row['rarityNodeCount'],'embeddedRarity':row['rarity'],'liveEmbeddedRarity':live_rarity or None,'literalTokenText':row['literalTokenText'],'cardType':row['cardType'],'rarity':c.get('rarity'),'rarityStatus':c['rarityStatus'],'provenance':meta,'liveProvenance':live_meta,'imageProvenance':image_meta,'imageObservation':obs})
                else:
                    entry=exact.get(canon(c['image']))
                    if entry:
                        c['cardType']=entry['cardType'];c['rarityStatus']=entry['rarityStatus'];c['rarityProvenance']=entry['provenance'];c['detailProvenance']=entry['provenance'];c['numberProvenance']=entry['provenance'];c['numberOrigin']='official-exact-card-detail';c['acquisition']=entry['acquisition']
                        if entry['rarity']:c['rarity']=entry['rarity'];c['rarityOrigin']='official-exact-card-detail'
                        else:c['rarityNotApplicable']=True;c['rarityNotApplicableOrigin']='official-exact-energy-marker-detail'
                        records.append({'categoryId':p['id'],**entry})
                    elif c.get('rarity'):
                        ri=rarity_index.get(canon(c['image']))
                        if not ri or ri['rarity']!=c['rarity']:problems.append([game,p['id'],c['id'],'rarity_filter_not_verified']);c['rarityStatus']='unavailable'
                        else:c['rarityStatus']='verified';c['rarityOrigin']='official-exact-image-rarity-filter';c['rarityProvenance']=ri['provenance']
                    else:c['rarityStatus']='unavailable'
            p['rarityComplete']=all(c['rarityStatus'] in ('verified','not_applicable') for c in p['cards'])
            p['numberComplete']=all(c['numberStatus'] in ('verified','unprinted') for c in p['cards'])
        # Preserve acquisition grouping membership; propagate only exact image matches.
        byimage={canon(c['image']):c for p in data['products'] for c in p['cards']}
        for p in data.get('derivedProducts',[]):
            for i,c in enumerate(p['cards']):p['cards'][i]=copy.deepcopy(byimage[canon(c['image'])])
            p['rarityComplete']=all(c['rarityStatus'] in ('verified','not_applicable') for c in p['cards']);p['numberComplete']=all(c['numberStatus'] in ('verified','unprinted') for c in p['cards'])
        cs=[c for p in data['products'] for c in p['cards']]
        identity=lambda d:[(p['id'],[(c['id'],c['number'],c['name'],c['image'],c['url']) for c in p['cards']]) for p in d['products']]
        membership_unchanged=identity(data)==identity(original)
        if not membership_unchanged:problems.append([game,'membership_or_source_order_changed'])
        data['metadataAudit']={'auditedAt':now(),'source':'official-manufacturer-only','complete':all(p['rarityComplete'] and p['numberComplete'] for p in data['products']),'officialInventoryCount':len(inventory_ids),'inventoryProvenance':inventory_meta,'rarityStatusCounts':dict(collections.Counter(c['rarityStatus'] for c in cs)),'numberStatusCounts':dict(collections.Counter(c['numberStatus'] for c in cs)),'previouslyMissingRarityRows':len(records),'allExactImagesMatched':not any(x[0]==game and 'image' in str(x).lower() for x in problems),'membershipAndSourceOrderUnchanged':membership_unchanged}
        data['rarityCoverageComplete']=all(p['rarityComplete'] for p in data['products'])
        audit['games'][game]={'categories':len(data['products']),'rows':len(cs),'derivedProducts':len(data.get('derivedProducts',[])),**data['metadataAudit'],'categoriesAudit':category_records,'previouslyMissingRarityAudit':records}
        writejson(OUT/(game+'.json'),data)
    manifest=[]
    for p in sorted(CACHE.glob('*/*.html.gz')):
        game=p.parent.name;key=p.name.removesuffix('.html.gz');b,meta=readcache(game,key);raw_count+=1;raw_bytes+=len(b)
        if urlsplit(meta['url']).hostname!=MANUFACTURER_HOSTS[game]:problems.append([str(p),'non_official_host'])
        manifest.append({'file':str(p.relative_to(ROOT)),'metadataFile':str(p.with_suffix('.json').relative_to(ROOT)),**meta})
    writejson(OUT/'source-manifest.json',manifest);writejson(OUT/'metadata-audit.json',audit)
    validation={'checkedAt':now(),'passed':not problems and all(g['complete'] for g in audit['games'].values()),'rawSourceResponsesChecked':raw_count,'rawSourceBytesChecked':raw_bytes,'games':{g:{k:v for k,v in x.items() if k not in ('categoriesAudit','previouslyMissingRarityAudit')} for g,x in audit['games'].items()},'problems':problems,'pureCollectorCommand':'python collect_other_metadata.py --build','collectionCommand':'python collect_other_metadata.py --collect --workers 3 --build'}
    writejson(OUT/'validation.json',validation);print(json.dumps(validation,ensure_ascii=False,indent=2),flush=True)
    return validation

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--source-root',type=Path,default=ROOT.parent/'research_bandai');ap.add_argument('--workers',type=int,default=3);ap.add_argument('--collect',action='store_true');ap.add_argument('--build',action='store_true');a=ap.parse_args()
    initialize(a.source_root)
    if a.collect:asyncio.run(collect(a.workers))
    if a.build:
        result=build()
        if not result['passed']:raise SystemExit(1)
if __name__=='__main__':main()
