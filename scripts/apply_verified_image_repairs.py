"""Apply exact, browser-verified artwork URL repairs without altering card identities."""
import argparse
import json
import re
from pathlib import Path


def run(root, verify_only=False):
    root = Path(root).resolve()
    config = json.loads((root / 'config/verified-image-url-repairs.json').read_bytes())
    assert config['schemaVersion'] == 1
    bindings = config['bindings']
    catalogue = json.loads((root / 'data/japanese-catalog.json').read_bytes())
    cards = {row['id']: row for row in catalogue['cards']}
    replacements = {}
    for row in bindings:
        assert row['oldImage'] != row['image'] and row['width'] > 0 and row['height'] > 0
        assert row['oldImage'].startswith('https://static.tcgcollector.com/content/images/')
        assert row['image'].startswith('https://static.tcgcollector.com/content/images/')
        card = cards[row['cardId']]
        assert card['number'] == row['number'], 'Printed number changed: ' + row['cardId']
        assert card['sourceUrl'].split('/cards/')[1].split('/')[0] == row['sourceUrl'].split('/cards/')[1].split('/')[0]
        assert row['oldImage'] not in replacements
        replacements[row['oldImage'].encode()] = row['image'].encode()
    image_pattern = re.compile(rb'https://static\.tcgcollector\.com/content/images/[^"\s\\<>]+')
    changed, remaining, replacements_made = [], [], 0
    for name in config['targetFiles']:
        path = (root / name).resolve()
        assert path.is_relative_to(root) and name.startswith('data/') and path.suffix == '.json'
        before = path.read_bytes()
        hits = 0
        def replace(match):
            nonlocal hits
            old = match.group()
            if old in replacements:
                hits += 1
                return replacements[old]
            return old
        after = image_pattern.sub(replace, before)
        if hits:
            remaining.append({'file': name, 'staleReferences': hits})
            if not verify_only:
                # Replacing only exact image URL byte strings preserves every
                # card, printed number, rarity, market product and quote field.
                json.loads(after)
                temporary = path.with_suffix(path.suffix + '.image-repair-tmp')
                temporary.write_bytes(after)
                temporary.replace(path)
                changed.append(name)
                replacements_made += hits
    result = {'bindings': len(bindings), 'filesChecked': len(config['targetFiles']),
              'changedFiles': changed, 'replacedReferences': replacements_made,
              'staleReferences': sum(r['staleReferences'] for r in remaining) if verify_only else 0}
    if verify_only and remaining:
        raise ValueError('Stale reviewed image URLs remain: ' + json.dumps(remaining))
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    print(json.dumps(run(args.root, args.verify_only)))
