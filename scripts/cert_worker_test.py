"""Offline regression tests. No network, credentials, Chrome, or production jobs."""
import unittest
from cert_worker_core import classify_psa, classify_bgs, extract_psa_fields, grade_value, validate_job

PSA = """#24311536
PSA Population 20
PSA Pop Higher 0
Item Information
Cert Number
23483296
Item Grade
GEM MT 10
Label Type
PSA Fugitive Ink Technology
Year
2003
Brand/Title
TOPPS CHROME
Subject
LeBRON JAMES
Card Number
111
Category
BASKETBALL CARDS
Variety/Pedigree
BLACK REFRACTOR
Sales of Similar Items
Cert Number 24311536
Item Grade GEM MT 10
"""
URL = "https://www.psacard.com/cert/23483296"
BGS_URL = "https://www.beckett.com/api/grading/lookup?category=BGS&serialNumber=0016097088"
BGS = {"item_id": "0016097088", "final_grade": "9.5", "label": "gold", "set_name": "Sample Set", "player_name": "Sample Player", "card_key": "OP07051", "pop_report": "5", "pop_higher": 0}


class WorkerTests(unittest.TestCase):
    def test_psa_valid(self):
        value = classify_psa(PSA, "23483296", URL)
        self.assertEqual(value["outcome"], "success")
        self.assertEqual(value["record"]["cert_number"], "23483296")
        self.assertEqual(value["record"]["pop_higher"], 0)

    def test_related_sale_cert_cannot_verify(self):
        self.assertEqual(classify_psa(PSA, "24311536", URL)["error_code"], "cert_number_mismatch")

    def test_incomplete_grade_not_cached(self):
        self.assertEqual(classify_psa(PSA.replace("GEM MT 10", ""), "23483296", URL)["outcome"], "parse_error")

    def test_grade_nine(self):
        value = classify_psa(PSA.replace("GEM MT 10", "MINT 9"), "23483296", URL)
        self.assertEqual(value["record"]["grade_text"], "MINT 9")

    def test_same_line_labels(self):
        text = "Item Information Cert Number 23483296 Item Grade GEM MT 10 Brand/Title TOPPS CHROME Subject LeBRON JAMES Card Number 111 Sales of Similar Items"
        self.assertEqual(classify_psa(text, "23483296", URL)["outcome"], "success")

    def test_challenge_not_not_found(self):
        self.assertEqual(classify_psa("Just a moment...", "23483296", URL, 403)["outcome"], "blocked")

    def test_unknown_layout_not_not_found(self):
        self.assertEqual(classify_psa("Loading...", "23483296", URL)["outcome"], "parse_error")

    def test_not_found_requires_matching_cert(self):
        self.assertEqual(classify_psa("Certification number 23483296 was not found", "23483296", URL)["outcome"], "not_found")
        self.assertNotEqual(classify_psa("Certification number 24311536 was not found", "23483296", URL)["outcome"], "not_found")

    def test_duplicate_identity_rejected(self):
        self.assertEqual(extract_psa_fields("Item Information Cert Number 23483296 Cert Number 24311536 Item Grade 10"), {})

    def test_bgs_grade_and_zero_preserved(self):
        value = classify_bgs(BGS, "0016097088", BGS_URL)
        self.assertEqual(value["outcome"], "success")
        self.assertEqual(value["record"]["grade_text"], "9.5")
        self.assertEqual(value["record"]["pop_higher"], 0)

    def test_bgs_maintenance_200(self):
        value = classify_bgs(None, "0016097088", "https://beckett-maintenance-page.s3.amazonaws.com/index.html", 200, "text/html")
        self.assertEqual(value["outcome"], "temporary_error")

    def test_bgs_missing_grade_not_not_found(self):
        value = classify_bgs({**BGS, "final_grade": ""}, "0016097088", BGS_URL)
        self.assertEqual(value["outcome"], "parse_error")

    def test_bgs_numeric_id_not_guessed(self):
        value = classify_bgs({**BGS, "item_id": 16097088}, "0016097088", BGS_URL)
        self.assertEqual(value["outcome"], "parse_error")

    def test_bgs_explicit_404(self):
        value = classify_bgs({"message": "No Record found"}, "0016097088", BGS_URL, 404)
        self.assertEqual(value["outcome"], "not_found")

    def test_grades_do_not_truncate(self):
        self.assertEqual(grade_value("9.5"), 9.5)
        self.assertEqual(grade_value("GEM MT 10"), 10)
        self.assertIsNone(grade_value("AUTHENTIC"))
        self.assertIsNone(grade_value("grade 10 autograph 9"))
        self.assertIsNone(grade_value("19"))

    def test_job_security(self):
        job = {"id": "job", "lease_token": "fixture-only", "provider": "psa", "cert_number": "23483296", "lookup_url": URL}
        self.assertTrue(validate_job(job))
        self.assertFalse(validate_job({**job, "lookup_url": "http://127.0.0.1/"}))
        self.assertFalse(validate_job({**job, "lookup_url": "https://www.psacard.com.evil.invalid/"}))


if __name__ == "__main__":
    unittest.main()
