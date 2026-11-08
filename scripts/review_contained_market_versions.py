"""Resolve ordinary Pokemon reference cards to explicitly labelled print versions.

This never chooses one edition as the source card's single price. Each labelled
version retains its own independently checked market product and price.
"""
import concurrent.futures
import hashlib
import json
import pathlib
import re
import sqlite3
import unicodedata
from collections import Counter

import reconcile_contained_market_links as review

W = review.WORK


def version_name(product):
    name = unicodedata.normalize('NFKC', product['name'])
    head, sep, tail = name.partition('[')
    if not sep or re.search(r'Error|Misprint|Signed|Serial|Winner|Prize|Tournament|Promotion|Promo|Parallel|Comic', head, re.I):
        return None
    labels = []
    patterns = [
        ('1ED', r'\b(?:1ED|1ST(?:\s+EDITION)?|FIRST\s+EDITION)\b'),
        ('희귀도 표시 없음', r'\bNO\s+RARITY\b'),
        ('일반판', r'\bUNLIMITED\b'),
        ('마스터볼 미러', r'\bMASTER\s*BALL(?:\s*MIRROR)?\b'),
        ('몬스터볼 미러', r'\bMONSTER\s*BALL(?:\s*MIRROR)?\b'),
        ('리버스 홀로', r'\bREVERSE\s*HOLO\b'),
        ('미러', r'\bMIRROR\b'),
    ]
    for label, pattern in patterns:
        if re.search(pattern, head, re.I):
            labels.append(label)
            head = re.sub(pattern, '', head, flags=re.I)
    label = ' · '.join(labels) if labels else '일반판'
    canonical = re.sub(r'[^a-z0-9]', '', (head + '[' + tail).lower())
    return label, canonical


def compare_versions(row, root):
    t, candidates = row['target'], row['candidates']
    if t['brand'] != 'pokemon' or t.get('bundle') or t.get('isBundle') or not 1 <= len(candidates) <= 4:
        return None
    descriptions = [version_name(p) for p in candidates]
    if any(x is None for x in descriptions) or len({x[1] for x in descriptions}) != 1 or len({x[0] for x in descriptions}) != len(candidates):
        return None
    if all(label == '일반판' for label, _ in descriptions):
        return None
    prior = dict((p['id'], p) for p in row.get('comparisons', []))
    if any(not review.geometry.passes(prior.get(str(p['id']), {}).get('evidence', {})) for p in candidates):
        return None
    try:
        source, source_url = review.source_image(t, root)
        versions = []
        for product, (label, _) in zip(candidates, descriptions):
            page = review.market_page(product)
            url = page.get('currentImage')
            if not url:
                return {'key': row['key'], 'status': 'current-market-photo-unavailable'}
            current = review.fetch(url)
            e = review.registered_compare(source, current)
            if not review.geometry.passes(e):
                return {'key': row['key'], 'status': 'current-market-photo-needs-review'}
            original = pathlib.Path(prior[str(product['id'])]['marketFile'])
            versions.append({'id': str(product['id']), 'label': label, 'marketName': product['name'], 'marketProductNumber': product['productNumber'], 'marketImage': product['thumbnailUrl'], 'marketSHA256': hashlib.sha256(original.read_bytes()).hexdigest(), 'marketPage': page, 'currentMarketImage': url, 'currentMarketSHA256': hashlib.sha256(current.read_bytes()).hexdigest(), 'imageEvidence': e})
        record = {k: t.get(k, '') for k in ['brand', 'boxCode', 'setCode', 'number', 'fullId', 'image']}
        record.update(sourceSHA256=hashlib.sha256(source.read_bytes()).hexdigest(), sourceLocalImage=t.get('localImage'), sourceEvidenceUrl=source_url, sourcePageUrl=t.get('currentSourceUrl') or t.get('sourceUrl') or t.get('url'), method='individually-verified-original-market-versions', reviewedAt=review.stamp(), versionCount=len(versions), versions=versions)
        return {'key': row['key'], 'status': 'verified-labelled-versions', 'record': record}
    except Exception as error:
        return {'key': row['key'], 'status': 'market-version-source-review-needed', 'error': str(error)}


def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=pathlib.Path, default=review.ROOT)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--retry-status', default='')
    args = parser.parse_args()
    source_db = sqlite3.connect(W / 'review.sqlite3')
    results = [json.loads(r[0]) for r in source_db.execute('select result from reviews')]
    source_rows = json.loads(W / 'pending-current.json'.read_text(encoding='utf-8'))
    inputs = {review.key(r): r for r in source_rows}
    db = sqlite3.connect(W / 'variants.sqlite3')
    db.execute('pragma journal_mode=WAL')
    db.execute('create table if not exists variants (key text primary key, result text not null)')
    done = {r[0] for r in db.execute('select key from variants')}
    if args.retry_status:
        retry = set(args.retry_status.split(','))
        done = {k for k, v in db.execute('select key,result from variants') if json.loads(v)['status'] not in retry}
    jobs = [{**inputs[r['key']], **r} for r in results if r['key'] not in done and r['status'] == 'edition-or-finish-source-review-needed']
    print(json.dumps({'variantJobs': len(jobs), 'previouslyCompleted': len(done)}), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i, result in enumerate(pool.map(lambda r: (r['key'], compare_versions(r, args.root)), jobs), 1):
            key, value = result
            value = value or {'key': key, 'status': 'independent-version-identity-not-established'}
            db.execute('insert or replace into variants values (?, ?)', (key, json.dumps(value, ensure_ascii=False)))
            db.commit()
            if i % 25 == 0 or i == len(jobs):
                values = [json.loads(r[0]) for r in db.execute('select result from variants')]
                records = [v['record'] for v in values if v['status'] == 'verified-labelled-versions']
                (W / 'verified-variants.json').write_text(json.dumps({'schemaVersion': 1, 'variants': records}, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
                status = {'completed': len(values), 'counts': dict(Counter(v['status'] for v in values)), 'verifiedMemberships': len(records), 'verifiedMarketVersions': sum(len(r['versions']) for r in records)}
                (W / 'VARIANT_CHECKPOINT.json').write_text(json.dumps(status), encoding='utf-8')
                print(json.dumps(status), flush=True)


if __name__ == '__main__':
    main()
