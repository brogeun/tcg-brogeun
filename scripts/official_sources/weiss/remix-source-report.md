# Hololive Re:Mix — independently verified membership

The official publisher image is a text roster of **274 explicitly numbered card designs**, split into 132 HOL/W91 rows and 142 HOL/W104 rows. It is not a card-picture montage. The source URL is:

https://ws-tcg.com/wordpress/wp-content/images/renew/products/holremix/holremix_cardlist3.jpg

The manufacturer product page directly links this image and advertises 274 normal plus 374 parallel printings:

https://ws-tcg.com/products/bpholremix/

## Independent verification

All six provided source-image segments were visually inspected. A separate number-column OCR pass removed table grid lines and produced 269 exact literal numbers. Five OCR failures were individually checked against enlarged source cells and corrected as follows; the visible source, rather than the expected count, determined every correction.

| W91 roster row | Raw OCR | Visually read source number |
| --- | --- | --- |
| 42 | BOE/WIIEOS0 | HOL/W91-050 |
| 44 | BOL/WO1E05S | HOL/W91-053 |
| 112 | BOSS | HOL/W91-123 |
| 116 | BOLWY1-127 | HOL/W91-127 |
| 128 | FIOL/W91-139 | HOL/W91-139 |

The resulting independent 274-number list agrees exactly with the parent's transcription. Raw OCR, the five enlarged cells, and the independent list are retained in `remix-independent/`.

The bottom notice explicitly covers card numbers, card text, illustrations and card finishes. Its short critical excerpt is “過去商品から変更はございません。” The publisher states that those properties are unchanged from the earlier products. This was read visually from the original source screenshot's bottom segment.

## Derivation

`remix-derived.json` selects **every existing literal native printing** from source products `ws-jp:357` and `ws-jp:419` whose HOL/W91-NNN or HOL/W104-NNN number stem appears as an actual row on that official roster. It creates no native IDs, printed numbers, suffixes, rarity labels or image paths. All original raw card records are retained. Each output card records its `sourceNativeProductId`.

The projection yields 264 native rows from 357 and 384 from 419: **648 distinct native IDs**. These independently equal the parent's candidate ID set. The advertised rarity distribution was then checked as a validation result, not used to select or trim cards:

| Rarity | Official product count | Literal projected rows |
| --- | ---: | ---: |
| SSP | 79 | 79 |
| SP | 79 | 79 |
| RRR | 30 | 30 |
| SR | 186 | 186 |
| RR | 30 | 30 |
| R | 63 | 63 |
| U | 76 | 76 |
| C | 75 | 75 |
| CR | 9 | 9 |
| CC | 21 | 21 |
| **Total** | **648** | **648** |

The official `parallel_param` also independently gives 274 normal rows and 374 parallel rows. All ten rarity totals agree. Source rows outside the explicit roster comprise 32 non-promo printings and 77 PR printings; these are consequences of the roster projection, not a target-count exclusion rule.

The separate hololive OFFICIAL CARD GAME box PR advertised on the product page is not included in Weiss Schwarz membership.

## Files and provenance

- `remix-derived.json`: the requested standalone derived product, ID `derived:ws:holremix`, market box `BOX:343239`, 648 literal cards, `complete:true`.
- `remix-source-proof.json`: roster, native parent provenance, independent checks, excluded native IDs, source hashes and preservation assertions.
- `remix-validation-summary.json`: compact validation and file hashes.
- `remix-independent/independent-roster.json`: the independent 274-number transcription and five visual corrections.
- `remix-independent/official-roster-rendered.png`: unchanged copy of the provided official image screenshot.

The 3000 × 6800 screenshot SHA256 is `19495dc002f9ab77d59a316238a9c84bf11fb4ac35fd6a0c5d5a770c3bde3b3e`. It hashes **browser-rendered PNG screenshot bytes**, not the original JPEG response bytes. The derivation and proof state that distinction explicitly. The ordinary official product-page extraction and its SHA are also preserved alongside the screenshot provenance.

The original 566-product native catalogue file was hashed before and after derivation and remained unchanged. Reproduction uses `build_remix_derived.py`, which writes only the separate Re:Mix files.
