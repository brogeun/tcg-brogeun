"""Record timestamps embedded in snapshots, never filesystem/deployment dates."""
import argparse
import json
import os
from datetime import datetime, timezone
from pathlib import Path

DATASETS = {
    'top10-pokemon.json': ('fetchedAt', 36),
    'price-pokemon-card.json': ('fetchedAt', 36),
    'top10-onepiece.json': ('fetchedAt', 36),
    'price-onepiece-card.json': ('fetchedAt', 36),
    'cards-prices.json': ('fetchedAt', 36),
    'fx-rates.json': ('updated', 36),
    'market-price-index.json': ('sourceAsOf', 48),
    'chinese-market.json': ('observedAt', 48),
}

def inspect(data_dir, now):
    records = []
    for filename, (field, hours) in DATASETS.items():
        entry = {'file': filename, 'timestampField': field, 'maximumAgeHours': hours}
        try:
            data = json.loads((data_dir / filename).read_bytes())
            value = data.get(field)
            if not isinstance(value, str):
                raise ValueError('Missing embedded timestamp')
            stamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
            # Date-only sourceAsOf is conservatively measured from the beginning
            # of that source day. It is never replaced with the generation date.
            if stamp.tzinfo is None:
                from datetime import timedelta
                stamp = stamp.replace(tzinfo=timezone(timedelta(hours=9)))
            age = (now - stamp).total_seconds() / 3600
            if age < -1:
                raise ValueError('Source timestamp is in the future')
            if filename == 'fx-rates.json':
                from refresh_search_prices import fx_basis
                basis = fx_basis(data, now)
                entry['businessCloseDate'] = basis['asOf']
            entry.update(sourceTimestamp=value, ageHours=round(age, 2),
                         status='fresh' if age <= hours else 'stale')
        except (OSError, ValueError, TypeError, RuntimeError) as error:
            entry.update(status='unavailable', error=str(error))
        records.append(entry)
    return {'checkedAt': now.isoformat(),
            'status': 'healthy' if all(r['status'] == 'fresh' for r in records) else 'incomplete',
            'datasets': records}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    report = inspect(args.root / 'data', datetime.now(timezone.utc))
    if args.output:
        target = args.root / args.output
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    output = os.environ.get('GITHUB_OUTPUT')
    if output:
        with open(output, 'a', encoding='utf-8') as stream:
            stream.write('status=' + report['status'] + '\n')
    for item in report['datasets']:
        print(json.dumps(item, ensure_ascii=False))
        if item['status'] != 'fresh':
            print('::warning::Data freshness: ' + item['file'] + ' is ' + item['status'])
    return 0  # Publish valid independent updates; collector failures fail the final workflow step.

if __name__ == '__main__':
    raise SystemExit(main())
