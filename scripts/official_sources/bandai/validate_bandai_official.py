#!/usr/bin/env python3
"""Reproduce structural membership checks and raw official-source hashes."""
import argparse,collections,gzip,hashlib,json
from pathlib import Path
from urllib.parse import urlsplit
from collect_bandai_official import ROOT,BASES,canonical_image,now,configure

def main():
    global ROOT
    ap=argparse.ArgumentParser();ap.add_argument('--output-dir');ap.add_argument('--cache-dir');a=ap.parse_args()
    ROOT,cache_root=configure(a.output_dir,a.cache_dir)
    games=[];problems=[]
    for game,base in BASES.items():
        data=json.loads((ROOT/(game+'.json')).read_text());products=data['products']
        counts=collections.Counter();native=set();missing=collections.Counter()
        if len(products)!=data['expectedProducts']:problems.append([game,'inventory_count'])
        if len({p['id'] for p in products})!=len(products):problems.append([game,'duplicate_product_id'])
        for p in products:
            if not p.get('complete'):problems.append([game,p['id'],'incomplete_membership'])
            if len(p['cards'])!=p.get('expectedCardCount'):problems.append([game,p['id'],'declared_count'])
            images=[canonical_image(c['image']) for c in p['cards']]
            if len(set(images))!=len(images):problems.append([game,p['id'],'duplicate_image_in_product'])
            counts['aggregateCategories' if p.get('isAggregate') else 'productCategories']+=1
            counts['rows']+=len(p['cards'])
            for c in p['cards']:
                native.add((c['number'],canonical_image(c['image'])))
                for field in ['id','number','name','image','url']:
                    if not c.get(field):problems.append([game,p['id'],c.get('id'),'missing_'+field])
                if not c.get('rarity'):missing['rarity']+=1
                if not c.get('cardType'):missing['cardType']+=1
                if urlsplit(c['image']).hostname!=urlsplit(base).hostname:problems.append([game,c['id'],'image_source_host'])
        for p in data.get('derivedProducts',[]):
            if not p.get('isDerivedProduct') or p.get('idSource')!='derived from official acquisition caption':problems.append([game,p['id'],'derived_provenance'])
            if len(p['cards'])!=p.get('expectedCardCount'):problems.append([game,p['id'],'derived_count'])
        games.append({'game':game,'complete':data['complete'],'officialSelectorCategories':len(products),
                      **dict(counts),'uniquePrintingImages':len(native),'derivedProducts':len(data.get('derivedProducts',[])),
                      'metadataMissing':dict(missing)})
    checked=0;bytes_checked=0
    for path in sorted(cache_root.glob('*/*.html.gz')):
        meta=path.with_suffix('.json')
        if not meta.exists():problems.append([str(path),'missing_cache_metadata']);continue
        info=json.loads(meta.read_text());body=gzip.decompress(path.read_bytes());checked+=1;bytes_checked+=len(body)
        if hashlib.sha256(body).hexdigest()!=info['sha256'] or len(body)!=info['bytes']:problems.append([str(path),'cache_integrity'])
    result={'checkedAt':now(),'passed':not problems,'games':games,'rawSourceResponsesChecked':checked,
            'rawSourceBytesChecked':bytes_checked,'problems':problems}
    dest=ROOT/'validation.json';tmp=dest.with_suffix('.tmp');tmp.write_text(json.dumps(result,ensure_ascii=False,indent=2));tmp.replace(dest)
    print(json.dumps(result,ensure_ascii=False,indent=2))
    if problems:raise SystemExit(1)
if __name__=='__main__':main()
