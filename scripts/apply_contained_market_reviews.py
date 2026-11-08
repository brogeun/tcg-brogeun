import hashlib,json,pathlib,sqlite3,sys
from collections import Counter
import reconcile_contained_market_links as review

W=review.WORK
ROOT=review.ROOT
ORIGINAL=ROOT


def read(path):return json.loads(path.read_text(encoding='utf-8'))


def product_key(row):return (row['brand'],row['boxCode'].upper(),(row.get('fullId') or row.get('number') or '').upper(),row.get('image',''))


def lean_link(link):
    keep=['brand','boxCode','setCode','number','fullId','image','id','marketName','marketProductNumber','marketImage','sourceSHA256','marketSHA256','sourcePageUrl','sourceLocalImage','sourceEvidenceUrl','method','reviewedAt','candidateCount']
    out={k:link[k] for k in keep if k in link}
    if link.get('marketPage'):
        out['marketPageSHA256']=link['marketPage']['sha256']
        out['marketPageUrl']=link['marketPage']['url']
        if link['marketPage'].get('currentImageSHA256'):out['currentMarketSHA256']=link['marketPage']['currentImageSHA256']
        if link['marketPage'].get('currentImage'):out['currentMarketImage']=link['marketPage']['currentImage']
    return out


def main():
    base=read(ORIGINAL/'data/contained-card-market-links.json')
    initial={product_key(r):r for r in base['links']}
    baseline_count=len(initial)
    products=read(ROOT/'data/all-cards.json')['details']
    catalogue=read(ROOT/'data/onepiece-official-search.json')
    review.ACQUISITION_CONTEXTS.update(review.learn_contexts({'catalogue':catalogue,'sources':[{'candidates':products}]}))
    known={}
    for r in catalogue['cards']:
        if r.get('productId'):known.setdefault(str(r['productId']),set()).add(r['fullId'].upper())
    db=sqlite3.connect(W/'review.sqlite3')
    rows=[json.loads(r[0]) for r in db.execute('select result from reviews')]
    excluded=[]
    for row in rows:
        if row['status']!='verified-original-source-link':continue
        link,t=row['link'],row['target']
        if t['brand']=='onepiece':
            product=next(p for p in products if str(p['id'])==link['id'])
            if not review.explicit_acquisition(t,product) or known.get(link['id'],set())-{t['fullId'].upper()}:
                excluded.append({'key':row['key'],'reason':'exact-official-acquisition-and-existing-artwork-check'})
                continue
        key=product_key(link)
        if key in initial and initial[key]['id']!=link['id']:raise ValueError('Conflicting prior artwork proof')
        initial[key]=lean_link(link)
    base['links']=list(initial.values())
    variant_db=sqlite3.connect(W/'variants.sqlite3')
    versions=[json.loads(v[0]) for v in variant_db.execute('select result from variants')]
    records=[]
    for value in versions:
        if value['status']!='verified-labelled-versions':continue
        record=value['record']
        output={k:v for k,v in record.items() if k!='versions'}
        output['versionCount']=len(record['versions'])
        output['versions']=[]
        for v in record['versions']:
            output['versions'].append({k:v[k] for k in ['id','label','marketName','marketProductNumber','marketImage','marketSHA256']})
        records.append(output)
    previous_versions={product_key(r):r for r in base.get('variants',[])}
    previous_versions.update({product_key(r):r for r in records})
    base['variants']=list(previous_versions.values())
    base['lastSourceReviewAt']=review.stamp()
    out=ROOT/'data/contained-card-market-links.json'
    out.write_text(json.dumps(base,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
    summary={'at':review.stamp(),'baselineAutomaticPending':None,'reviewedMemberships':len(rows),'newDirectLinks':len(initial)-baseline_count,'verifiedVersionMemberships':len(records),'verifiedMarketVersions':sum(len(r['versions']) for r in records),'excludedProposals':excluded,'reviewStatusCounts':dict(Counter(r['status'] for r in rows)),'variantStatusCounts':dict(Counter(v['status'] for v in versions)),'outputSHA256':hashlib.sha256(out.read_bytes()).hexdigest(),'outputBytes':out.stat().st_size}
    (W/'applied-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=True))


if __name__=='__main__':main()
