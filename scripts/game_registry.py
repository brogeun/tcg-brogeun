"""Explicit TCG identities for market data; unknown brands never become Pokemon."""
from __future__ import annotations

import re
import unicodedata

GAME_REGISTRY = {
    'pokemon': {'label': '포켓몬', 'source_brand': 'pokemon', 'aliases': ('포켓몬', 'pokémon', 'ポケモン')},
    'onepiece': {'label': '원피스', 'source_brand': 'onepiece', 'aliases': ('원피스', 'one-piece', 'one piece', 'ワンピース')},
    'weiss_schwarz': {'label': '바이스슈발츠', 'source_brand': 'weis-schwarz', 'aliases': ('바이스슈발츠', 'weiss', 'weiss-schwarz', 'weiss schwarz', 'weiß schwarz', 'weis-schwarz', 'ヴァイスシュヴァルツ')},
    'union_arena': {'label': '유니온아레나', 'source_brand': 'union-arena', 'aliases': ('유니온아레나', 'union-arena', 'union arena', 'ユニオンアリーナ')},
    'dragon_ball_fusion_world': {'label': '드래곤볼 퓨전월드', 'source_brand': 'dragon-ball-super-card-game', 'aliases': ('dragonball', 'dragon-ball-super-card-game', 'dragon-ball-fusion-world', 'fusion world', '드래곤볼 퓨전월드')},
    'yugioh': {'label': '유희왕', 'source_brand': 'yu-gi-oh', 'aliases': ('유희왕', 'yu-gi-oh', 'yu gi oh', '遊戯王')},
    'digimon': {'label': '디지몬', 'source_brand': 'digimoncard', 'aliases': ('디지몬', 'digimoncard', 'digimon-card', 'digimon card game', 'デジモン')},
}
LEGACY_GAMES = ('pokemon', 'onepiece')
ADDITIONAL_GAMES = tuple(key for key in GAME_REGISTRY if key not in LEGACY_GAMES)
RECOGNITION_GAME_IDS = {
    'pokemon': 'pokemon', 'onepiece': 'onepiece', 'weiss_schwarz': 'weiss',
    'union_arena': 'union-arena', 'dragon_ball_fusion_world': 'dragonball',
    'yugioh': 'yugioh', 'digimon': 'digimon',
}

def _flat(value):
    return re.sub(r'[\s_-]+', '', unicodedata.normalize('NFKC', str(value or '')).casefold())

def normalize_brand(value):
    """Resolve known canonical/source identifiers or names; never guess a default."""
    if isinstance(value, dict):
        for key in ('id', 'brandId', 'slug', 'name', 'displayName'):
            result = normalize_brand(value.get(key))
            if result:
                return result
        return None
    key = _flat(value)
    if not key:
        return None
    for brand, metadata in GAME_REGISTRY.items():
        if key in {_flat(x) for x in (brand, metadata['source_brand'], *metadata['aliases'])}:
            return brand
    return None

def select_brands(value=None, default=LEGACY_GAMES):
    if value is None or value == '':
        return list(default)
    values = value.split(',') if isinstance(value, str) else value
    if list(values) == ['all']:
        return list(GAME_REGISTRY)
    result = []
    for item in values:
        brand = normalize_brand(item)
        if not brand:
            raise ValueError('Unsupported brand: ' + str(item))
        if brand not in result:
            result.append(brand)
    if not result:
        raise ValueError('At least one explicit brand is required')
    return result

def infer_brand_from_product_number(value):
    code = str(value or '').upper()
    patterns = (
        ('pokemon', r'^(?:PKMN-TCG-|POKEMON-)'),
        ('onepiece', r'^(?:OP\d{1,3}-|ONEPIECE-|OP-TCG-)'),
        ('weiss_schwarz', r'^WS-TCG-'),
        ('union_arena', r'^(?:UATCG-|UA\d{1,3}(?:BT|ST)|PC\d{1,3}BT)'),
        ('dragon_ball_fusion_world', r'^(?:DBSC-TCG-)?(?:FB|FS|SB|FP)\d{1,3}(?:-|$)'),
        ('yugioh', r'^YGO-'),
        ('digimon', r'^DGCG-'),
    )
    for brand, pattern in patterns:
        if re.search(pattern, code):
            return brand
    return None

def product_in_scope(brand, item):
    """Keep distinct game systems separate even when a marketplace shares a brand."""
    if brand not in GAME_REGISTRY:
        return False
    name = str(item.get('name') or item.get('nameJa') or '')
    code = str(item.get('productNumber') or item.get('code') or '').upper()
    if brand == 'dragon_ball_fusion_world':
        return bool(re.search(r'^(?:DBSC-TCG-)?(?:FB|FS|SB|ST|FP)\d{1,3}(?:-|$)', code)
                    or re.search(r'FUSION\s*WORLD|フュージョンワールド', name, re.I))
    if brand == 'weiss_schwarz':
        return not bool(re.search(r'\bBLAU\b|ヴァイスシュヴァルツ\s*ブラウ', name, re.I)
                        or re.search(r'^(?:WSB-|WSBL-|CIKW)', code))
    return True

def ip_tags(item):
    text = ' '.join(str(item.get(key) or '') for key in ('name', 'nameJa', 'productNumber', 'code'))
    return ['nikke'] if re.search(r'NIKKE|(?:^|[-/])NIK(?:[-/]|$)|勝利の女神', text, re.I) else []

def price_filename(brand, kind):
    if brand not in GAME_REGISTRY or kind not in ('card', 'box'):
        raise ValueError('Explicit known game and card/box kind are required')
    return f'price-{brand}-{kind}.json'
