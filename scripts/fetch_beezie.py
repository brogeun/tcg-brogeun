"""Discover official current Beezie machines; report unavailable sources honestly.

Pull price uses the official priceUsdc contract (six decimal places). Active
machine average values must be read from the rendered official labelled text.
Paused/empty machines have no current quote, regardless of past values.
"""
from __future__ import annotations
import hashlib
import json
import math
import os
import re
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'data/beezie-prices.json'
CATALOGUE_URL = 'https://beezie.com/claw'
UA = 'Mozilla/5.0 (compatible; TCGHUB-public-status/1.0; +https://tcghub.kr)'
USDC_DECIMAL = 1_000_000
TIER_ALIASES = {'Silver': 'Silver TCG'}


def public_get(url):
    request = urllib.request.Request(url, headers={'User-Agent': UA,
        'Accept': 'application/json,text/html', 'Origin': 'https://beezie.com', 'Referer': 'https://beezie.com/'})
    with urllib.request.urlopen(request, timeout=20) as response:
        if response.status != 200:
            raise ValueError('Official Beezie response was not HTTP 200')
        if not response.url.startswith(('https://beezie.com/', 'https://api.beezie.com/')):
            raise ValueError('Official Beezie response redirected to another source')
        body = response.read(2_000_001)
    if len(body) > 2_000_000:
        raise ValueError('Official Beezie response exceeded byte limit')
    return body


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def discover_machines(html):
    """Read only the official successful SSR get-minimal-claws query."""
    packets = []
    for match in re.finditer(r'self\.__next_f\.push\((.*?)\)</script>', html, re.S):
        try:
            packet = json.loads(match.group(1))
        except ValueError:
            continue
        if isinstance(packet, list) and len(packet) > 1 and packet[0] == 1 and isinstance(packet[1], str):
            packets.append(packet[1])
    catalogues = []
    for line in ''.join(packets).splitlines():
        _, separator, encoded = line.partition(':')
        if not separator or 'get-minimal-claws' not in encoded:
            continue
        try:
            value = json.loads(encoded)
        except ValueError:
            continue
        for item in walk(value):
            if item.get('queryKey') == ['get-minimal-claws']:
                state = item.get('state', {})
                if state.get('status') != 'success' or not isinstance(state.get('data'), list):
                    raise ValueError('Official machine catalogue query was not successful')
                catalogues.append(state['data'])
    if len(catalogues) != 1 or not 1 <= len(catalogues[0]) <= 16:
        raise ValueError('Expected one official current catalogue with 1..16 machines')
    result, ids, tiers = [], set(), set()
    for row in catalogues[0]:
        if not isinstance(row, dict):
            raise ValueError('Invalid official catalogue machine')
        cid, name = row.get('id'), row.get('name')
        if type(cid) is not int or cid <= 0 or not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*', name):
            raise ValueError('Invalid official machine identity/label')
        tier = TIER_ALIASES.get(name, name)
        if cid in ids or tier in tiers:
            raise ValueError('Official machine catalogue contains duplicate identities/labels')
        ids.add(cid); tiers.add(tier)
        slug = name.replace(' ', '-') + '-' + str(cid)
        result.append({'id': cid, 'sourceName': name, 'tier': tier, 'slug': slug,
                       'url': 'https://beezie.com/claw/' + slug})
    return result


def parse_labelled_average(text):
    # Only the dollar amount directly following this exact official label.
    # A nearby pull price must never be substituted when Average Value is empty.
    match = re.search(r'Average\s*Value\s*:?\s*\$\s*([\d,]+(?:\.\d+)?)', text, re.I)
    if not match:
        return None
    value = float(match.group(1).replace(',', ''))
    return value if math.isfinite(value) and value > 0 else None


def fetch_avg_browser(slug, browser):
    page = browser.new_page(user_agent=UA)
    try:
        response = page.goto('https://beezie.com/claw/' + slug, wait_until='domcontentloaded', timeout=30000)
        if response is None or response.status != 200:
            raise ValueError('Official average-value page was not HTTP 200')
        page.wait_for_function(r"() => /Average\s*Value\s*:?\s*\$\s*[\d,]+/.test(document.body.innerText)", timeout=15000)
        value = parse_labelled_average(page.evaluate('() => document.body.innerText'))
        if value is None:
            raise ValueError('Official labelled Average Value is missing or nonpositive')
        return value, 'official-page-labelled-average'
    finally:
        page.close()


def machine_result(machine, payload, average_fetcher, observed):
    if not isinstance(payload, dict) or not isinstance(payload.get('claw'), dict):
        raise ValueError('Official machine API lacks claw object')
    claw = payload['claw']
    if claw.get('id') != machine['id'] or claw.get('name') != machine['sourceName']:
        raise ValueError('Official catalogue and machine API identity differ')
    status, stock = claw.get('status'), claw.get('clawStockCount')
    if not isinstance(status, str) or not status or type(stock) is not int or stock < 0:
        raise ValueError('Official machine status/stock is invalid')
    evidence = {'httpStatus': 200, 'sourceStatus': status, 'stockCount': stock,
                'sourceName': machine['sourceName'], 'machineId': machine['id'],
                'url': 'https://api.beezie.com/claw/by-id/' + str(machine['id']), 'checkedAt': observed}
    result = {key: machine[key] for key in ('id', 'tier', 'sourceName', 'url')}
    result.update(ok=True, checkedAt=observed, stockCount=stock, sourceEvidence=evidence)
    if stock == 0 and status in ('paused', 'active', 'started', 'running', 'open'):
        availability = 'paused' if status == 'paused' else 'out-of-stock'
        result.update(status=availability, price=None, avg=None, ev=None,
                      method='official-status; no current quote',
                      error='Beezie 일시 중지 · 재고 없음' if availability == 'paused' else 'Beezie 재고 없음')
        return result
    if status not in ('active', 'started', 'running', 'open') or stock == 0:
        raise ValueError('Unsupported official machine availability state: ' + status)
    amount = claw.get('priceUsdc')
    if type(amount) is not int or amount <= 0:
        raise ValueError('Active machine lacks a positive integer priceUsdc')
    price = amount / USDC_DECIMAL
    avg, method = average_fetcher(machine['slug'])
    if type(avg) not in (int, float) or not math.isfinite(avg) or avg <= 0 or method != 'official-page-labelled-average':
        raise ValueError('Active machine lacks an official rendered Average Value')
    # averageValue from the API is deliberately never converted or substituted.
    price, avg = round(price, 2), round(avg, 2)
    if price <= 0 or avg <= 0:
        raise ValueError('Active machine quote is smaller than output precision')
    result.update(status='active', price=price, avg=avg,
                  ev=round((avg / price - 1) * 100, 2), method=method, error=None)
    return result


def collect_snapshot(fetcher=public_get, average_fetcher=None, now=time.time):
    body = fetcher(CATALOGUE_URL)
    machines = discover_machines(body.decode('utf-8'))
    results = []
    for machine in machines:
        payload = json.loads(fetcher('https://api.beezie.com/claw/by-id/' + str(machine['id'])))
        observed = int(now() * 1000)
        results.append(machine_result(machine, payload, average_fetcher, observed))
    observed = int(now() * 1000)
    active = sum(row['status'] == 'active' for row in results)
    return {'schemaVersion': 2, 'ok': True, 'fetchedAt': observed, 'checkedAt': observed,
            'status': 'available' if active == len(results) else 'partially-unavailable' if active else 'unavailable',
            'pricesFresh': active == len(results),
            'source': 'official current Beezie catalogue + machine status API + labelled page average for active machines',
            'timestampMeaning': 'current official source check; unavailable rows contain no current quote',
            'catalogue': {'url': CATALOGUE_URL, 'httpStatus': 200, 'complete': True,
                          'machineIds': [machine['id'] for machine in machines],
                          'sourceNames': [machine['sourceName'] for machine in machines],
                          'htmlSha256': hashlib.sha256(body).hexdigest()},
            'results': results}


def save_snapshot(path, payload):
    path = Path(path); path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.beezie-current-', suffix='.tmp', delete=False) as handle:
            temporary = Path(handle.name)
            handle.write((json.dumps(payload, ensure_ascii=False, indent=2, allow_nan=False) + '\n').encode('utf-8'))
        os.replace(temporary, path)
    finally:
        if temporary is not None and temporary.exists():
            temporary.unlink()


def main():
    browser = playwright = None
    def average(slug):
        nonlocal browser, playwright
        if browser is None:
            from playwright.sync_api import sync_playwright
            playwright = sync_playwright().start()
            browser = playwright.chromium.launch(headless=True, args=['--no-sandbox'])
        return fetch_avg_browser(slug, browser)
    try:
        payload = collect_snapshot(fetcher=public_get, average_fetcher=average)
        from verify_beezie_snapshot import validate
        validate(payload, time.time())
        save_snapshot(OUT, payload)
        print(json.dumps({'status': payload['status'], 'checkedMachines': len(payload['results']),
                          'activeQuotes': sum(row['status'] == 'active' for row in payload['results']),
                          'pricesFresh': payload['pricesFresh'], 'fetchedAt': payload['fetchedAt']}))
        return 0
    except Exception as error:
        print('Beezie current-source collection failed; previous snapshot retained: ' + str(error))
        return 1
    finally:
        if browser is not None: browser.close()
        if playwright is not None: playwright.stop()


if __name__ == '__main__':
    sys.exit(main())
