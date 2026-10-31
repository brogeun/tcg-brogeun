"""Apply reviewable public fact corrections without replacing source archives."""
import copy
import json


def apply_fields(target, changes):
    for field, change in changes.items():
        current = target.get(field)
        if current == change['after']:
            continue
        if current != change['before']:
            raise ValueError('Catalogue resolution conflicts with newer source: ' + field)
        target[field] = copy.deepcopy(change['after'])


def apply_resolutions(root, data):
    path = root / 'data/official-card-contents/resolutions-20261031.json'
    if not path.exists():
        return data
    resolution = json.loads(path.read_bytes())
    if resolution.get('schemaVersion') != 1:
        raise ValueError('Invalid catalogue resolution schema')
    patch = resolution['games'].get(data['game'])
    if not patch:
        return data
    data = copy.deepcopy(data)
    apply_fields(data, patch['fields'])
    products = {str(p['id']): p for p in data['products']}
    for correction in patch['products']:
        product = products[correction['id']]
        apply_fields(product, correction['fields'])
        cards = {str(c['id']): c for c in product['cards']}
        for printing in correction['cards']:
            apply_fields(cards[printing['id']], printing['fields'])
    existing = {str(p['id']): p for p in data.get('derivedProducts', [])}
    for recipe in patch['derivedProducts']:
        derived = copy.deepcopy(recipe)
        excluded = set(map(str, recipe['excludedCardIds']))
        derived['cards'] = [copy.deepcopy(c) for c in products[recipe['sourceNativeProductId']]['cards']
                            if str(c['id']) not in excluded]
        if derived['id'] in existing:
            if derived != existing[derived['id']]:
                raise ValueError('Catalogue resolution changes existing derived edition')
        else:
            data.setdefault('derivedProducts', []).append(derived)
    return data
