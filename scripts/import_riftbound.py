"""Free English catalog import from Riot's public gallery. Default output is staged."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit
from bs4 import BeautifulSoup
import requests

ROOT = Path(__file__).resolve().parents[1]
GALLERY = 'https://playriftbound.com/en-us/card-gallery/'
CONTENT = 'https://content.publishing.riotgames.com'

def get(url):
    response = requests.get(url, timeout=45)
    response.raise_for_status()
    return response

def plain(value):
    return BeautifulSoup(value or '', 'html.parser').get_text(' ', strip=True)

def image_url(url):
    if urlsplit(url).hostname not in ('cmsassets.rgpub.io', 'cdn.sanity.io'):
        raise ValueError('Unexpected image host')
    return url + ('&' if '?' in url else '?') + 'w=744&fm=webp&q=85'

def normalize(card):
    if not re.fullmatch(r'[a-z0-9-]+', card['id']):
        raise ValueError('Invalid source ID')
    values = lambda key: [v['label'] for v in card.get(key, {}).get('values', [])]
    stat = lambda key: card.get(key, {}).get('value', {}).get('label')
    return dict(id=card['id'], name=card['name'], number=card['publicCode'],
        collectorNumber=card['collectorNumber'], language='en', brand='riftbound',
        setCode='RB-EN-'+card['set']['value']['id'],
        rarity=card.get('rarity', {}).get('value', {}).get('label', ''),
        types=[v['label'] for v in card.get('cardType', {}).get('type', [])],
        domains=values('domain'), tags=values('tags'), artists=values('illustrator'),
        ability=plain(card.get('text', {}).get('richText', {}).get('body')),
        energy=stat('energy'), might=stat('might'), power=stat('power'),
        image=image_url(card['cardImage']['url']),
        orientation=card.get('orientation', 'portrait'))

def build(output):
    html = get(GALLERY).text
    match = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    page = json.loads(match[1])['props']['pageProps']['page']
    assert page['locale'].lower().replace('_','-') == 'en-us'
    gallery = next(b for b in page['blades'] if b['type'] == 'riftboundCardGallery')
    link = gallery['cards']['async']['linkdata']['first']
    raw, pages, seen = [], 0, set()
    while link:
        if not link.startswith('/publishing-content/') or link in seen or pages >= 30:
            raise ValueError('Unexpected pagination')
        seen.add(link)
        batch = get(CONTENT+link).json()
        raw.extend(batch['data']); pages += 1
        link = batch.get('linkdata', {}).get('next')
    cards = [normalize(c) for c in raw]
    if not cards or len({c['id'] for c in cards}) != len(cards):
        raise ValueError('Empty or duplicate catalog')
    # Verify the full public pages against the gallery; metadata can count unpublished entries.
    if {c['id'] for c in raw} != {c['id'] for c in gallery['cards']['items']}:
        raise ValueError('Public pages and gallery differ; retry after the source update')
    sources = json.loads((ROOT/'scripts/riftbound_sets.json').read_text('utf-8'))
    sets = []
    for entry in gallery['sets']['items']:
        code = 'RB-EN-'+entry['id']; meta = sources.get(entry['id'], {})
        subset = sorted((c for c in cards if c['setCode']==code), key=lambda c:(c['collectorNumber'],c['id']))
        if not subset: continue
        sets.append(dict(code=code, displayCode=entry['id'], name=entry['name'],
            language='en', brand='riftbound', release=meta.get('release'),
            image=image_url(meta['image']) if meta.get('image') else '',
            sourceUrl=GALLERY, releaseSource=meta.get('releaseSource'), cards=subset))
    sets.sort(key=lambda s:s['release'] or '', reverse=True)
    # Riot's Korean champion names are search aliases only; display names remain English.
    aliases = {}
    try:
        version = get('https://ddragon.leagueoflegends.com/api/versions.json').json()[0]
        names = get(f'https://ddragon.leagueoflegends.com/cdn/{version}/data/ko_KR/champion.json').json()['data']
        english = get(f'https://ddragon.leagueoflegends.com/cdn/{version}/data/en_US/champion.json').json()['data']
        aliases = {v['name']:english[k]['name'] for k,v in names.items() if k in english}
    except (requests.RequestException,KeyError,ValueError):
        old = ROOT/'data/riftbound-catalog.json'
        if old.exists(): aliases=json.loads(old.read_text('utf-8')).get('searchAliases',{})
    payload = dict(schemaVersion=1, language='en', brand='riftbound', sourceUrl=GALLERY,
        fetchedAt=datetime.now(timezone.utc).isoformat(), sourceHash=hashlib.sha256(html.encode()).hexdigest(),
        sourceListedTotal=gallery['cards']['async']['metadata']['totalItems'],
        cardCount=len(cards), searchAliases=aliases, sets=sets)
    target=output/'data/riftbound-catalog.json'; target.parent.mkdir(parents=True,exist_ok=True)
    previous=json.loads(target.read_text('utf-8')) if target.exists() else None
    if previous and len(cards)<previous.get('cardCount',0)*.95:
        raise ValueError('Catalog dropped by more than 5%; preserve existing output for review')
    temporary=target.with_suffix('.tmp'); temporary.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':')),encoding='utf-8');temporary.replace(target)
    report=f'{len(sets)} sets / {len(cards)} public English cards / {pages} source pages / {len(aliases)} Korean search aliases\nOutput: {target}\nPrices are not collected. Deployment is not included.\n'
    (output/'riftbound-report.txt').write_text(report,encoding='utf-8');print(report)

if __name__ == '__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=ROOT/'.cache/riftbound-import')
    build(parser.parse_args().output)
