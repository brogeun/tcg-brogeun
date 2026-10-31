# KONAMI Japanese OCG complete printing verification

This isolated continuation never edits or publishes the application repository.
The ready state is `snapshot_manifest.json: allValidationChecksPass=true`.
A snapshot exported during collection remains explicitly incomplete.

## Validated final snapshot, 2026-10-31

| Measure | Count |
| --- | ---: |
| Reviewed official products | 297 |
| Target CIDs independently source-audited | 12,469 |
| Official unique card-member rows | 19,172 |
| Aggregate membership-rarity rows | 27,968 |
| Actual native artwork/rarity/number printings | 28,372 |
| Explicit official printed numbers | 27,951 |
| Explicitly blank manufacturer number rows | 421 |
| Unresolved number rows | 0 |
| Products with complete printing/number-state inventory | 297 |
| Actual-artwork corrections from list representative | 565 |
| Unambiguous v1 legacy aliases | 27,759 |
| Ambiguous v1 IDs deliberately left unaliased | 21 |
| Products with codes verified by actual printings | 289 |

All 16 validation checks pass. Independent XPath extraction matched the raw
SHA256 and every explicit tuple for all 12,469 card detail pages (38,184 printing
rows across their full official histories), plus all 297 product membership
pages. No collection errors, access blocks, 429 responses or backoff occurred.
READY.json records the validated snapshot manifest. JSON and gzip hashes are
verified, and decompressing the gzip reproduces the JSON byte-for-byte.

## Reproduce

Keep the scripts, requirements, products.json, reviewed_box_mappings.json, and
manufacturer_code_crosswalk.json together. Raw/parsed caches are resumable and
need not be committed.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -u collect_all_details.py
.venv/bin/python -u export_complete.py
```

Collection covers all 12,469 unique CIDs in the 297 reviewed products without a
detail cap. Six workers share a minimum 0.34-second request-start interval
(at most 2.94 starts/second). This self-imposed interval was increased from 0.55s
after more than 2400 stable successful requests and a standard robots.txt check
returned 404 without a published rate directive or Retry-After. This is not a
claimed official limit. Failures, Retry-After, or sustained latency growth
restore 0.55s. Access blocks stop collection.
Normal public HTTPS connections are reused without cookies or credentials.
HTTP failures preserve raw responses; denials, rate limits, or access challenges
stop collection without bypass. Progress is atomic and refreshed every 55s.
Run export_complete.py alone for offline export. Every output is replaced
atomically. snapshot_manifest.json hashes the JSON and deterministic gzip.

## Corrected printing identity

Official product totals count unique **card members**, not artwork variants or
physical copies. The detail-link IID is a representative image. The 297 product
pages have 19,172 rows and exactly 19,172 unique product/CID memberships.
Their rarity icons expand to 27,968 aggregate membership-rarity rows. These
counts stay in officialMemberRows and membershipRarityRows.

Native printings come only from explicit per-card detail rows: product ID + CID
+ artwork IID + rarity ID + printed number (including explicitly blank values).
Membership limits the relevant product/CID set. The detail table supplies actual
artwork, rarity, and number. No number comes from row order, image filenames,
card text, or old navigation associations.

Example: YAS3 Blue-Eyes White Dragon has UR numbers JP003/JP004/JP005 and UL
artwork IIDs 18/19 sharing JPP01. The membership IID1 and UR/UL icons cannot
express this inventory. Every explicit tuple is retained, without overwriting
multiple numbers or restricting all rarities to the representative artwork.
Native IDs include number; blank numbers use an identity token UNNUMBERED.
Exact duplicate source tuples retain all sourcePrintingIndexes and are reported.
legacy_printing_identities.json freezes the v1 source identity baseline.
legacyIds is added only when exact product/CID/IID/rarity plus the old verified
number (when present) identifies exactly one new native printing. Ambiguous
representative-image rows never receive guessed aliases. The full decisions
are recorded in legacy_alias_report.json.

## Number states

| numberStatus | Meaning | numberVerified |
| --- | --- | --- |
| verified | Explicit official printed number | true |
| not-listed-by-manufacturer | Matching official detail row with a blank number | false |
| unavailable | Genuine unresolved detail or rarity gap | false |

numberCompleteness means every printing has a resolved official number state,
including confirmed manufacturer blanks. allPrintingsNumbered is the stricter
nonblank-number check. Unknowns never become blanks. Blank rows remain distinct
when another printing with the same card/artwork/rarity has a number.
Each native row keeps its detail URL, HTML SHA256, fetched time, actual IID,
official image URL, and source indexes. membershipArtworkId is only the list's
representative image. Product provenance remains the membership page.

## Validation and coverage

validation_report.json checks totals, IDs, all target CIDs, exact source tuples,
image CID/IID, rarity coverage, language/kind, reviewed market assignments, and
number states. It reports artwork corrections, duplicates, gaps and code sources.
297 published products map to 285 of 286 reviewed marketplace boxes. Future
RV02 (BOX:924418) stays pending while its Japanese contents are absent from the
official product index. No membership or number is fabricated for it.

## Efficient official paths investigated

Official product/detail HTML, forms, common JavaScript and official-domain
searches exposed no card-data bulk download or documented multiple-CID printing
request. Download references were images or deck registration sheets.
Manufacturer pages IMPH, LOCR, QCAC, SD48 and 26PP expose promotional images,
sprites, product-list links and ordinary JavaScript, with no explicit CID plus
printed-number JSON/CSV map. Numeric filenames alone were not used.
manufacturer_research/observations.json records the four additional pages.

## Public endpoints

- Index: https://www.db.yugioh-card.com/yugiohdb/card_list.action?request_locale=ja
- Members: https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=1&sess=1&pid=PRODUCT_ID&rp=99999&request_locale=ja
- Printings: https://www.db.yugioh-card.com/yugiohdb/card_search.action?ope=2&cid=CARD_ID&request_locale=ja
- Manufacturer: https://www.yugioh-card.com/japan/products/

This is Japanese OCG only, without English TCG/Rush Duel memberships, unsupported
English name mappings, or marketplace prices.
