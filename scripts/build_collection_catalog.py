#!/usr/bin/env python3
"""Build collection registries without modifying upstream card catalogues.

Card ID specification (immutable cp1): namespace UUID
a7872361-e820-5f5e-bf17-7c918bd12f94; UUIDv5 UTF-8 name is
game + U+0000 + language + U+0000 + exact sourceKey. Output is 'cp1_'+UUID
with canonical lowercase hyphens. key shard is id[4]. No title, price, artist,
array order or mutable image URL enters the UUID. Never change the namespace.
JP keys preserve JP:...; EN keys preserve setCode:sourceId (Shadowless stays
separate); CN preserves existing variant-bearing id; OP preserves exact fullId
including _pN. Provider evidence has separate source keys and never inherits an
unverified local-printing join or market ID. Existing images are unchanged.

Initial evidence import:
 python scripts/build_collection_catalog.py --repo UPSTREAM --research RESEARCH
   --demo DEMO --species SPECIES_JSON --output data/collections
Offline rebuild: --repo . --sources-dir data/collections/sources --output
data/collections --offline. The compact checked-in cache contains all evidence,
taxonomy, official set counts and types. No workstation path is required.
Previously emitted IDs removed upstream are retained as retired snapshot records.
No network calls, credentials, database mutation or upstream writes are performed.
"""
import argparse
import collections
import hashlib
import json
import pathlib
import re
import unicodedata
import uuid
from urllib.parse import quote, urlparse

NAMESPACE = uuid.UUID('a7872361-e820-5f5e-bf17-7c918bd12f94')
FORMAT = 'packed-v1'
IMAGE_PREFIXES = ['https://static.tcgcollector.com/content/images/',
                  'https://cdn.snkrdunk.com/upload_bg_removed/',
                  'https://images.pikaqian.com/originals/',
                  'https://assets.tcgdex.net/',
                  'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece/',
                  '/images/onepiece/', 'images/pokemon-en-sheets/']


def load(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    # Stream small chunks so NTFS compression does not first allocate a whole
    # uncompressed multi-megabyte write on a nearly full workstation volume.
    with temporary.open('w', encoding='utf-8', buffering=65536, newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, separators=(',', ':'))
        stream.write('\n')
    temporary.replace(path)


def norm(value):
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', str(value)).casefold()).strip()


def key(game, language, source):
    return 'cp1_' + str(uuid.uuid5(NAMESPACE, game + '\0' + language + '\0' + source))


def image_url(value):
    if not value:
        return None
    if value.startswith('https://assets.tcgdex.net/') and not re.search(r'\.(?:webp|png|jpg)(?:\?|$)', value):
        return value.rstrip('/') + '/high.webp'
    return value


def import_evidence(research, demo, species_path, extra_path=None):
    displayed = load(demo / 'demo-data.json')
    artists = [{k: v for k, v in row.items() if k in ('id', 'game', 'name', 'ko', 'aliases', 'knownFor', 'sourceUrl')}
               for row in displayed['artists']]
    roster = {row['id']: row for row in artists}
    pk = collections.OrderedDict()
    pocket_sets = set(sum(load(research / 'pokemon_tcgdex_indexes.json').get('pocketSets', {}).values(), []))
    language_files = [('ja', 'ja', 'pokemon_ja_artist_cards.json'), ('en', 'en', 'pokemon_en_artist_cards.json'),
                      ('zh-CN', 'zh-cn', 'pokemon_zh_cn_artist_cards.json')]
    language_payloads = []
    for language, locale, filename in language_files:
        path = research / filename
        if not path.exists():
            continue
        language_payloads.append((language, locale, load(path)))
    if extra_path and extra_path.exists():
        for language in load(extra_path)['languages']:
            language_payloads.append((language['language'], language['locale'], language))
    for language, locale, payload in language_payloads:
        for credit, response in payload['artists'].items():
            artist_id = 'pokemon:' + credit
            if artist_id not in roster:
                artist = {'id': artist_id, 'game': 'pokemon', 'name': credit, 'ko': '', 'aliases': [],
                          'sourceUrl': 'https://api.tcgdex.net/v2/' + locale + '/illustrators/' + quote(credit, safe='')}
                roster[artist_id] = artist
                artists.append(artist)
            for row in response.get('cards', []):
                if not row.get('id') or row['id'].rsplit('-', 1)[0] in pocket_sets:
                    continue
                found = pk.setdefault(language + ':' + row['id'], {'providerId': row['id'], 'name': row['name'],
                                                 'language': language, 'locale': locale,
                                                 'number': row.get('localId', ''), 'artistIds': []})
                if artist_id not in found['artistIds']:
                    found['artistIds'].append(artist_id)
                if row.get('image'):
                    found['image'] = image_url(row['image'])
    op = collections.OrderedDict()
    for group in load(research / 'onepiece_limitless_summary.json')['sets']:
        for row in group['cards']:
            if not row.get('artistCredit') or not row.get('image'):
                continue
            match = re.search(r'/([^/]+)_JP\.(?:webp|png)', row['image'])
            if not match:
                continue
            printing = match.group(1)
            artist_id = 'onepiece:' + row['artistCredit']
            if artist_id not in roster:
                continue
            found = op.setdefault(printing, {'printing': printing, 'name': row['name'],
                                            'image': row['image'], 'sourceUrl': row['printingUrl'],
                                            'artistIds': []})
            if artist_id not in found['artistIds']:
                found['artistIds'].append(artist_id)
    representatives = []
    for game, directory, field in [('pokemon', 'pokemon', 'assets'), ('pokemon', 'pokemon-famous', 'assets'),
                                   ('onepiece', 'onepiece', 'cards'), ('onepiece', 'onepiece-famous', 'cards')]:
        for row in load(demo / 'assets' / directory / 'manifest.json')[field]:
            representatives.append({k: v for k, v in row.items() if k not in
                                    ('sha256', 'bytes', 'width', 'height', 'sourceDimensions', 'dimensions',
                                     'originalWidth', 'originalHeight', 'imagefile')})
            representatives[-1]['game'] = game
            representatives[-1]['originManifest'] = directory
    return {'schemaVersion': 1, 'artists': artists, 'featuredArtists': displayed['featured'],
            'species': load(species_path), 'pokemonSourceCards': list(pk.values()),
            'onepieceSourceCards': list(op.values()), 'representatives': representatives,
            'limitations': ['Artist labels are source strings, not a count of distinct humans.',
                           'Provider cards are separate identities until artwork and exact printing are verified.',
                           'Absent source images stay null and retain a source detail link.',
                           'No legacy candidate set/number joins are silently promoted to confirmed credits.']}


def prepare_taxonomy(evidence, taxonomy, names):
    species = evidence['species']
    if len(species) != 1025 or {row['id'] for row in species} != set(range(1, 1026)):
        raise ValueError('Expected 1025 exact national species IDs')
    by_number = {row['id']: row for row in species}
    by_ko = {row['ko']: row['id'] for row in species}
    aliases = {}
    for row in species:
        for label in (row['en'], row['ko'], row['ja']):
            aliases[norm(label)] = row['id']
    for label, ko in names['species'].items():
        if ko in by_ko:
            aliases[norm(label)] = by_ko[ko]
    tax_by_name = {norm(row['name']): row for row in taxonomy['species']}
    parent = {number: number for number in by_number}
    def find(number):
        while parent[number] != number:
            parent[number] = parent[parent[number]]
            number = parent[number]
        return number
    def union(a, b):
        a, b = find(a), find(b)
        if a != b:
            parent[max(a, b)] = min(a, b)
    mega_species = set()
    forme_aliases = {}
    for row in taxonomy['species']:
        if row.get('forme', '').startswith('Mega'):
            mega_species.add(row['num'])
        for ancestor in [row.get('prevo')] + row.get('evos', []):
            if ancestor and norm(ancestor) in tax_by_name:
                union(row['num'], tax_by_name[norm(ancestor)]['num'])
        if row.get('baseSpecies'):
            forme_aliases[norm(row['name'])] = (row['num'], row.get('forme', ''))
            if row.get('forme', '').startswith('Mega-'):
                suffix = row['forme'][5:]
                for base in (by_number[row['num']]['en'], by_number[row['num']]['ja'], by_number[row['num']]['ko']):
                    for separator in (' ', ''):
                        forme_aliases[norm(base + separator + suffix)] = (row['num'], row['forme'])
    families = collections.defaultdict(list)
    for number in by_number:
        families[find(number)].append(number)
    return by_number, aliases, mega_species, forme_aliases, {number: families[find(number)] for number in by_number}


def pokemon_classifier(aliases, mega_species, forme_aliases, owners):
    owner_prefixes = sorted({label + "'s " for label in owners} | {"Rocket's ", "Team Rocket's ", "Team Aqua's ", "Team Magma's "}, key=len, reverse=True)
    form_prefixes = ['Origin Forme ', 'Therian Forme ', 'Incarnate Forme ', 'Alolan ', 'Galarian ', 'Hisuian ',
                     'Paldean ', 'Radiant ', 'Shining ', 'Dark ', 'Light ', 'Flying ', 'Surfing ', 'Detective ',
                     'Primal ', 'Ultra ', 'ガラル ', 'アローラ ', 'ヒスイ ', 'パルデア ', '알로라 ', '가라르 ', '히스이 ', '팔데아 ']
    suffixes = [' V-UNION', ' VMAX', ' VSTAR', ' LV.X', ' BREAK', ' LEGEND', '-EX', '-GX', ' EX', ' ex', ' GX',
                ' V', ' ☆', ' ★', ' δ', ' FB', ' GL', ' E4', ' G', ' C', ' M', ' SAR', ' SSR', ' CSR', ' CHR',
                ' RRR', ' RR', ' AR', ' SR', ' HR', ' UR', ' MUR', ' PR', ' R', ' U', ' P', ' S', ' K']
    suffixes.sort(key=len, reverse=True)
    def classify(value):
        title = str(value or '').strip()
        # Exact vendor set/printed-number brackets may touch the name and pack annotation.
        # Internal letter-form brackets and arbitrary prose remain part of the name.
        title = re.sub(r'\s*\[[A-Za-z0-9][A-Za-z0-9_.:-]*\s+(?:[0-9]+/[0-9]+|[0-9]+|No\.?\s*[0-9]+)\]\s*(?:\(.*\))?\s*$', '', title)
        # Only trailing catalogue annotations are removed; printed names retain internal brackets.
        title = re.sub(r'\s+\([^()]*\)\s*$', '', title)
        title = re.sub(r'\s+\[[^\]]*\d[^\]]*\]\s*$', '', title)
        title = re.sub(r'(?:\s*:\s*(?:1ED|1st\s+Edition|UNL|Unlimited))+\s*$', '', title, flags=re.I)
        for _ in range(3):
            before = title
            for suffix in suffixes:
                if title.casefold().endswith(suffix.casefold()):
                    title = title[:-len(suffix)].rstrip(); break
            if title == before:
                break
        parts = re.split(r'\s+(?:&|and)\s+|＆', title)
        species_ids, is_mega = [], False
        for part in parts:
            part = part.strip()
            for prefix in owner_prefixes:
                if part.casefold().startswith(prefix.casefold()):
                    part = part[len(prefix):]; break
            mega = False
            for prefix in ('Mega ', 'M ', 'メガ', '메가'):
                if part.casefold().startswith(prefix.casefold()):
                    part = part[len(prefix):].strip(); mega = True; break
            for prefix in form_prefixes:
                if part.casefold().startswith(prefix.casefold()):
                    part = part[len(prefix):].strip(); break
            # Japanese ex is printed without a separating space.
            part = re.sub(r'(?<=[\u3040-\u30ff\uac00-\ud7af])(?:ex|EX|GX|VMAX|VSTAR|V)$', '', part)
            identity = aliases.get(norm(part))
            if identity is None and norm(part) in forme_aliases:
                identity, forme = forme_aliases[norm(part)]
                mega = mega or forme.startswith('Mega')
            if identity is None or (mega and identity not in mega_species):
                return [], 'unclassified'
            species_ids.append('pokemon:species:' + str(identity))
            is_mega = is_mega or mega
        return sorted(set(species_ids)), 'mega' if is_mega else 'base'
    return classify


def packed(cards, game, language, version):
    defaults = {'game': game, 'language': language, 'artistIds': [], 'characterIds': [],
                'rarity': '', 'marketVerified': False, 'form': 'base', 'artistCreditStatus': 'pending-evidence'}
    fields = [field for field in ('id', 'sourceKey', 'name', 'nameOriginal', 'number', 'setCode', 'image',
                                  'artistIds', 'characterIds', 'rarity', 'marketId', 'marketVerified', 'form',
                                  'sourceUrl', 'detailSourceUrl', 'sourceOnly', 'imageStatus', 'variantLabel',
                                  'sprite', 'cardType', 'canonicalId', 'printingStatus', 'artistGoalStatus', 'retired',
                                  'artistCreditStatus', 'characterDiscoveryVerified', 'sourceArtistIds', 'officialGoalSourceIds', 'imageSourceUrl') if any(field in card for card in cards)]
    references = {'nameOriginal': 'name', 'detailSourceUrl': 'sourceUrl'}
    dictionaries = {}
    for field in ['name', 'nameOriginal', 'setCode', 'image', 'rarity', 'sourceUrl', 'detailSourceUrl', 'artistCreditStatus']:
        eligible = [card for card in cards if field not in references or card.get(field) != card.get(references[field])]
        values = list(dict.fromkeys(card.get(field) for card in eligible if isinstance(card.get(field), str)))
        if not values:
            continue
        original_size = sum(len(json.dumps(card.get(field), ensure_ascii=False).encode()) for card in eligible)
        dictionary_size = len(json.dumps(values, ensure_ascii=False).encode()) + len(eligible) * 5
        if dictionary_size + 256 < original_size:
            dictionaries[field] = values
    indexes = {field: {value: index for index, value in enumerate(values)} for field, values in dictionaries.items()}
    rows = []
    for card in cards:
        row = []
        for field in fields:
            value = card.get(field)
            if field in references and field in card and card.get(field) == card.get(references[field]):
                value = -1
            elif value == defaults.get(field) and field in defaults:
                value = None
            elif field in indexes and isinstance(value, str):
                value = indexes[field][value]
            if field == 'image' and isinstance(value, str):
                for index, prefix in enumerate(IMAGE_PREFIXES):
                    if value.startswith(prefix):
                        value = '~' + str(index) + ':' + value[len(prefix):]; break
            row.append(value)
        while row and row[-1] is None:
            row.pop()
        rows.append(row)
    for i, value in enumerate(dictionaries.get('image', [])):
        for prefix_index, prefix in enumerate(IMAGE_PREFIXES):
            if value.startswith(prefix):
                dictionaries['image'][i] = '~' + str(prefix_index) + ':' + value[len(prefix):]; break
    return {'schemaVersion': 1, 'version': version, 'format': FORMAT, 'fields': fields,
            'defaults': defaults, 'references': references, 'dictionaries': dictionaries,
            'imagePrefixes': IMAGE_PREFIXES, 'rows': rows}


def unpack(payload):
    result = []
    for row in payload['rows']:
        card = dict(payload['defaults'])
        for i, field in enumerate(payload['fields']):
            value = row[i] if i < len(row) else None
            if value is None:
                if field == 'image':
                    card[field] = None
                elif field not in payload['defaults']:
                    continue
                continue
            if field in payload.get('references', {}) and value == -1:
                value = card[payload['references'][field]]
            elif field in payload['dictionaries'] and isinstance(value, int):
                value = payload['dictionaries'][field][value]
            if field == 'image' and isinstance(value, str) and re.match(r'^~\d+:', value):
                prefix, suffix = value[1:].split(':', 1)
                value = payload['imagePrefixes'][int(prefix)] + suffix
            card[field] = value
        result.append(card)
    return result


def pack_join_evidence(evidence):
    if evidence.get('format') == 'packed-join-v1':
        return evidence
    fields = ['sourceId', 'canonicalId', 'artistIds', 'sourceUrl', 'checksRef']
    artist_groups = list(dict.fromkeys(tuple(row['artistIds']) for row in evidence['joins']))
    check_ids = list(evidence['checks'])
    rows = [[row['sourceId'], row['canonicalId'], artist_groups.index(tuple(row['artistIds'])),
             row['sourceUrl'], check_ids.index(row['checksRef'])] for row in evidence['joins']]
    restored = [dict(zip(fields, [row[0], row[1], list(artist_groups[row[2]]), row[3], check_ids[row[4]]])) for row in rows]
    if restored != evidence['joins']:
        raise ValueError('Identity evidence roundtrip failed')
    return {key: value for key, value in evidence.items() if key != 'joins'} | {
        'format': 'packed-join-v1', 'fields': fields, 'artistGroups': artist_groups, 'checkIds': check_ids, 'rows': rows}


def finish_allowlists(args):
    """Resume only generated key files after a disk interruption, without rewriting card shards."""
    out = args.output.resolve()
    catalog = load(out / 'catalog.json')
    cards, shard_hashes, counts = {}, {}, {}
    for label, url in catalog['shards'].items():
        payload = load(out / 'cards' / (label + '.json'))
        if payload['version'] != catalog['version']:
            raise ValueError('Cannot resume mixed catalogue/card shard versions: ' + label)
        decoded = unpack(payload)
        counts[label] = len(decoded)
        shard_hashes[label] = hashlib.sha256(json.dumps(decoded, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        for card in decoded:
            if card['id'] in cards or key(card['game'], card['language'], card['sourceKey']) != card['id']:
                raise ValueError('Duplicate or invalid immutable card identity')
            cards[card['id']] = card
    evidence_path = out / 'sources/identity-joins.json'
    evidence = load(evidence_path)
    packed_evidence = pack_join_evidence(evidence)
    if packed_evidence != evidence:
        dump(evidence_path, packed_evidence)
    registries = {digit: {} for digit in '0123456789abcdef'}
    for card in cards.values():
        record = {field: card[field] for field in ['game', 'language', 'sourceKey', 'marketVerified']}
        for flag in ('marketVerified', 'sourceOnly', 'characterDiscoveryVerified'):
            value = card.get(flag, False)
            if not isinstance(value, bool):
                raise ValueError('Non-boolean registry flag: ' + flag)
            record[flag] = value
        for field in ('marketId', 'canonicalId', 'retired'):
            if card.get(field):
                record[field] = card[field]
        registries[card['id'][4]][card['id']] = record
    for digit, records in registries.items():
        path = out / 'keys' / (digit + '.json')
        expected = {'version': catalog['version'], 'cards': records}
        if path.exists() and load(path) == expected:
            continue
        dump(path, expected)
    artist_ok = all(identity in cards and artist['id'] in cards[identity]['artistIds'] for artist in catalog['artists'] for identity in artist['cardIds'])
    character_ok = all(identity in cards and (not cards[identity].get('sourceOnly') or cards[identity].get('characterDiscoveryVerified') is True) and char['id'] in cards[identity]['characterIds']
                       for char in catalog['characters'] for identity in char['cardIds'])
    featured_ok = all(next(artist for artist in catalog['artists'] if artist['id'] == featured)['coverCardId'] in
                      next(artist for artist in catalog['artists'] if artist['id'] == featured)['cardIds']
                      for featured in catalog['featuredArtists'])
    if not all([artist_ok, character_ok, featured_ok]):
        raise ValueError('Resumed catalogue membership validation failed')
    validation = {'version': catalog['version'], 'registryCards': len(cards),
                  'baselineExpected': catalog['coverage']['baselineCards'], 'baselineActual': catalog['coverage']['baselineCards'],
                  'roundtrips': counts, 'canonicalCardHashByShard': shard_hashes,
                  'allArtistMembershipKeysValid': artist_ok, 'allCharacterMembershipKeysValid': character_ok,
                  'allFeaturedArtistsHaveVerifiedCover': featured_ok, 'allRegistryIdsValid': True,
                  'resumedAfterDiskInterruption': True,
                  'outputBytes': sum(path.stat().st_size for path in out.rglob('*.json'))}
    dump(out / 'build-validation.json', validation)
    write_manifest(out, catalog, cards)
    print(json.dumps(validation, ensure_ascii=True))



def apply_official_supplements(evidence, supplements):
    if supplements.get('schemaVersion') != 1:
        raise ValueError('Invalid official collection supplement')
    rows = supplements.get('pokemonArtistCards', [])
    if len(rows) != 43 or len({row['officialId'] for row in rows}) != 43:
        raise ValueError('Expected 43 distinct official Shinji source references')
    groups = collections.Counter(row.get('candidateCardKey') for row in rows if row.get('candidateCardKey'))
    existing = {row.get('sourceCardId'): row for row in evidence['representatives'] if row['game'] == 'pokemon' and row.get('artist') == 'Shinji Kanda'}
    preferences = {}
    for row in rows:
        if row.get('creditIncludesExactShinjiKanda') is not True or 'Shinji Kanda' not in row.get('artistCredits', []):
            raise ValueError('Official illustrator credit missing')
        identity = row['officialId']
        representative = existing.get(identity)
        if not representative:
            representative = {'game':'pokemon', 'language':'ja', 'artist':'Shinji Kanda',
                'cardname':row['nameJa'], 'cardnameJa':row['nameJa'], 'setCode':row['setCode'],
                'number':row['number'], 'sourceCardId':identity, 'sourceUrl':row['sourceUrl'],
                'sourceImageUrl':row['sourceImage'], 'localId':row.get('candidateCardKey'),
                'representative':False, 'verification':'Official exact illustrator credit; printing mapping remains separately verified.'}
            evidence['representatives'].append(representative)
        representative['localCanonicalCandidateAllowed'] = row.get('localCandidateExists') is True and groups.get(row.get('candidateCardKey')) == 1
        number = row['number'].split('/')[0]
        if number.isdigit():
            preferences.setdefault((row['setCode'].upper(), int(number)), []).append('pokemon-official:ja:' + identity)
    return preferences


def write_manifest(out, catalog, cards):
    seen, checksums = set(), {}
    for digit in '0123456789abcdef':
        target = out / 'keys' / (digit + '.json')
        raw = target.read_bytes()
        shard = json.loads(raw)
        if shard['version'] != catalog['version']:
            raise ValueError('Registry version differs from catalogue')
        for identity, record in shard['cards'].items():
            if identity in seen or identity[4] != digit or identity not in cards:
                raise ValueError('Invalid registry identity')
            seen.add(identity)
            card = cards[identity]
            for field in ('game', 'language', 'sourceKey'):
                if record[field] != card[field]:
                    raise ValueError('Registry identity metadata differs')
            for field in ('marketVerified', 'sourceOnly', 'characterDiscoveryVerified'):
                if not isinstance(record.get(field), bool) or record[field] is not card.get(field, False):
                    raise ValueError('Registry boolean boundary differs: ' + field)
        checksums[digit] = hashlib.sha256(raw).hexdigest()
    if seen != set(cards) or len(cards) != catalog['coverage']['registryCards']:
        raise ValueError('Incomplete registry')
    dump(out / 'manifest.json', {'schemaVersion':1, 'version':catalog['version'],
        'readOnly':catalog.get('readOnly') is True, 'registryCards':len(cards),
        'registryShardSha256':checksums})


def build(args):
    repo, out = args.repo.resolve(), args.output.resolve()
    sources = args.sources_dir.resolve() if args.sources_dir else out / 'sources'
    if args.offline and any([args.research, args.demo, args.species]):
        raise ValueError('--offline reads checked-in sources only; omit external research/demo/species arguments')
    previous_cards = {}
    recovered_previous_files = []
    for path in sorted((out / 'cards').glob('*.json')):
        try:
            previous = load(path)
        except (json.JSONDecodeError, UnicodeError):
            if not args.recover_output:
                raise ValueError('Invalid previous generated shard; use --recover-output only when explicitly rebuilding an interrupted output: ' + str(path))
            recovered_previous_files.append(path.name)
            continue
        for card in (unpack(previous) if previous.get('format') == FORMAT else previous.get('cards', [])):
            previous_cards[card['id']] = card
    if args.research and args.demo and args.species:
        evidence = import_evidence(args.research, args.demo, args.species, sources / 'pokemon-extra-artist-cards.json')
        dump(sources / 'evidence.json', evidence)
    else:
        evidence = load(sources / 'evidence.json')
    supplements = load(sources / 'official-collection-supplements.json')
    official_goal_preferences = apply_official_supplements(evidence, supplements)
    verified_character_printings = {row['sourceKey']: row for row in supplements['characterPrintings']}
    taxonomy = load(sources / 'taxonomy.json')
    op_types = load(sources / 'onepiece-types.json')
    set_counts = load(sources / 'pokemon-set-counts.json')
    names = load(repo / 'data/japanese-card-names-ko.json')
    en_names = load(repo / 'data/english-card-names-ko.json')['names']
    by_number, aliases, mega_species, forms, families = prepare_taxonomy(evidence, taxonomy, names)
    classify = pokemon_classifier(aliases, mega_species, forms, names['owners'])
    artists = {row['id']: dict(row, cardIds=[], representative=None, coverCardId=None,
                             coverImage='', coverName='', coverLanguage='', cardCount=0,
                             verification='awaiting-card-evidence') for row in evidence['artists']}
    cards, shards = {}, collections.defaultdict(list)
    baseline_counts, expected_baseline_counts = collections.Counter(), collections.Counter()
    pending_artists = collections.Counter()
    def add(row, game, language, source_key, source_only=False):
        identity = key(game, language, source_key)
        if identity in cards:
            return cards[identity]
        original = str(row.get('nameOriginal') or row.get('name') or row.get('number') or source_key)
        card = {'id': identity, 'sourceKey': source_key, 'game': game, 'language': language,
                'name': str(row.get('nameKo') or row.get('name') or original), 'nameOriginal': original,
                'number': str(row.get('number') or ''), 'setCode': str(row.get('setCode') or row.get('boxCode') or ''),
                'image': row.get('image') or row.get('thumbnailUrl') or None,
                'artistIds': list(row.get('artistIds') or []), 'characterIds': [],
                'rarity': str(row.get('rarity') or ''), 'marketVerified': False, 'form': 'unclassified'}
        for field in ['sourceUrl', 'detailSourceUrl', 'imageStatus', 'variantLabel', 'sprite', 'printingStatus']:
            if row.get(field):
                if field == 'sourceUrl' and not source_only:
                    continue
                card[field] = row[field]
        if game == 'pokemon':
            card['characterIds'], card['form'] = classify(row.get('nameEn') or original)
        if source_only:
            card['sourceOnly'] = True
            card['artistCreditStatus'] = 'source-confirmed'
        else:
            card['artistCreditStatus'] = 'pending-evidence'
            pending_artists[game + '-' + language] += 1
        product = str(row.get('productId') or '')
        if not source_only and game == 'pokemon' and language == 'ja' and row.get('matchStatus') == 'matched' and re.fullmatch(r'\d+', product):
            card['marketId'], card['marketVerified'] = product, True
        cards[identity] = card
        shards[game + '-' + language].append(card)
        if not source_only:
            baseline_counts[game + '-' + language] += 1
        return card
    jp = load(repo / 'data/japanese-catalog.json')
    for row in jp['cards']:
        expected_baseline_counts['pokemon-ja'] += 1
        raw = dict(row)
        title = re.sub(r'\s+\([^()]*\)\s*$', '', row['name']).strip()
        raw['nameKo'] = names['names'].get(row['name']) or names['names'].get(title) or row['name']
        add(raw, 'pokemon', 'ja', row['id'])
    for language, directory in [('en', 'english-sets'), ('zh-CN', 'chinese-sets')]:
        for path in sorted((repo / 'data' / directory).glob('*.json')):
            for raw in load(path)['cards']:
                expected_baseline_counts['pokemon-' + language] += 1
                row = dict(raw)
                if language == 'en':
                    row['nameKo'] = en_names.get(row['name'], row['name'])
                source = row.get('id') or row['setCode'] + ':' + row['sourceId']
                add(row, 'pokemon', language, source)
    block = (repo / 'index.html').read_text(encoding='utf-8-sig').split('const CARDINFO = {', 1)[1].split('CARDINFO.pokemon.sort', 1)[0].split('onepiece: [', 1)[1]
    op_codes = re.findall(r'\{code:"([^"]+)"', block)
    for code in op_codes:
        for row in load(repo / 'data/cards-by-set' / (code + '.json'))['cards']:
            expected_baseline_counts['onepiece-ja'] += 1
            add(row, 'onepiece', 'ja', row['fullId'])
    for row in evidence['pokemonSourceCards']:
        provider = row['providerId']
        language, locale = row.get('language', 'ja'), row.get('locale', 'ja')
        record = dict(row, setCode=provider.rsplit('-', 1)[0], sourceUrl='https://api.tcgdex.net/v2/' + locale + '/cards/' + quote(provider, safe=''),
                      detailSourceUrl='https://api.tcgdex.net/v2/' + locale + '/cards/' + quote(provider, safe=''),
                      imageStatus='available' if row.get('image') else 'source-detail-required')
        if language == 'zh-CN':
            record['printingStatus'] = 'provider-locale-unverified'
        add(record, 'pokemon', language, 'tcgdex:' + language + ':' + provider, True)
    for row in evidence['onepieceSourceCards']:
        record = dict(row, number=row['printing'], setCode=row['printing'].split('-', 1)[0])
        add(record, 'onepiece', 'ja', 'limitless:ja:' + row['printing'], True)
    official_representative_targets = {}
    for row in evidence['representatives']:
        game, language = row['game'], row.get('language', 'ja')
        if game == 'pokemon':
            provider = row.get('providerCardId') or row['sourceCardId']
            variant = row.get('imageVariant', {}).get('variantId')
            source = ('pokemon-official:ja:' + row['sourceCardId']) if row['sourceUrl'].startswith('https://www.pokemon-card.com/') else 'tcgdex:' + language + ':' + provider
            if variant:
                source += ':variant:' + variant
        else:
            source = 'limitless:ja:' + row['localId']
        record = {'name': row.get('cardnameJa') or row.get('officialCardname') or row.get('sourceCardname') or row.get('cardnameEn') or row['cardname'],
                  'nameKo': row['cardname'], 'number': row.get('number') or row.get('setnumber', ''),
                  'setCode': row.get('setCode') or row.get('localId', '').split('-')[0],
                  'image': row['sourceImageUrl'], 'artistIds': [game + ':' + row['artist']],
                  'sourceUrl': row['sourceUrl'], 'variantLabel': row.get('variantLabelKo') or row.get('imageVariant', {}).get('label', '')}
        card = add(record, game, language, source, True)
        card.update(name=record['nameKo'], nameOriginal=record['name'], image=record['image'], sourceUrl=record['sourceUrl'])
        card['artistIds'] = sorted(set(card['artistIds'] + record['artistIds']))
        if record['variantLabel']:
            card['variantLabel'] = record['variantLabel']
        if game == 'pokemon' and language == 'en' and row.get('imageVariant', {}).get('variantId'):
            generic = cards.get(key(game, language, 'tcgdex:' + language + ':' + provider))
            if generic:
                generic['artistIds'] = [identity for identity in generic['artistIds'] if identity not in record['artistIds']]
                generic['artistGoalStatus'] = 'generic-variant-review-curated-example-present'
        if game == 'pokemon' and language == 'ja' and source.startswith('pokemon-official:ja:'):
            official_representative_targets[card['id']] = row.get('localId') if row.get('localCanonicalCandidateAllowed', True) is True else None
        if game == 'pokemon':
            card['characterIds'], card['form'] = classify(record['name'])
        artist = artists[game + ':' + row['artist']]
        if row.get('representative') or not artist['representative']:
            artist['representative'] = artist['coverCardId'] = card['id']
    if baseline_counts != expected_baseline_counts:
        raise ValueError('Baseline rows dropped or duplicated: expected ' + str(expected_baseline_counts) + ', got ' + str(baseline_counts))

    # Official printed references supersede a generic provider goal; identities are never merged here.
    for source in cards.values():
        if source['game'] == 'pokemon' and source['language'] == 'ja' and source['sourceKey'].startswith('tcgdex:ja:'):
            number = source['number'].split('/')[0]
            goals = official_goal_preferences.get((source['setCode'].upper(), int(number))) if number.isdigit() else None
            if goals and 'pokemon:Shinji Kanda' in source['artistIds']:
                source['sourceArtistIds'] = list(source['artistIds'])
                source['artistIds'] = [identity for identity in source['artistIds'] if identity != 'pokemon:Shinji Kanda']
                source['artistGoalStatus'] = 'covered-by-official-printing-snapshot'
                source['officialGoalSourceIds'] = goals

    # Strong metadata verification shares a canonical baseline identity, never an artist-name guess.
    official_counts = {row['id']: row['cardCount']['official'] for row in set_counts['sets']}
    jp_targets = collections.defaultdict(list)
    for original in jp['cards']:
        fraction = re.fullmatch(r'(\d+)/(\d+)', original.get('number', ''))
        if fraction and not original.get('unprintedNumber') and not original.get('variant'):
            jp_targets[(original['setCode'], int(fraction[1]), int(fraction[2]))].append(original)
    join_evidence, join_rejections, join_checks = [], collections.Counter(), {}
    for source in list(cards.values()):
        if not source.get('sourceOnly') or len(source['artistIds']) != 1:
            continue
        target, checks = None, []
        if source['id'] in official_representative_targets:
            target_source = official_representative_targets[source['id']]
            possible = cards.get(key('pokemon', 'ja', target_source)) if target_source else None
            fraction = re.fullmatch(r'(\d+)/(\d+)', source['number'])
            if (possible and fraction and possible['number'] == source['number'] and possible['setCode'] == source['setCode']
                    and official_counts.get(source['setCode']) == int(fraction[2])
                    and len(jp_targets.get((source['setCode'], int(fraction[1]), int(fraction[2])), [])) == 1
                    and source['characterIds'] and source['characterIds'] == possible['characterIds'] and source['form'] == possible['form']):
                target = possible
                checks = ['official-card-id-and-curated-full-fraction', 'game-language-set-exact',
                          'official-printed-fraction-exact', 'unique-local-printed-number', 'species-and-form-exact', 'single-source-credit']
        elif source['game'] == 'pokemon' and source['language'] == 'ja' and source['sourceKey'].startswith('tcgdex:ja:'):
            provider = source['sourceKey'].split(':', 2)[2]
            provider_set, provider_number = provider.rsplit('-', 1)
            official = official_counts.get(provider_set)
            if not official or not provider_number.isdigit():
                join_rejections['missing-official-full-fraction'] += 1; continue
            candidates = jp_targets.get((provider_set, int(provider_number), int(official)), [])
            if len(candidates) != 1:
                join_rejections['local-fraction-not-unique'] += 1; continue
            original = candidates[0]
            possible = cards[key('pokemon', 'ja', original['id'])]
            if not source['characterIds'] or source['characterIds'] != possible['characterIds'] or source['form'] != possible['form']:
                join_rejections['species-or-form-not-exact'] += 1; continue
            target = possible
            checks = ['game-language-set-exact', 'official-printed-fraction-exact', 'unique-local-printed-number',
                      'unprinted-and-explicit-variants-excluded', 'species-and-form-exact', 'single-source-credit']
        elif source['game'] == 'onepiece' and source['sourceKey'].startswith('limitless:ja:'):
            printing = source['sourceKey'].split(':', 2)[2]
            possible = cards.get(key('onepiece', 'ja', printing))
            type_record = op_types['types'].get(printing.split('_')[0])
            if not possible or not type_record or not type_record.get('official') or len(type_record.get('rarities', [])) != 1:
                join_rejections['op-printing-type-rarity-not-unambiguous'] += 1; continue
            image_name = urlparse(source['image'] or '').path.rsplit('/', 1)[-1]
            if image_name not in (printing + '_JP.webp', printing + '_JP.png', printing + '.png'):
                join_rejections['op-image-filename-not-exact'] += 1; continue
            target = possible
            checks = ['game-language-exact', 'full-printing-id-including-parallel-suffix-exact',
                      'official-card-type-and-single-rarity', 'exact-source-image-printing-filename', 'single-source-credit']
        if target:
            if target['artistIds'] and target['artistIds'] != source['artistIds']:
                join_rejections['conflicting-canonical-credit'] += 1; continue
            target['artistIds'] = list(source['artistIds'])
            target['artistCreditStatus'] = 'metadata-verified-printing'
            source['canonicalId'] = target['id']
            source['artistIds'] = []
            checks_id = ('pokemon-official-ja-v1' if source['id'] in official_representative_targets else
                         'pokemon-ja-v1' if source['game'] == 'pokemon' else 'onepiece-ja-v1')
            join_checks[checks_id] = checks
            join_evidence.append({'sourceId': source['id'], 'canonicalId': target['id'], 'artistIds': target['artistIds'],
                                  'sourceUrl': source.get('sourceUrl'), 'checksRef': checks_id})
            for artist in artists.values():
                if artist['coverCardId'] == source['id']:
                    artist['coverCardId'] = artist['representative'] = target['id']

    characters = {}
    for number, species in by_number.items():
        identity = 'pokemon:species:' + str(number)
        family = ['pokemon:species:' + str(member) for member in sorted(families[number])]
        characters[identity] = {'id': identity, 'game': 'pokemon', 'name': species['en'], 'ko': species['ko'],
                                'aliases': sorted({species['en'], species['ko'], species['ja']}), 'dexId': number,
                                'familyId': 'pokemon:family:' + str(min(families[number])),
                                'familyIds': family, 'evolutionIds': family,
                                'cardIds': [], 'megaCardIds': [], 'coverCardId': None, 'coverImage': '',
                                'coverName': '', 'coverLanguage': '', 'cardCount': 0,
                                'taxonomyStatus': 'verified-species-family', 'taxonomySource': taxonomy['sourceUrl']}
    # Canonical aliases are deliberately narrow; other exact titles remain visibly unclassified.
    op_known = {
        'luffy': ('몽키 D. 루피', 'Monkey D. Luffy', ['モンキー・D・ルフィ', 'ルフィ', '루피']),
        'zoro': ('롤로노아 조로', 'Roronoa Zoro', ['ロロノア・ゾロ', '조로']),
        'nami': ('나미', 'Nami', ['ナミ']), 'sanji': ('상디', 'Sanji', ['サンジ']),
        'usopp': ('우솝', 'Usopp', ['ウソップ']), 'chopper': ('토니토니 쵸파', 'Tony Tony Chopper', ['トニートニー・チョッパー', '쵸파']),
        'robin': ('니코 로빈', 'Nico Robin', ['ニコ・ロビン', '로빈']), 'franky': ('프랑키', 'Franky', ['フランキー']),
        'brook': ('브룩', 'Brook', ['ブルック']), 'jinbe': ('징베', 'Jinbe', ['ジンベエ']),
        'law': ('트라팔가 로', 'Trafalgar Law', ['トラファルガー・ロー', '로우']),
        'ace': ('포트거스 D. 에이스', 'Portgas D. Ace', ['ポートガス・D・エース', '에이스']),
        'shanks': ('샹크스', 'Shanks', ['シャンクス']), 'sabo': ('사보', 'Sabo', ['サボ']),
    }
    op_aliases = {}
    for slug, (ko, english, labels) in op_known.items():
        identity = 'onepiece:character:' + slug
        characters[identity] = {'id': identity, 'game': 'onepiece', 'name': english, 'ko': ko,
                                'aliases': sorted(set([ko, english] + labels)), 'familyIds': [identity],
                                'evolutionIds': [identity], 'cardIds': [], 'megaCardIds': [], 'cardCount': 0,
                                'coverCardId': None, 'coverImage': '', 'coverName': '', 'coverLanguage': '',
                                'taxonomyStatus': 'exact-reviewed-aliases'}
        for label in [ko, english] + labels:
            op_aliases[norm(label)] = identity
    op_type_counts = collections.Counter()
    op_type_review = []
    op_printing_metadata = {}
    source_character_candidates = collections.Counter()
    for card in cards.values():
        if card['game'] == 'onepiece':
            printing = card['sourceKey'].split(':')[-1].split('_')[0]
            type_record = op_types['types'].get(printing)
            if type_record:
                card['cardType'] = type_record['type']
                if len(type_record.get('rarities', [])) == 1:
                    card['rarity'] = type_record['rarities'][0]
                if not card.get('sourceOnly'):
                    op_type_counts[type_record['type']] += 1
                    op_printing_metadata[card['sourceKey']] = {'type': type_record['type'],
                        'rarity': card['rarity'], 'rarityStatus': 'official-unambiguous' if card['rarity'] else 'parallel-rarity-needs-exact-evidence'}
            else:
                card['cardType'] = 'Unknown'
                if not card.get('sourceOnly'):
                    op_type_review.append(card['sourceKey'])
            verified = verified_character_printings.get(card['sourceKey'])
            if verified and card.get('sourceOnly') is True:
                if (card['nameOriginal'] != verified['nameOriginal'] or card.get('image') != verified['sourceImageUrl']
                        or verified['artistId'] not in card['artistIds'] or verified['cardType'] != 'Character'):
                    raise ValueError('Official character supplement identity mismatch')
                card['characterDiscoveryVerified'] = True
                card['cardType'] = verified['cardType']
            if card['cardType'] not in ('Character', 'Leader'):
                card['characterIds'] = []
                card['form'] = 'base'
            else:
                title = card['nameOriginal']
                identity = op_aliases.get(norm(title))
                if not identity:
                    identity = 'onepiece:title:' + hashlib.sha256(title.encode()).hexdigest()[:16]
                    characters.setdefault(identity, {'id': identity, 'game': 'onepiece', 'name': title, 'ko': '',
                                                      'aliases': [title], 'familyIds': [identity], 'evolutionIds': [identity],
                                                      'cardIds': [], 'megaCardIds': [], 'cardCount': 0,
                                                      'coverCardId': None, 'coverImage': '', 'coverName': '', 'coverLanguage': '',
                                                      'taxonomyStatus': 'verified-character-type-exact-name'})
                card['characterIds'] = [identity]
                card['form'] = 'base'
        for artist_id in card['artistIds']:
            if artist_id not in artists:
                raise ValueError('Missing artist ' + artist_id)
            artists[artist_id]['cardIds'].append(card['id'])
        for character_id in card['characterIds']:
            if card.get('sourceOnly') and card.get('characterDiscoveryVerified') is not True:
                source_character_candidates[character_id] += 1
                continue
            character = characters[character_id]
            character['cardIds'].append(card['id'])
            if card['form'] == 'mega':
                character['megaCardIds'].append(card['id'])
    # Search aliases attach only to an exact complete Japanese character name; they never merge identities.
    alias_source = load(repo / 'data/search-aliases.json')
    jp_character_names = {norm(row['name']): row for row in characters.values() if row['game'] == 'onepiece'}
    for alias, labels in alias_source.items():
        if alias.startswith('_') or not isinstance(labels, list):
            continue
        matches = {jp_character_names[norm(label)]['id'] for label in labels if norm(label) in jp_character_names}
        if len(matches) != 1:
            continue
        entity = characters[next(iter(matches))]
        entity['aliases'] = sorted(set(entity['aliases'] + [alias] + labels))
        if not entity['ko'] and re.fullmatch(r'[가-힣 ·.D]+', alias):
            entity['ko'] = alias
    for alias_record in supplements.get('characterAliases', []):
        matches = [char for char in characters.values() if char['game'] == alias_record['game'] and char['name'] == alias_record['nameOriginal']]
        if len(matches) != 1:
            raise ValueError('Supplemental exact character alias target is not unique')
        character = matches[0]
        character['ko'] = alias_record['ko']
        character['aliases'] = sorted(set(character['aliases'] + alias_record['aliases']))
        character['aliasSourceUrl'] = alias_record['sourceUrl']
    for override in supplements.get('imageOverrides', []):
        source = cards.get(key(override['game'], override['language'], override['sourceKey']))
        if not source or source.get('image') != override['sourceImageUrl']:
            raise ValueError('Verified image source changed')
        image_path = repo / override['path'].lstrip('/')
        if hashlib.sha256(image_path.read_bytes()).hexdigest() != override['sha256']:
            raise ValueError('Verified local image bytes changed')
        for image_card in [source, cards[source['canonicalId']]] if source.get('canonicalId') else [source]:
            image_card['imageSourceUrl'] = override['sourceImageUrl']
            image_card['image'] = override['path']
    for preference in supplements.get('characterCovers', []):
        identity = key(preference['game'], preference['language'], preference['sourceKey'])
        character = characters[preference['entityId']]
        if identity not in character['cardIds']:
            raise ValueError('Preferred character cover is not a verified target')
        character['coverCardId'] = identity
    for entity in list(artists.values()) + list(characters.values()):
        entity['cardIds'] = sorted(set(entity['cardIds']))
        entity['cardCount'] = len(entity['cardIds'])
        entity['sourceOnlyCardCount'] = sum(bool(cards[identity].get('sourceOnly')) for identity in entity['cardIds'])
        entity['metadataVerifiedCardCount'] = sum(cards[identity].get('artistCreditStatus') == 'metadata-verified-printing' for identity in entity['cardIds'])
        entity['pendingImageCount'] = sum(not cards[identity].get('image') for identity in entity['cardIds'])
        if not entity.get('coverCardId') and entity['cardIds']:
            candidates = [cards[identity] for identity in entity['cardIds'] if cards[identity].get('image')]
            candidates.sort(key=lambda card: (card['language'] != 'ja', card.get('sourceOnly', False), card['form'] == 'mega', card['id']))
            if candidates:
                entity['coverCardId'] = candidates[0]['id']
        if entity.get('coverCardId'):
            cover = cards[entity['coverCardId']]
            entity['coverImage'], entity['coverName'], entity['coverLanguage'] = cover['image'], cover['name'], cover['language']
            if 'representative' in entity and not entity['representative']:
                entity['representative'] = cover['id']
            entity['coverCard'] = {field: cover[field] for field in ('id', 'name', 'image', 'game', 'language')}
            if cover.get('sprite'):
                entity['coverCard']['sprite'] = cover['sprite']
                entity['coverSprite'] = cover['sprite']
        entity['shardKeys'] = sorted({cards[identity]['game'] + '-' + cards[identity]['language'] for identity in entity['cardIds']})
        if 'taxonomyStatus' in entity:
            entity['sourceCandidateCount'] = source_character_candidates[entity['id']]
        if 'verification' in entity and entity['cardIds']:
            entity['verification'] = 'source-confirmed'
    retired_count = 0
    for identity, previous in previous_cards.items():
        if identity in cards:
            continue
        previous.update(retired=True, artistIds=[], characterIds=[])
        cards[identity] = previous
        shards[previous['game'] + '-' + previous['language']].append(previous)
        retired_count += 1
    checksum = hashlib.sha256()
    for relative in ['evidence.json', 'taxonomy.json', 'onepiece-types.json', 'pokemon-set-counts.json', 'official-collection-supplements.json']:
        checksum.update((sources / relative).read_bytes())
    for card in cards.values():
        checksum.update(json.dumps(card, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode())
    version = '20261029-cp1-' + checksum.hexdigest()[:12]
    registry = {digit: {} for digit in '0123456789abcdef'}
    for card in cards.values():
        record = {field: card[field] for field in ['game', 'language', 'sourceKey', 'marketVerified']}
        for flag in ('marketVerified', 'sourceOnly', 'characterDiscoveryVerified'):
            value = card.get(flag, False)
            if not isinstance(value, bool):
                raise ValueError('Non-boolean registry flag: ' + flag)
            record[flag] = value
        if card.get('marketId'):
            record['marketId'] = card['marketId']
        for field in ('retired', 'canonicalId'):
            if card.get(field):
                record[field] = card[field]
        registry[card['id'][4]][card['id']] = record
    shard_urls, roundtrips, card_hashes = {}, {}, {}
    for label, rows in sorted(shards.items()):
        payload = packed(rows, rows[0]['game'], rows[0]['language'], version)
        decoded = unpack(payload)
        # Defaults are explicit in canonical rows; exact object equality detects codec loss.
        if decoded != rows:
            for index, (a, b) in enumerate(zip(decoded, rows)):
                if a != b:
                    raise ValueError('Packed roundtrip failed ' + label + ':' + str(index) + ' ' + str(set(a) ^ set(b)))
        dump(out / 'cards' / (label + '.json'), payload)
        shard_urls[label] = '/data/collections/cards/' + label + '.json'
        roundtrips[label] = len(rows)
        card_hashes[label] = hashlib.sha256(json.dumps(rows, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    coverage = {'baselineCards': sum(baseline_counts.values()), 'baselineByShard': dict(baseline_counts),
                'registryCards': len(cards), 'sourceEvidenceCards': sum(bool(card.get('sourceOnly')) for card in cards.values()),
                'retiredCardsRetained': retired_count,
                'interruptedOutputFilesRecovered': recovered_previous_files,
                'sourceImagesPending': sum(bool(card.get('sourceOnly')) and not card.get('image') for card in cards.values()),
                'confirmedMarketLinks': sum(card['marketVerified'] for card in cards.values()),
                'localArtistCreditsPendingByShard': dict(collections.Counter(card['game'] + '-' + card['language'] for card in cards.values()
                    if not card.get('sourceOnly') and not card['artistIds'])),
                'metadataVerifiedPrintingJoins': len(join_evidence),
                'metadataJoinRejections': dict(join_rejections),
                'metadataJoinVisualVerificationClaim': False,
                'artistLabels': len(artists), 'artistsWithSourceCards': sum(bool(row['cardIds']) for row in artists.values()),
                'pokemonSpecies': len(by_number), 'pokemonFamilyTaxonomySource': taxonomy['sourceUrl'],
                'pokemonTaxonomySourceSha': taxonomy['sourceSha'],
                'pokemonCardsCharacterMatched': sum(bool(card['characterIds']) for card in cards.values() if card['game'] == 'pokemon'),
                'onepieceTitleGroupsUnclassified': sum(row['taxonomyStatus'] == 'card-title-unclassified' for row in characters.values()),
                'onepieceBaselineTypes': dict(op_type_counts), 'onepieceTypeReviewKeys': op_type_review,
                'characterDiscoveryExcludesSourceOnly': False,
                'characterDiscoveryExcludesUnverifiedSourceOnly': True,
                'officialCharacterSupplements': sum(card.get('characterDiscoveryVerified') is True for card in cards.values()),
                'officialShinjiReferencesIncluded': len(supplements['pokemonArtistCards']),
                'sourceBuildMode': 'offline-cache-no-network',
                'sourceFreshnessPolicy': 'External illustrator/taxonomy evidence is a checked-in snapshot; builds do not refresh network sources or confirm missing credits.',
                'providerChinesePrintingRegionVerified': False,
                'limitations': evidence['limitations'] + ['One Piece Character/Leader types are verified by exact printed number. Event/Stage titles are excluded from character groups.',
                    'Unverified source-only candidates are excluded from character completion denominators; three official exact printings are explicitly admitted.',
                    'Collection source cards do not automatically match existing holdings or contribute asset value.',
                    'Some physical printings remain separate source/local identities pending visual verification.',
                    'Provider zh-cn may contain mixed scripts; locale alone does not verify mainland simplified-Chinese physical printing.']}
    catalog = {'schemaVersion': 1, 'version': version, 'idNamespace': str(NAMESPACE),
               'artists': list(artists.values()), 'characters': list(characters.values()),
               'featuredArtists': evidence['featuredArtists'],
               'featuredCharacters': ['pokemon:species:' + str(number) for number in (25, 6, 15, 212, 133, 151, 487)] +
                                     ['onepiece:character:' + slug for slug in ('luffy', 'zoro', 'nami', 'sanji')],
               'shards': shard_urls, 'coverage': coverage}
    audit_rows = []
    for row in supplements['pokemonArtistCards']:
        source = cards[key('pokemon', 'ja', 'pokemon-official:ja:' + row['officialId'])]
        target = cards[source.get('canonicalId') or source['id']]
        if 'pokemon:Shinji Kanda' not in target['artistIds'] or target['id'] not in artists['pokemon:Shinji Kanda']['cardIds']:
            raise ValueError('Official Shinji reference missing from artist targets: ' + row['officialId'])
        audit_rows.append({'officialId':row['officialId'], 'sourceUrl':row['sourceUrl'], 'sourceCardId':source['id'],
            'targetCardId':target['id'], 'status':'canonical-baseline' if not target.get('sourceOnly') else 'official-source',
            'canonicalMappingPending':target.get('sourceOnly') is True})
    dump(out / 'sources' / 'official-shinji-audit.json', {'schemaVersion':1, 'version':version,
        'officialReferences':43, 'included':len(audit_rows), 'duplicateOfficialReferences':0, 'missing':[],
        'distinctTargets':len({row['targetCardId'] for row in audit_rows}), 'rows':audit_rows})
    dump(out / 'catalog.json', catalog)
    dump(out / 'sources' / 'identity-joins.json', pack_join_evidence({'version': version, 'verification': 'metadata-verified-printing',
        'visualVerified': False, 'checks': join_checks, 'setCountSource': set_counts['sourceUrl'],
        'joins': join_evidence, 'rejections': dict(join_rejections)}))
    dump(out / 'sources' / 'onepiece-printing-metadata.json', {'version': version,
        'sources': op_types.get('officialSources', []), 'cards': op_printing_metadata})
    # Write the many small allowlists after replacing the larger catalogue;
    # this keeps atomic-replacement peak disk usage bounded on small volumes.
    for digit, rows in registry.items():
        dump(out / 'keys' / (digit + '.json'), {'version': version, 'cards': rows})
    validation = {'version': version, 'registryCards': len(cards), 'baselineExpected': sum(expected_baseline_counts.values()),
                  'baselineActual': sum(baseline_counts.values()), 'roundtrips': roundtrips,
                  'canonicalCardHashByShard': card_hashes,
                  'allArtistMembershipKeysValid': all(identity in cards for artist in artists.values() for identity in artist['cardIds']),
                  'allCharacterMembershipKeysValid': all(identity in cards for char in characters.values() for identity in char['cardIds']),
                  'allFeaturedArtistsHaveVerifiedCover': all(artists[identity].get('coverImage') for identity in evidence['featuredArtists']),
                  'allRegistryIdsValid': all(re.fullmatch(r'cp1_[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', identity) for identity in cards),
                  'pokemonClassifierChecks': {title: classify(title) for title in ['Beedrill V', 'M Beedrill-EX', 'メガスピアーex', 'Scizor ex', 'Mewtwo', 'Mewtwo & Mew-GX', 'Beedrill Spirit Link', 'Pikachu Records']}}
    validation['outputBytes'] = sum(path.stat().st_size for path in out.rglob('*.json'))
    dump(out / 'build-validation.json', validation)
    write_manifest(out, catalog, cards)
    print(json.dumps(dict(validation, coverage=coverage), ensure_ascii=True))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repo', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, default=pathlib.Path('data/collections'))
    parser.add_argument('--sources-dir', type=pathlib.Path, help='Checked-in evidence cache; defaults to OUTPUT/sources')
    parser.add_argument('--offline', action='store_true', help='Use checked-in evidence only, without workstation imports or network calls')
    parser.add_argument('--recover-output', action='store_true', help='Rebuild explicitly interrupted JSON outputs; does not promise retention of unknown records in a corrupt prior shard')
    parser.add_argument('--finish-allowlists', action='store_true', help='Resume interrupted key allowlists from an already consistent catalogue and card-shard version')
    parser.add_argument('--research', type=pathlib.Path)
    parser.add_argument('--demo', type=pathlib.Path)
    parser.add_argument('--species', type=pathlib.Path)
    args = parser.parse_args()
    if args.finish_allowlists:
        finish_allowlists(args)
    else:
        build(args)


if __name__ == '__main__':
    main()
