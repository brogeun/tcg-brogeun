# Union Arena official metadata completion

The 119 official selector categories retain exactly the same 11,169 native printing identities, numbers, and order as the prior final snapshot. No marketplace inventory establishes card membership.

- All 708 franchise × official rarity/action-point queries completed: 11,169 exact image joins, zero unmatched images, zero classification conflicts or request failures.
- 10,190 rows have a verified literal rarity; 979 official ACTION POINT rows have `rarityStatus: "not_applicable"` and `rarityNotApplicable: true`. No unavailable rarity remains.
- 2,324 exact detail pages were checked: 2,316 non-AP parallel rows and eight AP rows also returned by the OBC search filter. Every detail was matched against its exact official image identity. Existing detail metadata brings the total labeled `rarityOrigin: "official-detail"` to 2,335 rows.
- Literal `PcSR`, `PcR`, `PcC` search classifications remain in `rarityFilter`. Exact labels such as `SR★★`, `PcSR★★`, and `PcR★` come only from official detail pages. No star tier is inferred from an image suffix.
- Eight AP images match the official OBC filter but expose no rarity in their own detail pages. These retain `rarityFilter: "OBC"` while their actual rarity is null and explicitly not applicable.
- All native rows have manufacturer-provided numbers and `numberStatus: "verified"`.

## Official second editions

The three official product pages publish an image stating that packages marked 第二版 exclude serial-numbered limited action-point cards. The notice artwork was visually compared with all five exact official card images. These are separate derived products; the original 119 categories remain unchanged.

| Reviewed marketplace box | Source native category | Original rows | Second edition rows | Explicitly excluded exact image IDs |
| --- | --- | ---: | ---: | --- |
| BOX:841643 | 570136 / UA36BT | 139 | 137 | UA36BT_MCR-1-AP01_p1, UA36BT_MCR-1-AP02_p1 |
| BOX:345233 | 570118 / UA18BT | 141 | 140 | UA18BT_NIK-1-AP06_s |
| BOX:426516 | 570123 / UA23BT | 137 | 135 | UA23BT_AOT-1-AP01_s, UA23BT_AOT-1-AP02_s |

Official notices:

- https://www.unionarena-tcg.com/jp/images/products/boosters/mcr-1/img_02.jpg
- https://www.unionarena-tcg.com/jp/images/products/boosters/nik-1/img_01.jpg
- https://www.unionarena-tcg.com/jp/images/products/boosters/aot-1/img_02.jpg

`union_arena-edition-evidence.json` preserves URLs, SHA256, response provenance, excluded IDs, and the separate derived membership snapshots. `union_arena.json` also appends the three second editions to its five existing acquisition-caption products. Derived row counts are reproducible inventory-minus-exclusion counts, not independently advertised pack quantities.

## Future inventories

EX18BT / BOX:931807 and UA58BT / BOX:931809 have official product announcements and a November 27, 2026 release date. A fresh successful official inventory response still lists 119 selectors with no matching selector for either code. Their state is `official-full-card-inventory-not-yet-published`, with `productAnnouncementPublished: true`, `cardInventoryPublished: false`, and `fetchFailed: false`. This describes the full card inventory, not the already published product announcement.

- https://www.unionarena-tcg.com/jp/products/boosters/ex_mgs.php
- https://www.unionarena-tcg.com/jp/products/boosters/dgm-1.php

## Verification

`validation.json` checks native/derived membership, counts, image hosts, source provenance, and cached response byte lengths/SHA256. `union_arena-metadata-validation.json` separately verifies complete classification/detail coverage, literal rarity and status counts, unchanged original membership, exact second-edition subtraction, and the future-product state. Both pass with zero problems.

Digimon and Fusion World files in this directory are copied reference snapshots and were not enriched by this UA task.
