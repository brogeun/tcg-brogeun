# Japanese Bandai official catalogue snapshots

These intermediate snapshots preserve manufacturer-published card printing membership. Market stock, market prices, and market card IDs do not determine which cards exist in a product. Collection uses public HTML GET parameters exposed by each official card-list form; it does not require authentication.

| Game | Official selector categories | Card printing rows | Count check |
| --- | ---: | ---: | --- |
| Union Arena | 119 | 11,169 | Each response's `検索結果 N 件` |
| Digimon | 78 | 7,502 | Independent official thumbnail anchors versus full card-detail blocks |
| Dragon Ball Fusion World | 27 | 3,230 | Each response's `検索結果 N 件` |

Counts include rows repeated in different official categories. They are not unique-card counts, physical pack sizes, or an estimate of market coverage. `complete` refers to the published membership of the captured selector categories. `validation.json` reports distinct image identities separately.

## Sources and request shapes

- Union Arena: `https://www.unionarena-tcg.com/jp/cardlist/?search=true&series=570101`. The `series` selector contains both products and broad promotional/merchandise categories. The visible paginator is client side: the response contains the full printing list. Exact printing identities use the complete official image filename and detail query, including `_p1`, `_p2`, and `_p3` suffixes. The printed `number` excludes only the parallel suffix; `sourceCardNo` preserves the original detail parameter.
- Digimon: `https://digimoncard.com/cards/?search=true&category=503041`. `/cardlist/` redirects to `/cards/`. Full details, rarity, image, native parallel ID, and per-printing acquisition text are embedded in each category response.
- Fusion World: `https://www.dbs-cardgame.com/fw/jp/cardlist/?search=true&category%5B%5D=584011`. Full printing lists appear in the response. Detail URLs preserve both `card_no` and `p`; the complete official image identity also preserves leader front-face suffixes.

Each snapshot has inventory and product response provenance: original/final URL, request method, timestamp, byte length, and SHA256. The local cache retains gzip-compressed original response bytes and paired metadata for reproducible parsing and hash checks. Raw caches need not be published with the snapshots.

## Broad categories and named special products

`isAggregate:true` prevents broad promotion/reward bins from being treated as a single booster box. UA categories `570901` (promotions) and `570801` (limited merchandise), DM `503901`–`503905`, and Fusion World `584901` are aggregates.

`derivedProducts` has explicitly derived IDs, never invented manufacturer IDs. It groups exact official per-printing acquisition captions while preserving `sourceCategoryIds`, source proofs, and every member printing. Counts use `official-acquisition-caption-partition` and are marked `independentlyDeclaredCount:false`.

- Digimon: 310 distinct acquisition-caption groups, including PB-22 (26 printings), PB-23 (13), and PB-17 (15). Identical captions appearing in multiple source categories are merged. Campaign/bonus groups have `isBonus:true` and must not replace a base booster just because the caption also mentions its code.
- Union Arena limited merchandise: 30 source rows partition into five exact named sets: Code Geass premium set (4), Jujutsu Kaisen premium set (4), HUNTER×HUNTER premium set (4), Idolmaster special supply set (13), and Iori Moe set (5). UA01PB/UA02PB/UA03PB codes are explicitly sourced from official card-number prefixes; generic UAPB action-point numbers remain unchanged.
- UA promotion and Fusion World promotion rows remain in their complete official aggregate bins unless their per-printing detail acquisition captions are explicitly collected. Aggregate membership is not evidence of membership in a particular promotional pack.

## Rarity and missing metadata

- Digimon uses literal rarity labels embedded in official card-detail blocks. Nine rows have an empty official rarity field: six tokens and three event printings. They remain null.
- Fusion World rarity is joined by exact official image identity from the seven official rarity-filter result lists. The 296 rows without a rarity classification are energy markers; the inspected official energy-marker detail also exposes no rarity. Null is retained.
- UA rarity and action-point type are joined by exact official image identity. This final handoff uses 498 of 708 planned franchise/rarity/type queries already captured from official sources; `rarityCoverageComplete:false` explicitly marks the remaining classification coverage. Unmatched rows retain null. The complete 119-category card membership is independent of this partial rarity enrichment. Literal filter values include `PcSR`, `PcR`, and `PcC`. These are search classifications and do not prove an exact parallel star tier. `rarityOrigin:official-detail` preserves an exact detail label such as `R★`; `rarityOrigin:official-filter` identifies a literal filter classification. `rarityFilter` remains separately available. No star tier is inferred from `_pN` suffixes.
- UA action-point rows may have no rarity classification. Those retain null and their official action-point type. Missing fields are not filled from a nearby market card.

## Reproduction

Run from this collector directory; supply absolute output/cache paths.

Requires Python 3 and `lxml`. Scripts can live in a repository's `scripts/` directory; output and cache directories are independent. A fresh cache directory captures a new official snapshot; an existing cache resumes the captured source responses without fetching them again.

```bash
python3 collect_bandai_official.py --output-dir data/official-card-contents --cache-dir /tmp/tcghub-bandai-cache
python3 enrich_union_arena.py --output-dir data/official-card-contents --cache-dir /tmp/tcghub-bandai-cache --workers 2
python3 enrich_union_arena_details.py --output-dir data/official-card-contents --cache-dir /tmp/tcghub-bandai-cache --categories 570801 --workers 2
python3 apply_union_arena_metadata.py --output-dir data/official-card-contents --cache-dir /tmp/tcghub-bandai-cache
python3 validate_bandai_official.py --output-dir data/official-card-contents --cache-dir /tmp/tcghub-bandai-cache
```

The handoff froze partial UA classification from `union_arena-rarities-final.json` using `apply_union_arena_metadata.py --index-file union_arena-rarities-final.json --allow-partial`. A normal full enrichment run uses the default index file and requires completion.

`--games union_arena digimon dragon_ball_fusion_world` limits the base collector; a subset is allowed. The base collector reads each manufacturer host sequentially, with at most three hosts in parallel. UA enrichers use two bounded readers by default and cap their optional `--workers` value at four. There is a short pause after successful network requests, at most one retry for transient/server failures, and no retry/access workaround for HTTP client errors. Every collector prints structured progress to stdout. Checkpoints and final snapshots are written atomically.

The validator checks selector counts, per-product source counts, missing identity fields, duplicated images within a product, official image hosts, derived-product provenance, and every available raw-response SHA256/length. Validation does not certify every physical foil edition the manufacturer may not separately list, future releases, physical pack collation, or marketplace correspondence.
