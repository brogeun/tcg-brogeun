# Verified manufacturer catalogue — 2026-10-31

These public manufacturer facts replace the unavailable f937c66c work. The old
805-product / 102,577-row report is not used as a validation baseline.

| Source | Native products | Native printing rows | Number state resolved | Rarity state resolved |
| --- | ---: | ---: | ---: | ---: |
| Weiss Schwarz | 566 | 66,462 | 66,462 | 66,462 |
| Union Arena | 119 | 11,169 | 11,169 | 11,169 |
| Digimon | 78 | 7,502 | 7,502 | 7,502 |
| Fusion World | 27 | 3,230 | 3,230 | 3,230 |
| Yu-Gi-Oh OCG | 297 | 28,372 | 28,372 | 28,372 |

Counts describe manufacturer categories and native printing rows, not unique
cards, physical copies, or sealed boxes. Nikke is a view of the WS/UA originals.
All 116,735 native rows have a resolved number and rarity state. Yu-Gi-Oh's
421 officially blank number rows are unprinted, rather than unresolved. Rarity
is not applicable to 979 UA action points, 296 Fusion World energy markers and
six Digimon tokens. Three missing Digimon HTML rarities were transcribed from
the exact official card images. Existing native identifiers are preserved.

WS acquisition recovered all 554 API pages and 566 expansion references. Exact
PR/PR+ associations are retained as related promos, apart from box cards;
PRR remains a real pack rarity. Documented included bonuses can remain with
the product. Manufacturer artwork variants are retained even when the printed
product specification counts fewer concepts (e.g. anime Summer Pockets).

Reviewed derived editions have distinct IDs: three UA second editions subtract
only explicitly identified serial APs; NIKKE reprint subtracts its first-print
AGR. Hololive Re:Mix projects the publisher's explicitly imaged 274-number
roster onto unchanged original native printings: 648 exact rows, 274 normal /
374 parallel, all ten advertised rarity counts agreeing. Two independent
transcriptions agree. The image's statement preserves original numbers,
illustrations and finishes. Its recorded PNG hash is a rendered screenshot,
not a hash of the original JPEG response. The separate hololive card-game bonus
is not imported into Weiss Schwarz.

Known source limits remain explicit: future products without published card
inventories, two WS reprints without sufficient edition-specific membership
proof, and older WS products whose API has no distinct row for every advertised
foil finish. Complete API collection does not imply every physical finish has
a distinct manufacturer identifier. No rows, IDs, numbers or prices are invented
to make a product's advertised count fit.

Yu-Gi-Oh was checked against all 12,469 relevant CID detail pages and all 297
product originals, using independent SHA/XPath audits. The detail table supplies
actual product/CID/artwork/rarity/number tuples; the product-list image can be
representative. 565 artwork assignments are corrected. 27,759 unambiguous v1 IDs
remain aliases; ambiguous IDs are not rebound to a guessed printing.

`metadata-validation.json` records resolved states. Public proof records and
reproduction scripts are in `scripts/official_sources/{weiss,bandai,yugioh,other_metadata}`.
Raw HTML, downloaded dependencies and unrelated files are excluded. The
prepare_verified_snapshot.py whitelist retains public catalogue facts and
provenance, omitting rules text and local caches. The build reads these inputs
offline; deployment removes them from the browser bundle.

Box membership never comes from market price availability. Existing market
printings and source prices remain intact. Only unique, exact product/number/
rarity/artwork matches bind a price. A reprinted unchanged native card may share
its original price identity. Uncertain market artwork qualifiers remain labelled
supplements; no cheapest-price or number-only joins are used.

Validation: build_tcg_card_info.py (build and --validate-only), the official and
navigation Python tests, test_card_info_quote_coverage.cjs, the Card Info / price
fallback / pricing integration JavaScript tests, and both public bundle checks.
Input failures stop the build before replacing the last good manifest.
