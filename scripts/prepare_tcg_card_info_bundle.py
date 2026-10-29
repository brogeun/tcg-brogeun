#!/usr/bin/env python3
"""Pack public card-info assets only in the explicit _deploy/data staging tree.

Git/source data keeps its original schema. Base payloads are wrapped unchanged,
active part bytes survive, and the unused public SNKR history cache is excluded.
"""
from __future__ import annotations
import argparse
import copy
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

GAMES = {"nikke", "weiss_schwarz", "union_arena", "dragon_ball_fusion_world", "yugioh", "digimon"}
TARGET_BYTES = 2 * 1024 * 1024
MAX_BYTES = 4 * 1024 * 1024
KEY = re.compile(r"[0-9a-f]{16}")
LEAF = re.compile(r"(?:[0-9a-f]{16}(?:-part[0-9]{2,6})?|public-[0-9]{4,6})\.json")


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def is_link(path):
    return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())


def guarded_data(value):
    path = Path(value).absolute()
    for component in (path, *path.parents):
        if is_link(component):
            raise ValueError("Symlinks are not allowed in staging paths")
    path = path.resolve(strict=True)
    if path.name != "data" or path.parent.name != "_deploy" or not path.is_dir():
        raise ValueError("--data-dir must be the existing _deploy/data staging directory")
    return path


def inventory(root):
    files = []
    for path in root.rglob("*"):
        if is_link(path):
            raise ValueError("Symlinks are not allowed in public staging: " + str(path))
        if path.is_file():
            files.append(path)
    return files


def asset_path(data, url, game):
    prefix = "/data/tcg-card-info/" + game + "/"
    if not isinstance(url, str) or not url.startswith(prefix):
        raise ValueError("Asset is outside its public game directory")
    leaf = url[len(prefix):]
    if not LEAF.fullmatch(leaf):
        raise ValueError("Unsafe card-info asset name")
    path = data / "tcg-card-info" / game / leaf
    if not path.is_file() or is_link(path):
        raise ValueError("Missing/unsafe card-info asset: " + url)
    if path.stat().st_size > MAX_BYTES:
        raise ValueError("Input asset exceeds 4MiB")
    return path


def wrapper(game, sets):
    return {"schemaVersion": 1, "bundleVersion": 1, "game": game, "sets": sets}


def remove_temporary(path, data):
    resolved = path.resolve()
    if resolved.parent != data or not resolved.name.startswith(".tcg-bundle-") or is_link(path):
        raise ValueError("Unsafe transaction cleanup path")
    shutil.rmtree(path)


def prepare(data_dir, max_files=20000, bundle_bytes=TARGET_BYTES):
    data = guarded_data(data_dir)
    if not 1 <= bundle_bytes <= MAX_BYTES or max_files < 1:
        raise ValueError("Invalid bundle/file budget")
    deployment = data.parent
    before_files = inventory(deployment)
    manifest_path = data / "tcg-card-info.json"
    original_manifest = manifest_path.read_bytes()
    manifest = json.loads(original_manifest)
    if manifest.get("schemaVersion") != 1 or not isinstance(manifest.get("games"), list):
        raise ValueError("Invalid card-info manifest")
    public_manifest = copy.deepcopy(manifest)
    catalog = data / "tcg-card-info"
    if not catalog.is_dir():
        # The earlier public-bundle step can already preserve these URLs in
        # route-backed packs. Validate that representation instead of packing
        # a second time or discarding its original-address compatibility.
        packed = data / "tcg-card-info-packs"
        if packed.is_dir():
            if len(before_files) > max_files:
                raise ValueError(f"Public staging contains {len(before_files)} files, over {max_files}")
            cache, parts, games = {}, set(), set()

            def payload(url, game, identity):
                prefix = "/data/tcg-card-info/" + game + "/"
                if not isinstance(url, str) or not url.startswith(prefix):
                    raise ValueError("Packed asset is outside its game directory")
                leaf = url[len(prefix):]
                if not re.fullmatch(identity + r"(?:-part[0-9]{2,6})?\.json", leaf):
                    raise ValueError("Packed asset belongs to another set")
                path = packed / game / (leaf[:2] + ".json")
                if path not in cache:
                    cache[path] = read(path)
                pack = cache[path]
                if pack.get("schemaVersion") != 1 or pack.get("game") != game:
                    raise ValueError("Packed asset game mismatch")
                body = pack.get("files", {}).get(leaf)
                if not isinstance(body, str):
                    raise ValueError("Missing packed set body")
                value = json.loads(body)
                if value.get("schemaVersion") != 1 or value.get("game") != game or value.get("set", {}).get("id") != identity or not isinstance(value.get("cards"), list):
                    raise ValueError("Packed set payload identity mismatch")
                return value

            for game_entry in public_manifest["games"]:
                game = game_entry.get("id")
                if game not in GAMES or game in games:
                    raise ValueError("Unknown/duplicate packed view game")
                games.add(game)
                seen = set()
                for entry in game_entry.get("sets", []):
                    identity = entry.get("id")
                    if not isinstance(identity, str) or not KEY.fullmatch(identity) or identity in seen:
                        raise ValueError("Invalid/duplicate packed set identity")
                    seen.add(identity)
                    first = payload(entry.get("file"), game, identity)
                    for url in first.get("shards", []):
                        payload(url, game, identity)
                        parts.add(url)
            if games != GAMES:
                raise ValueError("All six packed views are required")
            return {"filesBefore": len(before_files), "filesAfter": len(before_files), "maxFiles": max_files,
                    "bundles": len(cache), "activeParts": len(parts), "historyFilesExcluded": 0,
                    "largestBundleBytes": max((p.stat().st_size for p in cache), default=0),
                    "setCount": sum(len(game.get("sets", [])) for game in public_manifest["games"]),
                    "existingPackedRoutesPreserved": True}
        raise ValueError("Missing card-info directory")
    bundles, parts, seen_games = {}, {}, set()
    for game_entry in public_manifest["games"]:
        game = game_entry.get("id")
        if game not in GAMES or game in seen_games:
            raise ValueError("Unknown/duplicate view game")
        seen_games.add(game)
        batch, batch_entries, number, seen_ids = {}, [], 0, set()

        def flush():
            nonlocal batch, batch_entries, number
            if not batch:
                return
            leaf = "public-" + str(number).zfill(4) + ".json"
            payload = encoded(wrapper(game, batch))
            if len(payload) > MAX_BYTES:
                raise ValueError("A public bundle exceeds 4MiB")
            url = "/data/tcg-card-info/" + game + "/" + leaf
            bundles[Path(game) / leaf] = payload
            for entry in batch_entries:
                entry["file"] = url
            number += 1
            batch, batch_entries = {}, []

        for entry in game_entry.get("sets", []):
            identity = entry.get("id")
            if not isinstance(identity, str) or not KEY.fullmatch(identity) or identity in seen_ids:
                raise ValueError("Invalid/duplicate set identity")
            seen_ids.add(identity)
            payload = read(asset_path(data, entry.get("file"), game))
            if payload.get("bundleVersion") is not None:
                if payload.get("schemaVersion") != 1 or payload.get("bundleVersion") != 1 or payload.get("game") != game:
                    raise ValueError("Invalid existing public bundle")
                payload = payload.get("sets", {}).get(identity)
            if not isinstance(payload, dict) or payload.get("schemaVersion") != 1 or payload.get("game") != game or payload.get("set", {}).get("id") != identity or not isinstance(payload.get("cards"), list):
                raise ValueError("Base set payload identity mismatch")
            for url in payload.get("shards", []):
                part_path = asset_path(data, url, game)
                if not re.fullmatch(identity + r"-part[0-9]{2,6}\.json", part_path.name):
                    raise ValueError("Part belongs to another set")
                part_data = read(part_path)
                if part_data.get("game") != game or part_data.get("set", {}).get("id") != identity or not isinstance(part_data.get("cards"), list):
                    raise ValueError("Part payload identity mismatch")
                parts[part_path.relative_to(catalog)] = part_path.read_bytes()
            proposed = {**batch, identity: payload}
            if batch and len(encoded(wrapper(game, proposed))) > bundle_bytes:
                flush()
            batch[identity] = payload
            batch_entries.append(entry)
            if len(encoded(wrapper(game, batch))) > MAX_BYTES:
                raise ValueError("A single set exceeds the public bundle limit")
        flush()
    if seen_games != GAMES:
        raise ValueError('All six card-info views are required before public packing')
    candidates = {path for path in catalog.rglob("*.json")
                  if len(path.relative_to(catalog).parts) == 2
                  and path.parent.name in GAMES and LEAF.fullmatch(path.name)}
    history = data / "snkrdunk-history"
    if history.exists() and not history.is_dir():
        raise ValueError("Public history namespace must be a directory")
    history_files = inventory(history) if history.exists() else []
    predicted = len(before_files) - len(candidates) - len(history_files) + len(bundles) + len(parts)
    if predicted > max_files:
        raise ValueError(f"Public staging would contain {predicted} files, over {max_files}")
    # Every input, part and budget passed before staging is changed.
    work = Path(tempfile.mkdtemp(prefix=".tcg-bundle-", dir=data))
    replacement, backup, history_backup = work / "new", work / "old", work / "history"
    activated = moved_old = moved_history = False
    try:
        replacement.mkdir()
        for path in inventory(catalog):
            if path not in candidates:
                target = replacement / path.relative_to(catalog)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(path, target)
        for relative, contents in {**parts, **bundles}.items():
            target = replacement / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(contents)
        next_manifest = work / "manifest.json"
        next_manifest.write_bytes(encoded(public_manifest))
        os.replace(catalog, backup)
        moved_old = True
        os.replace(replacement, catalog)
        activated = True
        if history.exists():
            os.replace(history, history_backup)
            moved_history = True
        os.replace(next_manifest, manifest_path)
    except BaseException:
        if activated:
            os.replace(catalog, work / "failed-new")
        if moved_old:
            os.replace(backup, catalog)
        if moved_history:
            os.replace(history_backup, history)
        remove_temporary(work, data)
        raise
    remove_temporary(work, data)
    after = len(inventory(deployment))
    if after != predicted:
        raise RuntimeError(f"Unexpected staging file count: expected {predicted}, found {after}")
    return {"filesBefore": len(before_files), "filesAfter": after, "maxFiles": max_files,
            "bundles": len(bundles), "activeParts": len(parts), "historyFilesExcluded": len(history_files),
            "largestBundleBytes": max(map(len, bundles.values()), default=0),
            "setCount": sum(len(game.get("sets", [])) for game in public_manifest["games"])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--max-files", type=int, default=20000)
    args = parser.parse_args()
    print(json.dumps(prepare(args.data_dir, max_files=args.max_files)))


if __name__ == "__main__":
    main()

