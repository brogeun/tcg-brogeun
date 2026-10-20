"""Reject old/partial collector output before the existing data-branch publication."""
import argparse
import json
import math
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
    if payload.get('ok') is not True or not isinstance(rows, list) or len(rows) != 4:
        raise ValueError('Expected four successfully collected machines')
    if len({row.get('tier') for row in rows}) != 4:
        raise ValueError('Machine tiers must be unique')
    for row in rows:
        if row.get('ok') is not True:
            raise ValueError('At least one machine collection failed')
        for key in ('price', 'avg'):
            number = row.get(key)
            if type(number) not in (int, float) or not math.isfinite(number) or number <= 0:
                raise ValueError('Missing finite positive ' + key)
    return True

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--path', type=Path, required=True)
    args = parser.parse_args()
    validate(json.loads(args.path.read_bytes()), time.time())
    print('Four fresh complete machine results verified.')

if __name__ == '__main__':
    main()
