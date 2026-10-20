"""Validate the local China auction archive and build website prices without network requests."""
from __future__ import annotations
import argparse
import csv
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
import backfill_chinese_prices as base
import collect_chinese_prices as collector

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = ROOT / '.cache/chinese-price-backfill/cardhobby'


def build(root=ROOT, source=DEFAULT_SOURCE, report_dir=None):
    root, source = Path(root), Path(source)
    report_dir = Path(report_dir) if report_dir else root / '.cache/chinese-market-build'
    for output in (report_dir, root / 'data/chinese-market.json'):
        if output.resolve().is_relative_to(source.resolve()):
            raise ValueError('Website/report output must be outside the original auction archive')
    print('저장한 경매 자료를 카드·등급·박스 구성과 다시 대조합니다…', flush=True)
    catalog = collector.PriceCatalog(root)
    data, report = collector.compile_results(source, catalog, write=False)
    quotes = data['records']
    by_target = defaultdict(list)
    for row in quotes:
        by_target[(row['targetId'], row['grade'])].append(row)
    histories = {(h['targetId'], h['grade']): h['history'] for h in data['histories']}
    def summary(target, grade):
        rows = by_target[(target, grade)]
        points = []
        for point in histories[(target, grade)]:
            latest = max((r for r in rows if r['auctionEndAt'][:10] == point['date']), key=lambda r: (r['auctionEndAt'], r['listingId']))
            points.append({k:point[k] for k in ('date','priceMinor','auctionCount')} | {'sourceUrl':latest['sourceUrl']})
        return {**points[-1], 'totalAuctionCount':len(rows), 'history':points}
    cards = {}
    for source_id, facts in catalog.cards.items():
        grades = {grade:summary(source_id, grade) for grade in ('psa10','raw') if (source_id,grade) in by_target}
        if grades:
            cards[source_id] = {k:facts[k] for k in ('sourceId','sourceSetCode','number','name','variant')} | {'grades':grades}
    proof_path = root / 'data/chinese-box-configurations.json'
    proof = base.read_json(proof_path)['configurations'] if proof_path.exists() else {}
    boxes = defaultdict(list)
    for target_id, facts in catalog.boxes.items():
        if (target_id,'box') not in by_target:
            continue
        evidence = proof.get(target_id, {})
        if evidence and (evidence['setCode'] != facts['setCode'] or evidence['cardsPerPack'] != facts['cardsPerPack'] or type(evidence['packsPerBox']) is not int or evidence['packsPerBox'] < 1):
            raise ValueError('Box configuration evidence does not match its target')
        verified = facts['configurationStatus'] == 'verified' or evidence.get('basis') == 'official'
        packs = facts['packsPerBox'] if facts['configurationStatus'] == 'verified' else evidence.get('packsPerBox') if evidence.get('basis') == 'official' else None
        box = summary(target_id,'box') | {'targetId':target_id,'cardsPerPack':facts['cardsPerPack'],
            'packsPerBox':packs,'configurationVerified':verified,
            'configurationSourceUrl':evidence.get('sourceUrl') if evidence.get('basis') == 'official' else facts['productSourceUrl'] if facts['configurationStatus'] == 'verified' else None,
            'sellerReportedPacksPerBox':evidence.get('packsPerBox') if evidence.get('basis') == 'seller_reported' else None,
            'sellerConfigurationSourceUrl':evidence.get('sourceUrl') if evidence.get('basis') == 'seller_reported' else None}
        boxes[facts['setCode']].append(box)
    per_set = {}
    for product in catalog.products:
        code = product['code']
        entries = [c for c in catalog.cards.values() if any(ref['setCode'] == code for ref in c['refs'])]
        per_set[code] = {'cardVersions':len(entries),'pricedCards':sum(c['sourceId'] in cards for c in entries),
                         'boxFormats':len(catalog.box_formats[code]),'pricedBoxFormats':len(boxes[code])}
    coverage = {'cardVersions':len(catalog.cards),'pricedCards':len(cards),
                'psa10Cards':sum('psa10' in c['grades'] for c in cards.values()),
                'ACards':sum('raw' in c['grades'] for c in cards.values()),
                'products':len(catalog.products),'pricedBoxProducts':sum(bool(v) for v in boxes.values()),
                'boxFormats':len(catalog.boxes),'pricedBoxFormats':sum(len(v) for v in boxes.values()),
                'verifiedPricedBoxFormats':sum(b['configurationVerified'] for v in boxes.values() for b in v),
                'auctions':len(quotes),'queriesCompleted':report['queriesCompleted'],'queriesPending':report['queriesPending']}
    observed = max((q['observedAt'] for q in quotes),default=None)
    market = {'schemaVersion':1,'source':'cardhobby','language':'zh-CN','market':'CN','currency':'CNY',
              'priceKind':'auction_end_price','generatedAt':datetime.now(timezone.utc).isoformat(),
              'observedAt':observed,'aggregation':'median_per_auction_end_day','shippingIncluded':False,
              'paymentCompletionVerified':False,'cards':cards,'boxes':dict(boxes),'coverage':coverage,'sets':per_set}
    base.save_json(root / 'data/chinese-market.json', market)
    report.update(coverage=coverage,siteDataBuilt=True,websiteData='data/chinese-market.json',originalArchiveModified=False)
    base.save_json(report_dir / 'report.json',report)
    report_dir.mkdir(parents=True,exist_ok=True)
    with (report_dir/'missing-prices.csv').open('w',encoding='utf-8-sig',newline='') as stream:
        fields=['kind','targetId','setCode','name','number','variant','grade','status']
        writer=csv.DictWriter(stream,fieldnames=fields);writer.writeheader()
        for sid,c in catalog.cards.items():
            for grade in ('psa10','raw'):
                if grade not in cards.get(sid,{}).get('grades',{}):
                    writer.writerow({'kind':'card','targetId':sid,'setCode':'|'.join(r['setCode'] for r in c['refs']),
                                     'name':c['name'],'number':c['number'],'variant':c['variant'],'grade':grade,'status':'no_verified_price_record'})
        for tid,b in catalog.boxes.items():
            if (tid,'box') not in by_target:
                writer.writerow({'kind':'box','targetId':tid,'setCode':b['setCode'],'name':b['name'],'grade':'box','status':'no_verified_price_record'})
    print(f"사이트 가격 저장: 카드 {coverage['pricedCards']:,}종 (PSA10 {coverage['psa10Cards']:,}, A급 {coverage['ACards']:,}), 박스 {coverage['pricedBoxProducts']}상품 / {coverage['pricedBoxFormats']}형식, 경매 {coverage['auctions']:,}건")
    print(f'미확보 가격 목록: {report_dir / "missing-prices.csv"}')
    return market, report


def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=ROOT)
    parser.add_argument('--source',type=Path,default=DEFAULT_SOURCE)
    parser.add_argument('--report-dir',type=Path)
    args=parser.parse_args(argv)
    build(args.root,args.source,args.report_dir)
    return 0


if __name__=='__main__':
    raise SystemExit(main())
