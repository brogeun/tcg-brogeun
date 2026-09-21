"""Collect the four verified Futuristic Box promo products; no paid API.
All products must succeed before snapshots are replaced. Run daily or from CMD.
"""
import json
import re
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from bs4 import BeautifulSoup
from sync_anniversary_market import get, walk

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / 'data'
JST = timezone(timedelta(hours=9))
PROOFS = [('897035', '131', 'opened'), ('881432', '131', 'sealed'),
          ('897036', '132', 'opened'), ('881433', '132', 'sealed')]
GRADES = {18: 'raw', 22: 'psa10', 23: 'psa9', 25: 'bgs10_bl', 26: 'bgs10_gl', 27: 'bgs95'}


def parse_product(html, pid, number, packaging):
    product = chips = listings = None
    for script in BeautifulSoup(html, 'html.parser').select('script'):
        text = script.string or ''
        flight = re.search(r'self\.__next_f\.push\((\[.*\])\)\s*;?\s*$', text, re.S)
        if flight:
            for line in str(json.loads(flight[1])[1]).splitlines():
                try:
                    decoded = json.loads(line[line.index(':') + 1:])
                except (ValueError, TypeError):
                    continue
                for obj in walk(decoded):
                    item = obj.get('apparelData')
                    if isinstance(item, dict) and str(item.get('id')) == pid:
                        product = item
                    if str(obj.get('apparelId')) == pid and isinstance(obj.get('listings'), list):
                        listings = obj['listings']
        hydration = re.search(r'\.push\((\{"mutations".*\})\)\s*;?\s*$', text, re.S)
        if hydration:
            for query in json.loads(hydration[1]).get('queries', []):
                if query.get('queryKey', [None])[0] == f'/v2/products/{pid}/size-chips':
                    chips = query.get('state', {}).get('data', {}).get('data', {}).get('chips')
    expected = 'Opened' if packaging == 'opened' else 'Unopen'
    if (not product or product.get('productNumber') != f'pkmn-tcg-M-P-{number}'
            or not any(b.get('id') == 'pokemon' for b in product.get('brands', []))
            or f':{expected} [{number}/M-P]' not in product.get('name', '')
            or '30th CELEBRATION FUTURISTIC BOX' not in product.get('name', '')):
        raise ValueError(f'{pid}: product/card/packaging identity mismatch')
    grades = []
    if packaging == 'sealed':
        row = next((r for r in listings or [] if r.get('variant', {}).get('filterSizeID') == 'quantity_1'), None)
        if row is None:
            raise ValueError(f'{pid}: missing single-pack listing')
        value = row.get('minNewListingPrice')
        if value is not None and (not isinstance(value, int) or value <= 0):
            raise ValueError(f'{pid}: invalid single-pack price')
        grades = [{'key': 'raw', 'label': '미개봉 · 1팩', 'lowestAsk': value}]
    else:
        if not isinstance(chips, list) or not chips:
            raise ValueError(f'{pid}: missing grade chips')
        for chip in chips:
            cid, active, value = chip.get('conditionId'), chip.get('hasListing'), chip.get('usedMinPrice')
            if not isinstance(cid, int) or not isinstance(active, bool) or (active and (not isinstance(value, int) or value <= 0)):
                raise ValueError(f'{pid}: invalid grade quote')
            grades.append({'key': GRADES.get(cid, str(cid)), 'label': chip['text'], 'lowestAsk': value if active else None})
    image = product.get('primaryMedia', {}).get('imageUrl', '')
    if not image.startswith('https://cdn.snkrdunk.com/'):
        raise ValueError(f'{pid}: missing image')
    return dict(id=pid, setCode='FURBOX', boxId='881424', brand='pokemon', kind='card',
                name=product['name'], productNumber=product['productNumber'], number=number+'/M-P',
                packaging=packaging, variant=False, thumbnailUrl=image, currency='JPY', grades=grades,
                sourceUrl=f'https://snkrdunk.com/apparels/{pid}', status='ok')


def sales(pid):
    rows, seen = [], set()
    for page in range(1, 101):
        data = get(f'https://snkrdunk.com/v1/apparels/{pid}/sales-history?page={page}&per_page=100').json()
        batch = data.get('history')
        if not isinstance(batch, list):
            raise ValueError(f'{pid}: malformed sales response')
        if not batch:
            return rows
        fingerprint = json.dumps(batch, sort_keys=True)
        if fingerprint in seen:
            raise ValueError(f'{pid}: repeated sales page; refusing partial history')
        seen.add(fingerprint)
        for row in batch:
            if not isinstance(row.get('price'), int) or row['price'] <= 0 or not row.get('date'):
                raise ValueError(f'{pid}: malformed trade')
            rows.append({k: row.get(k, '') for k in ('date', 'price', 'condition', 'size', 'label')})
    raise ValueError(f'{pid}: pagination limit reached; previous history retained')


def sale_day(label, now):
    exact = re.fullmatch(r'(\d{4})[/-](\d{1,2})[/-](\d{1,2})', label)
    if exact:
        return datetime(*map(int, exact.groups()), tzinfo=JST).date().isoformat()
    relative = re.fullmatch(r'(\d+)(秒|分|時間|日)前', label)
    if relative:
        count, unit = relative.groups()
        delta = timedelta(seconds=int(count)*{'秒':1, '分':60, '時間':3600, '日':86400}[unit])
        return (now-delta).date().isoformat()
    raise ValueError('Unknown trade date: '+label)


def build_history(product, trades, now):
    rows = defaultdict(dict)
    single_prices = defaultdict(list)
    for trade in trades:
        day = sale_day(trade['date'], now)
        rows[day]['total_vol'] = rows[day].get('total_vol', 0)+1
        # A multi-pack total must never become a single-card price.
        if product['packaging'] == 'sealed' and trade['size'] == '1パック':
            single_prices[day].append(trade['price'])
    if product['packaging'] == 'sealed':
        for day, values in single_prices.items():
            rows[day]['raw_price'] = values[0]  # newest single-pack sale that day
    else:
        for option, key in GRADES.items():
            data = get(f"https://snkrdunk.com/v1/apparels/{product['id']}/sales-chart/used?range=all&salesChartOptionId={option}").json()
            points = data.get('points')
            if not isinstance(points, list):
                raise ValueError('Malformed grade chart')
            for point in sorted(points, key=lambda p:p[0]):
                if len(point) < 2 or not isinstance(point[1], (int,float)) or point[1] <= 0:
                    raise ValueError('Invalid grade chart point')
                day = datetime.fromtimestamp(point[0]/1000, JST).date().isoformat()
                rows[day][key+'_price'] = point[1]
    return dict(id=product['id'], updatedAt=now.isoformat(), currency='JPY',
                source='SNKRDUNK grade charts + paginated sales history; relative trade dates use collection time (JST)',
                history=[dict(date=day, **rows[day]) for day in sorted(rows)])


def collect(proof):
    pid, number, packaging = proof
    now = datetime.now(JST)
    product = parse_product(get(f'https://snkrdunk.com/apparels/{pid}').text, pid, number, packaging)
    trades = sales(pid)
    history = build_history(product, trades, now)
    product.update(fetchedAt=now.isoformat(), sales=dict(status='ok', fetchedAt=now.isoformat(),
                   sourceUrl=f'https://snkrdunk.com/apparels/{pid}/sales-histories', trades=trades, totalCount=len(trades)))
    return product, history


def write_json(path, data):
    temp = path.with_suffix('.json.tmp')
    temp.write_bytes((json.dumps(data, ensure_ascii=False, indent=2)+'\n').encode('utf-8'))
    temp.replace(path)


def main():
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(collect, PROOFS))
    snapshot = dict(schemaVersion=1, updatedAt=datetime.now(JST).isoformat(), products={p['id']:p for p,h in results})
    for product, history in results:
        write_json(DATA/'history'/f"{product['id']}.json", history)
        print(product['id'], product['number'], product['packaging'], 'trades='+str(product['sales']['totalCount']), flush=True)
    write_json(DATA/'futuristic-market.json', snapshot)


if __name__ == '__main__':
    main()
