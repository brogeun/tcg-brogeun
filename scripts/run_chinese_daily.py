"""Bounded public CN head refresh; publish only a completely validated snapshot."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path, PurePosixPath
import shutil
import tarfile
import tempfile
import time
import urllib.parse
import urllib.request
import uuid

import backfill_chinese_prices as base
import build_chinese_market as builder
import chinese_listing_details as details
import collect_chinese_prices as collector
import refresh_chinese_prices as head

ROOT = Path(__file__).resolve().parents[1]
SEED = 'automation-sources/chinese-bootstrap-20261011.tar.gz'


class RequestLimit(RuntimeError):
    pass


class Budget:
    """One sequential request gate shared by search, attributes and retries."""
    def __init__(self, delay=1.5, seconds=600, clock=time.monotonic, sleep=time.sleep):
        if delay < 1.5 or not 0 < seconds <= 600:
            raise ValueError('Delay must be >=1.5 seconds and duration <=600 seconds')
        self.clock, self.sleep, self.delay = clock, sleep, delay
        self.started, self.last = clock(), None
        self.deadline = self.started + seconds
        self.counts = {'search': 0, 'detail': 0}
        self.limits = {'search': 300, 'detail': 100}

    def remaining(self):
        return self.deadline - self.clock()

    def perform(self, kind, request):
        if self.counts[kind] >= self.limits[kind]:
            raise RequestLimit(f'{kind} HTTP attempt limit reached; cached progress retained')
        wait = 0 if self.last is None else max(0, self.delay - (self.clock() - self.last))
        if self.remaining() <= wait:
            raise RequestLimit('600-second refresh deadline reached; cached progress retained')
        self.sleep(wait)
        self.counts[kind] += 1
        self.last = self.clock()
        return request(min(45, self.remaining()))

    def pause(self, seconds):
        if self.remaining() <= seconds:
            raise RequestLimit('600-second refresh deadline reached; cached progress retained')
        self.sleep(seconds)


def bootstrap(root):
    """Extract allowlisted public records; never replace an existing archive."""
    root = Path(root)
    archive = root / '.cache/chinese-price-backfill/cardhobby'
    with tarfile.open(root / SEED, 'r:gz') as source:
        total = 0
        for member in source:
            name = PurePosixPath(member.name)
            if not member.isfile() or name.is_absolute() or '..' in name.parts or '\\' in member.name:
                raise ValueError('Invalid bootstrap member')
            if name.parts[0] == 'cardhobby' and (str(name) in ('cardhobby/checkpoint.json', 'cardhobby/listing-details.json') or str(name).startswith('cardhobby/pages/')):
                destination = archive.joinpath(*name.parts[1:])
            elif name.parts[0] == 'catalogue-cache' and len(name.parts) == 2 and name.name.startswith('chinese-card-source-') and name.suffix == '.json':
                destination = root / '.cache' / name.name
            elif str(name) == 'catalogue-evidence/chinese-box-configurations.json':
                destination = root / '.cache/chinese-daily' / name.name
            else:
                raise ValueError('Unexpected bootstrap member')
            total += member.size
            if total > 150_000_000 or member.size > 16_000_000:
                raise ValueError('Bootstrap exceeds its documented size')
            if destination.exists():
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(destination.suffix + '.bootstrap.tmp')
            temporary.write_bytes(source.extractfile(member).read())
            temporary.replace(destination)
    return archive


def public_json(url, referer, timeout):
    request = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0', 'Referer': referer, 'Accept': 'application/json'})
    # Public requests only: no environment proxy credentials or cookie jar.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=timeout) as response:
        if response.status != 200:
            raise ValueError('Public source did not return HTTP 200')
        return json.loads(response.read().decode('utf-8-sig'))


def search_fetcher(budget):
    def fetch(query, page, size):
        params = {'userId': '', 'pageIndex': page, 'pageSize': size, 'searchKey': query,
                  'searchJson': json.dumps([{'Key': 'Status', 'Value': -2}]),
                  'sort': 'EffectiveTimeStamp', 'sortType': 'DESC'}
        url = collector.ENDPOINT + '?' + urllib.parse.urlencode(params)
        payload = budget.perform('search', lambda timeout: public_json(url, collector.search_url(query), timeout))
        return collector.decode_response(payload)
    return fetch


def fill_attributes(archive, catalog, budget):
    candidates, _ = collector.compile_results(archive, catalog, write=False, require_details=False)
    valid = collector.read_listing_details(archive)
    path = Path(archive) / 'listing-details.json'
    cached = base.read_json(path)
    cached['requirePublicAttributes'] = True
    base.save_json(path, cached)
    for quote in candidates['records']:
        identity = quote['listingId']
        if identity in valid:
            continue
        url = details.ENDPOINT + '?' + urllib.parse.urlencode({'id': identity})
        for attempt in range(1, 4):
            try:
                payload = budget.perform('detail', lambda timeout: public_json(url, quote['sourceUrl'], timeout))
                details.parse_properties(payload)
                break
            except OSError as error:
                if attempt == 3 or not collector.retryable_network_error(error):
                    raise
                budget.pause(3 * 2 ** (attempt - 1))
        cached['items'][identity] = {
            'id': identity, 'sourceUrl': quote['sourceUrl'], 'propertiesUrl': url,
            'observedAt': datetime.now(timezone.utc).isoformat(), 'properties': payload['data']}
        base.save_json(path, cached)
        valid[identity] = True
    _, report = collector.compile_results(archive, catalog, write=False, require_details=True)
    if report['listingDetailsPending'] or report['queriesPending']:
        raise ValueError('Public attribute or historical-query validation remains incomplete')
    return report


def ensure_preserved(previous, updated):
    if any(updated.get(key) != value for key, value in {
        'source': 'cardhobby', 'market': 'CN', 'currency': 'CNY', 'priceKind': 'auction_end_price'}.items()):
        raise ValueError('Wrong market snapshot')
    def series(market):
        result = {(identity, grade): quote for identity, card in market.get('cards', {}).items()
                  for grade, quote in card.get('grades', {}).items()}
        result.update({(box['targetId'], 'box'): box for boxes in market.get('boxes', {}).values() for box in boxes})
        return result
    old, new = series(previous), series(updated)
    for key, quote in old.items():
        if key not in new or not {p['date'] for p in quote['history']} <= {p['date'] for p in new[key]['history']}:
            raise ValueError('Refusing to remove previously published target or history')
        if new[key].get('totalAuctionCount', 0) < quote.get('totalAuctionCount', 0):
            raise ValueError('Refusing to reduce previously published auction coverage')
    if previous.get('observedAt') and (not updated.get('observedAt') or updated['observedAt'] < previous['observedAt']):
        raise ValueError('Refusing an older observation snapshot')


def promote(root, archive, report_dir, build=builder.build):
    """Build in isolation; all gates precede the one atomic website-file write."""
    root, report_dir = Path(root), Path(report_dir)
    published = root / 'data/chinese-market.json'
    previous = base.read_json(published)
    report_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='chinese-validated-', dir=report_dir) as temporary:
        staging = Path(temporary)
        (staging / 'data').mkdir()
        shutil.copyfile(root / 'data/chinese-catalog.json', staging / 'data/chinese-catalog.json')
        shutil.copytree(root / 'data/chinese-sets', staging / 'data/chinese-sets')
        for source in (root / '.cache').glob('chinese-card-source-*.json'):
            target = staging / '.cache' / source.name
            target.parent.mkdir(exist_ok=True)
            shutil.copyfile(source, target)
        proof = root / 'data/chinese-box-configurations.json'
        if not proof.exists():
            proof = root / '.cache/chinese-daily/chinese-box-configurations.json'
        if proof.exists():
            shutil.copyfile(proof, staging / 'data/chinese-box-configurations.json')
        updated, report = build(staging, archive, report_dir / 'build')
        if report['queriesPending'] or report['listingDetailsPending'] or not report['publicAttributesRequired']:
            raise ValueError('Incomplete archive; previous website file preserved')
        ensure_preserved(previous, updated)
        base.save_json(published, updated)
    return report


def run(root=ROOT, budget=None):
    root = Path(root)
    archive = bootstrap(root)
    state_root = root / '.cache/chinese-daily'
    pointer_path = state_root / 'active-run.json'
    pointer = base.read_json(pointer_path) if pointer_path.exists() else {}
    if not pointer.get('id') or pointer.get('published'):
        pointer = {'id': uuid.uuid4().hex, 'published': False}
        base.save_json(pointer_path, pointer)
    run_dir = state_root / 'runs' / pointer['id']
    catalog = collector.PriceCatalog(root)
    budget = budget or Budget()
    report = {'complete': False, 'published': False, 'runId': pointer['id']}
    try:
        state = head.refresh(catalog, archive, run_dir, delay=1.5, max_pages=100,
                             fetcher=search_fetcher(budget), sleeper=budget.pause, attempts=3)
        if not state['complete']:
            raise RequestLimit('Per-query 100-page bound reached; previous website file preserved')
        attributes = fill_attributes(archive, catalog, budget)
        if budget.remaining() <= 0:
            raise RequestLimit('Refresh deadline reached; previous website file preserved')
        result = promote(root, archive, state_root / 'reports' / pointer['id'])
        pointer['published'] = True
        base.save_json(pointer_path, pointer)
        report.update(complete=True, published=True, newUniqueListingIds=state['newUniqueListingIds'],
                      coverage=result['coverage'], listingDetailsPending=attributes['listingDetailsPending'])
        return report
    finally:
        report.update(httpAttempts=budget.counts, checkedAt=datetime.now(timezone.utc).isoformat())
        base.save_json(state_root / 'last-run.json', report)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    args = parser.parse_args()
    try:
        print(json.dumps(run(args.root), ensure_ascii=False))
    except Exception as error:
        print(f'CN refresh incomplete: {error}; existing website data retained.')
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
