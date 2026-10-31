# KONAMI Japanese OCG intermediate source snapshot

`yugioh.json` is the integration snapshot. It contains official Japanese OCG
printing memberships for the reviewed marketplace box crosswalk. It does not
contain Rush Duel, English TCG product memberships, marketplace prices, or
numbers inferred from card order.

## Reproduce

Keep these files together: `collect_konami.py`, `expand_and_export.py`,
`requirements.txt`, `reviewed_box_mappings.json`, and
`manufacturer_code_crosswalk.json`. `products.json` is an optional cached
official index; without it, the collector fetches and parses the public index.
Raw caches and `deps/` are optional and should not be committed.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -u expand_and_export.py
```

The exporter resumes cached product/detail requests. It fetches only reviewed
product IDs, with at most six concurrent public GET requests and a shared
minimum 0.55-second interval between new request starts. Detail collection is
bounded to 250 unique CIDs. It never tries to defeat an access challenge.

To regenerate the integration snapshot from existing parsed data, without
network requests:

```sh
.venv/bin/python - <<'PY'
import expand_and_export as exporter
products = exporter.c.load_index()  # products.json must exist for offline use
exporter.export_snapshot(products, exporter.mappings(products), [])
PY
```

Do not run the offline command while a collector is writing parsed data.
The final integration snapshot is replaced atomically.

## Validated snapshot on 2026-10-31

| Measure | Count |
| --- | ---: |
| Official products in the full Japanese index | 1,530 |
| Existing marketplace boxes reviewed | 286 |
| Boxes mapped to published official products | 285 |
| Collected official component products | 297 |
| Products matching the official stated member total | 297 |
| Official card/artwork member rows | 19,172 |
| Explicit official rarity/artwork variants | 27,968 |
| Unique CIDs with official printing detail tables collected | 250 |
| Variant rows with exact source-verified printed numbers | 1,071 |
| Products with codes verified by official printed numbers | 281 |
| Additional products with official manufacturer page identifiers | 3 |

`validation_report.json` records these checks: expected product count, unique
product and printing IDs, every product's declared member total, provenance for
all verified numbers, Japanese OCG language/kind, native official image URLs,
and reviewed marketplace assignment. No collection errors remained.

## Data meanings and limits

The official product page's total is a count of card/artwork member rows. The
collector requires exactly that many parsed rows before `complete=true` and
`membershipComplete=true`. It expands only the rarity icons actually published
on each row. Thus the expanded printing count can exceed the stated member
count. `expectedMemberCount`/`officialCardCount` preserve the official total;
`expectedCardCount` and `cardCount` describe the expanded variant rows.

Rarity abbreviations are not unique variant identifiers. In particular, normal
SE and SPECIAL RED SE can have the same abbreviation but different official
rarity IDs. The printing identity includes official product ID, CID, artwork ID,
and rarity ID. Keep these distinctions when merging.

The membership pages do not expose printed card numbers. A printed number is
filled only by matching product ID + CID + artwork ID + rarity ID against the
official per-card printing table. Unresolved numbers remain null, with
`printedNumberSource="unavailable"`. Seventeen collected variant rows have a
matching official detail-table entry whose number is blank; those carry
`numberStatus="not-listed-by-manufacturer"`. Membership completeness does not
mean printed-number completeness.

Thirteen products have no verified product code in this bounded snapshot.
These include Vol.1–7, the theatrical STARTER BOX, and five remaining product
code gaps. No old navigation set association supplies a code. Every populated
code has `codeSource`; manufacturer page identifiers additionally have source
URLs. Current navigation set codes were known to contain a Fire Kings → DBVS
misassociation, so they were excluded. The corrected Fire Kings components are
official IDs 1000000891000 and 1000000892000, both verified SR14; Valiant Smashers
is the separate DBVS product 1000007418000.

The reviewed crosswalk distinguishes 2011 BEGINNER'S EDITION remakes from the
2004 products, anime character editions, six explicitly included +1 packs,
and separate deck/bonus components. The sole unmapped box is future RV02
(marketplace BOX:924418), absent from the currently published official index.
`navigationCoverageComplete=false` records this. Official printing inventory
completeness does not assert the contents of every random pre-existing booster
pack that may have been physically bundled inside a promotional box.

Main and bonus components can share a printing prefix. A verified prefix plus
the reviewed mapping can support retaining a supplemental marketplace row at
the **box union** level. Prefix alone cannot establish ownership of one
component or assert an exact official printing/rarity match.

Images are the native `get_image.action` URLs, including the `enc` value
published by the official page. No credentials or cookies are collected.
A direct request without cookies returned HTTP 200 and a valid PNG signature;
all 27,968 rows have native official image URLs. This probe establishes current
public accessibility, not a promise that a signed URL never expires or that
all external embedding policies are permanent. Keep each card's official page
URL as its durable source reference.

## Public source endpoints

- Product index: `https://www.db.yugioh-card.com/yugiohdb/card_list.action?request_locale=ja`
- Product members: `https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=1&sess=1&pid=PRODUCT_ID&rp=99999&request_locale=ja`
- Card printing details: `https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=CARD_ID&request_locale=ja`
- Official manufacturer products: `https://www.yugioh-card.com/japan/products/`

The same Japanese product PID in the English locale returned no memberships;
this snapshot therefore makes no unsupported CID-to-English-name mapping.
Source HTML hashes and fetch times are retained per product/detail record.
