import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

SPEC = importlib.util.spec_from_file_location(
    "prepare_tcg_card_info_bundle",
    Path(__file__).resolve().parents[1] / "scripts/prepare_tcg_card_info_bundle.py",
)
bundler = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(bundler)

VIEWS = ("nikke", "weiss_schwarz", "union_arena",
         "dragon_ball_fusion_world", "yugioh", "digimon")


def encoded(value):
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def put(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(encoded(value))


def read(path):
    return json.loads(path.read_text(encoding="utf-8"))


def from_url(data_dir, url):
    if not url.startswith("/data/"):
        raise AssertionError("Unexpected fixture asset URL")
    return data_dir / url[len("/data/"):]


def tree_bytes(root):
    return {path.relative_to(root).as_posix(): path.read_bytes()
            for path in root.rglob("*") if path.is_file() and not path.is_symlink()}


def add_set(data_dir, game, index, filler=""):
    manifest_path = data_dir / "tcg-card-info.json"
    manifest = read(manifest_path)
    view = next(row for row in manifest["games"] if row["id"] == game)
    source_game = "weiss_schwarz" if game == "nikke" else game
    key = format(index, "016x")
    entry = {
        "id": key, "code": "NIK/S117", "name": "Fixture " + str(index),
        "sourceGame": source_game, "sourcePackTitle": 'Trial Deck "NIKKE"',
        "packageKind": "trial_deck", "language": "unknown",
        "image": "https://example.test/cover.webp", "coverType": "card",
        "coverProductId": str(index), "cardCount": 1,
        "file": "/data/tcg-card-info/" + game + "/" + key + ".json",
        "releasedAt": "2026-10-01T00:00:00Z",
        "coverage": "source-catalog-partial", "officialComplete": False,
    }
    card = {
        "id": str(index), "snkrdunkId": str(index), "catalogSource": "SNKRDUNK",
        "name": "Card " + str(index) + filler, "image": "https://example.test/card.webp",
        "fullCardNumber": "NIK/S117-T01R", "rarity": "RRR",
        "game": source_game, "language": "unknown", "variant": "parallel",
        "sourcePackTitle": 'Trial Deck "NIKKE"', "releasedAt": entry["releasedAt"],
        "snkrProduct": {"id": str(index), "name": "Original product", "brand": source_game,
                        "kind": "card", "language": "unknown", "fullCardNumber": "NIK/S117-T01R",
                        "setCode": "NIK/S117", "currency": "JPY", "minPrice": None,
                        "catalogAsk": {"amount": None, "currency": "JPY"},
                        "grades": {"raw": {"lowest_ask": None}, "psa10": {"lowest_ask": 12345}}},
    }
    payload = {
        "schemaVersion": 1, "game": game, "sourceGame": source_game,
        "set": copy.deepcopy(entry), "cards": [card],
        "generatedAt": "2026-10-29T00:00:00Z",
        "source": "SNKRDUNK catalog", "officialComplete": False,
    }
    view["sets"].append(entry)
    view["setCount"] = len(view["sets"])
    view["cardCount"] += 1
    put(from_url(data_dir, entry["file"]), payload)
    put(manifest_path, manifest)
    return copy.deepcopy(entry), copy.deepcopy(payload)


def fixture(base):
    data_dir = base / "_deploy" / "data"
    data_dir.mkdir(parents=True)
    manifest = {
        "schemaVersion": 1, "generatedAt": "2026-10-29T00:00:00Z",
        "source": "SNKRDUNK catalog", "officialComplete": False,
        "coverage": {},
        "games": [{"id": game, "label": game, "setCount": 0, "cardCount": 0,
                   "sets": [], "officialComplete": False} for game in VIEWS],
    }
    put(data_dir / "tcg-card-info.json", manifest)
    originals = {}
    for index, game in enumerate(VIEWS, 1):
        entry, payload = add_set(data_dir, game, index)
        originals[game] = (entry, payload)
    return data_dir, originals


def entries(data_dir):
    for game in read(data_dir / "tcg-card-info.json")["games"]:
        for entry in game["sets"]:
            yield game["id"], entry


def unpack_entry(data_dir, entry):
    wrapper = read(from_url(data_dir, entry["file"]))
    return wrapper, wrapper["sets"][entry["id"]]


class BundlePreparationTests(unittest.TestCase):
    def test_all_six_views_preserve_exact_original_payloads_and_price_semantics(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, originals = fixture(Path(temporary))
            before_manifest = read(data_dir / "tcg-card-info.json")
            result = bundler.prepare(data_dir)
            after_manifest = read(data_dir / "tcg-card-info.json")
            self.assertEqual(set(row["id"] for row in after_manifest["games"]), set(VIEWS))
            self.assertGreater(result["bundles"], 0)
            self.assertGreaterEqual(result["filesBefore"], result["filesAfter"])
            for game, entry in entries(data_dir):
                self.assertRegex(entry["file"], r"^/data/tcg-card-info/" + game + r"/public-[0-9]{4}\.json$")
                wrapper, payload = unpack_entry(data_dir, entry)
                self.assertEqual(wrapper["schemaVersion"], 1)
                self.assertEqual(wrapper["bundleVersion"], 1)
                self.assertEqual(wrapper["game"], game)
                self.assertEqual(payload, originals[game][1])
                original_entry = originals[game][0]
                self.assertEqual({k: v for k, v in entry.items() if k != "file"},
                                 {k: v for k, v in original_entry.items() if k != "file"})
            # Public manifest rewrites entry.file only; source metadata and counts survive.
            restored = copy.deepcopy(after_manifest)
            old_files = {entry["id"]: entry["file"]
                         for game in before_manifest["games"] for entry in game["sets"]}
            for game in restored["games"]:
                for entry in game["sets"]:
                    entry["file"] = old_files[entry["id"]]
            self.assertEqual(restored, before_manifest)

    def test_active_parts_keep_exact_bytes_and_original_set_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, originals = fixture(Path(temporary))
            entry, original = originals["weiss_schwarz"]
            part_url = entry["file"][:-5] + "-part02.json"
            part = copy.deepcopy(original)
            part["cards"][0]["id"] = "part-card"
            part["cards"][0]["snkrdunkId"] = "part-card"
            part["cards"][0]["snkrProduct"]["id"] = "part-card"
            first = copy.deepcopy(original)
            first["shards"] = [part_url]
            first["set"]["cardCount"] = 2
            part["set"]["cardCount"] = 2
            # Deliberately different whitespace proves the part was copied byte-for-byte.
            part_path = from_url(data_dir, part_url)
            part_path.write_text(json.dumps(part, ensure_ascii=False, indent=3) + "\n", encoding="utf-8")
            exact_bytes = part_path.read_bytes()
            put(from_url(data_dir, entry["file"]), first)
            manifest = read(data_dir / "tcg-card-info.json")
            ws = next(row for row in manifest["games"] if row["id"] == "weiss_schwarz")
            ws["sets"][0]["cardCount"] = 2
            ws["cardCount"] = 2
            put(data_dir / "tcg-card-info.json", manifest)
            result = bundler.prepare(data_dir)
            rewritten = next(e for game, e in entries(data_dir) if game == "weiss_schwarz")
            _, preserved = unpack_entry(data_dir, rewritten)
            self.assertEqual(preserved, first)
            self.assertEqual(preserved["shards"], [part_url])
            self.assertEqual(part_path.read_bytes(), exact_bytes)
            self.assertEqual(read(part_path)["set"]["id"], entry["id"])
            self.assertEqual(result["activeParts"], 1)

    def test_target_bundle_boundary_splits_sets_without_splitting_card_payloads(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, originals = fixture(Path(temporary))
            first_entry, first = originals["weiss_schwarz"]
            first["cards"][0]["name"] += "x" * 9000
            put(from_url(data_dir, first_entry["file"]), first)
            add_set(data_dir, "weiss_schwarz", 100, "y" * 9000)
            add_set(data_dir, "weiss_schwarz", 101, "z" * 9000)
            expected = {
                entry["id"]: read(from_url(data_dir, entry["file"]))
                for game, entry in entries(data_dir) if game == "weiss_schwarz"
            }
            bundler.prepare(data_dir, bundle_bytes=16384)
            ws_entries = [entry for game, entry in entries(data_dir) if game == "weiss_schwarz"]
            self.assertEqual(len(ws_entries), 3)
            self.assertEqual(len({entry["file"] for entry in ws_entries}), 3)
            for entry in ws_entries:
                path = from_url(data_dir, entry["file"])
                self.assertLessEqual(path.stat().st_size, 16384)
                self.assertEqual(unpack_entry(data_dir, entry)[1], expected[entry["id"]])

    def test_wrong_staging_path_is_rejected_without_mutation(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, _ = fixture(Path(temporary))
            before = tree_bytes(data_dir)
            wrong = data_dir.parent.parent / "production-data"
            wrong.mkdir()
            put(wrong / "tcg-card-info.json", read(data_dir / "tcg-card-info.json"))
            wrong_before = tree_bytes(wrong)
            with self.assertRaises(ValueError):
                bundler.prepare(wrong)
            self.assertEqual(tree_bytes(wrong), wrong_before)
            self.assertEqual(tree_bytes(data_dir), before)

    def test_symlinked_staging_data_is_rejected_without_touching_target(self):
        with tempfile.TemporaryDirectory() as temporary:
            base = Path(temporary)
            data_dir, _ = fixture(base / "real")
            linked_parent = base / "linked" / "_deploy"
            linked_parent.mkdir(parents=True)
            linked = linked_parent / "data"
            try:
                linked.symlink_to(data_dir, target_is_directory=True)
            except (OSError, NotImplementedError):
                self.skipTest("Directory symlinks unavailable on this runner")
            before = tree_bytes(data_dir)
            with self.assertRaises(ValueError):
                bundler.prepare(linked)
            self.assertEqual(tree_bytes(data_dir), before)

    def test_missing_referenced_base_retains_entire_previous_staging_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, originals = fixture(Path(temporary))
            from_url(data_dir, originals["digimon"][0]["file"]).unlink()
            before = tree_bytes(data_dir)
            with self.assertRaises(ValueError):
                bundler.prepare(data_dir)
            self.assertEqual(tree_bytes(data_dir), before)

    def test_missing_active_part_retains_entire_previous_staging_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, originals = fixture(Path(temporary))
            entry, first = originals["union_arena"]
            first["shards"] = [entry["file"][:-5] + "-part02.json"]
            put(from_url(data_dir, entry["file"]), first)
            before = tree_bytes(data_dir)
            with self.assertRaises(ValueError):
                bundler.prepare(data_dir)
            self.assertEqual(tree_bytes(data_dir), before)

    def test_wrong_part_set_identity_retains_entire_previous_staging_tree(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, originals = fixture(Path(temporary))
            entry, first = originals["union_arena"]
            part_url = entry["file"][:-5] + "-part02.json"
            first["shards"] = [part_url]
            bad = copy.deepcopy(first)
            bad.pop("shards", None)
            bad["set"]["id"] = "f" * 16
            put(from_url(data_dir, entry["file"]), first)
            put(from_url(data_dir, part_url), bad)
            before = tree_bytes(data_dir)
            with self.assertRaises(ValueError):
                bundler.prepare(data_dir)
            self.assertEqual(tree_bytes(data_dir), before)

    def test_oversized_single_payload_rejects_transaction_before_any_rewrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, originals = fixture(Path(temporary))
            entry, first = originals["yugioh"]
            first["cards"][0]["name"] = "x" * (4 * 1024 * 1024 + 1024)
            put(from_url(data_dir, entry["file"]), first)
            before = tree_bytes(data_dir)
            with self.assertRaises(ValueError):
                bundler.prepare(data_dir)
            self.assertEqual(tree_bytes(data_dir), before)

    def test_impossible_file_budget_rejects_transaction_before_any_rewrite(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, _ = fixture(Path(temporary))
            before = tree_bytes(data_dir)
            with self.assertRaises(ValueError):
                bundler.prepare(data_dir, max_files=1)
            self.assertEqual(tree_bytes(data_dir), before)

    def test_history_excluded_and_unrelated_assets_preserved(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, _ = fixture(Path(temporary))
            history = data_dir / "snkrdunk-history" / "123.json"
            put(history, {"history": [1, 2, 3]})
            unrelated = data_dir / "existing-app-asset.json"
            put(unrelated, {"keep": "unchanged"})
            unrelated_bytes = unrelated.read_bytes()
            # Obsolete hash asset is eligible for staging-only cleanup.
            obsolete = data_dir / "tcg-card-info" / "weiss_schwarz" / ("e" * 16 + ".json")
            put(obsolete, {"obsolete": True})
            result = bundler.prepare(data_dir)
            self.assertFalse(history.exists())
            self.assertGreaterEqual(result["historyFilesExcluded"], 1)
            self.assertEqual(unrelated.read_bytes(), unrelated_bytes)
            self.assertFalse(obsolete.exists())

    def test_missing_required_view_rejects_before_any_staging_change(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, _ = fixture(Path(temporary))
            manifest = read(data_dir / "tcg-card-info.json")
            manifest["games"] = [row for row in manifest["games"] if row["id"] != "digimon"]
            put(data_dir / "tcg-card-info.json", manifest)
            before = tree_bytes(data_dir)
            with self.assertRaises(ValueError):
                bundler.prepare(data_dir)
            self.assertEqual(tree_bytes(data_dir), before)

    def test_rerun_bundled_manifest_is_idempotent(self):
        with tempfile.TemporaryDirectory() as temporary:
            data_dir, _ = fixture(Path(temporary))
            bundler.prepare(data_dir)
            after_first = tree_bytes(data_dir)
            result = bundler.prepare(data_dir)
            self.assertEqual(tree_bytes(data_dir), after_first)
            self.assertGreater(result["bundles"], 0)
            for game, entry in entries(data_dir):
                wrapper, payload = unpack_entry(data_dir, entry)
                self.assertEqual(wrapper["game"], game)
                self.assertEqual(payload["set"]["id"], entry["id"])


if __name__ == "__main__":
    unittest.main()
