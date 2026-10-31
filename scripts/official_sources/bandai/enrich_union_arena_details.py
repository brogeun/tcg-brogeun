#!/usr/bin/env python3
"""Derive named UA special products only from official per-printing captions.

The default bounded target is the 30-card limited merchandise aggregate.
Promotions can be collected explicitly with --categories 570901. It never
turns partial detail coverage into a completed product grouping.
"""
import argparse, hashlib, json, re
from concurrent.futures import ThreadPoolExecutor, as_completed
from lxml import html
from collect_bandai_official import ROOT,fetch,text,tok,first,now,derive_acquisition_products,configure

def one(card):
    key='detail-'+hashlib.sha256(card['url'].encode()).hexdigest()[:20]
    body,info=fetch('union_arena',key,card['url'])
    tree=html.fromstring(body)
    heading=first(tree.xpath('//h2['+tok('cardNameCol')+']'))
    name=None
    if heading is not None:
        name=re.sub(r'\s+',' ',''.join(heading.xpath('.//text()[not(ancestor::*['+tok('rubyData')+'])]'))).strip()
    rarity=text(first(tree.xpath('//*[contains(@class,"rareData")]')))
    acquisition=text(first(tree.xpath('//dl['+tok('getInfoData')+']/dd')))
    card_type=text(first(tree.xpath('//dl['+tok('categoryData')+']/dd')))
    return {**card,'name':name or card['name'],'rarity':rarity or card.get('rarity'),
            'rarityOrigin':'official-detail' if rarity else card.get('rarityOrigin'),
            'acquisition':acquisition or None,'cardType':card_type or None,
            'detailProvenance':info}

def main():
    global ROOT
    ap=argparse.ArgumentParser();ap.add_argument('--categories',nargs='+',default=['570801']);ap.add_argument('--workers',type=int,default=2);ap.add_argument('--output-dir');ap.add_argument('--cache-dir');a=ap.parse_args()
    ROOT,_=configure(a.output_dir,a.cache_dir)
    dest=ROOT/'union_arena.json';data=json.loads(dest.read_text());fail=[]
    for product in data['products']:
        if product['id'] not in a.categories:continue
        product['isAggregate']=True;cards=list(product['cards']);out=[None]*len(cards)
        with ThreadPoolExecutor(max_workers=min(max(a.workers,1),4)) as ex:
            futures={ex.submit(one,c):i for i,c in enumerate(cards)}
            for future in as_completed(futures):
                i=futures[future]
                try:out[i]=future.result()
                except Exception as e:out[i]=cards[i];fail.append({'category':product['id'],'card':cards[i]['id'],'error':str(e)})
                print(json.dumps({'category':product['id'],'done':sum(c is not None for c in out),'total':len(cards),'failures':len(fail)}),flush=True)
        product['cards']=out;product['acquisitionComplete']=all(c.get('acquisition') for c in out)
        product['rarityComplete']=all(c.get('rarity') for c in out)
    data['derivedProducts']=derive_acquisition_products('union_arena',data['products'])
    data['detailEnrichment']={'fetchedAt':now(),'categories':a.categories,'failures':fail,'complete':not fail}
    tmp=dest.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')));tmp.replace(dest)
    print(json.dumps({'derivedProducts':len(data['derivedProducts']),'failures':fail}),flush=True)
if __name__=='__main__':main()
