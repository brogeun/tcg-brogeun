"""Import saved public PriceCharting pages. Offline; no paid API or browser bypass.

Default output is staged for review. Missing prices are never zero; a price guide
is not a completed sale. Public sale rows are a partial sample, not market volume.
"""
import argparse
import copy
import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit, urljoin, unquote
from bs4 import BeautifulSoup

ROOT = Path(__file__).resolve().parent.parent
SOURCE = 'https://www.pricecharting.com'
NAME_ALIASES = {'Chaos Rising': {'Nitro R Energy': 'Nitro Fire Energy', 'Bubbly W Energy': 'Bubbly Water Energy', 'Magnetic M Energy': 'Magnetic Metal Energy'}}

def norm(s):
    return re.sub(r'[^a-z0-9]', '', unicodedata.normalize('NFKD', str(s)).casefold())

def number(s):
    return re.sub(r'\d+', lambda m: str(int(m[0])), str(s).split('/')[0].upper())

def cents(s):
    if s in (None, '', '-'): return None
    if not re.fullmatch(r'\$\d[\d,]*\.\d{2}', s):
        raise ValueError(f'Not an explicit USD price: {s}')
    n = int(Decimal(s.replace('$', '').replace(',', '')) * 100)
    return n if n > 0 else None

def timestamp(s):
    t = datetime.fromisoformat(s.replace('Z', '+00:00'))
    if t.tzinfo is None or t > datetime.now(timezone.utc):
        raise ValueError('Observation time must be timezone-aware and not in the future')
    return t

def pc_url(s, kind):
    u = urlsplit(s)
    if u.scheme != 'https' or u.netloc != 'www.pricecharting.com' or not re.fullmatch(
        r'/' + kind + r'/pokemon-[a-z0-9-]+' + (r'/[a-z0-9%\x27()-]+' if kind == 'game' else ''), u.path):
        raise ValueError(f'Unsupported source URL: {s}')
    return SOURCE + u.path

def parse_html(raw, observed):
    soup = BeautifulSoup(raw, 'html.parser')
    currency = soup.select_one('#dropdown_selected_currency')
    if not currency or currency.get_text(strip=True) != 'USD':
        raise ValueError('Select USD on the source page before saving')
    canonical = soup.select_one('link[rel="canonical"]')
    if not canonical: raise ValueError('No source URL. Save the fully loaded original page as HTML.')
    url = canonical.get('href', '')
    table = soup.select_one('#games_table')
    payload = dict(schemaVersion=1, observedAt=observed, grade='PSA 10', currency='USD', rows=[])
    if table:
        payload.update(kind='set', sourceUrl=pc_url(url, 'console'))
        h1 = soup.select_one('h1')
        match = re.fullmatch(r'Prices for Pokemon (.+) Pokemon Cards', h1.get_text(' ', strip=True) if h1 else '', re.I)
        if not match: raise ValueError('Not a supported English Pokemon set page')
        payload['sourceSetName'] = match[1]
        heads = [x.get_text(' ', strip=True) for x in table.select('thead th')]
        if heads.count('PSA 10') != 1: raise ValueError('PSA 10 column is missing or ambiguous')
        col = heads.index('PSA 10')
        for row in table.select('tbody tr'):
            link = row.select_one('td.title a'); cells = row.find_all('td', recursive=False)
            if link and len(cells) > col:
                payload['rows'].append(dict(title=link.get_text(' ', strip=True), sourceUrl=urljoin(SOURCE, link['href']), price=cells[col].get_text(' ', strip=True)))
    else:
        payload.update(kind='card', sourceUrl=pc_url(url, 'game'))
        title = soup.select_one('#product_name'); set_link = title.select_one('a') if title else None
        if not set_link: raise ValueError('Card identity is missing')
        payload['sourceSetName'] = re.sub(r'^Pokemon\s+', '', set_link.get_text(' ', strip=True))
        set_link.extract()
        title_text = title.get_text(' ', strip=True)
        prices = [r.find_all('td') for r in soup.select('#full-prices tr')]
        prices = [r[1].get_text(' ', strip=True) for r in prices if len(r) == 2 and r[0].get_text(' ', strip=True) == 'PSA 10']
        if len(prices) != 1: raise ValueError('Explicit PSA 10 price guide row missing')
        payload['rows'] = [dict(title=title_text, sourceUrl=payload['sourceUrl'], price=prices[0])]
        option = soup.select_one('option[value="completed-auctions-manual-only"]')
        match = re.fullmatch(r'PSA 10\s*\((\d+)\)', option.get_text(' ', strip=True) if option else '')
        if not match: raise ValueError('PSA 10 sold-listings count missing')
        payload['sourceSalesCount'] = int(match[1]); payload['sales'] = []
        for row in soup.select('.completed-auctions-manual-only tbody tr'):
            link = row.select_one('td.title a'); date = row.select_one('td.date')
            # The separate listed-price cell may be crossed out (best offer).
            price = row.select_one('td.numeric:not(.listed-price) .js-price')
            if link and date and price:
                payload['sales'].append(dict(title=link.get_text(' ', strip=True), date=date.get_text(strip=True), price=price.get_text(strip=True), url=link['href']))
        if len(payload['sales']) != payload['sourceSalesCount']:
            raise ValueError('Save after the PSA 10 tab has loaded all its visible sale rows')
    return payload

def sale_reason(sale, card, data, observed):
    title = sale.get('title', '')
    if not re.search(r'\bPSA\s*10\b', title, re.I): return 'grade-not-explicit'
    if re.search(r'candidate|potential|contender|quality|pack\s*fresh|ungraded|\braw\b|proxy|replica|reprint|\blot\b|bundle|\bCGC\b|\bBGS\b|\bACE\b|\bSGC\b|Japanese|\bJPN?\b|Korean|Chinese|French|German|Italian|Spanish', title, re.I):
        return 'other-grade-language-or-ungraded'
    if norm(data['name']) not in norm(title) and not re.search(r'\b' + re.escape(data.get('displayCode') or '__none__') + r'\b', title, re.I): return 'set-not-explicit'
    n = number(card['number'])
    if not re.search(r'(?:#\s*0*' + re.escape(n) + r'\b|\b0*' + re.escape(n) + r'\s*/)', title, re.I): return 'number-not-explicit'
    if norm(card['name']) not in norm(title): return 'name-mismatch'
    u = urlsplit(sale.get('url', ''))
    # Supported public eBay regions; query parameters are discarded after validation.
    if u.scheme != 'https' or u.netloc not in ('www.ebay.com', 'www.ebay.co.uk', 'www.ebay.ca', 'www.ebay.com.au', 'www.ebay.de', 'www.ebay.es', 'www.ebay.fr', 'www.ebay.it') or not re.fullmatch(r'/itm/\d+', u.path): return 'unsupported-sale-source'
    try:
        d = datetime.strptime(sale['date'], '%Y-%m-%d').date()
        release = datetime.strptime(data['release'].replace('.', '-'), '%Y-%m-%d').date() if data.get('release') else None
        if d > timestamp(observed).date() or (release and d < release): return 'invalid-date'
        if not cents(sale.get('price')): return 'price-missing'
    except (ValueError, KeyError): return 'invalid-date-or-price'
    return None

def merge(data, snapshot):
    data = copy.deepcopy(data)
    if snapshot.get('schemaVersion') != 1 or snapshot.get('grade') != 'PSA 10' or snapshot.get('currency') != 'USD': raise ValueError('Wrong snapshot schema, grade or currency')
    if data.get('language') != 'en' or norm(data['name']) != norm(snapshot['sourceSetName']): raise ValueError('Set/language mismatch')
    at = timestamp(snapshot['observedAt']); kind = snapshot['kind']
    if kind not in ('set', 'card'): raise ValueError('Unsupported snapshot kind')
    source = pc_url(snapshot['sourceUrl'], 'console' if kind == 'set' else 'game')
    console_slug = urlsplit(source).path.split('/')[2]
    index = defaultdict(list)
    for card in data['cards']: index[(norm(card['name']), number(card['number']))].append(card)
    seen = set(); report = dict(matched=0, priced=0, noPrice=0, skipped=[], acceptedSales=0, rejectedSales=[], stale=0)
    for row in snapshot['rows']:
        match = re.fullmatch(r'(.+) #([A-Za-z0-9]+)', row['title'])
        if not match: report['skipped'].append(row['title']); continue
        name = NAME_ALIASES.get(data['name'], {}).get(match[1], match[1])
        key = norm(name), number(match[2]); cards = index.get(key, [])
        if len(cards) != 1: report['skipped'].append(row['title']); continue
        if key in seen: raise ValueError('Duplicate matching card identity')
        seen.add(key); card = cards[0]
        url = pc_url(row['sourceUrl'], 'game')
        if urlsplit(url).path.split('/')[2] != console_slug: raise ValueError('Card URL belongs to another set')
        slug = unquote(urlsplit(url).path.split('/')[-1]).rsplit('-', 1)
        if len(slug) != 2 or norm(slug[0]) != norm(match[1]) or number(slug[1]) != number(match[2]):
            raise ValueError('Source URL does not match the card name/number')
        if kind == 'card' and url != source: raise ValueError('Card source mismatch')
        price = cents(row.get('price'))
        previous = card.get('psa10', {})
        if previous.get('fetchedAt') and timestamp(previous['fetchedAt']) > at:
            report['stale'] += 1; continue
        p = {**previous, 'source': 'PriceCharting', 'sourceUrl': url, 'grade': 'PSA 10', 'language': 'en', 'currency': 'USD', 'fetchedAt': snapshot['observedAt'], 'sourcePriceCents': price, 'referencePriceCents': None, 'status': 'estimated' if price else 'no-price'}
        if kind == 'card':
            accepted = []; rejected = []; unique = set()
            for sale in snapshot.get('sales', []):
                reason = sale_reason(sale, card, data, snapshot['observedAt'])
                if reason:
                    rejected.append(dict(url=sale.get('url'), reason=reason)); continue
                u = urlsplit(sale['url']); sale_url = 'https://' + u.netloc + u.path
                if sale_url in unique: continue
                unique.add(sale_url)
                accepted.append(dict(date=sale['date'], title=sale['title'], url=sale_url, priceCents=cents(sale['price'])))
            # Preserve older verified records across captures; deduplicate by source URL.
            rejected_urls = {urlsplit(s.get('url') or '')._replace(query='', fragment='').geturl() for s in rejected}
            combined = {s['url']: s for s in previous.get('sales', []) if s['url'] not in rejected_urls}
            combined.update({s['url']: s for s in accepted})
            p.update(sales=sorted(combined.values(), key=lambda s:s['date'], reverse=True), rejectedSales=rejected, sourceSalesCount=snapshot.get('sourceSalesCount'), salesFetchedAt=snapshot['observedAt'], salesCoverage='public-recent-sample')
            report['acceptedSales'] += len(accepted); report['rejectedSales'] += rejected
        card['psa10'] = p; report['matched'] += 1
        report['priced' if price else 'noPrice'] += 1
    if kind == 'card' and (len(snapshot['rows']) != 1 or len(snapshot.get('sales', [])) != snapshot.get('sourceSalesCount')):
        raise ValueError('Incomplete card sale snapshot')
    if not seen: raise ValueError('No exact card name/number matches; nothing imported')
    data['priceCoverage'] = dict(Counter(c.get('psa10', {}).get('status', 'not-collected') for c in data['cards']))
    data['priceStatus'] = 'partial' if 'not-collected' in data['priceCoverage'] else 'reference-prices'
    data['priceFetchedAt'] = max((c['psa10']['fetchedAt'] for c in data['cards'] if c.get('psa10', {}).get('fetchedAt')), default=None)
    report['unmatchedCards'] = len(data['cards']) - len(seen)
    return data, report

def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':')), encoding='utf-8')
    tmp.replace(path)

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('files', type=Path, nargs='*'); p.add_argument('--inbox', action='store_true')
    p.add_argument('--output', type=Path, default=ROOT/'.cache/english-prices')
    args = p.parse_args(); inbox = ROOT/'price-import'; inbox.mkdir(exist_ok=True)
    files = args.files or sorted([*inbox.glob('*.html'), *inbox.glob('*.htm'), *inbox.glob('*.json')])
    if not files:
        print('Save loaded PriceCharting set/card pages as HTML into:\n' + str(inbox))
        print('Then run this CMD again. No API/payment. The website is not deployed by this tool.'); return
    catalog = json.loads((ROOT/'data/english-catalog.json').read_text('utf-8'))['sets']
    ledger_path = ROOT/'.cache/english-prices/import-ledger.json'
    ledger = json.loads(ledger_path.read_text('utf-8')) if ledger_path.exists() else {}
    reports = []; failures = 0
    for path in sorted(files, key=lambda x:x.stat().st_mtime):
        try:
            raw = path.read_bytes(); digest = hashlib.sha256(raw).hexdigest()
            observed = ledger.get(digest) or datetime.fromtimestamp(path.stat().st_mtime, timezone.utc).isoformat()
            snap = json.loads(raw) if path.suffix.lower() == '.json' else parse_html(raw, observed)
            candidates = [s for s in catalog if norm(s['name']) == norm(snap['sourceSetName'])]
            if len(candidates) != 1: raise ValueError('Set name not uniquely matched; review required')
            code = candidates[0]['code']; relative = Path('data/english-sets')/(code+'.json')
            base = args.output/relative if (args.output/relative).exists() else ROOT/relative
            data, report = merge(json.loads(base.read_text('utf-8')), snap)
            save(args.output/relative, data)
            save(ROOT/'.cache/english-prices/snapshots'/(digest+'.json'), snap)
            ledger[digest] = snap['observedAt']
            reports.append(dict(file=path.name, code=code, observedAt=snap['observedAt'], **report))
            print(f'{code}: {report["matched"]} matched, {report["priced"]} quotes, {report["acceptedSales"]} accepted sales, {len(report["skipped"])} skipped')
        except (ValueError, KeyError, OSError, TypeError) as e:
            failures += 1; reports.append(dict(file=path.name, error=str(e))); print(f'REVIEW {path.name}: {e}')
    save(ledger_path, ledger); save(args.output/'report.json', reports)
    print('Report: '+str(args.output/'report.json'))
    print('Saved quotes are current reference estimates; sale rows are a partial public sample. Deployment is separate.')
    raise SystemExit(1 if failures else 0)

if __name__ == '__main__': main()
