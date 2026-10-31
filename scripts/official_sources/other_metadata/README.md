# Fusion World / Digimon official metadata audit

This directory is isolated research output. Upstream repositories, collectors, caches, and published sites were not modified.

## Result

| Game | Official categories | Rows | Verified rarity | Rarity not applicable | Unavailable rarity | Verified native identifier |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Dragon Ball Fusion World | 27 | 3,230 | 2,934 | 296 | 0 | 3,230 |
| Digimon | 78 | 7,502 | 7,496 | 6 | 0 | 7,502 |

All 296 Fusion World previously blank rarity rows were fetched at their exact official detail URL, including each `p` variant parameter. Every response displays literal `ENERGY MARKER`, has no rarity element, and matches the exact snapshot image and displayed card number. They have `rarityStatus: not_applicable`, with `rarity: null` retained.

All nine Digimon previously blank rarity rows were matched to their exact embedded official HTML details. Five live category responses and all nine exact manufacturer images were also read. The six token images print no rarity; their official rules explicitly call them tokens. They have `rarityStatus: not_applicable`.

The three 2026 Season 1 event printings have incomplete rarity metadata in the official HTML, but the exact official images visibly print these rarities:

| Exact printing | Image literal rarity |
| --- | --- |
| BT18-092_P1 | U |
| BT21-098_P1 | C |
| BT21-060_P1 | U |

These three values were directly transcribed from the exact official images, not copied from base cards or inferred from suffixes. `image-observations.json` pins each observation to the downloaded image SHA-256. Images at their original resolution are in `image-review/`.

Every native identifier was confirmed from a literal official list/detail identifier. Token images do not physically print card numbers, while the manufacturer database explicitly assigns `BT24-TOKEN`, `BT23-TOKEN`, `BT22-TOKEN`, `ST22-TOKEN01`, `ST22-TOKEN02`, and `TOKEN` in its `cardNo` field. Those literal database identifiers remain verified, and the image observations separately record the absence of a printed physical number.

## Artifacts and reproduction

- `final-complete/dragon_ball_fusion_world.json` and `digimon.json`: full snapshots with original category/card membership, identity, and order preserved; no price/market fields.
- `final-complete/metadata-audit.json`: every formerly blank rarity row, exact matching image, literal type/rules evidence, official URLs, and response SHA-256.
- `final-complete/source-manifest.json`: 456 immutable raw manufacturer responses totaling 74,633,413 uncompressed bytes, including the original full inventories, all category responses, rarity filters, 296 new exact marker details, five live Digimon categories, and nine exact images.
- `cache/`: gzip-compressed original response bytes and per-response JSON metadata. Image responses use the same cache envelope as HTML; `contentType` and source URL identify them.
- `input/`: frozen original snapshots and their SHA-256 manifest.
- `image-observations.json`: explicit visual observations of exact official images, keyed by image hash.
- `final-complete/validation.json` and `independent-validation.json`: source hash, count, membership/order, literal identifier, and metadata coverage validation.

Offline rebuild and verification, from this directory:

```bash
python collect_other_metadata.py --build
python validate_other_metadata.py
```

To fill missing official cache entries, use `python collect_other_metadata.py --collect --workers 3 --build`. This collector uses three bounded persistent public read sessions, does not retry HTTP errors, and never works around 403, 404, 429, or security blocks. Dependencies: Python, `aiohttp`, and `lxml`.

`verified` means sufficient literal manufacturer evidence. `not_applicable` means an auxiliary item with explicit official token/energy-marker evidence and no manufacturer rarity. `unavailable` remains reserved for insufficient evidence or failed retrieval. Names, image suffixes, and source order never determine a rarity.
