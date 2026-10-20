"""Reject old/partial collector output before the existing data-branch publication."""
import argparse
import json
import math
import re
import time
from pathlib import Path

def validate(payload, now):
    stamp = payload.get('fetchedAt')
    if type(stamp) not in (int, float) or not math.isfinite(stamp):
        raise ValueError('Missing finite collection timestamp')
    age = now - stamp / 1000
    if not 0 <= age <= 900:
        raise ValueError('Snapshot is stale or has a future collection timestamp')
    rows = payload.get('results')
    current = payload.get('schemaVersion') == 2
    if payload.get('ok') is not True or not isinstance(rows, list) or not (1 <= len(rows) <= 16 if current else len(rows) == 4):
        raise ValueError('Expected a complete current catalogue, or four legacy quotes')
    if not all(isinstance(row, dict) for row in rows) or len({row.get('tier') for row in rows}) != len(rows):
        raise ValueError('Machine tiers must be unique')
    if current:
        catalogue = payload.get('catalogue', {})
        ids = [row.get('id') for row in rows]
        if (catalogue.get('complete') is not True or catalogue.get('httpStatus') != 200
                or catalogue.get('url') != 'https://beezie.com/claw'
                or catalogue.get('machineIds') != ids or len(set(ids)) != len(ids)
                or catalogue.get('sourceNames') != [row.get('sourceName') for row in rows]):
            raise ValueError('Snapshot does not cover its exact verified current catalogue')
        if (not all(type(cid) is int and cid > 0 for cid in ids)
                or not re.fullmatch(r'[a-f0-9]{64}', str(catalogue.get('htmlSha256', '')))):
            raise ValueError('Invalid official catalogue identities or source fingerprint')
    for row in rows:
        if row.get('ok') is not True:
            raise ValueError('At least one machine collection failed')
        if current:
            evidence = row.get('sourceEvidence', {})
            observed = row.get('checkedAt')
            name = row.get('sourceName')
            if (not isinstance(name, str) or not re.fullmatch(r'[A-Za-z0-9]+(?:[ -][A-Za-z0-9]+)*', name)
                    or row.get('tier') != ('Silver TCG' if name == 'Silver' else name)
                    or row.get('url') != 'https://beezie.com/claw/' + name.replace(' ', '-') + '-' + str(row['id'])):
                raise ValueError('Official machine source label and slug/ID differ')
            if (type(observed) not in (int, float) or not math.isfinite(observed) or not 0 <= now - observed / 1000 <= 900
                    or evidence.get('httpStatus') != 200 or evidence.get('machineId') != row.get('id')
                    or evidence.get('sourceName') != row.get('sourceName') or evidence.get('checkedAt') != observed
                    or evidence.get('stockCount') != row.get('stockCount')):
                raise ValueError('Missing fresh official machine identity/status evidence')
            if row.get('status') in ('paused', 'out-of-stock'):
                if (row.get('stockCount') != 0 or type(row.get('stockCount')) is not int
                        or evidence.get('sourceStatus') not in ('paused', 'active', 'started', 'running', 'open')
                        or (row.get('status') == 'paused') != (evidence.get('sourceStatus') == 'paused')
                        or any(row.get(key) is not None for key in ('price', 'avg', 'ev'))):
                    raise ValueError('Unavailable machines must have verified empty stock and no current quote')
                continue
            if (row.get('status') != 'active' or evidence.get('sourceStatus') not in ('active', 'started', 'running', 'open')
                    or type(row.get('stockCount')) is not int or row['stockCount'] <= 0
                    or row.get('method') != 'official-page-labelled-average'):
                raise ValueError('Active quote lacks official availability and labelled average evidence')
        for key in ('price', 'avg'):
            number = row.get(key)
            if type(number) not in (int, float) or not math.isfinite(number) or number <= 0:
                raise ValueError('Missing finite positive ' + key)
        if current:
            ev = row.get('ev')
            if type(ev) not in (int, float) or not math.isfinite(ev) or abs(ev - (row['avg'] / row['price'] - 1) * 100) > .02:
                raise ValueError('Current EV differs from its verified price/average quote')
    if current:
        active = sum(row.get('status') == 'active' for row in rows)
        expected = 'available' if active == len(rows) else 'partially-unavailable' if active else 'unavailable'
        if payload.get('status') != expected or payload.get('pricesFresh') is not (active == len(rows)):
            raise ValueError('Current availability summary differs from source rows')
    return True

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--path', type=Path, required=True)
    args = parser.parse_args()
    validate(json.loads(args.path.read_bytes()), time.time())
    print('Complete current machine source checks verified; unavailable rows have no current quote.')

if __name__ == '__main__':
    main()
