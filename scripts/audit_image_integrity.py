"""Resumable image inventory and byte checks for every registered catalogue.

The default only inventories references. --check checks all local files and
performs bounded GETs for external URLs. Full downloads are decoded; oversized
images are explicitly reported as header-only checks. SQLite commits preserve
completed URLs if the process or chat is interrupted. HTTP failures are findings,
not reasons to discard the run or abandon the remaining catalogue.
"""
from __future__ import annotations

import argparse
import collections
import concurrent.futures as futures
import datetime as dt
import io
import json
from pathlib import Path
import sqlite3
import subprocess
import threading
import time
import urllib.parse
import xml.etree.ElementTree as ET

from PIL import Image, ImageFile
import requests
from audit_all_boxes import Audit, save

thread_state = threading.local()


def build_inventory(root, work):
    audit = Audit(root)
    report = audit.run()
    save(work / 'box-audit.json', report)
    refs = {}
    missing = []

    def add(url, kind, origin, identity):
        if not isinstance(url, str) or not url.strip():
            missing.append({'kind': kind, 'origin': origin, 'identity': str(identity)})
            return
        url = url.strip()
        if url.startswith('//'):
            url = 'https:' + url
        entry = refs.setdefault(url, {'url': url, 'kinds': [], 'references': 0, 'examples': []})
        if kind not in entry['kinds']:
            entry['kinds'].append(kind)
        entry['references'] += 1
        if len(entry['examples']) < 3:
            example = {'origin': origin, 'identity': str(identity)}
            if example not in entry['examples']:
                entry['examples'].append(example)

    for row in report['rows']:
        add(row.get('image'), 'box', row['group'], row.get('code') or row['id'])
        for cover in row.get('sealedCoverSources', []):
            add(cover.get('image'), 'box', row['group'], row.get('code') or row['id'])

    def visit(doc, name):
        if not isinstance(doc, dict):
            return
        for card in doc.get('cards', []):
            if not isinstance(card, dict):
                continue
            add(card.get('localImage') or card.get('image') or card.get('thumbnailUrl'),
                'card', name, card.get('id') or card.get('fullId') or card.get('number') or card.get('name'))
        # Chiikawa and Riftbound embed cards directly within their set catalogue.
        for item in doc.get('sets', []):
            if isinstance(item, dict) and 'cards' in item:
                visit(item, name + ':' + str(item.get('code') or item.get('id')))

    for name, document in audit.cache.items():
        visit(document, name)
    inventory = {'sourceCommit': report['sourceCommit'], 'observedAt': dt.datetime.now(dt.timezone.utc).isoformat(),
                 'boxes': len(report['rows']), 'images': list(refs.values()), 'missingReferences': missing,
                 'summary': {'uniqueImages': len(refs), 'references': sum(e['references'] for e in refs.values()),
                             'missingByKind': dict(collections.Counter(e['kind'] for e in missing)),
                             'hosts': dict(collections.Counter(urllib.parse.urlparse(e['url']).netloc or 'local' for e in refs.values()))}}
    save(work / 'image-inventory.json', inventory)
    return inventory


def inspect_bytes(raw, complete, content_type=''):
    if 'svg' in content_type or raw.lstrip().startswith((b'<svg', b'<?xml')):
        document = ET.fromstring(raw)
        if document.tag.split('}')[-1] != 'svg':
            raise ValueError('Response is XML but not SVG')
        return {'status': 'svg-validated', 'bytes': len(raw)}
    if complete:
        with Image.open(io.BytesIO(raw)) as image:
            image.load()
            width, height = image.size
            image_type = image.format
    else:
        parser = ImageFile.Parser()
        parser.feed(raw)
        if parser.image is None:
            raise ValueError('No valid image header within bounded download')
        width, height = parser.image.size
        image_type = parser.image.format
    if min(width, height) < 2:
        raise ValueError('Empty/tracking image dimensions')
    return {'status': 'decoded' if complete else 'header-valid', 'bytes': len(raw), 'width': width, 'height': height, 'format': image_type}


def probe(entry, root, max_bytes, timeout):
    url = entry['url']
    result = {'url': url, 'checkedAt': dt.datetime.now(dt.timezone.utc).isoformat()}
    if not url.startswith(('https://', 'http://')):
        try:
            relative = urllib.parse.unquote(url.split('?')[0]).lstrip('/')
            path = (root / relative).resolve()
            if not path.is_relative_to(root):
                raise ValueError('Image path escapes source')
            raw = path.read_bytes()
            result.update(inspect_bytes(raw, True, 'image/svg+xml' if path.suffix.lower() == '.svg' else ''))
            result['location'] = 'source'
        except Exception as error:
            result.update(status='local-missing' if isinstance(error, FileNotFoundError) else 'decode-error', error=str(error))
        return result
    if not hasattr(thread_state, 'session'):
        thread_state.session = requests.Session()
        thread_state.session.headers.update({'User-Agent': 'Mozilla/5.0', 'Referer': 'https://tcghub.kr/'})
    session = thread_state.session
    for attempt in range(2):
        try:
            with session.get(url, stream=True, timeout=(timeout, timeout), allow_redirects=True) as response:
                result['httpStatus'] = response.status_code
                if response.status_code in (429, 500, 502, 503, 504) and attempt == 0:
                    time.sleep(min(float(response.headers.get('Retry-After', '1')), 10))
                    continue
                response.raise_for_status()
                chunks, received = [], 0
                complete = True
                for chunk in response.iter_content(32768):
                    chunks.append(chunk)
                    received += len(chunk)
                    if received > max_bytes:
                        complete = False
                        break
                result.update(inspect_bytes(b''.join(chunks), complete, response.headers.get('Content-Type', '')))
                result['location'] = 'remote'
                result['contentType'] = response.headers.get('Content-Type')
                return result
        except Exception as error:
            result.update(status='http-error' if isinstance(error, requests.HTTPError) else 'unverified', error=str(error))
            if attempt == 0 and result.get('httpStatus') not in (400, 401, 403, 404, 410):
                time.sleep(0.25)
                continue
            return result
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output-dir', type=Path)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--reuse-inventory', action='store_true')
    parser.add_argument('--retry-failed', action='store_true')
    parser.add_argument('--workers', type=int, default=12)
    parser.add_argument('--timeout', type=float, default=10)
    parser.add_argument('--max-bytes', type=int, default=2 * 1024 * 1024)
    parser.add_argument('--limit', type=int)
    args = parser.parse_args()
    root = args.root.resolve()
    work = (args.output_dir or root / '.cache/image-review').resolve()
    work.mkdir(parents=True, exist_ok=True)
    inventory_path = work / 'image-inventory.json'
    inventory = json.loads(inventory_path.read_text(encoding='utf-8')) if args.reuse_inventory and inventory_path.is_file() else build_inventory(root, work)
    print(json.dumps({'inventory': inventory['summary'], 'boxes': inventory['boxes']}), flush=True)
    if not args.check:
        return
    connection = sqlite3.connect(work / 'image-checks.sqlite3')
    connection.execute('CREATE TABLE IF NOT EXISTS results (url TEXT PRIMARY KEY, status TEXT NOT NULL, document TEXT NOT NULL)')
    connection.execute('PRAGMA journal_mode=WAL')
    good = {'decoded', 'header-valid', 'svg-validated'}
    existing = {url: status for url, status in connection.execute('SELECT url,status FROM results')}
    pending = [e for e in inventory['images'] if e['url'] not in existing or args.retry_failed and existing[e['url']] not in good]
    pending.sort(key=lambda e: (0 if 'box' in e['kinds'] else 1, 0 if not e['url'].startswith('http') else 1))
    if args.limit:
        pending = pending[:args.limit]
    counts = collections.Counter(existing.values())
    checked, last_saved = 0, time.monotonic()

    def checkpoint():
        connection.commit()
        relevant = [json.loads(document) for url, document in connection.execute('SELECT url,document FROM results') if url in wanted]
        statuses = dict(collections.Counter(r['status'] for r in relevant))
        summary = {'sourceCommit': inventory['sourceCommit'], 'updatedAtUtc': dt.datetime.now(dt.timezone.utc).isoformat(),
                   'inventory': inventory['summary'], 'completed': len(relevant), 'remaining': len(wanted) - len(relevant),
                   'statuses': statuses, 'failures': [r for r in relevant if r['status'] not in good],
                   'limits': ['Byte checks do not establish artwork or edition identity.', 'header-valid is not a complete byte decode.', 'Source files and remote images are distinguished; this does not claim an unpublished change is deployed.']}
        save(work / 'image-check-summary.json', summary)
        print(json.dumps({key: summary[key] for key in ['completed', 'remaining', 'statuses']}), flush=True)

    wanted = {e['url'] for e in inventory['images']}
    with futures.ThreadPoolExecutor(max_workers=max(1, min(args.workers, 32))) as pool:
        tasks = {pool.submit(probe, entry, root, args.max_bytes, args.timeout): entry['url'] for entry in pending}
        for task in futures.as_completed(tasks):
            result = task.result()
            connection.execute('INSERT OR REPLACE INTO results VALUES (?,?,?)', (result['url'], result['status'], json.dumps(result, ensure_ascii=False)))
            checked += 1
            if checked % 25 == 0:
                connection.commit()
            if checked % 1000 == 0 or time.monotonic() - last_saved > 25:
                checkpoint()
                last_saved = time.monotonic()
    checkpoint()
    connection.close()


if __name__ == '__main__':
    main()
