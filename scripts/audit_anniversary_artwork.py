"""Measure original artwork alpha bounds. Never crop or rewrite image files."""
import concurrent.futures
import io
import json
from pathlib import Path

import requests
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]


def measure(url):
    response = requests.get(url, timeout=40)
    response.raise_for_status()
    image = Image.open(io.BytesIO(response.content)).convert('RGBA')
    width, height = image.size
    bounds = image.getchannel('A').getbbox()
    if not bounds:
        raise ValueError(f'Empty artwork: {url}')
    return url, {'width': width, 'height': height, 'bounds': list(bounds)}


def main():
    urls = set()
    for code in ('M6a', 'MF'):
        data = json.loads((ROOT / f'data/cards-by-set/{code}.json').read_text(encoding='utf-8'))
        urls.update(c['image'] for c in data['cards'] if c.get('image'))
    market = json.loads((ROOT / 'data/anniversary-market.json').read_text(encoding='utf-8'))
    urls.update(p['thumbnailUrl'] for p in market['products'].values() if p['kind'] == 'card')
    with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
        images = dict(pool.map(measure, sorted(urls)))
    output = ROOT / 'data/anniversary-artwork.json'
    payload = {'schemaVersion': 1, 'images': images}
    output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    padded = sum(v['bounds'] != [0, 0, v['width'], v['height']] for v in images.values())
    print(json.dumps({'images': len(images), 'withTransparentMargins': padded, 'failures': 0}))


if __name__ == '__main__':
    main()
