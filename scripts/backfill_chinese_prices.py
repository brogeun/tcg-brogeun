"""Prepare and import Simplified Chinese prices from an explicitly supplied Jihuan snapshot.

This does not guess private API routes, log in, buy access, or use another market
as Chinese prices. Targets are deduplicated by the exact printed-variant UUID.
Imports stage locally by default; missing data is not a zero price or zero sales.
"""
from __future__ import annotations
import argparse
import copy
import csv
import hashlib
import json
import re
import unicodedata
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'jihuanshe'
GRADES = {'raw', 'psa10'}
A_LABELS = {'a', 'a급', 'a级', 'a級', 'nm', 'nearmint'}
HOSTS = {'www.jihuanshe.com', 'h5.jihuanshe.com', 'api.jihuanshe.com'}


def read_json(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def save_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n', encoding='utf-8')
    temporary.replace(path)


def norm(value):
    return ''.join(unicodedata.normalize('NFKC', str(value)).casefold().split())


def instant(value, now=None):
    if not isinstance(value, str):
        raise ValueError('A recorded observation timestamp is required')
    try:
        result = datetime.fromisoformat(value.replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('Invalid observation timestamp') from None
    if result.tzinfo is None or result > (now or datetime.now(timezone.utc)):
        raise ValueError('Observation timestamp needs a timezone and cannot be in the future')
    return result


def valid_url(value):
    if not isinstance(value, str):
        raise ValueError('A source URL is required')
    parsed = urlsplit(value)
    if parsed.scheme != 'https' or parsed.hostname not in HOSTS or parsed.netloc != parsed.hostname or parsed.path in ('', '/'):
        raise ValueError('Source must be an original HTTPS Jihuan card page or export endpoint')
    if any(re.search(r'price|amount|token|secret|password|cookie|api.?key|signature', key, re.I)
           for key in parse_qs(parsed.query)):
        raise ValueError('Source URLs cannot contain supplied prices or credentials')
    return value


def build_inventory(root=ROOT):
    root = Path(root)
    catalog = read_json(root / 'data/chinese-catalog.json')
    if catalog.get('language') != 'zh-CN' or catalog.get('schemaVersion') != 1:
        raise ValueError('Invalid Simplified Chinese catalog')
    result = {}
    for product in catalog['sets']:
        data = read_json(root / 'data/chinese-sets' / (product['code'] + '.json'))
        if data.get('language') != 'zh-CN' or data.get('code') != product['code'] or data.get('complete') is not True or data.get('cardCount') != len(data.get('cards', [])) or data.get('expectedCardCount') != data.get('cardCount'):
            raise ValueError('Incomplete or mismatched card list')
        for card in data['cards']:
            if card.get('language') != 'zh-CN' or card.get('setCode') != product['code']:
                raise ValueError('Card language or product does not match the catalog')
            source_id = card.get('sourceId')
            if not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', str(source_id)):
                raise ValueError('Every target needs its exact printed-variant UUID')
            facts = {key: card[key] for key in ('sourceId', 'sourceSetCode', 'number', 'name', 'variant')}
            facts.update(language='zh-CN', refs=[], release=product.get('release'))
            old = result.get(source_id)
            if old and any(old[k] != facts[k] for k in ('sourceSetCode', 'number', 'name', 'variant')):
                raise ValueError('Shared UUID has conflicting card facts')
            if not old:
                result[source_id] = facts
            ref = {'setCode': product['code'], 'cardId': card['id']}
            if ref in result[source_id]['refs']:
                raise ValueError('Duplicate catalog target')
            result[source_id]['refs'].append(ref)
            release = product.get('release')
            if release and (not result[source_id]['release'] or release < result[source_id]['release']):
                result[source_id]['release'] = release
    return result


def build_box_targets(root=ROOT):
    """Prepare each pack format for a one-box quote without guessing box contents."""
    catalog = read_json(Path(root) / 'data/chinese-catalog.json')
    result = {}
    for product in catalog['sets']:
        for variant in product.get('variants', []):
            cards = variant.get('cardsPerPack')
            if type(cards) is not int or cards <= 0 or variant.get('msrpUnit') == '세트':
                continue
            key = f"BOX:{product['code']}:{cards}"
            target = result.setdefault(key, {
                'targetId': key, 'setCode': product['code'], 'name': product['originalName'],
                'cardsPerPack': cards, 'packsPerBox': None, 'configurationStatus': 'needs_verification',
                'grade': 'box', 'condition': 'sealed', 'quantity': 1, 'unit': 'box',
                'productSourceUrl': product['sourceUrl'],
            })
            packs = variant.get('packsPerBox')
            if (variant.get('msrpUnit') == '박스' or '박스' in variant.get('name', '')) and type(packs) is int and packs > 1:
                if target['packsPerBox'] is not None and target['packsPerBox'] != packs:
                    raise ValueError('The same pack format has conflicting box contents')
                target.update(packsPerBox=packs, configurationStatus='verified')
    return result


def money(value, status):
    if status == 'no_price' and value is None:
        return None
    if status != 'available' or type(value) is not int or value <= 0:
        raise ValueError('Prices must be positive integer CNY cents, or explicit no_price/null')
    return value


def history_rows(rows, observed, release=None):
    if not isinstance(rows, list):
        raise ValueError('History must be a list')
    output = {}
    for row in rows:
        date = row.get('date', '')
        if not isinstance(date, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', date):
            raise ValueError('History dates must use YYYY-MM-DD')
        try:
            day = datetime.strptime(date, '%Y-%m-%d').date()
        except (ValueError, TypeError):
            raise ValueError('Invalid history date') from None
        if day > observed.date() or release and date < release:
            raise ValueError('History date is outside this card lifetime')
        price = money(row.get('priceMinor'), 'available')
        previous = output.get(date)
        item = {'date': date, 'priceMinor': price}
        if row.get('sourceUrl'):
            item['sourceUrl'] = valid_url(row['sourceUrl'])
        if previous and previous != item:
            raise ValueError('Conflicting history prices for the same day')
        output[date] = item
    return [output[k] for k in sorted(output)]


def validate_condition(row, grade):
    if grade not in GRADES:
        raise ValueError('Unsupported or ambiguous grade')
    if grade == 'psa10' and row.get('gradingCompany') != 'PSA':
        raise ValueError('PSA 10 needs an explicitly confirmed PSA grading company')
    if grade == 'raw':
        if row.get('gradingCompany', 'ungraded') != 'ungraded':
            raise ValueError('A-grade cards must be ungraded')
        if row.get('condition') != 'A':
            raise ValueError('Ungraded cards require a confirmed A condition')
        if (row.get('status') == 'available' or row.get('history')) and norm(row.get('conditionLabel', '')) not in A_LABELS:
            raise ValueError('A price requires an explicit source A/NM condition label')


def validate_snapshot(snapshot, inventory, now=None):
    expected = {'schemaVersion': 1, 'source': SOURCE, 'language': 'zh-CN', 'market': 'CN', 'currency': 'CNY'}
    if any(snapshot.get(k) != v for k, v in expected.items()):
        raise ValueError('Only explicit Jihuan Simplified Chinese CNY market snapshots are accepted')
    observed = instant(snapshot.get('observedAt'), now)
    if not isinstance(snapshot.get('records'), list):
        raise ValueError('Snapshot records must be a list')
    normalized, seen, provider_bindings = [], set(), {}
    for original in snapshot['records']:
        row = copy.deepcopy(original)
        target = inventory.get(row.get('sourceId'))
        if not target:
            raise ValueError('Unknown printed-variant UUID')
        if any(norm(row.get(k, '')) != norm(target[k]) for k in ('sourceSetCode', 'number', 'name', 'variant')):
            raise ValueError('Card set, number, Chinese name or foil variant does not match the catalog')
        if row.get('language', 'zh-CN') != 'zh-CN' or row.get('currency', 'CNY') != 'CNY' or row.get('market', 'CN') != 'CN':
            raise ValueError('A row cannot change language, currency or market')
        grade = row.get('grade')
        if grade not in GRADES:
            raise ValueError('Unsupported or ambiguous grade')
        validate_condition(row, grade)
        if row.get('priceKind') not in ('reference', 'asking'):
            raise ValueError('A quote must say whether it is a reference price or a seller ask')
        status = row.get('status')
        price = money(row.get('priceMinor'), status)
        source_url = valid_url(row.get('sourceUrl'))
        provider_id = str(row.get('providerCardId', ''))
        if not re.fullmatch(r'[1-9][0-9]*', provider_id):
            raise ValueError('An exact Jihuan card-version ID is required')
        if provider_id in provider_bindings and provider_bindings[provider_id] != row['sourceId']:
            raise ValueError('A Jihuan card-version ID cannot identify different printed variants')
        provider_bindings[provider_id] = row['sourceId']
        row_observed = instant(row.get('observedAt', snapshot['observedAt']), now)
        if row_observed > observed:
            raise ValueError('A row observation cannot be later than its containing snapshot')
        if target.get('release') and row_observed.date().isoformat() < target['release']:
            raise ValueError('Observed price predates this print release')
        key = (row['sourceId'], grade)
        if key in seen:
            raise ValueError('Duplicate card/grade quote')
        seen.add(key)
        normalized.append({**{k: target[k] for k in ('sourceId', 'sourceSetCode', 'number', 'name', 'variant')},
                           'grade': grade, 'gradingCompany': 'PSA' if grade == 'psa10' else 'ungraded',
                           'priceMinor': price, 'status': status,
                           'priceKind': row['priceKind'], 'providerCardId': provider_id,
                           'sourceUrl': source_url, 'observedAt': row.get('observedAt', snapshot['observedAt']),
                           **({'condition': 'A', 'conditionLabel': row.get('conditionLabel', '')} if grade == 'raw' else {}),
                           'history': history_rows(row.get('history', []), row_observed, target.get('release'))})
    return normalized


def merge_records(previous, snapshot, inventory, now=None):
    records = validate_snapshot(snapshot, inventory, now)
    data = copy.deepcopy(previous) if previous is not None else {
        'schemaVersion': 1, 'source': SOURCE, 'language': 'zh-CN', 'market': 'CN', 'currency': 'CNY', 'records': {}}
    if any(data.get(k) != snapshot.get(k) for k in ('schemaVersion', 'source', 'language', 'market', 'currency')) or not isinstance(data.get('records'), dict):
        raise ValueError('Existing prices belong to a different market/schema')
    provider_bindings = {}
    for source_id, card in data['records'].items():
        for grade, quote in card.get('quotes', {}).items():
            validate_condition(quote, grade)
            provider_id = quote['providerCardId']
            if provider_id in provider_bindings and provider_bindings[provider_id] != source_id:
                raise ValueError('Stored provider ID identifies different printed variants')
            provider_bindings[provider_id] = source_id
    for row in records:
        provider_id, source_id = row['providerCardId'], row['sourceId']
        if provider_id in provider_bindings and provider_bindings[provider_id] != source_id:
            raise ValueError('A provider card-version ID is already bound to another printed variant')
        provider_bindings[provider_id] = source_id
    report = {'imported': 0, 'unchanged': 0, 'stale': 0, 'quoted': 0, 'noPrice': 0, 'historyPoints': 0}
    for row in records:
        source_id, grade = row['sourceId'], row['grade']
        card = data['records'].setdefault(source_id, {k: row[k] for k in ('sourceId', 'sourceSetCode', 'number', 'name', 'variant')})
        if any(card[k] != row[k] for k in ('sourceId', 'sourceSetCode', 'number', 'name', 'variant')):
            raise ValueError('Stored card identity conflicts with the catalog')
        quotes = card.setdefault('quotes', {})
        old = quotes.get(grade)
        quote = {k: row[k] for k in ('priceMinor', 'status', 'priceKind', 'providerCardId', 'sourceUrl', 'observedAt', 'history', 'gradingCompany')}
        if grade == 'raw':
            quote.update(condition='A', conditionLabel=row['conditionLabel'])
        if old and old['priceKind'] != quote['priceKind']:
            raise ValueError('Reference-price and seller-ask histories must be kept separately')
        if old and old['providerCardId'] != quote['providerCardId']:
            raise ValueError('An existing printed variant cannot change its provider card-version ID')
        if old and instant(old['observedAt'], now) > instant(quote['observedAt'], now):
            report['stale'] += 1
            continue
        if old:
            historic = {x['date']: x for x in old.get('history', [])}
            historic.update({x['date']: x for x in quote['history']})
            quote['history'] = [historic[k] for k in sorted(historic)]
            if grade == 'raw' and quote['history'] and not quote['conditionLabel']:
                quote['conditionLabel'] = old['conditionLabel']
        if old:
            same_instant = instant(old['observedAt'], now) == instant(quote['observedAt'], now)
            if same_instant:
                quote['observedAt'] = old['observedAt']
        if old == quote:
            report['unchanged'] += 1
            continue
        if old and instant(old['observedAt'], now) == instant(quote['observedAt'], now):
            raise ValueError('The same observed quote cannot change on a later import')
        quotes[grade] = quote
        report['imported'] += 1
    times = [q['observedAt'] for c in data['records'].values() for q in c.get('quotes', {}).values()]
    if times:
        data['observedAt'] = max(times, key=lambda x: instant(x, now))
    report.update(quoted=sum(q['status'] == 'available' for c in data['records'].values() for q in c.get('quotes', {}).values()),
                  noPrice=sum(q['status'] == 'no_price' for c in data['records'].values() for q in c.get('quotes', {}).values()),
                  historyPoints=sum(len(q['history']) for c in data['records'].values() for q in c.get('quotes', {}).values()),
                  inventoryCards=len(inventory), pricedCards=sum(any(q['status'] == 'available' for q in c.get('quotes', {}).values()) for c in data['records'].values()))
    return data, report


def prepare_targets(root=ROOT, output=None):
    output = Path(output or Path(root) / '.cache/chinese-price-backfill')
    output.mkdir(parents=True, exist_ok=True)
    targets = build_inventory(root)
    # Explicit blank quote columns are input fields, not prices or completed work.
    fields = ['sourceId', 'sourceSetCode', 'number', 'name', 'variant', 'providerCardId', 'sourceUrl', 'grade', 'gradingCompany', 'condition', 'conditionLabel', 'priceKind', 'priceMinor', 'status', 'observedAt']
    with (output / 'targets.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        for card in targets.values():
            for grade in ('psa10', 'raw'):
                writer.writerow({**{k: card.get(k, '') for k in fields}, 'grade': grade,
                                 'gradingCompany': 'PSA' if grade == 'psa10' else 'ungraded',
                                 'condition': 'A' if grade == 'raw' else ''})
    boxes = build_box_targets(root)
    box_fields = ['targetId', 'setCode', 'name', 'cardsPerPack', 'packsPerBox', 'configurationStatus',
                  'grade', 'condition', 'quantity', 'unit', 'productSourceUrl', 'providerProductId',
                  'sourceUrl', 'priceMinor', 'status', 'observedAt']
    with (output / 'box-targets.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=box_fields)
        writer.writeheader()
        for box in boxes.values():
            writer.writerow({k: box.get(k, '') for k in box_fields})
    report = {'schemaVersion': 1, 'source': SOURCE, 'language': 'zh-CN', 'market': 'CN', 'currency': 'CNY',
              'inventoryCards': len(targets), 'catalogEntries': sum(len(c['refs']) for c in targets.values()),
              'cardQuoteTargets': len(targets) * 2, 'boxQuoteTargets': len(boxes),
              'boxProducts': len({b['setCode'] for b in boxes.values()}),
              'verifiedBoxTargets': sum(b['configurationStatus'] == 'verified' for b in boxes.values()),
              'categories': ['box', 'psa10', 'A'], 'collectedBoxes': 0,
              'collectedCards': 0, 'status': 'awaiting_source_data',
              'reason': '공개 웹에서 카드별 집환가격 대량 조회 경로가 확인되지 않았습니다. 실제 가격 자료 또는 공식 데이터 연동이 필요합니다.'}
    save_json(output / 'progress.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--prepare', action='store_true', help='Write deduplicated targets and an honest collection status')
    parser.add_argument('--input', type=Path, help='Actual Jihuan CNY snapshot; see docs/chinese-price-backfill.md')
    parser.add_argument('--output', type=Path, help='Local staging directory (default .cache/chinese-price-backfill)')
    parser.add_argument('--apply', action='store_true', help='Apply a fully validated local snapshot to the app data')
    args = parser.parse_args()
    if bool(args.prepare) == bool(args.input) or args.apply and not args.input:
        parser.error('Choose --prepare or --input; --apply requires --input')
    output = args.output or args.root / '.cache/chinese-price-backfill'
    if args.prepare:
        report = prepare_targets(args.root, output)
    else:
        inventory = build_inventory(args.root)
        target = args.root / 'data/chinese-prices-jihuanshe.json' if args.apply else output / 'prices.json'
        previous = read_json(target) if target.exists() else None
        data, report = merge_records(previous, read_json(args.input), inventory)
        report.update(source=SOURCE, currency='CNY', market='CN', status='imported', applied=args.apply,
                      inputSha256=hashlib.sha256(args.input.read_bytes()).hexdigest(), output=str(target))
        save_json(target, data)
        save_json(output / 'import-report.json', report)
    print(json.dumps(report, ensure_ascii=True))


if __name__ == '__main__':
    main()
