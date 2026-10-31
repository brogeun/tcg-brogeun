# Official contained-card reconstruction — 2026-10-31

This replaces the unavailable `f937c66c` work with newly collected, independently
checked public manufacturer data. The old report of 805 products / 102,577 rows
is not treated as a verified result of this reconstruction.

The JSON/gzip snapshots are build inputs, not browser assets. They contain
exact source URLs, capture times, native printing identities and response hashes.
`scripts/build_tcg_card_info.py` reads them offline on every normal deployment;
the public bundle omits the collector inputs and retains the generated set URLs.

| Source | Captured inventory | Membership rows |
| --- | ---: | ---: |
| Union Arena | 119 official selector categories | 11,169 native printings |
| Digimon | 78 official selector categories | 7,502 native printings |
| Fusion World | 27 official selector categories | 3,230 native printings |
| Yu-Gi-Oh OCG | 297 reviewed component products | 19,172 card/artwork rows; 27,968 rarity variants |
| Weiss Schwarz | 11 indexed product specifications | No complete membership lists recovered |

Selector counts include broad promotional categories and repeated printings.
They are not counts of unique cards or sealed boxes. Promotional aggregates are
never assigned to one box. Exact acquisition-caption partitions are retained as
source evidence, with derived IDs distinguished from manufacturer product IDs.

Product membership and metadata completeness are separate. Yu-Gi-Oh has 1,071
source-verified printed-number variant rows; other numbers remain unknown. No
number is inferred from list order. UA official rarity filters do not prove a
parallel star tier; missing metadata stays unknown. Official image URLs may
later expire or change independently of this snapshot.

Manufacturer product identity controls box membership. Normal/parallel image
IDs and explicit rarity IDs stay separate. Reviewed box unions may contain a
main product and its included bonus component. Known market printings that
cannot yet be bound to one exact official variant are labelled separately;
their existing price identities remain available. Number-only or cheapest-price
joins are forbidden. Ordinary price snapshot updates remain authoritative,
including explicit no-listing results.

Weiss Summer Pockets SMP/W60 and SMP/W137 are separated despite their identical
titles. The Hololive Re:Mix advertised 648 types, NIKKE first/reprint differences
and other product specifications are cross-check evidence, not invented card
memberships. Unavailable official lists remain explicitly partial.

Collectors and reproduction notes: `scripts/official_sources/bandai/` and
`scripts/official_sources/yugioh/`. Raw HTML caches and downloaded dependencies
are deliberately excluded. Refresh into a temporary directory, run the source
validator, then replace the corresponding snapshot using deterministic gzip
(`gzip.compress(body, compresslevel=9, mtime=0)`).

Validation:

```sh
python scripts/build_tcg_card_info.py
python scripts/build_tcg_card_info.py --validate-only
python -m unittest discover -s tests -p test_build_tcg_card_info.py
python -m unittest discover -s tests -p test_official_card_contents.py
node scripts/test_card_info_quote_coverage.cjs
node --test scripts/test_tcg_card_info.cjs scripts/test_card_price_fallback.cjs
python -m unittest discover -s scripts -p test_prepare_public_bundle.py
```

The source build is atomic with respect to input failures: invalid official
identities/counts stop before any output replaces the last good manifest.
Existing source set IDs remain available for shared links and price regression
checks. A manifest-wide `officialComplete` remains false while any source is
partial.
