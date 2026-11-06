# Registered box UI linkage repair, 2026-11-06

## Resume checkpoint

- Repository: `brogeun/tcg-brogeun`.
- Existing draft PR: https://github.com/brogeun/tcg-brogeun/pull/66
- Branch: `review/all-boxes-20261106`.
- Starting commit: `f0a8cc8ef13b603b10bd02871e56df0da55b5276`.
- Scope: complete the previously reviewed product-to-set links and regression coverage. No merge, deployment, PR approval, or live-price refresh was performed.

## Failure and repair

The PR's pricing integration job failed because product `66739` (`S10P`) lacked `CARDINFO.boxId`. The newly saved market products did not all reach the initial UI catalogue. Comparing every registered manual product found 11 missing Pokémon IDs and 38 One Piece starter/premium products absent from the initial catalogue.

The repair adds only those exact links. Existing Pokémon metadata stays intact. One Piece entries copy names, categories, original product images and inventory routing from the committed official manifest, and add the reviewed sealed-product IDs. The official manifest still supplies the current inventory counts during normal registration. Products without a recorded release date remain undated, matching the existing renderer; the screen test checks dates only where the source records one and still checks every product tile. Single-card prices, card artwork, inventories, source evidence, unresolved editions, existing snapshots and previous checkpoints are untouched.

The existing direct-mapping test now also calls the real UI functions in both directions, before any async manifest or price fetch. All 178 Pokémon and 60 One Piece registered products resolve to the correct localized name and exact price product with zero fallback requests. S10P and wrong-brand lookups have explicit regression checks.

## Local verification

All listed commands passed on Node v24.22.1 and Python 3.12.14; the PR workflow uses Node 22 and must be checked on the pushed commit separately.

- `node --test --test-concurrency=1 scripts/test_card_info_pricing_integration.cjs scripts/test_verify_card_info_prices.cjs` (15 tests).
- `node scripts/test_futuristic_market.mjs`.
- `node scripts/test_price_box_names.mjs` (238 direct products, zero fallback requests).
- `node --test --test-concurrency=1 scripts/test_onepiece_official.cjs scripts/test_catalogue_card_navigation.cjs scripts/test_japanese_set_artwork.cjs scripts/test_search_modal_catalog_rows.cjs scripts/test_app_route_integration.cjs` (39 tests).
- `node scripts/test_price_product_info.cjs` (2,934 card-to-set mappings checked).
- `node scripts/test_collections_release.mjs` (63 Node tests and embedded four-test Python check; 96,676 collection registry cards validated).
- `node scripts/test_ja_production_gate.cjs`.
- `node scripts/test_cardinfo_screen.mjs` (193 Pokémon and 60 One Piece initial tiles, dated/undated rendering, search and escaping).
- `node scripts/test_anniversary_sets.mjs`.
- `python -B -m unittest discover -s scripts -p test_refresh_registered_box_quotes.py` (7 tests).
- `python -B -m unittest discover -s scripts -p 'test_backfill_box_*.py'` (5 tests).
- `python -B -m unittest discover -s scripts -p test_publish_data_snapshot.py` (37 tests).
- Read-only `scripts/audit_all_boxes.py` run across all 1,481 registered groups; `git diff --check`.

The audit's existing unresolved categories remain: 12 Japanese Pokémon market-product identities, three nonstandard One Piece groups, English packaging coverage (253 groups, including 31 with no image), and source completeness/remote image verification limits. They were not replaced with inferred identities. No live or deployed behaviour was claimed as verified by this local run.

## Exact restored mappings

### pokemon

S10P → 66739, S10D → 66738, S8a → 14025, SMP2 → 15555, BSTXY → 14125, CP2 → 14126, CP4 → 20486, CP5 → 13958, CP6 → 86179, LL → 86000, DPt-MRP09 → 879241

### onepiece

PRB02 → 548907, ST36 → 847165, ST35 → 847164, ST34 → 847163, ST33 → 847162, ST32 → 847161, ST31 → 847160, ST28 → 549009, ST27 → 549008, ST26 → 549007, ST25 → 549006, ST24 → 549005, ST23 → 549004, ST21 → 407695, ST20 → 294198, ST19 → 294197, ST18 → 294196, ST17 → 294195, ST16 → 294194, ST15 → 294193, ST14 → 251268, ST13 → 234189, ST12 → 234190, ST11 → 234188, ST10 → 234187, ST09 → 234186, ST08 → 234185, ST07 → 234184, ST06 → 234183, ST05 → 234182, ST04 → 234181, ST03 → 234180, ST02 → 234179, ST01 → 234178, PRB01 → 216885, ST30 → 780928, ST29 → 742112, ST22 → 539677

