Final integration addendum: Re:Mix is resolved by the explicit 274-number publisher roster. See remix-source-report.md and remix-source-proof.json. The earlier pending discussion below describes the state before that image became available.

# WS official catalogue recovered

The current official public JSON catalogue was retrieved in full through ordinary TinyFish fetches. A public scraper was used only to discover the exact endpoint URLs; every imported row comes from the official manufacturer response.

- `https://ws-tcg.com/manage/CardListUser/filter-options`: 566 native expansion records, category taxonomy and other filters.
- `https://ws-tcg.com/manage/CardListUser/searchJson?keyword=&keyword_or=&keyword_not=&keyword_type%5B%5D=all&show_page_count=120&page=1`: the verified first page; pages 1 through 554 were all collected.
- Total rows, distinct native IDs, distinct literal printed numbers and native ID/variation/picture keys are all **66,462**. Missing page, number, rarity, picture and unknown-expansion counts are zero. Every page reports the same total, limit and page count. There are no duplicate literal printing keys.
- Every official `variation` is numeric zero. The separate official `parallel_param` is empty on 42,736 rows and `〇` on 23,726. No E1/E5 or other invented printed qualifiers were added.
- Official card-image base was directly observed on manufacturer product image links: `https://ws-tcg.com/wordpress/wp-content/images/cardlist/`. The literal API `picture` is appended; filenames are never constructed from numbers.

## Files for import

`weiss-official-products.json` contains 566 complete native manufacturer expansion assignments plus one documented NIKKE reprint derivation. All card rows retain `officialRaw`, literal number, native ID, variation, raw and trimmed rarity, literal picture, observed-base image URL, official parallel flag and card roles.

The stable import contract is `products` (566 native entries), `derivedProducts` (one NIKKE reprint), and `futureProducts` (two publisher-announced products with no matching native booster expansion in this snapshot). Every card has `url` equal to its official `sourceUrl`. The derived product has local `id: ws-jp:494:reprint`, `derivedFromOfficialId: 494`, `nativeExpansionId: 494`, `edition: reprint`, and `editionEvidence`; it has no fabricated native `officialId`. `imageBaseEvidence` is an actual URL/evidence object rather than a local filename.

The exact returned NIKKE official-page extraction is isolated in `nikke-reprint-official-page.json`, SHA256 `102e9963a185af58a5acc53bc219d3211cd6bf2c6065c10144a0574b0c5caef4`. Its extracted-text SHA256 is `30f6b184294b7e618467d92c52d76aaf2565ccedeb789c39517d281901fb5711`. These describe returned extraction bytes, not original HTTP response bytes. The two future-product announcement caches and native-inventory snapshot hashes are included in `futureProducts` and `future-products-evidence.json`.

`official-box-mapping-review.json` records all 381 market boxes, reviewed identity evidence/corrections, core/related IDs, edition conditions and pack verification. Product identities were established for **378** boxes; **376** have direct reviewed membership in product `marketBoxIds`. The two edition-unverified resales are listed only under `relatedMarketBoxIds` so they cannot silently inherit an original edition's printing identity.

`official-catalog-audit.json` and `membership-role-audit.json` provide the counts, limits and per-page hashes. `card-pages/page-####.json` preserves all 554 source pages. `official-cards-full.json` contains the 66,462 literal rows without derived editions.

`official-product-index-pages-complete.json` preserves all 56 index pages reached only via observed pagination links. `product-details/batch-###.json`, `official-special-product-pages.json` and `explicit-special-spec-pages.json` preserve all 660 observed product detail/special URLs plus the previously cited `bp_nik` page, for 661 unique official pages. `official-product-pages-normalized.json` combines them. Exact native product-name/kind or explicit cardlist links associated current product-page evidence with 493 native products.

## Role and edition findings

- Precisely `PR` and `PR+` are related promos for pack products. **PRR is a legitimate pack rarity**, including Key 25th's 60 PRR printings; it must stay in core. Trial and promo-only products are handled separately. No individual box/carton bonus ID is asserted without literal role evidence; `includedBonusIds` stays empty otherwise.
- 216 mapped boxes have reconciled normal/parallel pack specifications. Other products preserve their complete native listing while retaining verification limits; they are not trimmed to an advertised number.
- Summer Pockets 2018 is expansion 238, `SMP/W60`, with 140 native rows / 135 non-PR. The TV anime is expansion 548, `SMP/W137`, with **232 literal rows**. Its advertised 100 normal + 123 parallel counts game designs, while 012a/b/c/d, 068a/b/c/d and 070a/b/c/d preserve nine additional normal art printings. All 232 remain. Manufacturer special pages explicitly state that final alphabet variants are not counted separately in advertised normal types.
- Hololive original 357 has 350 rows (62 PR), Vol.2 419 has 407 (15 PR). Their non-PR pack lists reconcile as 288 and 392 respectively. Their union is **680 non-PR**, not Re:Mix's advertised 648. Do not synthesize Re:Mix from these groups. The actual observed official full-list image URL is `https://ws-tcg.com/wordpress/wp-content/images/renew/products/holremix/holremix_cardlist3.jpg`; its pixels remain a parent visual-review task.
- NIKKE original expansion 494 contains exactly 289 rows, including the sole AGR native ID **57856**, literal **NIK/S117-029A**. The official `https://ws-tcg.com/ex/nik_jp/` reprint section explicitly gives 115 normal + 173 parallel and excludes AGR, box bonuses and the three-box campaign. Derived product `ws-jp:494:reprint` therefore contains the same literal original rows except that AGR: **288**. This derived identifier is local; `derivedFromOfficialId` and `nativeExpansionId` preserve manufacturer 494.
- NIKKE Vol.2 expansion 564 has 270 core rows. One official rarity has trailing whitespace (`NIK/S135-040S`, native 70315, raw `SR `); the normalized field is SR and raw remains preserved.
- Official API category for VIRTUAL GIRL expansion 542 says trial deck, but the directly observed official `vrg_eb` product page explicitly says Extra Booster. The conflict is preserved and the product kind uses that actual product-page evidence.
- Azur Lane Vol.2 resale BOX:760198 and Bunny Girl Senpai resale BOX:724259 have a verified original-product identity but lack a verified separate resale printing rule. They remain related-only, `editionMembershipComplete:false`, and must not inherit a complete original-edition assertion.
- Persona 30th Anniversary BOX:927942 and Mugendai Mewtype Booster BOX:920093 are future releases relative to 2026-10-31; a native booster expansion was not published in this source snapshot. Re:Mix BOX:343239 remains the other unmapped product pending its actual list image.

## Genuine remaining source representation limits

Some older Extra products advertise both normal and parallel finishes but the official API supplies only one literal printed-number/image row per card. For example, CLANNAD vol.01 advertises 27 normal + 27 parallel but native expansion 21 has 27 rows, and anime D.C.III Extra advertises 36 + 36 but expansion 99 has 36 rows. The derivation marks these limits and creates no imaginary native rows, numbers or images. Complete native API collection is verified; every physical finish is not individually represented by that API.

Direct HTTP and cloud-browser routes still returned the historical 228-byte 404 even when TinyFish successfully retrieved the same official public content. The earlier general source-unavailable conclusion is superseded. Deck Log's explicit CloudFront 403 was not retried or bypassed.

Regenerate the derivation by running `audit_complete_catalog.py` and then `enrich_membership_roles.py`; neither script accesses the network or writes the source repository.
