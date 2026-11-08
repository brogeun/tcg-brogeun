"""Review saved unresolved memberships against their original card and market images.

Each completed membership is committed to SQLite immediately, so interruption
does not discard the run. Multiple candidates and official reprints are compared
instead of being skipped. Only separated artwork matches or explicit official
acquisition matches may produce a binding; editions with indistinguishable art
remain separate.
"""
import argparse
import concurrent.futures
import hashlib
import io
import json
import os
import pathlib
import re
import sqlite3
import sys
import threading
import time
import unicodedata
from collections import OrderedDict
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import imagehash
import numpy as np
from bs4 import BeautifulSoup
from PIL import Image, ImageChops

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / '.cache/contained-market-reconciliation/deps'))
sys.path.insert(0, str(ROOT / 'scripts/onepiece_audit'))
import geometry
from run import acquisition as original_acquisition, learn_contexts

sys.stdout.reconfigure(encoding='utf-8')
WORK = ROOT / '.cache/contained-market-reconciliation'
WORK.mkdir(parents=True, exist_ok=True)
CACHE = WORK / 'image-cache'
CACHE.mkdir(exist_ok=True)
OLD_CACHE = ROOT / '.cache/onepiece-audit/images'
HOSTS = {'cdn.pooka.app', 'static.tcgcollector.com', 'cdn.snkrdunk.com', 'www.onepiece-cardgame.com', 'snkrdunk.com', 'www.tcgcollector.com', 'pooka.app'}
LOCK = threading.Lock()
URL_LOCKS = {}
BLOCKED = set()
OFFICIAL_SIBLINGS = {}
KNOWN_PRODUCTS = {}
IMAGE_FEATURES = OrderedDict()
ACQUISITION_CONTEXTS = {}


def stamp():
    return datetime.now(timezone.utc).isoformat()


def candidate_fingerprint(row):
    payload=json.dumps({'target':row['target'],'candidates':row['candidates']},ensure_ascii=False,sort_keys=True,separators=(',',':'))
    return hashlib.sha256(payload.encode('utf-8')).hexdigest()


def key(row):
    t = row['target']
    return '|'.join([t['brand'], t['boxCode'].upper(), t.get('fullId', '').upper() or t.get('number', ''), t.get('image', '')])


def fetch(url, html=False):
    u = urllib.parse.urlsplit(url)
    if u.scheme != 'https' or u.hostname not in HOSTS or u.username or u.password:
        raise ValueError('Unsupported original source URL')
    digest = hashlib.sha256(url.encode()).hexdigest()
    suffix = '.html' if html else '.bin'
    with LOCK:
        url_lock = URL_LOCKS.setdefault(url, threading.Lock())
    with url_lock:
        path = CACHE / (digest + suffix)
        old = OLD_CACHE / (digest + suffix)
        if path.exists():
            return path
        if old.exists():
            return old
        with LOCK:
            if u.hostname in BLOCKED:
                raise RuntimeError('Source temporarily unavailable; stopped repeated requests')
        req = urllib.request.Request(url, headers={'User-Agent': 'TCGHubCardIdentityReview/2.0 (+https://tcghub.kr)'})
        try:
            with urllib.request.urlopen(req, timeout=12) as response:
                raw = response.read(4_000_001)
        except urllib.error.HTTPError as error:
            if error.code in (401, 403, 429):
                with LOCK:
                    BLOCKED.add(u.hostname)
            raise
        if len(raw) > 4_000_000:
            raise ValueError('Source response too large')
        if not html:
            with Image.open(io.BytesIO(raw)) as image:
                image.load()
        temp = path.with_suffix(path.suffix + '.tmp')
        temp.write_bytes(raw)
        temp.replace(path)
        return path


def frame(path):
    with Image.open(path) as im:
        im.load()
        rgba = im.convert('RGBA')
    alpha = rgba.getchannel('A')
    if alpha.getextrema()[0] < 250:
        bounds = alpha.point(lambda v: 255 if v > 40 else 0).getbbox()
        if bounds:
            rgba = rgba.crop(bounds)
    canvas = Image.new('RGBA', rgba.size, 'white')
    canvas.alpha_composite(rgba)
    rgb = canvas.convert('RGB')
    # Marketplace thumbnails are frequently square canvases around a card.
    mask = ImageChops.difference(rgb, Image.new('RGB', rgb.size, 'white')).convert('L').point(lambda v: 255 if v > 24 else 0)
    bounds = mask.getbbox()
    if bounds:
        ratio = (bounds[2] - bounds[0]) / (bounds[3] - bounds[1])
        if .61 < ratio < .80 and (rgb.width / rgb.height > .82 or bounds[0] > 3 or bounds[1] > 3):
            rgb = rgb.crop(bounds)
    if not .61 < rgb.width / rgb.height < .82:
        raise ValueError('Cannot establish a complete card frame')
    if rgb.width < 150 or rgb.height < 210:
        raise ValueError('Insufficient card image resolution')
    return rgb.resize((252, 352), Image.Resampling.LANCZOS)


def metrics(source, market):
    regions = [(0, 0, 252, 352), (16, 34, 236, 302), (18, 55, 234, 190), (8, 275, 244, 348)]
    distances = [int(imagehash.phash(source.crop(r)) - imagehash.phash(market.crop(r))) for r in regions]
    delta = np.abs(np.asarray(source, dtype=np.float32) - np.asarray(market, dtype=np.float32))
    mean = float(delta.mean())
    return {'distance': distances[0], 'detailDistance': distances[1], 'artDistance': distances[2], 'footerDistance': distances[3], 'meanPixelDifference': round(mean, 3), 'score': round(distances[0] + .5 * distances[1] + .3 * distances[2] + .12 * mean, 3)}


def geometry_for(path):
    name = str(path)
    with LOCK:
        saved = IMAGE_FEATURES.get(name)
        if saved is not None:
            IMAGE_FEATURES.move_to_end(name)
    if saved is not None:
        return saved
    im = geometry.normalize(path.read_bytes())
    value = (im, geometry.features(im))
    with LOCK:
        IMAGE_FEATURES[name] = value
        IMAGE_FEATURES.move_to_end(name)
        while len(IMAGE_FEATURES) > 256:
            IMAGE_FEATURES.popitem(last=False)
    return value


def registered_compare(source_path, market_path):
    a, fa = geometry_for(source_path)
    b, fb = geometry_for(market_path)
    return geometry.compare(a, b, fa, fb)


def source_image(t, root):
    local = t.get('localImage') or (t.get('image') if str(t.get('image', '')).startswith('/images/') else '') or ''
    if local.startswith('/images/') and '..' not in local.split('/'):
        path = (root / local.lstrip('/')).resolve()
        path.relative_to(root.resolve())
        if path.exists():
            return path, local
    # Previously reviewed URL migrations are retained with the source card.
    url = t.get('imageSourceUrl') or t.get('officialImage') or t.get('image', '')
    return fetch(url), url


def explicit_acquisition(t, p):
    if t['brand'] != 'onepiece' or not t.get('officialId') or not t.get('acquisition'):
        return False
    return bool(original_acquisition({'card': t}, p, ACQUISITION_CONTEXTS))


def market_page(product):
    url = 'https://snkrdunk.com/apparels/' + str(product['id'])
    path = fetch(url, html=True)
    soup = BeautifulSoup(path.read_text(encoding='utf-8'), 'html.parser')
    metadata = []
    for tag in soup.find_all('script', type='application/ld+json'):
        try:
            doc = json.loads(tag.get_text())
        except (ValueError, TypeError):
            continue
        entries = doc if isinstance(doc, list) else [doc]
        for entry in entries:
            if isinstance(entry, dict):
                metadata.extend(entry.get('@graph', [entry]))
    item = next((m for m in metadata if isinstance(m, dict) and m.get('@type') == 'Product'), None)
    page_text = soup.get_text(' ', strip=True)
    normalize_name = lambda v: re.sub(r'\s+', '', unicodedata.normalize('NFKC', str(v))).lower()
    # Unlisted products may omit Product JSON-LD. Their canonical product URL,
    # visible English title, management number and original image still exist.
    if not item:
        canonical = soup.find('meta', property='og:url')
        if not canonical or canonical.get('content', '').rstrip('/') != url or not soup.find('h1') or normalize_name(product.get('name')) not in normalize_name(page_text):
            raise ValueError('Original product page has no matching product identity')
        item = {'name': product['name'], 'image': []}
    # SKU and product photo bind a receipt to the original marketplace product.
    raw_sku = str(item.get('sku') or item.get('mpn') or '')
    if product.get('productNumber') and product['productNumber'].lower() not in page_text.lower() and raw_sku.lower() != product['productNumber'].lower():
        raise ValueError('Original market product number differs from catalogue')
    images = item.get('image') or []
    if isinstance(images, str):
        images = [images]
    if isinstance(images, dict):
        images = [images.get('url')]
    asset = lambda v: urllib.parse.urlsplit(str(v))._replace(query='', fragment='').geturl()
    expected = asset(product.get('thumbnailUrl') or product.get('image', ''))
    og = soup.find('meta', property='og:image')
    images += [og.get('content')] if og else []
    # Product JSON-LD is omitted on some unlisted items. The product carousel
    # still exposes the current original photograph; recommendations are not
    # evidence for the inspected product.
    main_image = soup.select_one('img[class*="_mainImage"]')
    if main_image and urllib.parse.urlsplit(main_image.get('src', '')).hostname == 'cdn.snkrdunk.com':
        images.insert(0, main_image['src'])
    if normalize_name(item.get('name')) != normalize_name(product.get('name')):
        raise ValueError('Original marketplace title changed; identity review required')
    current_image = next((v for v in images if isinstance(v, str) and urllib.parse.urlsplit(v).hostname == 'cdn.snkrdunk.com'), None)
    return {'url': url, 'name': item.get('name'), 'sku': raw_sku, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'checkedAt': stamp(), 'currentImage': current_image, 'catalogueImageCurrent': any(asset(v) == expected for v in images)}


def review(row, root):
    t = row['target']
    result = {'key': key(row), 'code': row['code'], 'group': row['group'], 'oldStatus': row['status'], 'target': t, 'candidateFingerprint':candidate_fingerprint(row)}
    if t.get('bundle') or t.get('isBundle') or row['status'] == 'paired-product':
        return {**result, 'status': 'separate-bundle-product'}
    candidates = row['candidates']
    if not candidates:
        return {**result, 'status': 'original-market-search-needed'}
    try:
        sp, source_url = source_image(t, root)
        own = geometry_for(sp)
    except Exception as error:
        return {**result, 'status': 'source-image-review-needed', 'error': str(error)}
    comparisons = []
    for product in candidates:
        try:
            url = product.get('thumbnailUrl') or product.get('image', '')
            path = fetch(url)
            evidence = registered_compare(sp, path)
            measure = {'evidence': evidence, 'score': round(1 - evidence.get('quality', 0), 6)}
            comparisons.append({'id': str(product['id']), **measure, 'marketFile': str(path), 'acquisitionMatch': explicit_acquisition(t, product)})
        except Exception as error:
            comparisons.append({'id': str(product['id']), 'error': str(error)})
    good = sorted([c for c in comparisons if 'score' in c], key=lambda c: c['score'])
    result.update(comparisons=comparisons, sourceFile=str(sp), sourceEvidenceUrl=source_url)
    if not good:
        return {**result, 'status': 'market-image-review-needed'}
    first = good[0]
    acquisition = [c for c in good if c['acquisitionMatch']]
    if t['brand'] == 'onepiece':
        if not acquisition:
            return {**result, 'status': 'original-acquisition-product-search-needed'}
        first = min(acquisition, key=lambda c: c['score'])
    acceptable = geometry.passes(first['evidence'])
    if not acceptable:
        return {**result, 'status': 'image-review-needed', 'best': first}
    # Missing competitor images cannot establish a unique artwork match.
    if len(good) != len(candidates):
        return {**result, 'status': 'competitor-image-review-needed', 'best': first}
    unique_acquisition = len(acquisition) == 1 and first['acquisitionMatch']
    eligible = acquisition if t['brand'] == 'onepiece' else good
    others = [c for c in eligible if c['id'] != first['id']]
    separated = not others or all(c['score'] >= first['score'] + .10 for c in others)
    product = next(p for p in candidates if str(p['id']) == first['id'])
    # A stock scan cannot establish foil/edition details when the artwork itself
    # is shared. Such versions remain explicit, separately priced products.
    if not unique_acquisition and (not separated or re.search(r'\b(?:1ED|1ST|FIRST EDITION|UNLIMITED|NO RARITY|SERIAL|SIGNED|Mirror|Reverse|Master.?Ball|Monster.?Ball)\b', product['name'], re.I)):
        return {**result, 'status': 'edition-or-finish-source-review-needed', 'best': first}
    try:
        page = market_page(product)
        if page['currentImage']:
            current_path = fetch(page['currentImage'])
            current_evidence = registered_compare(sp, current_path)
            if not geometry.passes(current_evidence):
                return {**result, 'status': 'current-original-image-review-needed', 'best': first, 'currentEvidence': current_evidence}
            page['currentImageSHA256'] = hashlib.sha256(current_path.read_bytes()).hexdigest()
            page['currentImageEvidence'] = current_evidence
    except Exception as error:
        return {**result, 'status': 'original-market-page-review-needed', 'best': first, 'error': str(error)}
    if t['brand'] == 'onepiece':
        sibling_key = (t['boxCode'], t['setCode'], t.get('baseNumber') or t.get('number'))
        sibling_scores = []
        for sibling in OFFICIAL_SIBLINGS.get(sibling_key, []):
            if sibling.get('fullId', '').upper() == t.get('fullId', '').upper():
                continue
            try:
                sibling_path, _ = source_image(sibling, root)
                e = registered_compare(sibling_path, pathlib.Path(first['marketFile']))
                sibling_scores.append({'fullId': sibling.get('fullId'), 'quality': e.get('quality', 0)})
            except Exception as error:
                return {**result, 'status': 'official-sibling-image-review-needed', 'error': str(error)}
        if sibling_scores and first['evidence']['quality'] - max(r['quality'] for r in sibling_scores) < .10:
            return {**result, 'status': 'official-printing-source-review-needed', 'best': first, 'siblings': sibling_scores}
        existing = KNOWN_PRODUCTS.get(str(product['id']), set())
        if existing - {t.get('fullId', '').upper()}:
            return {**result, 'status': 'previously-linked-other-artwork', 'best': first, 'existingFullIds': sorted(existing)}
    link = {k: t.get(k, '') for k in ['brand', 'boxCode', 'setCode', 'number', 'fullId', 'image']}
    link.update(id=str(product['id']), marketName=product['name'], marketProductNumber=product.get('productNumber', ''), marketImage=product.get('thumbnailUrl') or product.get('image', ''), sourceSHA256=hashlib.sha256(sp.read_bytes()).hexdigest(), marketSHA256=hashlib.sha256(pathlib.Path(first['marketFile']).read_bytes()).hexdigest(), sourcePageUrl=t.get('currentSourceUrl') or t.get('sourceUrl') or t.get('url'), sourceLocalImage=t.get('localImage'), sourceEvidenceUrl=source_url, marketPage=page, method='official-acquisition-and-full-card-image' if unique_acquisition else 'separated-candidate-full-card-image-and-original-product-page', candidateCount=len(candidates), reviewedAt=stamp(), **{k: v for k, v in first.items() if k not in ('id', 'marketFile', 'acquisitionMatch')})
    return {**result, 'status': 'verified-original-source-link', 'link': link}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=pathlib.Path, default=ROOT)
    parser.add_argument('--input', type=pathlib.Path, default=WORK / 'pending-current.json')
    parser.add_argument('--limit', type=int, default=0)
    parser.add_argument('--workers', type=int, default=6)
    parser.add_argument('--codes', default='')
    parser.add_argument('--retry', action='store_true')
    parser.add_argument('--retry-status', default='')
    args = parser.parse_args()
    rows = json.loads(args.input.read_text(encoding='utf-8'))
    for path in (args.root / 'data/cards-by-set').glob('*.json'):
        doc = json.loads(path.read_text(encoding='utf-8'))
        for t in doc.get('cards', []):
            if t.get('brand') == 'onepiece' and t.get('officialId'):
                sibling_key = (t.get('boxCode'), t.get('setCode'), t.get('baseNumber') or t.get('number'))
                OFFICIAL_SIBLINGS.setdefault(sibling_key, []).append(t)
    for name in ['contained-card-market-links.json', 'onepiece-reviewed-promo-links.json']:
        doc = json.loads((args.root / 'data' / name).read_text(encoding='utf-8'))
        for link in doc.get('links', []):
            if link.get('brand') == 'onepiece':
                KNOWN_PRODUCTS.setdefault(str(link['id']), set()).add(link.get('fullId', '').upper())
    catalogue = json.loads((args.root / 'data/onepiece-official-search.json').read_text(encoding='utf-8'))
    for card in catalogue.get('cards', []):
        if card.get('productId'):
            KNOWN_PRODUCTS.setdefault(str(card['productId']), set()).add(card.get('fullId', '').upper())
    products = json.loads((args.root / 'data/all-cards.json').read_text(encoding='utf-8'))['details']
    context_input = {'catalogue': catalogue, 'sources': [{'candidates': products}]}
    ACQUISITION_CONTEXTS.update(learn_contexts(context_input))
    db = sqlite3.connect(WORK / 'review.sqlite3')
    db.execute('pragma journal_mode=WAL')
    db.execute('create table if not exists reviews (key text primary key, result text not null, completed_at text not null)')
    done = {r[0] for r in db.execute('select key from reviews')} if not args.retry else set()
    if args.retry_status:
        retry_status = set(args.retry_status.split(','))
        done = {k for k, value in db.execute('select key, result from reviews') if json.loads(value)['status'] not in retry_status}
    if not args.retry and not args.retry_status:
        current_fingerprints={key(r):candidate_fingerprint(r) for r in rows}
        done={k for k,value in db.execute('select key,result from reviews') if json.loads(value).get('candidateFingerprint')==current_fingerprints.get(k)}
    chosen = [r for r in rows if key(r) not in done and (not args.codes or r['code'] in args.codes.split(','))]
    if args.limit:
        chosen = chosen[:args.limit]
    started = time.monotonic()
    print(json.dumps({'event': 'started', 'queued': len(chosen), 'previouslyCompleted': len(done), 'at': stamp()}), flush=True)
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(review, r, args.root): r for r in chosen}
        for i, future in enumerate(concurrent.futures.as_completed(futures), 1):
            result = future.result()
            db.execute('insert or replace into reviews values (?, ?, ?)', (result['key'], json.dumps(result, ensure_ascii=False), stamp()))
            db.commit()
            if i % 100 == 0 or i == len(chosen):
                export(db, rows)
                print(json.dumps({'event': 'progress', 'completedThisRun': i, 'queued': len(chosen), 'seconds': round(time.monotonic() - started, 1), 'blockedHosts': sorted(BLOCKED)}), flush=True)
    export(db, rows)


def export(db, rows):
    from collections import Counter
    results = [json.loads(r[0]) for r in db.execute('select result from reviews')]
    counts = Counter(r['status'] for r in results)
    links = [r['link'] for r in results if r['status'] == 'verified-original-source-link']
    unique = len({key(r) for r in rows})
    snapshot = {'updatedAt': stamp(), 'processId': os.getpid(), 'featureCacheLimit': 256, 'inputMemberships': len(rows), 'uniqueSourceIdentities': unique, 'duplicateMemberships': len(rows)-unique, 'completed': len(results), 'remaining': unique - len(results), 'counts': counts, 'links': len(links)}
    for name, doc in [('CHECKPOINT.json', snapshot), ('verified-links.json', {'schemaVersion': 1, 'links': links}), ('review-results.json', results)]:
        out = WORK / name
        tmp = out.with_suffix('.json.tmp')
        tmp.write_text(json.dumps(doc, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
        tmp.replace(out)


if __name__ == '__main__':
    main()
