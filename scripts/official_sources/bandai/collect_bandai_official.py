#!/usr/bin/env python3
"""Collect the complete published Japanese Bandai product card lists.

Read-only manufacturer HTML collection. Client-side pagers are not server
pagination: all printed images are retained from each product response.
Rarity filters supply DB rarity labels without relying on market inventory.
Missing data is reported, never guessed. HTTP failures preserve cached pages.
"""
from __future__ import annotations
import argparse, collections, gzip, hashlib, json, re, time, unicodedata
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from lxml import html

ROOT = Path(__file__).resolve().parent
CACHE_ROOT = ROOT/'cache'

def configure(output_dir=None,cache_dir=None):
    global ROOT,CACHE_ROOT
    ROOT=Path(output_dir).resolve() if output_dir else Path(__file__).resolve().parent
    CACHE_ROOT=Path(cache_dir).resolve() if cache_dir else ROOT/'cache'
    ROOT.mkdir(parents=True,exist_ok=True);CACHE_ROOT.mkdir(parents=True,exist_ok=True)
    return ROOT,CACHE_ROOT

BASES = {
    'union_arena':'https://www.unionarena-tcg.com/jp/cardlist/',
    'digimon':'https://digimoncard.com/cards/',
    'dragon_ball_fusion_world':'https://www.dbs-cardgame.com/fw/jp/cardlist/',
}
UA_RARITIES = ['SR','R','U','C','PcSR','PcR','PcC','UR','SP','PR','OBC']
DB_RARITIES = ['L','C','UC','R','SR','SCR','PR']
errors = []

def now(): return datetime.now(timezone.utc).isoformat()
def text(e): return re.sub(r'\s+',' ',e.text_content()).strip() if e is not None else ''
def tok(cls): return 'contains(concat(" ",normalize-space(@class)," ")," '+cls+' ")'
def first(es): return es[0] if es else None
def canonical_image(u):
    p=urlsplit(u);return urlunsplit((p.scheme,p.netloc,p.path,'',''))
def product_code(title):
    m=re.search(r'[\[【]([A-Z][A-Z0-9 -]*\d[A-Z0-9 -]*)[\]】]',title)
    return re.sub(r'[ -]','',m.group(1)) if m else None
def kind(title,code=None):
    if code and re.fullmatch(r'PC\d+BT',code):return 'premium_booster'
    if code and re.fullmatch(r'UA\d+DC',code):return 'starter_deck'
    if re.search(r'プロモーション|プロモカード',title):return 'promo'
    if re.search(r'大会景品|店舗イベント|争奪|バトル景品',title):return 'event_reward'
    if re.search(r'スタート|アドバンスデッキ|トライアル',title) or (code and re.fullmatch(r'UA\d+ST',code)):return 'starter_deck'
    if re.search(r'プレミアム|NEW CARD|リミテッドカードセット|その他物販',title):return 'special_set'
    if re.search(r'リミテッド',title):return 'limited_pack'
    if re.search(r'MANGA',title):return 'manga_booster'
    if re.search(r'STORY',title):return 'story_booster'
    if re.search(r'エクストラ|テーマブースター',title) or (code and re.fullmatch(r'EX\d+BT',code)):return 'extra_booster'
    if re.search(r'リブート',title):return 'reboot_booster'
    if re.search(r'ブースター',title) or (code and re.fullmatch(r'UA\d+BT',code)):return 'booster'
    return 'special_set'

def fetch(game,key,url,data=None):
    dest=CACHE_ROOT/game/(key+'.html.gz');meta=dest.with_suffix('.json')
    if dest.exists() and meta.exists():
        return gzip.decompress(dest.read_bytes()),json.loads(meta.read_text())
    dest.parent.mkdir(parents=True,exist_ok=True)
    req=Request(url, data=urlencode(data).encode() if data else None,
                headers={'User-Agent':'TCGHUB official catalogue integrity audit (+https://tcghub.kr)'})
    failure=None
    for attempt in range(2):
        try:
            with urlopen(req,timeout=60) as response:
                body=response.read();status=response.status;final=response.url
            if not body or status!=200:raise ValueError('Invalid empty/non-200 response')
            info={'url':url,'finalUrl':final,'method':'POST' if data else 'GET',
                  'parameters':data or {},'status':status,'fetchedAt':now(),
                  'bytes':len(body),'sha256':hashlib.sha256(body).hexdigest()}
            # Canonical source bytes survive parser changes and interrupted runs.
            tmp=dest.with_suffix('.tmp');tmp.write_bytes(gzip.compress(body));tmp.replace(dest)
            meta.write_text(json.dumps(info,ensure_ascii=False,indent=2),encoding='utf-8')
            time.sleep(.12)
            return body,info
        except HTTPError as e:
            failure=f'HTTP {e.code}'
            if e.code<500:break
        except (TimeoutError,URLError,OSError,ValueError) as e:failure=f'{type(e).__name__}: {e}'
        if attempt==0:time.sleep(1)
    raise RuntimeError(f'{url}: {failure}')

def inventory(game,with_provenance=False):
    body,inventory_info=fetch(game,'inventory',BASES[game])
    landing=ROOT/(game+'-landing.html');landing.write_bytes(body)
    tree=html.fromstring(body)
    products=[]
    if game=='union_arena':
        opts=tree.xpath('//select[@name="series"]/option[@value]')
        rows=[(o.get('value'),text(o)) for o in opts if o.get('value')]
    elif game=='digimon':
        opts=tree.xpath('//select[@name="category"]/option[@value]')
        rows=[(o.get('value'),text(o)) for o in opts if o.get('value')]
    else:
        rows=[(a.get('data-val'),text(a)) for a in tree.xpath('//a[@data-val]') if re.fullmatch(r'\d{6}',a.get('data-val',''))]
    seen=set()
    for key,title in rows:
        if key in seen:continue
        seen.add(key);code=product_code(title)
        param='series' if game=='union_arena' else ('category[]' if game=='dragon_ball_fusion_world' else 'category')
        url=BASES[game]+'?'+urlencode({'search':'true',param:key})
        aggregate=(game=='union_arena' and key in {'570901','570801'}) or (game=='digimon' and key in {'503901','503902','503903','503904','503905'}) or (game=='dragon_ball_fusion_world' and key=='584901')
        products.append({'id':key,'name':title,'code':code,'kind':kind(title,code),'url':url,
                         'isAggregate':aggregate,'language':'ja'})
    return (products,inventory_info) if with_provenance else products

def parse_cards(game,body,url):
    tree=html.fromstring(body);cards=[];seen=set()
    if game in ['union_arena','dragon_ball_fusion_world']:
        cls='cardImgCol' if game=='union_arena' else 'cardItem'
        items=tree.xpath('//li['+tok(cls)+']')
        for item in items:
            a=first(item.xpath('.//a'));img=first(item.xpath('.//img'))
            if a is None or img is None:continue
            image=urljoin(url,img.get('data-src') or img.get('src') or '')
            detail=urljoin(url,a.get('data-src') or a.get('href') or '')
            params=parse_qs(urlsplit(detail).query)
            source_card_no=(params.get('card_no') or [''])[0]
            number=re.sub(r'_[pP]\d+$','',source_card_no)
            alt=img.get('alt','').strip()
            alt_number=alt.partition(' ')[0]
            if not number:number=alt_number
            name=alt[len(alt_number):].strip() if alt_number else ''
            for prefix in [source_card_no,number]:
                if prefix and alt.startswith(prefix):
                    name=alt[len(prefix):].strip();break
            stem=Path(urlsplit(image).path).stem
            variant=(params.get('p') or [''])[0]
            if not variant:
                m=re.search(r'(_[pP]\d+(?:_.*)?)$',stem)
                if m:variant=m.group(1)
            key=canonical_image(image)
            if key in seen:continue
            seen.add(key)
            cards.append({'id':stem,'number':number,'name':name,'rarity':None,
                          'image':image,'url':detail,'variant':variant or 'base','cardId':number,
                          'sourceCardNo':source_card_no})
        match=re.search(r'検索結果\s*([\d,]+)\s*件',text(tree))
        expected=int(match.group(1).replace(',','')) if match else None
    else:
        items=tree.xpath('//div['+tok('cardDetailCol')+']')
        for detail in items:
            number=text(first(detail.xpath('.//li['+tok('cardNo')+']')))
            name=text(first(detail.xpath('.//div['+tok('cardTitle')+']')))
            rarity=text(first(detail.xpath('.//li['+tok('cardRarity')+']')))
            img=first(detail.xpath('.//div['+tok('cardImg')+']//img'))
            if img is None:continue
            image=urljoin(url,img.get('src') or '')
            ancestor=first(detail.xpath('ancestor::*[@id][1]'))
            ident=ancestor.get('id') if ancestor is not None else Path(urlsplit(image).path).stem
            m=re.search(r'(_[pP]\d+(?:_.*)?)$',Path(urlsplit(image).path).stem)
            variant=m.group(1) if m else ('parallel' if 'パラレル' in text(first(detail.xpath('.//ul['+tok('cardTitleList')+']'))) else 'base')
            key=ident+'|'+canonical_image(image)
            if key in seen:continue
            seen.add(key)
            info={}
            for dl in detail.xpath('.//dl['+tok('cardInfoBox')+']'):
                dt=first(dl.xpath('./dt'));dd=first(dl.xpath('./dd'))
                if dt is not None and dd is not None:
                    # Exclude nested "card list/product" navigation captions.
                    info[text(dt)]=re.sub(r'\s+',' ',' '.join(dd.xpath('./text()'))).strip()
            links=[urljoin(url,x) for x in detail.xpath('.//a[contains(@href,"products")]/@href')]
            cards.append({'id':ident,'number':number,'name':name,'rarity':rarity or None,
                          'image':image,'url':url+'#'+ident,'variant':variant,'cardId':number,
                          'acquisition':info.get('入手情報'),'productInfoUrls':list(dict.fromkeys(links))})
        expected=len(tree.xpath('//a['+tok('card_img')+']'))
    return cards,expected

def repair_ua_names(cards):
    for card in cards:
        if card['name']:continue
        key='detail-'+hashlib.sha256(card['url'].encode()).hexdigest()[:20]
        body,meta=fetch('union_arena',key,card['url']);tree=html.fromstring(body)
        heading=first(tree.xpath('//h2['+tok('cardNameCol')+']'))
        if heading is not None:
            name=''.join(heading.xpath('.//text()[not(ancestor::*['+tok('rubyData')+'])]'))
            card['name']=re.sub(r'\s+',' ',name).strip()
        rarity=text(first(tree.xpath('//*[contains(@class,"rareData")]')))
        if rarity:card['rarity']=rarity
        card['detailProvenance']=meta
    return cards

def derive_acquisition_products(game,products):
    """Partition Digimon's official broad bins by explicit acquisition caption.

    These IDs are locally derived; no manufacturer product ID is fabricated.
    Counts are reproducible source partitions, not independently advertised
    pack counts. A campaign/bonus partition must not replace its base booster.
    """
    if game not in {'digimon','union_arena','dragon_ball_fusion_world'}:return []
    groups={}
    for product in products:
        if not product.get('isAggregate'):continue
        for card in product['cards']:
            title=card.get('acquisition')
            if not title:continue
            group=groups.setdefault(title,{'cards':{},'categories':{},'provenance':[]})
            key=card['number']+'|'+canonical_image(card['image'])
            group['cards'][key]=card
            group['categories'][product['id']]=product.get('complete',False) and all(c.get('acquisition') for c in product['cards'])
            if product['provenance'] not in group['provenance']:group['provenance'].append(product['provenance'])
    result=[]
    for title,g in sorted(groups.items()):
        cards=list(g['cards'].values());code=product_code(title)
        code_source='official acquisition caption' if code else None
        prefixes=sorted({c['number'].split('/')[0] for c in cards if re.match(r'^UA\d+PB/',c['number'])})
        if not code and game=='union_arena' and len(prefixes)==1 and re.fullmatch(r'UA\d+PB',prefixes[0]):
            code=prefixes[0];code_source='official card-number prefix'
        info_urls=list(dict.fromkeys(u for c in cards for u in c.get('productInfoUrls',[])))
        result.append({'id':'acq-'+hashlib.sha256(title.encode()).hexdigest()[:16],
                       'name':title,'code':code,'codeSource':code_source,'kind':kind(title,code),'language':'ja',
                       'isAggregate':False,'isDerivedProduct':True,
                       'idSource':'derived from official acquisition caption',
                       'groupingBasis':'official per-printing acquisition caption',
                       'isBonus':bool(re.search(r'キャンペーン|購入特典|購入者特典|BOX購入|ボックス購入',title)),
                       'url':info_urls[0] if len(info_urls)==1 else cards[0]['url'],
                       'sourceCategoryIds':list(g['categories']),'complete':all(g['categories'].values()),
                       'cards':cards,'cardCount':len(cards),'expectedCardCount':len(cards),
                       'sourceCountMethod':'official-acquisition-caption-partition',
                       'independentlyDeclaredCount':False,'provenanceSources':g['provenance']})
    return result

def rarity_index(game):
    rarities=DB_RARITIES if game=='dragon_ball_fusion_world' else UA_RARITIES
    field='rarity[]' if game=='dragon_ball_fusion_world' else 'rare[]'
    index={};counts={};fail=[]
    for rarity in rarities:
        params={'search':'true',field:rarity}
        url=BASES[game]+'?'+urlencode(params)
        try:
            body,info=fetch(game,'rarity-'+rarity,url)
            cards,expected=parse_cards(game,body,info['finalUrl'])
            if expected is not None and len(cards)!=expected:raise ValueError(f'Rarity list {len(cards)} differs from reported {expected}')
            counts[rarity]=len(cards)
            for c in cards:
                key=canonical_image(c['image'])
                if key in index and index[key]!=rarity:fail.append({'image':key,'rarities':[index[key],rarity]})
                index[key]=rarity
        except Exception as e:fail.append({'rarity':rarity,'error':str(e)})
    return index,counts,fail

def collect_game(game):
    products,inventory_info=inventory(game,with_provenance=True);out=[];failures=[]
    rarities={};rarity_counts={};rarity_errors=[]
    if game=='dragon_ball_fusion_world':rarities,rarity_counts,rarity_errors=rarity_index(game)
    for i,product in enumerate(products,1):
        try:
            body,meta=fetch(game,product['id'],product['url'])
            cards,reported=parse_cards(game,body,meta['finalUrl'])
            if game=='union_arena':cards=repair_ua_names(cards)
            for c in cards:
                if not c['rarity']:c['rarity']=rarities.get(canonical_image(c['image']))
            problems=[]
            if reported is not None and reported!=len(cards):problems.append(f'Reported count {reported}; parsed {len(cards)}')
            if not cards:problems.append('Official response contains no published cards')
            if any(not c['number'] or not c['name'] or not c['image'] for c in cards):problems.append('Identity field missing')
            record={**product,'complete':not problems,'cards':cards,'reportedCardCount':reported,
                    'cardCount':len(cards),'expectedCardCount':reported,
                    'sourceCountMethod':'official-thumbnail-anchor-count' if game=='digimon' else 'official-reported-result-count',
                    'rarityComplete':all(c['rarity'] for c in cards),
                    'problems':problems,'provenance':meta}
            out.append(record)
            if problems:failures.append({'product':product['id'],'problems':problems})
            print(json.dumps({'game':game,'product':product['id'],'progress':f'{i}/{len(products)}','cards':len(cards),'reported':reported,'complete':record['complete']},ensure_ascii=False),flush=True)
        except Exception as e:
            failures.append({'product':product['id'],'error':str(e)})
            out.append({**product,'complete':False,'cards':[],'cardCount':0,'problems':[str(e)]})
            print(json.dumps({'game':game,'product':product['id'],'error':str(e)},ensure_ascii=False),flush=True)
        # A recoverable checkpoint is updated after each validated source page.
        payload={'game':game,'source':'official manufacturer Japanese card list','sourceUrl':BASES[game],
                 'fetchedAt':now(),'complete':len(out)==len(products) and not failures,
                 'expectedProducts':len(products),'inventoryProvenance':inventory_info,'products':out,'failures':failures,
                 'rarityFilterCounts':rarity_counts,'rarityFilterProblems':rarity_errors}
        # Partial checkpoints never truncate an existing complete snapshot.
        dest=ROOT/(game+'.partial.json');tmp=dest.with_suffix('.tmp');tmp.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':')),encoding='utf-8');tmp.replace(dest)
    payload['derivedProducts']=derive_acquisition_products(game,out)
    dest=ROOT/(game+'.json');tmp=dest.with_suffix('.tmp');tmp.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':')),encoding='utf-8');tmp.replace(dest)
    return {'game':game,'products':len(out),'cards':sum(len(x['cards']) for x in out),'complete':not failures,
            'rarityMissing':sum(not c['rarity'] for p in out for c in p['cards']),'failures':failures,
            'rarityFilterCounts':rarity_counts,'rarityFilterProblems':rarity_errors}

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--games',nargs='+',choices=list(BASES),default=list(BASES));ap.add_argument('--output-dir');ap.add_argument('--cache-dir');args=ap.parse_args()
    configure(args.output_dir,args.cache_dir)
    summaries=[]
    # Exactly one sequential reader per manufacturer host. No search explosions.
    with ThreadPoolExecutor(max_workers=3) as ex:
        futures={ex.submit(collect_game,g):g for g in args.games}
        for f in as_completed(futures):
            try:summaries.append(f.result())
            except Exception as e:summaries.append({'game':futures[f],'error':str(e),'complete':False})
    (ROOT/'summary.json').write_text(json.dumps({'fetchedAt':now(),'games':summaries},ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(summaries,ensure_ascii=False),flush=True)
if __name__=='__main__':main()
