"""Refresh new public CN auction records while preserving the completed archive.

An existing fully downloaded query is refreshed in newest-first order until a
whole page overlaps its saved IDs. This updates new records; it does not claim
to re-download or certify every historical auction.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import backfill_chinese_prices as base
import collect_chinese_prices as collector


def refresh(catalog, source, run_dir, delay=1.5, max_pages=100,
            fetcher=collector.fetch_page, sleeper=time.sleep, attempts=5):
    source, run_dir = Path(source), Path(run_dir)
    checkpoint = base.read_json(source / 'checkpoint.json')
    if checkpoint.get('source') != 'cardhobby' or checkpoint.get('currency') != 'CNY':
        raise ValueError('A valid CN auction archive is required')
    size = checkpoint.get('pageSize')
    if type(size) is not int or not 1 <= size <= 60:
        raise ValueError('Invalid archive page size')
    queries = catalog.queries()
    if any(not checkpoint['queries'].get(q, {}).get('complete') for q in queries):
        raise ValueError('Finish the original historical backfill before using a head refresh')
    run_dir.mkdir(parents=True, exist_ok=True)
    state_path = run_dir / 'refresh-progress.json'
    if state_path.exists():
        state = base.read_json(state_path)
        if state.get('archive') != str(source.resolve()) or state.get('pageSize') != size:
            raise ValueError('This refresh run belongs to a different archive')
    else:
        state = {'source':'cardhobby', 'currency':'CNY', 'archive':str(source.resolve()),
                 'pageSize':size, 'startedAt':datetime.now(timezone.utc).isoformat(),
                 'scope':'newest_records_until_saved_page_overlap', 'queries':{}}
    stamp = hashlib.sha256(state['startedAt'].encode()).hexdigest()[:12]
    baseline_path = run_dir / 'saved-ids-before.json'
    if baseline_path.exists():
        baseline = base.read_json(baseline_path)
        if baseline.get('archive') != str(source.resolve()) or set(baseline.get('queries', {})) != set(queries):
            raise ValueError('Invalid saved-ID baseline for this refresh')
        known = {q:set(ids) for q,ids in baseline['queries'].items()}
    else:
        known = {q:set() for q in queries}
        for path in (source / 'pages').glob('*.json'):
            if path.name.startswith(f'refresh-{stamp}-'):
                continue
            page = base.read_json(path)
            if page.get('source') != 'cardhobby' or page.get('currency') != 'CNY':
                raise ValueError('Foreign archive page')
            if page.get('query') in known:
                known[page['query']].update(str(r.get('ID')) for r in page['items'])
        base.save_json(baseline_path, {'archive':str(source.resolve()),
                                     'queries':{q:sorted(ids) for q,ids in known.items()}})
    for index, query in enumerate(queries, 1):
        progress = state['queries'].setdefault(query, {'complete':False, 'pagesFetched':0, 'newIds':[]})
        if progress['complete']:
            continue
        # Restart an interrupted query from its front because live pages can shift.
        new_ids = set(progress['newIds'])
        for number in range(1, max_pages + 1):
            sleeper(delay)
            total, rows = collector.fetch_with_retry(query, number, size, attempts, fetcher, sleeper)
            observed = datetime.now(timezone.utc).isoformat()
            ids = {str(r.get('ID')) for r in rows}
            new_ids.update(ids - known[query])
            page = {'schemaVersion':1, 'source':'cardhobby', 'market':'CN', 'currency':'CNY',
                    'query':query, 'page':number, 'pageSize':size, 'totalCount':total,
                    'observedAt':observed,
                    'items':[{**{key:row.get(key) for key in collector.FIELDS}, '_observedAt':observed} for row in rows]}
            digest = hashlib.sha256(query.encode()).hexdigest()[:20]
            archive_path = source / 'pages' / f'refresh-{stamp}-{digest}-{number:06}.json'
            # A resumed run retains prior observations from the same live page.
            if archive_path.exists():
                old = base.read_json(archive_path)
                combined = {str(r.get('ID')):r for r in old['items']}
                combined.update({str(r.get('ID')):r for r in page['items']})
                page['items'] = list(combined.values())
            base.save_json(archive_path, page)
            end = number * size >= total
            overlap = bool(rows) and ids <= known[query]
            progress.update(pagesFetched=number, totalCount=total, newIds=sorted(new_ids),
                            observedAt=observed, complete=end or overlap,
                            stopReason='end_of_results' if end else 'saved_page_overlap' if overlap else 'page_limit')
            base.save_json(state_path, state)
            print(f'[{index}/{len(queries)}] {query} · {number}페이지 · 새 기록 {len(new_ids):,}건' +
                  (' · 대조 완료' if progress['complete'] else ''), flush=True)
            if progress['complete']:
                break
    state['completedAt'] = datetime.now(timezone.utc).isoformat()
    state['complete'] = all(state['queries'].get(q, {}).get('complete') for q in queries)
    state['newUniqueListingIds'] = len({sid for p in state['queries'].values() for sid in p['newIds']})
    base.save_json(state_path, state)
    return state


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=collector.ROOT)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--run-dir', type=Path)
    parser.add_argument('--delay', type=float, default=1.5)
    parser.add_argument('--max-pages', type=int, default=100)
    args = parser.parse_args(argv)
    if not 1 <= args.max_pages or not 1 <= args.delay < float('inf'):
        parser.error('Use max-pages >=1 and a delay >=1 second')
    source = args.source or args.root / '.cache/chinese-price-backfill/cardhobby'
    run_dir = args.run_dir or args.root / '.cache/chinese-price-refresh' / datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    catalog = collector.PriceCatalog(args.root)
    try:
        state = refresh(catalog, source, run_dir, args.delay, args.max_pages)
    finally:
        # Reuse the same public-attribute validation as the user's backfill CMD.
        # A stop or failed page only rebuilds previously confirmed cached prices.
        if source.resolve() == (args.root / '.cache/chinese-price-backfill/cardhobby').resolve():
            collector.apply_cached_prices(args.root, source, allow_network=sys.exc_info()[0] is None)
        else:
            collector.validate_saved_prices(args.root, source, allow_network=sys.exc_info()[0] is None)
    print(json.dumps({'refreshComplete':state['complete'], 'newUniqueListingIds':state['newUniqueListingIds'],
                      'scope':state['scope'], 'historicalCheckpointPreserved':True}, ensure_ascii=False))
    return 0 if state['complete'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
