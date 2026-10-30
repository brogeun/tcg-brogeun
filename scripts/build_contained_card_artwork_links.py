"""Audit exact-number artwork candidates, retaining hashes instead of downloaded images."""
import concurrent.futures
import hashlib
import io
import json
import urllib.request
from pathlib import Path
from PIL import Image
import imagehash

ROOT = Path(__file__).resolve().parent.parent
WORK = ROOT / '.cache' / 'price-link-audit'
CACHE = WORK / 'image-hashes.jsonl'

def read(path):
    return json.loads(path.read_text(encoding='utf8'))

def fingerprint(address):
    try:
        if address.startswith('/'):
            file = ROOT / address.lstrip('/')
            if not file.is_file():
                return {'error': 'local-image-unavailable'}
            payload = file.read_bytes()
        else:
            request = urllib.request.Request(address, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(request, timeout=15) as response:
                payload = response.read(5 * 1024 * 1024)
        image = Image.open(io.BytesIO(payload)).convert('RGBA')
        image = image.crop(image.getchannel('A').getbbox())
        width, height = image.size
        art = image.crop((int(width*.06), int(height*.10), int(width*.94), int(height*.62)))
        return {'sha256': hashlib.sha256(payload).hexdigest(), 'phash': str(imagehash.phash(image)),
                'dhash': str(imagehash.dhash(image)), 'art': str(imagehash.phash(art))}
    except Exception as error:
        return {'error': str(error)}

def fill(addresses, cache, phase):
    missing = sorted(set(addresses) - cache.keys())
    with CACHE.open('a', encoding='utf8') as output, concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        futures = {pool.submit(fingerprint, address): address for address in missing}
        for done, future in enumerate(concurrent.futures.as_completed(futures), 1):
            address, value = futures[future], future.result()
            cache[address] = value
            output.write(json.dumps({'image': address, **value}) + '\n')
            if done % 200 == 0 or done == len(missing):
                output.flush()
                print(json.dumps({'phase': phase, 'done': done, 'total': len(missing)}), flush=True)

def distance(a, b, key):
    return int(imagehash.hex_to_hash(a[key]) - imagehash.hex_to_hash(b[key]))

def main():
    rows = read(WORK / 'visible-unresolved.json')
    products = {str(p['id']): p for p in read(WORK / 'baseline/products.json')}
    cache = {}
    if CACHE.exists():
        for line in CACHE.read_text(encoding='utf8').splitlines():
            item = json.loads(line)
            cache[item.pop('image')] = item
    fill([r['image'] for r in rows if r.get('image') and r['candidateIds']], cache, 'source')
    valid = [r for r in rows if r.get('image') and 'error' not in cache.get(r['image'], {'error': 'missing'})]
    fill([products[id].get('thumbnailUrl') or products[id].get('image') for r in valid for id in r['candidateIds']
          if products[id].get('thumbnailUrl') or products[id].get('image')], cache, 'market')
    links, pending = [], []
    for row in valid:
        own, candidates = cache[row['image']], []
        for id in row['candidateIds']:
            product = products[id]
            image = product.get('thumbnailUrl') or product.get('image')
            proof = cache.get(image, {'error': 'missing'})
            if 'error' in proof:
                continue
            candidates.append({'id': id, 'distance': distance(own, proof, 'phash'),
                               'detailDistance': distance(own, proof, 'dhash'),
                               'artDistance': distance(own, proof, 'art')})
        candidates.sort(key=lambda c: (c['distance'], c['detailDistance']))
        if not candidates:
            continue
        best = candidates[0]
        margin = candidates[1]['distance'] - best['distance'] if len(candidates) > 1 else 64
        if best['distance'] <= 8 and best['detailDistance'] <= 14 and best['artDistance'] <= 12 and margin >= 10:
            product = products[best['id']]
            links.append({'brand': row['brand'], 'boxCode': row['boxCode'], 'setCode': row['setCode'],
                          'number': row.get('number', ''), 'fullId': row.get('fullId', ''),
                          'image': row['image'], 'id': best['id'], 'marketName': product['name'],
                          'marketProductNumber': product.get('productNumber', ''),
                          'marketImage': product.get('thumbnailUrl') or product.get('image'),
                          'sourceSHA256': own['sha256'],
                          'marketSHA256': cache[product.get('thumbnailUrl') or product.get('image')]['sha256'],
                          'method': 'artwork-comparison', 'margin': margin,
                          **{k:v for k,v in best.items() if k!='id'}})
        else:
            pending.append({**row, 'scores': candidates[:4], 'margin': margin})
    (WORK / 'proposed-links.json').write_text(json.dumps({'schemaVersion': 1, 'links': links}, ensure_ascii=False, indent=2), encoding='utf8')
    (WORK / 'pending-artworks.json').write_text(json.dumps(pending, ensure_ascii=False), encoding='utf8')
    summary = {'sourceImages': len(valid), 'proposedLinks': len(links), 'ambiguous': len(pending),
               'unavailableSourceImages': sum('error' in cache.get(r.get('image'), {}) for r in rows)}
    (WORK / 'artwork-summary.json').write_text(json.dumps(summary), encoding='utf8')
    print(json.dumps(summary), flush=True)

if __name__ == '__main__':
    main()
