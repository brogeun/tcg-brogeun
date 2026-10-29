import json
from pathlib import Path
import tempfile
import unittest
from urllib.error import URLError

from collect_mercari_references import infer_identity, load_watchlist, parse_listing, refresh, valid_item_url

URL = "https://jp.mercari.com/item/m47783276036"
ITEM = {"itemId": "m47783276036", "sourceUrl": URL, "game": "onepiece"}
NOW = "2026-10-29T12:00:00Z"


def page(title="ワンピース OP05-119 SEC", price="500", currency="JPY", extra=""):
    return ('<title>' + title + ' - メルカリ</title>'
            '<meta property="og:title" content="' + title + ' by メルカリ">'
            '<meta name="product:price:amount" content="' + price + '">'
            '<meta name="product:price:currency" content="' + currency + '">'
            '<meta property="og:locale" content="ja_JP">' + extra)


class OriginalListingParsingTests(unittest.TestCase):
    def test_script_translations_do_not_imply_sold_or_active(self):
        row = parse_listing(page(extra='<script>{"sold":"売り切れました","buy":"購入手続きへ"}</script>'), ITEM, NOW)
        self.assertEqual(row["saleStatus"], "unknown")
        self.assertEqual(row["price"], {"amount": 500, "currency": "JPY"})
        self.assertIsNone(row["soldAt"])
        self.assertFalse(row["valuationEligible"])
        self.assertEqual(row["verification"], "unverified")

    def test_site_locale_and_sec_do_not_establish_language_variant_or_grade(self):
        row = parse_listing(page(), ITEM, NOW)
        for field in ("language", "variant", "grade", "setCode", "quantity"):
            self.assertIsNone(row["identity"][field])

    def test_purchase_and_sold_labels_require_real_buttons(self):
        for text, expected in (("購入手続きへ", "active"), ("売り切れました", "sold")):
            row = parse_listing(page(extra='<button><span>' + text + '</span></button>'), ITEM, NOW)
            self.assertEqual(row["saleStatus"], expected)
            self.assertFalse(row["valuationEligible"])
            self.assertIsNone(row["soldAt"])
        self.assertEqual(parse_listing(page(extra='<p>売り切れました</p>'), ITEM, NOW)["saleStatus"], "unknown")

    def test_conflicting_buttons_fail_closed(self):
        row = parse_listing(page(extra='<button>売り切れました</button><button>購入手続きへ</button>'), ITEM, NOW)
        self.assertEqual(row["saleStatus"], "unknown")

    def test_english_psa_and_four_card_lot_are_separate_claims(self):
        row = parse_listing(page("ONE PIECE ENGLISH 2ND ANNIVERSARY OP05-119 PSA10 4枚セット", "19000"), ITEM, NOW)
        self.assertEqual(row["identity"]["language"], "en")
        self.assertEqual(row["identity"]["grade"], "PSA10")
        self.assertEqual(row["identity"]["quantity"], 4)
        self.assertTrue(row["identity"]["bundle"])
        self.assertEqual(row["price"]["amount"], 19000)  # Never a synthetic unit price.
        self.assertFalse(row["valuationEligible"])

    def test_wrong_number_is_not_replaced_by_watchlist_hint(self):
        row = parse_listing(page("ワンピース PSA10 ウタ SEC SP OP02-120"), dict(ITEM, cardNumber="OP05-119"), NOW)
        self.assertEqual(row["identity"]["cardNumber"], "OP02-120")
        self.assertEqual(row["matchHints"]["cardNumbers"], ["OP02-120"])
        self.assertFalse(row["valuationEligible"])

    def test_recommendation_numbers_do_not_contaminate_identity(self):
        row = parse_listing(page(extra='<div>この商品を見ている人におすすめ</div><div>OP02-120</div>'), ITEM, NOW)
        self.assertEqual(row["identity"]["cardNumber"], "OP05-119")

    def test_recommendation_purchase_buttons_do_not_define_main_item_status(self):
        row = parse_listing(page(extra='<div>この商品を見ている人におすすめ</div><button>購入手続きへ</button>'), ITEM, NOW)
        self.assertEqual(row["saleStatus"], "unknown")

    def test_missing_zero_negative_or_wrong_currency_price_is_rejected(self):
        for price, currency in (("", "JPY"), ("0", "JPY"), ("-20", "JPY"), ("500", "USD")):
            with self.subTest(price=price, currency=currency), self.assertRaises(ValueError):
                parse_listing(page(price=price, currency=currency), ITEM, NOW)

    def test_manga_parallel_and_multiple_numbers_remain_distinct(self):
        self.assertEqual(infer_identity("OP05-119 コミパラ")["variant"], "manga")
        self.assertEqual(infer_identity("OP05-119 パラレル")["variant"], "parallel")
        self.assertIsNone(infer_identity("OP05-119 OP02-120 2枚セット")["cardNumber"])

    def test_game_hint_does_not_promote_unobserved_identity(self):
        row = parse_listing(page("PSA10 ENGLISH 2ND ANNIVERSARY ルフィ"), ITEM, NOW)
        self.assertIsNone(row["identity"]["game"])
        self.assertEqual(row["matchHints"]["game"], "onepiece")
        self.assertEqual(row["matchHints"]["cardNumbers"], [])


class RefreshAndWatchlistTests(unittest.TestCase):
    def test_exact_original_urls_only(self):
        self.assertTrue(valid_item_url(URL))
        for url in (URL.replace("https", "http"), URL.replace("jp.mercari.com", "evil.example"), URL + "?redirect=x", URL + "/other", "https://jp.mercari.com@evil.example/item/m47783276036"):
            self.assertFalse(valid_item_url(url))

    def test_duplicate_invalid_and_over_limit_watchlists_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "watchlist.json"
            for items, limit in (([ITEM, ITEM], 20), ([dict(ITEM, sourceUrl="https://evil.example/item/m47783276036")], 20), ([ITEM], 0)):
                path.write_text(json.dumps({"items": items}), encoding="utf-8")
                with self.assertRaises(ValueError):
                    load_watchlist(path, limit)

    def test_failed_refresh_preserves_last_good_price_and_observation_time(self):
        first = refresh([ITEM], {}, NOW, lambda url, timeout: page())
        def fail(url, timeout):
            raise URLError("source temporarily unavailable")
        second = refresh([ITEM], first, "2026-10-30T12:00:00Z", fail)
        row = second["references"][0]
        self.assertEqual(row["price"]["amount"], 500)
        self.assertEqual(row["observedAt"], NOW)
        self.assertEqual(row["lastAttemptAt"], "2026-10-30T12:00:00Z")
        self.assertEqual(row["fetchStatus"], "error")
        self.assertTrue(row["stale"])
        self.assertFalse(row["valuationEligible"])
        self.assertEqual(second["coverage"]["errorCount"], 1)

    def test_failed_first_fetch_never_fabricates_price_or_date(self):
        def fail(url, timeout):
            raise TimeoutError("timeout")
        row = refresh([ITEM], {}, NOW, fail)["references"][0]
        self.assertIsNone(row["price"])
        self.assertIsNone(row["observedAt"])
        self.assertIsNone(row["soldAt"])

    def test_refresh_failure_does_not_present_last_known_active_as_current(self):
        first = refresh([ITEM], {}, NOW, lambda url, timeout: page(extra='<button>購入手続きへ</button>'))
        def fail(url, timeout):
            raise TimeoutError("timeout")
        row = refresh([ITEM], first, "2026-10-30T12:00:00Z", fail)["references"][0]
        self.assertEqual(row["saleStatus"], "unknown")
        self.assertEqual(row["lastKnownSaleStatus"], "active")
        self.assertEqual(row["observedAt"], NOW)
        self.assertIsNone(row["statusEvidence"])

    def test_sold_and_active_candidates_are_not_averaged_or_made_verified(self):
        second = dict(ITEM, itemId="m10897947375", sourceUrl="https://jp.mercari.com/item/m10897947375")
        result = refresh([ITEM, second], {}, NOW, lambda url, timeout: page(extra='<button>' + ("売り切れました" if url == URL else "購入手続きへ") + '</button>'))
        self.assertEqual({row["saleStatus"] for row in result["references"]}, {"sold", "active"})
        self.assertEqual(result["verifiedQuotes"], [])
        self.assertEqual(result["coverage"]["verifiedQuoteCount"], 0)
        self.assertTrue(all(not row["valuationEligible"] for row in result["references"]))
        self.assertNotIn("averagePrice", result)


if __name__ == "__main__":
    unittest.main(verbosity=2)
