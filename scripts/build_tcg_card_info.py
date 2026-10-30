#!/usr/bin/env python3
"""Build additional-game card information from registered SNKRDUNK products.

This is a source-catalog collection, not a verified official complete set list.
Offline only: no source HTTP requests or number-only price joins.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import unicodedata
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

GAMES = {"weiss_schwarz": "바이스슈발츠", "union_arena": "유니온아레나",
         "dragon_ball_fusion_world": "드래곤볼 퓨전월드", "yugioh": "유희왕", "digimon": "디지몬"}
VIEWS = {"nikke": "니케", **GAMES}
MAX_BYTES = 3_700_000
PRODUCT_KEYS = ("id", "name", "brand", "kind", "language", "productNumber",
                "url", "minPrice", "currency", "listingCount", "priceCheckedAt",
                "priceStatus", "catalogAsk", "priceSource", "grades", "gradeCheckedAt", "gradeStatus")
WRAPPERS = re.compile(r"^(?:WS-TCG-|UATCG-|DBSC-TCG-|DBSCG-|DBFW-|YGO-OCG-TCG-|YGO-OCG-|YGO-TCG-|DGCG-TCG-|DGCG-)", re.I)
SAFE_KEY = re.compile(r"^[0-9a-f]{16}(?:-part[0-9]{2,6})?$")


def normalized(value):
    return re.sub(r"\s+", " ", unicodedata.normalize("NFKC", str(value or ""))).strip()


def flat(value):
    return normalized(value).casefold()


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def atomic_write(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".json.tmp")
    temp.write_bytes(json_bytes(value))
    temp.replace(path)


def snapshot(root, game, kind):
    path = root / "data" / ("price-" + game + "-" + kind + ".json")
    source = read_json(path)
    if not isinstance(source, dict) or source.get("source") != "SNKRDUNK":
        raise ValueError("Unexpected catalog source: " + str(path))
    if source.get("brand") != game or source.get("kind") != kind:
        raise ValueError("Catalog game/kind mismatch: " + str(path))
    products = list(source.get("products") or [])
    declared = source.get("shards") or []
    if not isinstance(declared, list):
        raise ValueError("Invalid source shard list")
    for item in declared:
        url = item.get("file") or item.get("url") if isinstance(item, dict) else item
        if not isinstance(url, str) or not re.fullmatch(r"/data/snkrdunk-games/[A-Za-z0-9_-]+\.json", url):
            raise ValueError("Unsafe catalog shard path: " + str(url))
        shard = read_json(root / url.lstrip("/"))
        if isinstance(shard, dict):
            for key, expected in (("source", "SNKRDUNK"), ("brand", game), ("kind", kind)):
                if key in shard and shard[key] != expected:
                    raise ValueError("Source shard identity mismatch: " + url)
            shard = shard.get("products")
        if not isinstance(shard, list):
            raise ValueError("Invalid source shard: " + url)
        products.extend(shard)
    unique = {}
    for product in products:
        if not isinstance(product, dict) or product.get("id") in (None, ""):
            raise ValueError("Source product is missing an ID")
        identity = str(product["id"])
        if identity in unique and unique[identity] != product:
            raise ValueError("Conflicting source product ID: " + identity)
        unique[identity] = product
    expected = source.get("totalCount")
    if expected is not None and int(expected) != len(unique):
        raise ValueError("Source catalog count mismatch for " + game + "/" + kind)
    return list(unique.values()), source


def full_number(product, game):
    # The actual name bracket is authoritative for source identity. Raw WS code
    # can collapse T01/T01R and cannot replace the printed bracket.
    patterns = {
        "weiss_schwarz": r"[A-Za-z0-9+_.]+/[A-Za-z0-9+_.]+-[A-Za-z0-9]+(?:\s+[A-Za-z0-9]+)*",
        "union_arena": r"(?:UA|EX|PC)[A-Za-z0-9]*[/-][A-Za-z0-9][A-Za-z0-9/_-]*",
        "dragon_ball_fusion_world": r"(?:FB|FS|FP|SB|FBP)[0-9]{0,3}-[A-Za-z0-9]+",
        "yugioh": r"[A-Za-z0-9]+-[A-Za-z0-9]+",
        "digimon": r"(?:BT|EX|ST|LM|RB|P|AD|TS)[0-9]{0,3}-[A-Za-z0-9]+",
    }
    pattern = patterns[game]
    candidates = re.findall(r"\[([^\[\]]+)\]", str(product.get("name") or ""))
    candidates += [product.get(key) for key in ("fullCardNumber", "productNumber", "code")]
    for candidate in candidates:
        candidate = WRAPPERS.sub("", normalized(candidate))
        if re.fullmatch(pattern, candidate, re.I):
            return candidate
    return ""


def language(product, game, number):
    raw = flat(product.get("language"))
    japanese = {"ja", "jp", "jpn", "japanese", "日本語"}
    unknown = {"", "unknown", "und", "null"}
    if raw not in japanese | unknown:
        return None
    name = str(product.get("name") or "")
    if re.search(r"\b(?:English|Korean|Chinese|French|German|Italian|Spanish)\s*(?:Version|Edition|Ver\.?)\b", name, re.I):
        return None
    if re.search(r"(?:英語|韓国語|中国語|繁体字|簡体字)(?:版|バージョン)", name):
        return None
    if game == "yugioh" and re.search(r"-(?:EN|KR|SC|TC)[A-Z0-9]*$", number, re.I):
        return None
    if game == "weiss_schwarz" and re.search(r"/[A-Z0-9]+-E[0-9]", number, re.I):
        return None
    return "ja" if raw in japanese else "unknown"


def pack_context(product):
    name = str(product.get("name") or "")
    match = re.search(r"\]\s*\((.*)\)\s*$", name)
    return normalized(match.group(1)) if match else ""


def quoted_title(value):
    match = re.search(r'["「『“]([^"」』”]+)["」』”]', str(value or ""))
    return normalized(match.group(1)) if match else ""


def package_kind(value):
    value = flat(value)
    for kind, pattern in (
        ("trial_deck", r"trial\s*deck|トライアルデッキ"),
        ("starter_deck", r"starter\s*deck|スタートデッキ|スターターデッキ"),
        ("extra_booster", r"extra\s*booster|エクストラブースター"),
        ("premium_booster", r"premium\s*booster|プレミアムブースター"),
        ("booster_pack", r"booster\s*(?:pack)?|ブースターパック|ブースター"),
        ("premium_card_set", r"premium\s*card\s*set|プレミアムカードセット"),
        ("structure_deck", r"structure\s*deck|ストラクチャーデッキ"),
    ):
        if re.search(pattern, value):
            return kind
    return "unspecified"


def edition(value):
    value = flat(value)
    if re.search(r"second\s*edition|2nd\s*edition|第2版|再版", value):
        return "second"
    if re.search(r"first\s*edition|1st\s*edition|初版", value):
        return "first"
    return ""


def printed_set(game, number):
    core = normalized(number)
    if not core:
        return ""
    if game == "weiss_schwarz":
        return core.rsplit("-", 1)[0]
    if game == "union_arena":
        return re.split(r"[-/]", core, maxsplit=1)[0]
    return core.split("-", 1)[0]


def rarity(product):
    if product.get("rarity"):
        return str(product["rarity"])
    before = str(product.get("name") or "").split("[", 1)[0]
    matches = re.findall(r"(?<![A-Za-z0-9])(?:[0-9]+(?:th)?\s*SE|QCSE|PSE|P-SR|P-SEC|SSP|SEC|SCR|SP|SR|RRR|RR|LRR|PR|TD|UR|SE|OR|R|U|UC|C|L|N)(?:[★☆*]+)?(?![A-Za-z0-9])", before)
    return matches[-1] if matches else ""


def is_nikke(product):
    text = " ".join(str(product.get(key) or "") for key in ("name", "code", "productNumber"))
    return "nikke" in (product.get("ipTags") or []) or bool(re.search(r"NIKKE|(?:^|[-/])NIK(?:[-/]|$)|勝利の女神", text, re.I))


def box_cover(boxes, game, context, card_language):
    title, kind = quoted_title(context), package_kind(context)
    if not title or kind == "unspecified":
        return None
    matches = []
    for product in boxes:
        text = str(product.get("name") or "")
        if not re.search(r"(?:\bBox\b|ボックス|BOX)", text, re.I):
            continue  # Marketplace kind=box also contains loose packs.
        if language(product, game, full_number(product, game)) is None:
            continue
        if flat(quoted_title(text)) == flat(title) and package_kind(text) == kind and edition(text) == edition(context):
            if card_language == "ja" and flat(product.get("language") or "unknown") not in {"ja", "jp", "jpn", "japanese", "日本語", "unknown"}:
                continue
            matches.append(product)
    return matches[0] if len(matches) == 1 else None


def navigation_title(value):
    """Compare product titles, never printed numbers shared by later reprints."""
    value = normalized(value)
    value = re.sub(r'^(?:Weiss Schwarz|UNION\s*ARENA|DRAGON BALL SUPER CARD GAME FUSION WORLD|FUSION WORLD|DIGIMON CARD GAME|Yu-Gi-Oh!?(?: OCG)?(?: Duel Monsters)?)\s*', '', value, flags=re.I)
    value = value.strip('"「」『』“” ')
    value = re.sub(r'^(?:(?:Extra|Premium|Theme|Advanced|Reboot|Basic|Deck Build|Duelist|Expansion|Concept|Special|Limited)\s+)?(?:Booster(?:\s+Pack)?|Pack)\s*', '', value, flags=re.I)
    value = re.sub(r'\s*\bBox\b.*$', '', value, flags=re.I)
    value = re.sub(r'\s*(?:First Edition|Second Edition|1st Edition|2nd Edition|JP Edition|Japanese Version)\s*$', '', value, flags=re.I)
    value = value.strip('"「」『』“” ')
    key = ''.join(char for char in value.casefold() if char.isalnum())
    # Both spellings are used by the source for the same licensed title.
    key = key.replace('goddessofvictorynikke', 'nikke')
    return key


def series_title(value):
    value = normalized(value)
    value = re.sub(r'^(?:Weiss Schwarz|UNION ARENA)\s*', '', value, flags=re.I)
    value = re.sub(r'^(?:(?:Extra|Premium)\s+)?Booster(?:\s+Pack)?\s*', '', value, flags=re.I)
    value = re.sub(r'\s*\bBox\b.*$', '', value, flags=re.I).strip('"「」『』“” ')
    value = re.sub(r'\s*(?:First Edition|Second Edition|1st Edition|2nd Edition)\s*$', '', value, flags=re.I).strip('" ')
    aliases = (
        (r'BLEACH|ブリーチ', '블리치'), (r'NIKKE|勝利の女神', '니케'),
        (r'HUNTER.?HUNTER', '헌터×헌터'), (r'Jujutsu Kaisen|呪術廻戦', '주술회전'),
        (r'Demon Slayer|鬼滅', '귀멸의 칼날'), (r'Hololive|ホロライブ', '홀로라이브'),
        (r'Blue Archive|ブルーアーカイブ', '블루 아카이브'),
        (r'Frieren|葬送のフリーレン', '장송의 프리렌'),
        (r'Sword Art Online|ソードアート', '소드 아트 온라인'),
        (r'Chainsaw Man|チェンソーマン', '체인소 맨'), (r'My Hero Academia|僕のヒーロー', '나의 히어로 아카데미아'),
        (r'Code Geass|コードギアス', '코드 기어스'), (r'Haikyu|ハイキュー', '하이큐!!'),
        (r'Gintama|銀魂', '은혼'), (r'Attack on Titan|進撃の巨人', '진격의 거인'),
        (r'Oshi no Ko|推しの子', '최애의 아이'), (r'Bocchi|ぼっち', '봇치 더 록!'),
        (r'Puella Magi Madoka|魔法少女まどか', '마법소녀 마도카☆마기카'),
        (r'Re:ZERO|Re：ゼロ', '리제로'), (r'Jojo|ジョジョ', '죠죠의 기묘한 모험'),
        (r'Solo Leveling', '나 혼자만 레벨업'), (r'Kaiju No.?8|怪獣8', '괴수 8호'),
    )
    for pattern, label in aliases:
        if re.search(pattern, value, re.I):
            return label
    return re.sub(r'\s*[,：:]?\s*(?:Vol\.?\s*\d+|\d+(?:st|nd|rd|th) Anniversary).*$', '', value, flags=re.I).strip() or value


def navigation_boxes(sets, products, game):
    """Expose sealed boxes only and link exact source-pack memberships."""
    by_title = defaultdict(list)
    for entry in sets:
        if entry.get('sourceGame') != game:
            continue
        context = entry.get('sourcePackTitle') or ''
        if not context or re.search(r'promo|promotional|特典|プロモ', context, re.I):
            continue
        by_title[navigation_title(context)].append(entry)
    result, seen = [], set()
    for product in products:
        name = str(product.get('name') or '')
        # kind=box also includes single packs, cases and store bonus packs.
        if not re.search(r'\bBox\b|ボックス', name, re.I) or re.search(r'\bCase\b|\bBox Purchase Bonus\b|Bonus for Purchasing|\b(?:EN|English|Korean|Chinese)\b', name, re.I):
            continue
        if re.search(r'\bPack\s*$', name, re.I):
            continue
        if language(product, game, full_number(product, game)) is None:
            continue
        title = navigation_title(name)
        if not title:
            continue
        matches = [entry for entry in by_title.get(title, [])
                   if (not edition(entry['sourcePackTitle']) or edition(entry['sourcePackTitle']) == edition(name))]
        code = WRAPPERS.sub('', normalized(product.get('productNumber') or product.get('code')))
        if game == 'union_arena':
            code = printed_set(game, code)
            # Legacy marketplace labels include wrong deck/volume text. Match
            # their full printed BT set code, never later reprint contexts.
            known = {entry['id'] for entry in matches}
            matches += [entry for entry in sets if entry['id'] not in known and entry.get('sourceGame') == game
                        and entry['code'].casefold() == code.casefold()
                        and re.match(r'^UNION\s*ARENA\b', entry.get('sourcePackTitle') or '', re.I)
                        and not re.search(r'promo|selection|bonus', entry['sourcePackTitle'], re.I)]
            known = {entry['id'] for entry in matches}
            matches += [entry for entry in sets if entry['id'] not in known and entry.get('sourceGame') == game
                        and entry['code'].casefold() == code.casefold()
                        and navigation_title(entry.get('sourcePackTitle')) == re.sub(r'vol\d+$', '', title)
                        and re.match(r'^Booster Pack', entry.get('sourcePackTitle') or '', re.I)]
        # Multiple marketplace listings of one printing are one navigation box.
        identity = (title, edition(name))
        if identity in seen:
            continue
        seen.add(identity)
        label = series_title(name) if game in ('weiss_schwarz', 'union_arena') else GAMES[game]
        result.append({'id': 'BOX:' + str(product['id']), 'name': name, 'code': code,
                       'sourceGame': game, 'series': label, 'seriesId': flat(label),
                       'image': product.get('image') or product.get('thumbnailUrl') or '', 'coverType': 'box',
                       'releasedAt': product.get('releasedAt'), 'setIds': [entry['id'] for entry in matches],
                       'cardCount': sum(entry['cardCount'] for entry in matches), 'officialComplete': False})
    return sorted(result, key=lambda entry: (entry.get('releasedAt') or '', entry['name']), reverse=True)


def build(root):
    root = Path(root)
    views = {game: defaultdict(list) for game in VIEWS}
    descriptors, metadata, coverage = {}, {}, {}
    # Verify every input before writing anything, preserving last-good on source failures.
    inputs = {game: (snapshot(root, game, "card"), snapshot(root, game, "box")) for game in GAMES}
    for game, ((cards, source), (boxes, _)) in inputs.items():
        excluded = unknown_numbers = unknown_languages = 0
        for product in cards:
            number = full_number(product, game)
            lang = language(product, game, number)
            if lang is None:
                excluded += 1
                continue
            unknown_numbers += not bool(number)
            unknown_languages += lang == "unknown"
            context = pack_context(product)
            code = printed_set(game, number)
            group = (game, code, flat(context), package_kind(context), lang)
            identity = str(product["id"])
            row = {"id": identity, "snkrdunkId": identity, "catalogSource": "SNKRDUNK",
                   "name": product.get("name", ""), "image": product.get("image") or product.get("thumbnailUrl") or "",
                   "fullCardNumber": number, "rarity": rarity(product), "game": game, "language": lang,
                   "variant": product.get("variant") or "", "sourcePackTitle": context,
                   "releasedAt": product.get("releasedAt"),
                   "snkrProduct": {**{key: product[key] for key in PRODUCT_KEYS if key in product},
                                   "fullCardNumber": number, "setCode": code}}
            views[game][group].append(row)
            if game in ("weiss_schwarz", "union_arena") and is_nikke(product):
                views["nikke"][group].append(row)
            descriptors[group] = {"code": code,
                                  "name": context or (code + " 출처 등록 카드" if code else "세트 미확인 출처 등록 카드"),
                                  "sourceGame": game, "sourcePackTitle": context,
                                  "packageKind": package_kind(context), "language": lang}
        metadata[game] = (boxes, source)
        coverage[game] = {"sourceProducts": len(cards), "includedProducts": len(cards) - excluded,
                          "excludedForeignProducts": excluded,
                          "sourceListingComplete": bool(source.get("collection", {}).get("complete")),
                          "unknownNumberProducts": unknown_numbers, "unknownLanguageProducts": unknown_languages,
                          "officialComplete": False, "sourceAsOf": source.get("fetchedAt") or source.get("updatedAt")}
    generated = datetime.now(timezone.utc).isoformat()
    manifest = {"schemaVersion": 1, "generatedAt": generated, "source": "SNKRDUNK catalog",
                "coverage": coverage, "officialComplete": False, "games": [],
                "semantics": "Registered source products grouped by printed set and source pack title. Not verified complete official box contents."}
    outputs = []
    for view_game, groups in views.items():
        sets = []
        for group, cards in groups.items():
            cards.sort(key=lambda row: (row["fullCardNumber"], row["name"], row["id"]))
            key = hashlib.sha256(json.dumps([view_game, *group], ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()[:16]
            descriptor = descriptors[group]
            cover = box_cover(metadata[group[0]][0], group[0], descriptor["sourcePackTitle"], descriptor["language"])
            cover = cover or cards[0]
            image = cover.get("image") or cover.get("thumbnailUrl") or ""
            entry = {"id": key, **descriptor, "image": image, "coverType": "box" if cover.get("kind") == "box" else "card",
                     "coverProductId": str(cover.get("id", "")), "cardCount": len(cards),
                     "file": "/data/tcg-card-info/" + view_game + "/" + key + ".json",
                     "releasedAt": max((str(card.get("releasedAt") or "") for card in cards), default="") or None,
                     "coverage": "source-catalog-partial", "officialComplete": False}
            base = {"schemaVersion": 1, "game": view_game, "sourceGame": group[0], "set": entry,
                    "generatedAt": generated, "source": "SNKRDUNK catalog", "officialComplete": False}
            # Split only when needed. All files retain the same set.id.
            chunks, chunk, size = [], [], len(json_bytes({**base, "cards": []})) + 4096
            for card in cards:
                card_size = len(json_bytes(card)) + 1
                if chunk and size + card_size > MAX_BYTES:
                    chunks.append(chunk)
                    chunk, size = [], len(json_bytes({**base, "cards": []})) + 4096
                if size + card_size > MAX_BYTES:
                    raise ValueError("A single product exceeds the card-info asset budget")
                chunk.append(card)
                size += card_size
            chunks.append(chunk)
            parts = ["/data/tcg-card-info/" + view_game + "/" + key + "-part" + str(index).zfill(2) + ".json"
                     for index in range(2, len(chunks) + 1)]
            for index, chunk in enumerate(chunks):
                url = entry["file"] if index == 0 else parts[index - 1]
                payload = {**base, "cards": chunk}
                if index == 0 and parts:
                    payload["shards"] = parts
                if len(json_bytes(payload)) >= 4_000_000:
                    raise ValueError("Generated card-info asset exceeds 4MB")
                outputs.append((root / url.lstrip("/"), payload))
            sets.append(entry)
        sets.sort(key=lambda entry: (entry.get("releasedAt") or "", entry["name"], entry["id"]), reverse=True)
        manifest["games"].append({"id": view_game, "label": VIEWS[view_game], "cardCount": sum(s["cardCount"] for s in sets),
                                  "setCount": len(sets), "sets": sets, "officialComplete": False,
                                  "coverCounts": dict(Counter(s["coverType"] for s in sets))})
    for game in manifest['games']:
        sources = ('weiss_schwarz', 'union_arena') if game['id'] == 'nikke' else (game['id'],)
        boxes = [box for source_game in sources
                 for box in navigation_boxes(game['sets'], metadata[source_game][0], source_game)
                 if game['id'] != 'nikke' or is_nikke(box)]
        game['boxes'] = boxes
        game['boxCount'] = len(boxes)
    manifest['navigationVersion'] = 1
    if len(json_bytes(manifest)) >= 4_000_000:
        raise ValueError("Card-info manifest exceeds 4MB")
    # Keep obsolete files: publication preserves concurrent/last-good assets.
    for path, payload in reversed(outputs):
        atomic_write(path, payload)
    atomic_write(root / "data/tcg-card-info.json", manifest)
    return manifest


def validate(root):
    root = Path(root)
    errors, count = [], 0
    try:
        manifest = read_json(root / "data/tcg-card-info.json")
        if manifest.get("schemaVersion") != 1 or manifest.get("officialComplete") is not False:
            raise ValueError("Invalid manifest identity/coverage")
        seen_games = set()
        for game in manifest["games"]:
            view = game["id"]
            if view not in VIEWS or view in seen_games or game.get("officialComplete") is not False:
                raise ValueError("Invalid/duplicate view game")
            seen_games.add(view)
            seen_ids, game_count = set(), 0
            if game["setCount"] != len(game["sets"]):
                raise ValueError("View set count mismatch")
            for entry in game["sets"]:
                key, url = entry["id"], entry["file"]
                if not re.fullmatch(r"[0-9a-f]{16}", key) or url != "/data/tcg-card-info/" + view + "/" + key + ".json":
                    raise ValueError("Unsafe set path")
                if entry.get("officialComplete") is not False:
                    raise ValueError("Set incorrectly claims official completeness")
                first = read_json(root / url.lstrip("/"))
                urls = [url] + (first.get("shards") or [])
                set_count = 0
                for part_url in urls:
                    prefix = "/data/tcg-card-info/" + view + "/"
                    if not isinstance(part_url, str) or not part_url.startswith(prefix) or not part_url.endswith(".json"):
                        raise ValueError("Unsafe part path")
                    filename = part_url[len(prefix):-5]
                    if not SAFE_KEY.fullmatch(filename) or (filename != key and not filename.startswith(key + "-part")):
                        raise ValueError("Part does not belong to this set")
                    path = root / part_url.lstrip("/")
                    if path.stat().st_size >= 4_000_000:
                        raise ValueError("Oversized card-info file")
                    data = first if part_url == url else read_json(path)
                    if data.get("game") != view or data.get("set", {}).get("id") != key or data.get("officialComplete") is not False:
                        raise ValueError("Set/part identity mismatch")
                    if data.get("sourceGame") != entry["sourceGame"]:
                        raise ValueError("Set source game mismatch")
                    for card in data["cards"]:
                        identity = str(card["id"])
                        if identity in seen_ids or card["game"] != entry["sourceGame"] or card["game"] not in GAMES:
                            raise ValueError("Duplicate/wrong-game card")
                        if card["language"] not in ("ja", "unknown"):
                            raise ValueError("Foreign card in Japanese view")
                        if card.get("catalogSource") != "SNKRDUNK" or str(card.get("snkrdunkId")) != identity or str(card.get("snkrProduct", {}).get("id")) != identity:
                            raise ValueError("Source product identity mismatch")
                        if card["snkrProduct"].get("fullCardNumber") != card.get("fullCardNumber"):
                            raise ValueError("Source printed identity mismatch")
                        seen_ids.add(identity)
                        set_count += 1
                if set_count != entry["cardCount"]:
                    raise ValueError("Set card count mismatch")
                count += set_count
                game_count += set_count
            if game_count != game["cardCount"]:
                raise ValueError("View card count mismatch")
            if manifest.get('navigationVersion') == 1:
                boxes = game.get('boxes')
                if not isinstance(boxes, list) or game.get('boxCount') != len(boxes):
                    raise ValueError('Box navigation count mismatch')
                members = {entry['id']: entry for entry in game['sets']}
                box_ids = set()
                for box in boxes:
                    if not isinstance(box.get('id'), str) or not box['id'].startswith('BOX:') or box['id'] in box_ids or box.get('coverType') != 'box':
                        raise ValueError('Invalid/duplicate box identity')
                    box_ids.add(box['id'])
                    ids = box.get('setIds')
                    if not isinstance(ids, list) or len(ids) != len(set(ids)) or any(identity not in members for identity in ids):
                        raise ValueError('Invalid box members')
                    if any(members[identity]['sourceGame'] != box['sourceGame'] for identity in ids):
                        raise ValueError('Box mixes source games')
                    if box.get('cardCount') != sum(members[identity]['cardCount'] for identity in ids):
                        raise ValueError('Box card count mismatch')
        if seen_games != set(VIEWS):
            raise ValueError("Missing card-info view")
    except (ValueError, KeyError, TypeError, OSError, json.JSONDecodeError) as exc:
        errors.append(str(exc))
    return errors, count


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("."))
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    if not args.validate_only:
        manifest = build(args.root)
        print(json.dumps({game["id"]: {"sets": game["setCount"], "cards": game["cardCount"]} for game in manifest["games"]}))
    errors, count = validate(args.root)
    print(json.dumps({"validatedCardRowsIncludingNikkeView": count, "errors": errors, "errorCount": len(errors)}))
    return bool(errors)


if __name__ == "__main__":
    raise SystemExit(main())

