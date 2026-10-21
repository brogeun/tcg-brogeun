"""Plan deterministic daily collection and truthfully report every source result."""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os

KST = timezone(timedelta(hours=9))
REQUIRED = ('plan', 'history', 'boxes', 'chinese', 'site')
WEEKLY = ('pokemon', 'onepiece')


def plan(now):
    if now.tzinfo is None:
        raise ValueError('An aware collection time is required')
    local = now.astimezone(KST)
    return {
        'source_day_kst': local.date().isoformat(),
        'weekly': 'true' if local.weekday() == 0 else 'false',
        'box_days': '90' if local.weekday() == 6 else '14',
        # Preserve the existing rotation's UTC day-of-year modulo seven.
        'history_batch': str(now.astimezone(timezone.utc).timetuple().tm_yday % 7),
    }


def assess(results, weekly):
    if not isinstance(results, dict):
        raise ValueError('Expected the complete GitHub needs object')
    if weekly not in ('true', 'false'):
        raise ValueError('Expected an explicit weekly plan')
    failures = []
    states = {}
    for name in REQUIRED + WEEKLY:
        row = results.get(name)
        value = row.get('result') if isinstance(row, dict) else None
        states[name] = value
        expected = 'success' if name in REQUIRED or weekly == 'true' else 'skipped'
        if value != expected:
            failures.append(name)
    return {'status': 'success' if not failures else 'incomplete',
            'jobs': states, 'incompleteJobs': failures,
            'policy': 'Completed independent snapshots may be deployed; any failed collector remains an overall failure.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('mode', choices=('plan', 'report'))
    args = parser.parse_args()
    if args.mode == 'plan':
        result = plan(datetime.now(timezone.utc))
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as stream:
                for key, value in result.items():
                    stream.write(key + '=' + value + '\n')
    else:
        result = assess(json.loads(os.environ.get('DAILY_RESULTS', '{}')),
                        os.environ.get('WEEKLY_EXPECTED', 'false'))
        if os.environ.get('GITHUB_STEP_SUMMARY'):
            with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as stream:
                stream.write('### Daily collection and single deployment\n```json\n'
                             + json.dumps(result, indent=2) + '\n```\n')
    print(json.dumps(result))
    return 1 if result.get('status') == 'incomplete' else 0


if __name__ == '__main__':
    raise SystemExit(main())
