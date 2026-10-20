"""Collect public Simplified Chinese CardHobby auction-end prices in CNY.

No login, API keys or dependencies. Results are a local auction archive, not
Jihuan reference prices, confirmed payments or today's market averages.
"""
from __future__ import annotations

import argparse
import csv
import errno
import http.client
import hashlib
import html
import json
import re
import socket
import ssl
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path

import backfill_chinese_prices as base

ROOT = Path(__file__).resolve().parents[1]
SOURCE = 'cardhobby'
CN_TIME = timezone(timedelta(hours=8))
ENDPOINT = 'https://www.cardhobby.com.cn/NewCommodity/SearchCommodity'
FIELDS = ('ID', 'Title', 'LowestPrice', 'EffectiveDate', 'Status', 'ByWay', 'PriceCount', 'SellSource', 'NewPostageMoney')
DEFAULT_OUTPUT = ROOT / '.cache/chinese-price-backfill/cardhobby'
LANGUAGE = re.compile(r'简中|簡中|简体|簡體|\bchs\b|simplified\s*chinese', re.I)
FOREIGN = re.compile(r'繁中|繁体|繁體|日版|日文|英文|英语|英語|英版|\bjpn\b|\bjp\b|japanese|traditional\s*chinese|\benglish\b', re.I)
BRAND = re.compile(r'宝可梦|寶可夢|pokemon|pokémon|\bptcg\b', re.I)
PSA = re.compile(r'PSA\s*(?:评级|評級|鉴定|鑑定|GEM\s*MINT)?\s*(10|9(?:\.5)?|8|7|6|5|4|3|2|1)(?![\d.])', re.I)
OTHER_GRADER = re.compile(r'(?<![a-z])(?:CCIC|CCG|BGN|BGS|CGC|SGC|ARS|OCD|TAG|ACE|公博)\s*(?:(?:评级|鑑定|鉴定|評級|评分|評分)\s*)?(?:金标|金標|金)?\s*\d', re.I)
POTENTIAL = re.compile(
    r'潜力|潛力|可评|可評|送评|送評|目测|目測|冲10|衝10|可能|预估|預估|对标|對標|媲美|比肩|potential|likely|candidate'
    r'|(?:博|搏|冲|衝|挑战|挑戰|争取|爭取|可达|可達|预计|預計|预期|預期)\s*(?:评级|評級)?\s*PSA'
    r'|PSA\s*(?:评级|評級|鉴定|鑑定|GEM\s*MINT)?\s*10\s*分?\s*(?:概率|機率|几率|機會|机会|可博|可搏|可冲|可衝)', re.I)
A_CONDITION = re.compile(r'品相\s*A(?:级|級)?(?![a-z0-9])|卡品\s*A(?:级|級)?(?![a-z0-9])|A[级級]|A급|\bNM\b(?!#)|\bNear[\s-]*Mint\b', re.I)
DAMAGE = re.compile(r'微瑕|有瑕|瑕疵|白点|白點|白角|折痕|划痕|劃痕|破损|破損|受损|受損|damaged|played|\b(?:LP|MP|HP|VLP)\b', re.I)
LOT = re.compile(r'整套|全套|套卡|一对|一對|成对|成對|多张|多張|打包|组合|組合|整箱|原箱|一箱|\b(?:lot|bundle|pair|full\s*set)\b', re.I)
MULTIPLE = re.compile(r'(?:[×*]\s*(?:[2-9]|[1-9]\d+)(?!\d)|(?<![a-z])x\s*(?:[2-9]|[1-9]\d+)(?![a-z0-9])|(?<![a-z0-9])(?:[2-9]|[1-9]\d+)\s*[x×*](?![a-z0-9]))', re.I)
NEGATED_PSA = re.compile(r'(?:非|不是|并非|並非|不(?:是|到|达|達|保证|保證)|未(?:达|達|到)|无|無|not(?:\s+a)?)\s*PSA\s*(?:评级|評級|鉴定|鑑定)?\s*10|PSA\s*10\s*(?:以下|未达|未達|不保)', re.I)
MULTI_BOX_WORDS = re.compile(r'(?<![第零一二三四五六七八九十百千两兩俩倆])(?:两|兩|俩|倆|[二三四五六七八九十百千]+)\s*盒|\b(?:two|three|four|five|six|seven|eight|nine|ten)\s*boxes\b', re.I)
MULTI_CARD_WORDS = re.compile(r'(?<![第零一二三四五六七八九十百千两兩俩倆])(?:两|兩|俩|倆|[二三四五六七八九十百千]+)\s*[张張枚]|\b(?:two|three|four|five|six|seven|eight|nine|ten)\s*cards\b', re.I)
GIFT_BOX = re.compile(r'徽章|硬币|硬幣|礼盒|禮盒|铁盒|鐵盒|收纳盒|收納盒|卡砖|卡磚|公仔|模型|手办|手辦|figure|gift\s*box|coin\s*box', re.I)
SEALED = re.compile(r'未拆|未开封|未開封|原封|原膜|原塑|原包装|原包裝|\bsealed\b|\bunopened\b', re.I)
BOX_WORD = re.compile(r'整盒|原盒|肥盒|瘦盒|薄盒|厚盒|胖盒|补充包盒|强化包盒|宝石包.*盒|寶石包.*盒|\bbooster\s*box\b', re.I)


def compact(value):
    return ''.join(unicodedata.normalize('NFKC', html.unescape(str(value))).casefold().split())


def product_key(value):
    return re.sub(r'[·•＆&＋+：:（）()“”「」《》【】,.，。\-]', '', compact(value))



def product_label(value):
    label = unicodedata.normalize('NFKC', str(value))
    return re.sub(r'^(?:(?:补充包|强化包|pokemon|pokémon)\s*)+', '', label, flags=re.I)


def product_name_pattern(product):
    key = product_key(product_label(product['originalName']))
    pattern = re.escape(key)
    # These products share 151C card codes; an explicit title suffix is required.
    if product['code'].startswith('CN-151-') and re.fullmatch(r'收集啦151[旅望惊驚聚]', key):
        pattern = re.escape(key[:-1]) + 'c?' + re.escape(key[-1])
    return re.compile(pattern + (r'(?!\d)' if key[-1].isdigit() else ''))


def cents(value):
    if type(value) not in (int, float, str):
        raise ValueError('Invalid CNY amount')
    try:
        price = Decimal(str(value).replace(',', ''))
    except InvalidOperation:
        raise ValueError('Invalid CNY amount') from None
    amount = price * 100
    if not amount.is_finite() or amount <= 0 or amount != amount.to_integral_value():
        raise ValueError('CNY amount must be positive and have at most two decimals')
    return int(amount)


def classify_title(title):
    title = unicodedata.normalize('NFKC', html.unescape(str(title)))
    if not LANGUAGE.search(title) or FOREIGN.search(title) or not BRAND.search(title):
        return None, 'language_or_game_not_confirmed'
    if LOT.search(title) or MULTIPLE.search(title) or MULTI_BOX_WORDS.search(title):
        return None, 'multiple_items_or_carton'
    grades = PSA.findall(title)
    if grades:
        if set(grades) != {'10'} or OTHER_GRADER.search(title) or POTENTIAL.search(title) or NEGATED_PSA.search(title):
            return None, 'unsupported_or_estimated_grade'
        # The archive records a seller's PSA10 label, not a certification check.
        if MULTI_CARD_WORDS.search(title) or re.search(r'([2-9]|[1-9]\d+)\s*[张張枚]', title):
            return None, 'multiple_items_or_carton'
        return 'psa10', ''
    if OTHER_GRADER.search(title) or re.search(r'PSA|评级|評級|鉴定卡|鑑定卡', title, re.I):
        return None, 'unsupported_or_estimated_grade'
    if BOX_WORD.search(title):
        if GIFT_BOX.search(title):
            return None, 'gift_product_not_a_booster_box'
        if re.search(r'盒上有胶|盒上有膠|重封|再封|重新封|默认打牌品|默認打牌品', title):
            return None, 'box_condition_uncertain'
        if not SEALED.search(title) or re.search(r'(?:开盒|開盒|拆盒|散包)', title):
            return None, 'box_seal_not_confirmed'
        if re.search(r'(?<![第\d])(?:[2-9]|[1-9]\d+)\s*盒', title):
            return None, 'multiple_items_or_carton'
        return 'box', ''
    if MULTI_CARD_WORDS.search(title) or re.search(r'([2-9]|[1-9]\d+)\s*[张張枚]', title):
        return None, 'multiple_items_or_carton'
    if A_CONDITION.search(title) and not DAMAGE.search(title) and not re.search(r'非\s*NM|不保(?:证|證)?\s*(?:A|NM)|不是\s*(?:A|NM)|不保证品相|不保證品相|品相不保|卡品不确定|卡品不確定|不保(?:证|證)?\s*(?:卡品|品相)|非\s*A[级級]', title, re.I):
        return 'raw', ''
    return None, 'A_condition_not_confirmed'


def normalize_quote(row, now=None):
    now = now or datetime.now(timezone.utc)
    try:
        item_id = str(row.get('ID', ''))
        if not re.fullmatch(r'[1-9][0-9]*', item_id):
            return None, 'invalid_listing_id'
        if row.get('Status') != -2 or row.get('ByWay') != 2 or row.get('SellSource') != 'CN':
            return None, 'not_a_CN_sold_search_auction'
        bids = row.get('PriceCount')
        if type(bids) is not int or bids < 1:
            return None, 'no_bids'
        price = cents(row.get('LowestPrice'))  # Price is the starting bid: never use it.
        original_date = row.get('EffectiveDate', '')
        ended = datetime.strptime(original_date, '%Y-%m-%d %H:%M:%S').replace(tzinfo=CN_TIME)
        if ended > now:
            return None, 'auction_not_ended'
        title = html.unescape(str(row.get('Title', ''))).strip()
        grade, reason = classify_title(title)
        if not grade:
            return None, reason
        shipping = None
        try:
            if Decimal(str(row.get('NewPostageMoney', ''))) == 0:
                shipping = 0
            else:
                shipping = cents(row.get('NewPostageMoney'))
        except (InvalidOperation, ValueError):
            pass
        record = {
            'listingId': item_id, 'title': title, 'source': SOURCE, 'sourceUrl': f'https://www.cardhobby.com.cn/market/item/{item_id}',
            'language': 'zh-CN', 'market': 'CN', 'currency': 'CNY', 'grade': grade,
            'priceMinor': price, 'priceKind': 'auction_end_price', 'shippingMinor': shipping,
            'quantity': 1, 'quantityBasis': 'single_listing_title', 'unit': 'box' if grade == 'box' else 'card',
            'auctionEndAt': ended.isoformat(), 'sourceEndTime': original_date, 'timeZoneAssumed': 'Asia/Shanghai',
            'bidCount': bids, 'sellerConditionOnly': True, 'paymentCompletionVerified': False,
        }
        if grade == 'raw':
            record.update(condition='A', conditionLabel=A_CONDITION.search(title).group())
        elif grade == 'psa10':
            record['gradingCompany'] = 'PSA'
        else:
            record['condition'] = 'sealed'
        return record, ''
    except (ValueError, TypeError, InvalidOperation):
        return None, 'invalid_amount_or_end_time'


def decode_response(payload):
    if not isinstance(payload, dict) or type(payload.get('result')) is not int or payload.get('result') != 1 or not isinstance(payload.get('data'), dict):
        raise ValueError('CardHobby did not return a successful public search result')
    data = payload['data']
    total = data.get('TotalCount')
    rows = data.get('PagedMarketItemList')
    if type(total) is not int or total < 0 or not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise ValueError('Missing public results: a blank/null response is not a completed backfill')
    if total > 0 and not rows:
        raise ValueError('The search returned a total but no rows; retry without advancing the checkpoint')
    return total, rows


def code_pattern(code):
    return re.compile(r'(?<![a-z0-9])' + re.escape(code) + r'(?![a-z])', re.I)


def number_pattern(number):
    parts = str(number).split()
    if not all(p.isdigit() for p in parts):
        return re.compile(r'(?!)')
    digits = [r'0*' + str(int(p)) for p in parts]
    return re.compile(r'(?<!\d)' + r'[\s_-]*'.join(digits) + r'\s*[/／]\s*\d+(?!\d)', re.I)


class PriceCatalog:
    def __init__(self, root=ROOT):
        self.cards = base.build_inventory(root)
        self.boxes = base.build_box_targets(root)
        self.products = base.read_json(Path(root) / 'data/chinese-catalog.json')['sets']
        self.visible_numbers, self.english_names = {}, {}
        for path in (Path(root) / '.cache').glob('chinese-card-source-*.json'):
            raw = base.read_json(path)
            code = path.stem.removeprefix('chinese-card-source-')
            visible = raw.get('set', {}).get('set_count_visible')
            if not code.startswith('cbb') and type(visible) is int and visible > 0:
                self.visible_numbers[code] = visible
            for item in raw.get('cards', []):
                current = self.cards.get(item.get('id'))
                if current and current['sourceSetCode'] == code and str(item.get('card_number')) == current['number'] and item.get('english_card_name'):
                    english = re.escape(item['english_card_name']).replace(r'\ ', r'\s*')
                    self.english_names[current['sourceId']] = re.compile(r'(?<![a-z0-9])' + english + r'(?![a-z0-9])', re.I)
        self.by_code = defaultdict(list)
        self.product_codes = defaultdict(set)
        for card in self.cards.values():
            self.by_code[card['sourceSetCode']].append({**card, '_name': compact(card['name']), '_number': number_pattern(card['number'])})
            for ref in card['refs']:
                self.product_codes[ref['setCode']].add(card['sourceSetCode'])
        self.patterns = {code: code_pattern(code) for code in self.by_code}
        self.product_names = {p['code']: product_key(product_label(p['originalName'])) for p in self.products}
        self.product_name_patterns = {p['code']: product_name_pattern(p) for p in self.products}
        self.named_sources = []
        for product in self.products:
            label = re.sub(r'^(?:补充包|强化包)\s*', '', product['originalName'])
            label = re.sub(r'^(?:pokemon|pokémon)\s*', '', label, flags=re.I)
            key = product_key(label)
            if len(key) >= 4:
                self.named_sources.append((re.compile(re.escape(key) + (r'(?!\d)' if key[-1].isdigit() else '')),
                                           self.product_codes[product['code']]))
        self.box_formats = defaultdict(list)
        for b in self.boxes.values():
            self.box_formats[b['setCode']].append(b)

    def queries(self):
        # Code searches include single cards; official product names also find boxes.
        names = [re.sub(r'^(?:补充包|强化包)\s*', '', p['originalName']).strip() for p in self.products]
        return list(dict.fromkeys([c.upper() for c in sorted(self.by_code)] + names))

    def match(self, title, grade):
        code_hits = [code for code, pattern in self.patterns.items() if pattern.search(title)]
        name_title = compact(title)
        if grade == 'box':
            products = [p for p in self.products if self.product_name_patterns[p['code']].search(product_key(title))]
            if not products:
                products = [p for p in self.products if any(code in self.product_codes[p['code']] for code in code_hits)]
            if len(products) != 1:
                return None, 'box_product_not_unique'
            if code_hits and set(code_hits) != self.product_codes[products[0]['code']]:
                return None, 'box_set_code_name_conflict'
            formats = self.box_formats[products[0]['code']]
            explicit_cards = {int(n) for n in re.findall(r'(\d+)\s*[张張]\s*(?:[/／]\s*)?(?:每?包|装|裝)', title)}
            explicit_cards.update(int(n) for n in re.findall(r'每包\s*(\d+)\s*[张張]', title))
            if len(explicit_cards) > 1:
                return None, 'box_format_not_unique'
            if explicit_cards:
                formats = [b for b in formats if b['cardsPerPack'] in explicit_cards]
            elif re.search(r'肥盒|胖盒|厚盒|jumbo', title, re.I) and len(formats) > 1:
                formats = [max(formats, key=lambda b: b['cardsPerPack'])]
            elif re.search(r'瘦盒|薄盒|slim', title, re.I) and len(formats) > 1:
                formats = [min(formats, key=lambda b: b['cardsPerPack'])]
            if len(formats) != 1:
                return None, 'box_format_not_unique'
            b = formats[0]
            return {**b, 'targetId': b['targetId'], 'kind': 'box', 'configurationVerified': b['configurationStatus'] == 'verified'}, ''
        named_codes = {code for pattern, codes in self.named_sources if pattern.search(product_key(title)) for code in codes}
        if not code_hits and len(named_codes) == 1:
            code_hits = list(named_codes)
        elif code_hits and named_codes and set(code_hits) != named_codes:
            return None, 'card_set_code_name_conflict'
        if len(code_hits) != 1:
            return None, 'card_set_not_unique'
        hits = [c for c in self.by_code[code_hits[0]] if (c['_name'] in name_title or
                c['sourceId'] in self.english_names and self.english_names[c['sourceId']].search(title)) and c['_number'].search(title)]
        visible = self.visible_numbers.get(code_hits[0])
        if visible and hits:
            hits = [c for c in hits if int(re.search(r'[/／]\s*(\d+)', c['_number'].search(title).group()).group(1)) == visible]
            if not hits:
                return None, 'card_printed_denominator_mismatch'

        if hits:
            longest = max(len(c['_name']) for c in hits)
            hits = [c for c in hits if len(c['_name']) == longest]
        foil = []
        for pattern, variant in [(r'大师球|大師球|master\s*ball', 'masterball'), (r'精灵球|精靈球|宝贝球|寶貝球|怪兽球|poke\s*ball|poké\s*ball', 'pokeball'), (r'反向闪|反向閃|反闪|反閃|reverse', 'reverse')]:
            if re.search(pattern, title, re.I):
                foil.append(variant)
        plain_marker = re.search(r'不闪|非闪|普卡|non[ -]?holo|non[ -]?foil', title, re.I)
        if len(foil) > 1 or foil and plain_marker:
            return None, 'card_foil_not_unique'
        if foil:
            hits = [c for c in hits if c['variant'] == foil[0]]
        elif plain_marker:
            hits = [c for c in hits if c['variant'] == 'non-holo']
        if len(hits) != 1:
            return None, 'card_number_name_or_foil_not_unique'
        c = hits[0]
        return {k: v for k, v in {**c, 'targetId': c['sourceId'], 'kind': 'card'}.items() if not k.startswith('_')}, ''


def search_url(keyword):
    return 'https://www.cardhobby.com.cn/market/search?' + urllib.parse.urlencode({'keyword': keyword, 'searchtype': 1})


def fetch_page(keyword, page, size=60):
    params = {'userId': '', 'pageIndex': page, 'pageSize': size, 'searchKey': keyword,
              'searchJson': json.dumps([{'Key': 'Status', 'Value': -2}]), 'sort': 'EffectiveTimeStamp', 'sortType': 'DESC'}
    req = urllib.request.Request(ENDPOINT + '?' + urllib.parse.urlencode(params), headers={'User-Agent': 'Mozilla/5.0', 'Referer': search_url(keyword), 'Accept': 'application/json'})
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(req, timeout=45) as response:
        if response.status != 200:
            raise ValueError('Public search did not return HTTP 200')
        payload = json.loads(response.read().decode('utf-8-sig'))
    return decode_response(payload)


def retryable_network_error(exc):
    if isinstance(exc, urllib.error.HTTPError):
        return exc.code in (408, 500, 502, 503, 504)
    reason = exc.reason if isinstance(exc, urllib.error.URLError) else exc
    if isinstance(reason, ssl.SSLError):
        return False
    if isinstance(reason, (TimeoutError, ConnectionError, http.client.IncompleteRead)):
        return True
    if isinstance(reason, OSError):
        return reason.errno in (errno.ETIMEDOUT, errno.ECONNRESET, errno.ECONNABORTED,
                                errno.ECONNREFUSED, errno.ENETDOWN, errno.ENETUNREACH,
                                errno.EHOSTUNREACH, socket.EAI_AGAIN) or getattr(reason, 'winerror', None) in (10050, 10051, 10052, 10053, 10054, 10060, 10061, 10065, 11002)
    return isinstance(exc, urllib.error.URLError)


def fetch_with_retry(keyword, page, size=60, attempts=5, fetcher=fetch_page, sleeper=time.sleep):
    for attempt in range(1, attempts + 1):
        try:
            return fetcher(keyword, page, size)
        except (OSError, urllib.error.URLError, http.client.IncompleteRead) as exc:
            if not retryable_network_error(exc) or attempt == attempts:
                raise
            wait_seconds = min(30, 3 * (2 ** (attempt - 1)))
            print(f'[연결 재시도 {attempt}/{attempts-1}] {keyword} {page}페이지: {wait_seconds}초 후 같은 페이지를 다시 받습니다. ({exc})', flush=True)
            sleeper(wait_seconds)


def page_file(output, keyword, page):
    digest = hashlib.sha256(keyword.encode('utf-8')).hexdigest()[:20]
    return Path(output) / 'pages' / f'{digest}-{page:06}.json'



def read_listing_details(output):
    """Validate a separate public attribute cache without changing raw auction pages."""
    from chinese_listing_details import ENDPOINT as DETAIL_ENDPOINT, parse_properties
    path = Path(output) / 'listing-details.json'
    if not path.exists():
        return {}
    cache = base.read_json(path)
    if (cache.get('schemaVersion') != 1 or cache.get('source') != SOURCE or
            cache.get('endpoint') != DETAIL_ENDPOINT or not isinstance(cache.get('items'), dict)):
        raise ValueError('Foreign or invalid listing-detail cache')
    details = {}
    for key, item in cache['items'].items():
        if (not re.fullmatch(r'[1-9][0-9]*', key) or not isinstance(item, dict) or str(item.get('id')) != key or
                item.get('sourceUrl') != f'https://www.cardhobby.com.cn/market/item/{key}' or
                item.get('propertiesUrl') != f'{DETAIL_ENDPOINT}?id={key}' or not item.get('observedAt')):
            raise ValueError(f'Listing detail does not belong to its public ID: {key}')
        try:
            observed = datetime.fromisoformat(str(item['observedAt']).replace('Z', '+00:00'))
        except (ValueError, TypeError):
            raise ValueError(f'Invalid public attribute observation time: {key}') from None
        if observed.tzinfo is None or observed > datetime.now(timezone.utc):
            raise ValueError(f'Invalid public attribute observation time: {key}')
        fields = parse_properties({'result': 1, 'data': item.get('properties')})
        details[key] = {'fields': fields, 'propertiesUrl': item['propertiesUrl'], 'observedAt': item['observedAt']}
    return details


def compile_results(output, catalog, write=True, require_details=None):
    output = Path(output)
    listings = {}
    details = read_listing_details(output)
    detail_path = output / 'listing-details.json'
    if require_details is None:
        require_details = detail_path.exists() and base.read_json(detail_path).get('requirePublicAttributes') is True
    detail_checks, detail_conflicts = 0, Counter()
    from chinese_listing_details import grade_evidence
    for path in sorted((output / 'pages').glob('*.json')):
        cached = base.read_json(path)
        if cached.get('source') != SOURCE or cached.get('currency') != 'CNY' or cached.get('market') != 'CN' or not isinstance(cached.get('items'), list):
            raise ValueError(f'Foreign or invalid cached page: {path.name}')
        for row in cached['items']:
            key = str(row.get('ID', ''))
            old = listings.get(key)
            observed = row.get('_observedAt', cached['observedAt'])
            if old is None or observed > old[1]:
                listings[key] = (row, observed)
    accepted, rejected, counts = [], [], Counter()
    for row, observed in listings.values():
        quote, reason = normalize_quote(row)
        target = None
        if quote:
            target, reason = catalog.match(quote['title'], quote['grade'])
        if target:
            detail = details.get(quote['listingId'])
            if detail is None and require_details:
                reason = 'detail_public_attributes_pending'
                target = None
            elif detail is not None:
                evidence = grade_evidence(quote['grade'], detail['fields'])
                detail_checks += 1
                if evidence['contradictions']:
                    reason = evidence['contradictions'][0]
                    detail_conflicts.update(evidence['contradictions'])
                    target = None
                else:
                    quote['detailGradeEvidence'] = {**evidence, 'propertiesUrl': detail['propertiesUrl'],
                                                     'observedAt': detail['observedAt']}
        if not target:
            counts[reason] += 1
            rejected.append({'listingId': row.get('ID', ''), 'title': row.get('Title', ''), 'reason': reason,
                             'sourceUrl': f"https://www.cardhobby.com.cn/market/item/{row.get('ID', '')}"})
            continue
        quote.update(observedAt=observed, targetId=target['targetId'], kind=target['kind'])
        quote['identityBasis'] = 'seller_title_exact_catalog_match'
        if target['kind'] == 'card':
            quote.update({k: target[k] for k in ('sourceId', 'sourceSetCode', 'number', 'name', 'variant', 'refs')})
        else:
            quote.update({k: target[k] for k in ('setCode', 'cardsPerPack', 'packsPerBox', 'configurationVerified')})
        accepted.append(quote)
    grouped = defaultdict(list)
    for quote in accepted:
        grouped[(quote['targetId'], quote['grade'])].append(quote)
    histories = []
    for (target_id, grade), rows in grouped.items():
        daily = defaultdict(list)
        for row in rows:
            daily[row['auctionEndAt'][:10]].append(row)
        points = []
        for date, events in sorted(daily.items()):
            amounts = sorted(e['priceMinor'] for e in events)
            n = len(amounts)
            median = (Decimal(amounts[(n-1)//2]) + Decimal(amounts[n//2])) / 2
            points.append({'date': date, 'priceMinor': int(median.quantize(Decimal('1'), rounding=ROUND_HALF_UP)),
                           'auctionCount': n, 'listingIds': sorted(e['listingId'] for e in events)})
        histories.append({'targetId': target_id, 'grade': grade, 'history': points})
    accepted.sort(key=lambda x: (x['auctionEndAt'], x['listingId']))
    data = {'schemaVersion': 1, 'source': SOURCE, 'market': 'CN', 'currency': 'CNY', 'language': 'zh-CN',
            'priceKind': 'auction_end_price', 'generatedAt': datetime.now(timezone.utc).isoformat(),
            'appliedToApp': False, 'records': accepted, 'histories': histories}
    checkpoint_path = output / 'checkpoint.json'
    checkpoint = base.read_json(checkpoint_path) if checkpoint_path.exists() else {'queries': {}}
    states = checkpoint['queries'].values()
    report = {'source': SOURCE, 'market': 'CN', 'currency': 'CNY', 'appPricesChanged': False,
              'listingsDownloaded': len(listings), 'acceptedAuctions': len(accepted),
              'PSA10Auctions': sum(x['grade'] == 'psa10' for x in accepted),
              'AAuctions': sum(x['grade'] == 'raw' for x in accepted), 'boxAuctions': sum(x['grade'] == 'box' for x in accepted),
              'matchedCards': len({x['sourceId'] for x in accepted if x['kind'] == 'card'}),
              'matchedBoxFormats': len({x['targetId'] for x in accepted if x['kind'] == 'box'}),
              'boxConfigurationPending': sum(x['kind'] == 'box' and not x['configurationVerified'] for x in accepted),
              'queriesCompleted': sum(s.get('complete', False) for s in states),
              'queriesPending': sum(not s.get('complete', False) for s in checkpoint['queries'].values()),
              'rejectedByReason': dict(counts), 'priceKind': 'auction_end_price', 'paymentCompletionVerified': False,
              'listingDetailsChecked': detail_checks, 'detailContradictions': dict(detail_conflicts),
              'publicAttributesRequired': bool(require_details),
              'listingDetailsPending': counts['detail_public_attributes_pending'],
              'certificateVerificationPerformed': False}
    if not write:
        return data, report
    base.save_json(output / 'prices.json', data)
    base.save_json(output / 'report.json', report)
    with (output / 'prices.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        fields = ['listingId', 'targetId', 'grade', 'name', 'title', 'number', 'variant', 'setCode', 'cardsPerPack', 'packsPerBox', 'priceCNY', 'shippingCNY', 'priceMinor', 'currency', 'auctionEndAt', 'sourceUrl']
        writer = csv.DictWriter(stream, fieldnames=fields, extrasaction='ignore')
        writer.writeheader()
        for quote in accepted:
            writer.writerow({**quote, 'priceCNY': format(Decimal(quote['priceMinor']) / 100, '.2f'),
                             'shippingCNY': '' if quote['shippingMinor'] is None else format(Decimal(quote['shippingMinor']) / 100, '.2f')})
    with (output / 'excluded.csv').open('w', encoding='utf-8-sig', newline='') as stream:
        writer = csv.DictWriter(stream, fieldnames=['listingId', 'title', 'reason', 'sourceUrl']);writer.writeheader();writer.writerows(rejected)
    return data, report


def run_collection(catalog, output, keywords, max_pages=20, size=60, delay=1.5, fetcher=fetch_page, sleeper=time.sleep, attempts=5, on_compiled=None):
    output = Path(output); output.mkdir(parents=True, exist_ok=True)
    checkpoint_path = output / 'checkpoint.json'
    if checkpoint_path.exists():
        state = base.read_json(checkpoint_path)
        if state.get('source') != SOURCE or state.get('currency') != 'CNY' or state.get('pageSize') != size:
            raise ValueError('Existing checkpoint belongs to another source/page size; use a separate output folder')
    else:
        state = {'schemaVersion': 1, 'source': SOURCE, 'currency': 'CNY', 'pageSize': size, 'queries': {}}
    for keyword in keywords:
        state['queries'].setdefault(keyword, {'nextPage': 1, 'complete': False})
    base.save_json(checkpoint_path, state)
    resume_pending = any(not state['queries'][keyword].get('complete', False) for keyword in keywords)
    try:
        for index, keyword in enumerate(keywords, 1):
            progress = state['queries'][keyword]
            if resume_pending and progress.get('complete', False):
                print(f'[{index}/{len(keywords)}] {keyword} 이미 완료 — 저장 기록을 유지하고 다음 검색어로 넘어갑니다.', flush=True)
                continue
            # Refresh the front page. A changed total shifts pagination, so revisit from page 2.
            page, front, limit = 1, True, max_pages
            next_old = max(2, progress['nextPage'])
            while True:
                if not front and (progress['complete'] or limit and page > limit):
                    break
                sleeper(delay)
                total, rows = fetch_with_retry(keyword, page, size, attempts, fetcher, sleeper)
                observed = datetime.now(timezone.utc).isoformat()
                if front and total != progress.get('totalCount', total):
                    progress.update(complete=False, nextPage=2)
                    next_old = 2
                cached = {'schemaVersion': 1, 'source': SOURCE, 'market': 'CN', 'currency': 'CNY',
                          'query': keyword, 'page': page, 'pageSize': size, 'totalCount': total,
                          'observedAt': observed,
                          'items': [{**{k: row.get(k) for k in FIELDS}, '_observedAt': observed} for row in rows]}
                # Keep the union of front-page observations when new auctions arrive.
                path = page_file(output, keyword, page)
                if path.exists():
                    old = base.read_json(path)
                    if old.get('source') != SOURCE or old.get('query') != keyword or old.get('pageSize') != size:
                        raise ValueError('Existing cache does not belong to this query')
                    combined = {str(r.get('ID')): {**r, '_observedAt': r.get('_observedAt', old['observedAt'])} for r in old['items']}
                    combined.update({str(r.get('ID')): r for r in cached['items']})
                    cached['items'] = list(combined.values())
                base.save_json(path, cached)
                if page == 1 and not progress['complete']:
                    progress['nextPage'] = max(progress['nextPage'], 2)
                elif not front:
                    progress['nextPage'] = page + 1
                progress['totalCount'] = total
                progress['complete'] = progress.get('complete', False) or page * size >= total
                base.save_json(checkpoint_path, state)
                print(f'[{index}/{len(keywords)}] {keyword}  {page}페이지 / 검색 {total:,}건  저장 {len(rows)}건', flush=True)
                if progress['complete']:
                    break
                page = next_old if front else page + 1
                front = False
    finally:
        # Valid cached pages remain useful even when networking stops or Ctrl+C is pressed.
        _, report = compile_results(output, catalog)
        if on_compiled is not None:
            on_compiled()
    return report



def validate_saved_prices(root, output, allow_network=True):
    """Fill missing public attributes, then hold every unresolved new price."""
    from chinese_listing_details import ensure_listing_details
    catalog = PriceCatalog(root)
    if allow_network:
        candidates, _ = compile_results(output, catalog, write=False, require_details=False)
        try:
            detail_report = ensure_listing_details(output, candidates['records'])
        except KeyboardInterrupt:
            # The helper preserves successful attribute responses and its required policy.
            compile_results(output, catalog, require_details=True)
            raise
    else:
        # A stopped collection must not begin another network phase.
        from chinese_listing_details import ENDPOINT as DETAIL_ENDPOINT
        details = read_listing_details(output)
        path = Path(output) / 'listing-details.json'
        cache = base.read_json(path) if path.exists() else {
            'schemaVersion': 1, 'source': SOURCE, 'endpoint': DETAIL_ENDPOINT, 'items': {}}
        cache['requirePublicAttributes'] = True
        base.save_json(path, cache)
        detail_report = {'requestedCount': 0, 'cachedCount': len(details), 'fetchedCount': 0,
                         'failedCount': 0, 'failures': [], 'cachePath': str(path), 'networkRequests': 0}
    data, report = compile_results(output, catalog, require_details=True)
    if detail_report['failedCount']:
        print(f"공개 상태 확인 실패 {detail_report['failedCount']:,}건은 가격 반영을 보류했습니다. 다음 실행 때 다시 확인합니다.")
    print(f"공개 상태 확인: 저장 {detail_report['cachedCount']:,}건 · 추가 {detail_report['fetchedCount']:,}건 · 가격 확인 보류 {report['listingDetailsPending']:,}건")
    return data, report, detail_report


def apply_cached_prices(root, output, keywords=None, allow_network=True):
    """Publish revalidated saved pages only for this root's normal full archive."""
    root, output = Path(root), Path(output)
    expected = root / '.cache/chinese-price-backfill/cardhobby'
    if keywords or output.resolve() != expected.resolve() or not any((output / 'pages').glob('*.json')):
        return False
    from build_chinese_market import build
    try:
        validate_saved_prices(root, output, allow_network=allow_network)
    except KeyboardInterrupt:
        build(root, output)
        print('공개 확인을 중지했습니다. 확인된 저장 가격을 반영했고 나머지는 보류했습니다.')
        raise
    _, report = build(root, output)
    if report['queriesPending']:
        print('저장한 자료의 가격 연결 완료. 아직 받지 않은 과거 기록은 남아 있습니다.')
    else:
        print('저장한 자료의 가격 연결 완료. 사이트를 새로고침하세요.')
    return True


def main(argv=None):
    if hasattr(sys.stdout, 'reconfigure'):
        sys.stdout.reconfigure(encoding='utf-8')
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=ROOT)
    parser.add_argument('--output', type=Path, help='Archive folder; default is .cache/chinese-price-backfill/cardhobby inside --root')
    parser.add_argument('--interactive', action='store_true')
    parser.add_argument('--check', action='store_true', help='Check the catalog and runtime offline; no network or writes')
    parser.add_argument('--keyword', action='append', help='Collect only this public keyword (repeatable)')
    parser.add_argument('--max-pages', type=int, default=20, help='Pages per keyword; 0 collects all available history')
    parser.add_argument('--page-size', type=int, default=60)
    parser.add_argument('--delay', type=float, default=1.5)
    parser.add_argument('--attempts', type=int, default=5, help='Total attempts per page for temporary network errors (1..10)')
    args = parser.parse_args(argv)
    if args.output is None:
        args.output = args.root / '.cache/chinese-price-backfill/cardhobby'
    if args.max_pages < 0 or not 1 <= args.page_size <= 60 or args.delay < 1 or not args.delay < float('inf'):
        parser.error('Use max-pages >=0, page-size 1..60, and a delay >=1 second')
    if not 1 <= args.attempts <= 10:
        parser.error('Use attempts 1..10')
    if args.keyword and any(not k.strip() for k in args.keyword):
        parser.error('A keyword cannot be empty')
    catalog = PriceCatalog(args.root)
    if args.check:
        print(json.dumps({'status': 'offline_check_passed', 'networkRequests': 0, 'source': SOURCE, 'currency': 'CNY',
                          'inventoryCards': len(catalog.cards), 'boxTargets': len(catalog.boxes), 'searchKeywords': len(catalog.queries())}, ensure_ascii=False))
        return 0
    print('\n중판 가격 백필 — 중국 CNY / 카드하비 공개 경매 종료가')
    print('대상: 미개봉 박스 · PSA 10 · A급(미감정). 집환사 가격 수집은 아직 연결되지 않았습니다.')
    print('저장한 자료는 매번 재검증해 로컬 사이트 가격에 연결합니다. 전체 수집 여부와는 별개입니다.')
    print('판매자 표기와 정확한 세트·번호·무늬를 대조합니다. 상태·수량이 불명확하면 제외합니다.\n')
    if args.interactive:
        print('1. 최근 기록부터 받기 (기본: 검색어당 20페이지, 중단 후 이어받기)')
        print('2. 공개된 과거 기록 전체 받기 (시간이 오래 걸릴 수 있음)')
        print('3. 저장한 결과 확인하기')
        print('4. 저장된 자료로 사이트 가격 다시 연결하기 (추가 조회 없음)')
        print('0. 종료')
        choice = input('\n선택 [엔터=1]: ').strip() or '1'
        if choice == '0':
            return 0
        if choice == '3':
            if (args.output / 'report.json').exists():
                print(json.dumps(base.read_json(args.output / 'report.json'), ensure_ascii=False, indent=2))
            else:
                print('아직 저장된 수집 결과가 없습니다.')
            return 0
        if choice == '4':
            from build_chinese_market import build
            validate_saved_prices(args.root, args.output, allow_network=False)
            build(args.root, args.output)
            print('로컬 사이트를 새로고침하면 검증된 가격을 볼 수 있습니다.')
            return 0
        if choice not in ('1', '2'):
            print('선택값은 0, 1, 2, 3, 4 중 하나입니다.');return 2
        args.max_pages = 0 if choice == '2' else args.max_pages
    keywords = list(dict.fromkeys(args.keyword or catalog.queries()))
    print(f'검색어 {len(keywords)}개. 저장 위치: {args.output}')
    print(f'일시적인 연결 오류는 같은 페이지에서 최대 {args.attempts}회 시도합니다. 재개 중에는 완료된 검색어를 건너뜁니다.')
    try:
        report = run_collection(catalog, args.output, keywords, args.max_pages, args.page_size, args.delay, attempts=args.attempts,
                                on_compiled=lambda: apply_cached_prices(args.root, args.output, args.keyword,
                                                                         allow_network=sys.exc_info()[0] is None))
    except KeyboardInterrupt:
        print('\n수집을 중지했습니다. 저장된 가격과 진행 기록은 남아 있으며 같은 CMD로 이어받을 수 있습니다.');return 130
    except (OSError, ValueError, urllib.error.URLError, http.client.IncompleteRead) as exc:
        print(f'\n수집 중단: {exc}\n진행 기록은 보존됐습니다. 같은 CMD로 다시 실행하면 이어받습니다.');return 1
    print(f"\n이번 실행 저장: 경매 {report['acceptedAuctions']:,}건 (PSA10 {report['PSA10Auctions']:,}, A급 {report['AAuctions']:,}, 박스 {report['boxAuctions']:,})")
    if report['queriesPending']:
        print('더 오래된 기록이 남아 있습니다. 메뉴 2번으로 전체 과거 기록을 이어받을 수 있습니다.')
    print('prices.json / prices.csv: 가격 자료, report.json: 수집 요약, excluded.csv: 제외 사유')
    print('경매 종료가이며 결제 완료나 현재 시세 평균을 보증하지 않습니다.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
