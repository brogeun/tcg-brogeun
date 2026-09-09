# Riftbound English catalog

Run `리프트바운드_카드수집.cmd` from the project folder. It fetches Riot's public English gallery and follows its public pagination. There is no paid API or OpenAI call. Output defaults to `.cache/riftbound-import/data/riftbound-catalog.json` and a report; review before copying into `data/`. This does not deploy or schedule daily collection.

`python scripts/import_riftbound.py --output .` updates the local catalog directly when explicitly desired. Product images and release dates come from the official pages recorded in `scripts/riftbound_sets.json`. Unknown dates remain null. Card images use Riot's public CDN with WebP resizing; no API credential is needed.

The September 9, 2026 import has 1,189 public cards in 5 sets. The source metadata reports 1,197 entries, but all 6 public pages and the rendered gallery agree on 1,189 exposed cards; the difference is recorded as `sourceListedTotal` and is not invented as additional cards. The catalog represents the official gallery, not a claim of exhaustive promo coverage.

Card IDs use `RB-EN-<set>` and Riot's original string IDs. Variants retain separate IDs. They must never be treated as SNKRDUNK numeric product IDs. Display names stay English; Riot Data Dragon Korean champion names are search aliases. Prices, transaction volume, favorites and portfolio integration are not part of this import.

Validation: `node scripts/test_riftbound.cjs`.
