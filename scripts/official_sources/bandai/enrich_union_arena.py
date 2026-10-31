#!/usr/bin/env python3
"""Official UA rarity/type image identities, no market-data assumptions."""
import argparse,hashlib,json
from concurrent.futures import ThreadPoolExecutor,as_completed
from urllib.parse import urlencode
from lxml import html
from collect_bandai_official import ROOT,BASES,UA_RARITIES,fetch,parse_cards,text,canonical_image,now,configure

def tasks():
    tree=html.fromstring((ROOT/'union_arena-landing.html').read_bytes())
    titles=[o.get('value') for o in tree.xpath('//select[@name="selectTitle"]/option') if o.get('value')]
    out=[]
    for title in titles:
        for rarity in UA_RARITIES:
            out.append((title,rarity,{'search':'true','selectTitle':title,'rare[]':rarity}))
        out.append((title,'ACTION POINT',{'search':'true','selectTitle':title,'categories[]':'アクションポイント'}))
    return out

def one(task):
    title,kind,params=task
    key='metadata-'+hashlib.sha256(json.dumps(params,ensure_ascii=False,sort_keys=True).encode()).hexdigest()[:20]
    url=BASES['union_arena']+'?'+urlencode(params)
    body,info=fetch('union_arena',key,url)
    cards,expected=parse_cards('union_arena',body,info['finalUrl'])
    if expected is not None and expected!=len(cards):raise ValueError(f'{title}/{kind}: parsed {len(cards)} but expected {expected}')
    return {'title':title,'filter':kind,'count':len(cards),'provenance':info,'cards':cards}

def main():
    global ROOT
    ap=argparse.ArgumentParser();ap.add_argument('--output-dir');ap.add_argument('--cache-dir');ap.add_argument('--workers',type=int,default=2);a=ap.parse_args()
    ROOT,_=configure(a.output_dir,a.cache_dir)
    work=tasks();index={};records=[];errors=[];conflicts=[]
    def checkpoint():
        payload={'game':'union_arena','fetchedAt':now(),'expectedQueries':len(work),'finishedQueries':len(records)+len(errors),
                 'complete':len(records)+len(errors)==len(work) and not errors and not conflicts,
                 'byImage':index,'sourceQueries':records,'failures':errors,'conflicts':conflicts}
        dest=ROOT/'union_arena-rarities.json';tmp=dest.with_suffix('.tmp');tmp.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':')),encoding='utf-8');tmp.replace(dest)
    with ThreadPoolExecutor(max_workers=min(max(a.workers,1),4)) as ex:
        futures={ex.submit(one,t):t for t in work}
        for n,f in enumerate(as_completed(futures),1):
            title,kind,_=futures[f]
            try:
                r=f.result()
                for c in r.pop('cards'):
                    key=canonical_image(c['image']);ent=index.setdefault(key,{'number':c['number'],'name':c['name'],'rarity':None,'cardType':None,'sources':[]})
                    ent['sources'].append(r['provenance']['url'])
                    if kind=='ACTION POINT':ent['cardType']='ACTION POINT'
                    elif ent['rarity'] and ent['rarity']!=kind:conflicts.append({'image':key,'values':[ent['rarity'],kind]})
                    else:ent['rarity']=kind
                    if c['name'] and not ent['name']:ent['name']=c['name']
                records.append(r)
            except Exception as e:errors.append({'title':title,'filter':kind,'error':str(e)})
            if n%10==0 or n==len(work):
                checkpoint();print(json.dumps({'done':n,'total':len(work),'images':len(index),'errors':len(errors),'conflicts':len(conflicts)}),flush=True)
    checkpoint()
if __name__=='__main__':main()
