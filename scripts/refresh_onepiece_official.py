"""Bounded public official inventory refresh. Preserve the complete last-good source on any error."""
from __future__ import annotations
import argparse, concurrent.futures, hashlib, json, re, threading, urllib.parse, urllib.request
from datetime import datetime, timezone
from pathlib import Path

BASE='https://www.onepiece-cardgame.com';LIST=BASE+'/cardlist/'
def parse_sets(body):
    from bs4 import BeautifulSoup
    soup=BeautifulSoup(body,'html.parser');rows=[]
    for opt in soup.select('select[name=series] option[value]'):
        sid=opt['value'];label=BeautifulSoup(opt.get_text(' ',strip=True),'html.parser').get_text(' ',strip=True)
        m=re.search(r'【((?:OP|EB|PRB|ST)-\d+)】',label)
        if m:
            code=m[1].replace('-','');category='starter'if code.startswith('ST')else'premium_booster'if code.startswith('PRB')else'extra_booster'if code.startswith('EB')else'booster'
        elif sid in {'550901','550801','550701'}:
            code,category={'550901':('PROMO','promotion'),'550801':('LIMITED','limited_product'),'550701':('FAMILY','family_deck')}[sid]
        else:continue
        if not sid.isdigit():raise ValueError('Invalid official series ID')
        rows.append({'code':code,'seriesId':sid,'name':label,'category':category,'sourceUrl':LIST+'?series='+sid})
    if len(rows)<63 or len({r['code']for r in rows})!=len(rows):raise ValueError('Incomplete official series dropdown')
    return rows
def parse_cards(body,row):
    from bs4 import BeautifulSoup
    soup=BeautifulSoup(body,'html.parser');cards=[]
    for dl in soup.select('dl.modalCol[id]'):
        spans=dl.select('.infoCol span');image=dl.select_one('.frontCol img');name=dl.select_one('.cardName')
        if len(spans)<3 or not image or not name:raise ValueError('Incomplete official card markup')
        printed=spans[0].get_text(strip=True);m=re.fullmatch(r'((?:OP|EB|PRB|ST)\d+|P)-(.+)',printed)
        if not m:raise ValueError('Unknown printed number '+printed)
        url=urllib.parse.urljoin(LIST,image.get('data-src')or image.get('src')or'')
        if not url.startswith(BASE+'/images/cardlist/card/'):raise ValueError('Invalid official image')
        info=dl.select_one('.getInfo');acq=''
        if info:
            copy=BeautifulSoup(str(info),'html.parser')
            for x in copy.select('h3,.getInfoBtnCol'):x.decompose()
            acq=copy.get_text(' ',strip=True)
        cards.append({'officialId':dl['id'],'fullId':dl['id'],'printedNumber':printed,'fullCardNumber':printed,
            'number':m[2],'baseNumber':m[2],'setCode':m[1],'boxCode':row['code'],'brand':'onepiece','kind':'card',
            'language':'ja','rarity':spans[1].get_text(strip=True),'cardType':spans[2].get_text(strip=True),
            'name':name.get_text(' ',strip=True),'image':url,'acquisition':acq,
            'acquisitionLinks':[{'label':a.get_text(' ',strip=True),'url':urllib.parse.urljoin(LIST,a['href'])}for a in dl.select('.getInfo a[href]')],
            'sourceUrl':row['sourceUrl'],'officialSeriesId':row['seriesId'],'sourceCategory':row['category']})
    if not cards or len({c['officialId']for c in cards})!=len(cards):raise ValueError('Empty or duplicate official artwork list')
    if any(not c['rarity']or not c['name']or not c['acquisition']for c in cards):raise ValueError('Missing official identity metadata')
    return cards
def refresh(root,workers=2):
    from build_onepiece_official import load_snapshot,write
    previous=load_snapshot(root);stamp=datetime.now(timezone.utc).isoformat();stop=threading.Event()
    def get(url):
        if stop.is_set():raise RuntimeError('Official source refresh stopped after a provider failure')
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0 TCGHUB-OfficialInventory'}),timeout=30)as r:
                if urllib.parse.urlparse(r.url).hostname!='www.onepiece-cardgame.com':raise ValueError('Unexpected official redirect')
                body=r.read(10_000_001)
                if len(body)>10_000_000:raise ValueError('Oversized official response')
                return body
        except Exception:stop.set();raise
    try:
        seed=get(LIST+'?series=550901');sets=parse_sets(seed.decode('utf-8'))
        if len(sets)>120:raise ValueError('Official inventory exceeds bounded request budget')
        def collect(row):
            body=seed if row['seriesId']=='550901'else get(row['sourceUrl'])
            return {**row,'cards':parse_cards(body.decode('utf-8'),row),'sourceSnapshotSHA256':hashlib.sha256(body).hexdigest()}
        with concurrent.futures.ThreadPoolExecutor(max_workers=max(1,min(2,workers)))as pool:results=list(pool.map(collect,sets))
        old={s['code']:{c['officialId']for c in s['cards']}for s in previous['sets']}
        new={s['code']:{c['officialId']for c in s['cards']}for s in results}
        if any(not ids<=new.get(code,set())for code,ids in old.items()):raise ValueError('Official source lost previously published artworks; retaining last-good source for review')
        value={'schemaVersion':1,'collectedAt':stamp,'sets':results}
        destination=root/'data/onepiece-official-source.json';temp=destination.with_suffix('.json.tmp');write(temp,value);temp.replace(destination)
        write(root/'data/onepiece-official-refresh.json',{'status':'success','checkedAt':stamp,'sets':len(results),'officialCards':sum(len(s['cards'])for s in results),'sourceAsOf':stamp})
        return {'status':'success','sets':len(results)}
    except Exception as error:
        write(root/'data/onepiece-official-refresh.json',{'status':'retained-after-error','checkedAt':stamp,'sourceAsOf':previous['collectedAt'],'error':str(error)[:300]})
        raise
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1]);a=p.parse_args();print(json.dumps(refresh(a.root)))
