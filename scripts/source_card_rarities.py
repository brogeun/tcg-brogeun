"""Recover literal source rarity labels without joining artwork or prices.

Manufacturer rows supply the allowed taxonomy and exact printed-code evidence.
A marketplace suffix can choose one of several official rarities, but a bare
code can only supply a rarity when every manufacturer row agrees. Conflicts
remain unresolved. This module never changes a market product or quote.
"""
from collections import defaultdict
import re
import unicodedata


def normalize(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value or ''))).strip()


def grade_key(value):
    return normalize(value).upper().replace('*', '★').replace('☆', '★')


def number_key(value, game):
    value = normalize(value).upper()
    if game == 'union_arena':
        value = re.sub(r'^((?:UA|EX|PC)[A-Z0-9]*)-', r'\1/', value, count=1)
    return value


# Explicit marketplace labels used for Yu-Gi-Oh parallel/foil treatments. Keep
# their source spelling: NP must not silently become manufacturer P, for example.
SOURCE_LABELS = {
    'yugioh': {'NP', 'URP', 'NR', 'SRP', 'SEP', 'MR', 'GS', 'PSC', 'USR',
               'MUR', 'MG', 'S', 'PG', 'KC'},
    'digimon': {'P-P'},
}
BASE_LABELS = set('C U UC R RR RRR SR SP SSP SEC SCR PR TD UR SE OR L N LRR QCSE PSE P-SR P-SEC'.split())


class RarityResolver:
    def __init__(self, sources, disclosures=None):
        self.by_number = {}
        self.labels = {}
        self.audit = []
        self.disclosures = disclosures or {}
        for game, source in sources.items():
            by_number = defaultdict(list)
            labels = BASE_LABELS | SOURCE_LABELS.get(game, set())
            for product in source.get('products', []):
                for card in product.get('cards', []):
                    if card.get('number'):
                        by_number[number_key(card['number'], game)].append(card)
                    value = normalize(card.get('rarity'))
                    if value and value != '-':
                        labels.add(value)
            self.by_number[game] = by_number
            self.labels[game] = {grade_key(label): label for label in sorted(labels)}

    def explicit(self, product, game, number):
        title = normalize(product.get('name'))
        # Card titles may themselves contain brackets. Use the actual full code.
        bracket = next((m for m in re.finditer(r'\[([^\[\]]+)\]', title)
                        if number_key(m[1], game) == number_key(number, game)), None)
        if bracket is None:
            return ''
        before = title[:bracket.start()].strip()
        before = re.sub(r'\s*:\s*Autographed(?:\s*&\s*Serial Numbered)?\s*$', '', before, flags=re.I).strip()
        # Literal suffix only, never any grade-looking word elsewhere in a name.
        match = re.search(r'(?:^|\s)([A-Za-z0-9@+_-]+(?:\s+SE)?\s*[★☆*+]*)$', before)
        if not match:
            return ''
        value = normalize(match[1])
        labels = self.labels.get(game, {grade_key(x): x for x in BASE_LABELS | SOURCE_LABELS.get(game, set())})
        return labels.get(grade_key(value), '')

    def resolve(self, product, game, number, previous):
        if previous:
            return {'rarity': previous}
        literal = self.explicit(product, game, number)
        native = self.by_number.get(game, {}).get(number_key(number, game), []) if number else []
        values = {normalize(card.get('rarity')) for card in native}
        values = {'' if value == '-' else value for value in values}
        supported = {grade_key(value): value for value in values if value}
        method, value, status = '', '', 'unavailable'
        if literal and (not native or grade_key(literal) in supported
                        or literal in SOURCE_LABELS.get(game, set())):
            value = supported.get(grade_key(literal), literal)
            method, status = 'marketplace-explicit-suffix', 'verified'
        elif literal and native:
            method = 'source-conflict'
        elif len(values) == 1:
            value = next(iter(values))
            method = 'exact-manufacturer-code-consensus'
            status = ('verified' if value else 'not_applicable'
                      if all(c.get('rarityStatus') == 'not_applicable' for c in native)
                      else 'unavailable')
        else:
            method = 'unresolved'
        result = {'rarity': value, 'rarityStatus': status, 'rarityOrigin': method}
        if native and values == {''} and status == 'unavailable' and not literal:
            result['raritySourceUnlisted'] = True
            entry = self.disclosures.get(game, {}).get(str(product['id']))
            if (entry and entry.get('name') == product.get('name')
                    and entry.get('fullCardNumber') == number
                    and entry.get('manufacturerCardIds') == sorted({str(c['id']) for c in native})
                    and entry.get('status') == 'verified-unprinted-rarity'
                    and entry.get('manufacturerLiteral') == '-'
                    and all(c.get('rarity') == '-' for c in native)):
                result['rarityDisclosureStatus'] = entry['status']
                result['rarityDisclosureEvidence'] = {'references': entry['references']}
        if status != 'unavailable':
            result['raritySourceUrl'] = (product.get('url') if literal else native[0].get('url')) or ''
        self.audit.append({'game': game, 'sourceId': str(product['id']), 'fullCardNumber': number,
                           'rarity': value, 'rarityStatus': status, 'method': method,
                           'sourceUnlisted': result.get('raritySourceUnlisted', False),
                           'explicitSourceLabel': literal, 'officialRarities': sorted(values),
                           'sourceUrl': product.get('url'),
                           'officialCardIds': sorted({str(c['id']) for c in native})})
        return result
