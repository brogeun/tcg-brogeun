#!/usr/bin/env python3
"""Apply completed official image-based UA filter classifications.

PcSR/PcR/PcC are the manufacturer's literal search filters, not a guessed
star tier. Any exact rarity already read from a detail page wins.
"""
import argparse,json
from collect_bandai_official import configure,canonical_image,now,derive_acquisition_products

def main():
    ap=argparse.ArgumentParser();ap.add_argument('--output-dir');ap.add_argument('--cache-dir');ap.add_argument('--index-file',default='union_arena-rarities.json');ap.add_argument('--allow-partial',action='store_true');a=ap.parse_args()
    root,_=configure(a.output_dir,a.cache_dir)
    index=json.loads((root/a.index_file).read_text())
    if not index['complete'] and not a.allow_partial:raise SystemExit('Official classification collection is incomplete; snapshot was not modified.')
    dest=root/'union_arena.json';data=json.loads(dest.read_text());unmatched=[];detail_conflicts=[]
    for product in data['products']:
        if product['id'] in {'570801','570901'}:product['isAggregate']=True
        for card in product['cards']:
            entry=index['byImage'].get(canonical_image(card['image']))
            if not entry:
                unmatched.append({'product':product['id'],'id':card['id'],'image':card['image']});continue
            if entry['number']!=card['number']:raise ValueError('Native image/printed-card number conflict: '+card['id'])
            if card.get('rarity') and card.get('detailProvenance'):card['rarityOrigin']='official-detail'
            elif entry['rarity']:
                card['rarity']=entry['rarity'];card['rarityOrigin']='official-filter'
            if entry['rarity']:card['rarityFilter']=entry['rarity']
            elif not card.get('rarity'):card['rarityStatus']='not-exposed-in-official-rarity-filters'
            if not card.get('cardType') and entry.get('cardType'):card['cardType']=entry['cardType']
            card['classificationSources']=entry['sources']
        product['rarityComplete']=all(c.get('rarity') for c in product['cards'])
        product['classificationComplete']=all(c.get('classificationSources') for c in product['cards'])
    data['rarityCoverageComplete']=index['complete'] and not unmatched
    data['derivedProducts']=derive_acquisition_products('union_arena',data['products'])
    data['classificationEnrichment']={'fetchedAt':now(),'complete':index['complete'] and not unmatched,'rarityCoverageComplete':index['complete'] and not unmatched,'expectedQueries':index['expectedQueries'],
                                      'sourceQueries':index['sourceQueries'],'conflicts':index['conflicts'],'unmatched':unmatched,
                                      'rarityMeaning':'Literal official search classification unless rarityOrigin is official-detail; parallel star tiers are not inferred.'}
    tmp=dest.with_suffix('.tmp');tmp.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')));tmp.replace(dest)
    print(json.dumps({'classificationComplete':not unmatched,'sourceQueries':len(index['sourceQueries']),'unmatched':unmatched},ensure_ascii=False))
if __name__=='__main__':main()
