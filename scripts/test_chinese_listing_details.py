"""Regression checks for seller attribute contradictions, not PSA authentication."""
import unittest
import json
from pathlib import Path
import tempfile
from unittest.mock import patch

from chinese_listing_details import ENDPOINT, accepted_targets, ensure_listing_details, grade_evidence, parse_properties


class ListingDetailEvidenceTests(unittest.TestCase):
    def test_psa_title_cannot_override_not_graded(self):
        evidence = grade_evidence('psa10', {'Graded': 'No', 'CardCondition': 'Good'})
        self.assertEqual(evidence['contradictions'], ['detail_says_not_graded'])

    def test_wrong_grader_and_score_are_both_recorded(self):
        evidence = grade_evidence('psa10', {'Graded': 'Yes', 'ProfessionalGrader': 'GBTC', 'Grade': '9.5'})
        self.assertEqual(evidence['contradictions'], ['detail_grading_company_not_PSA', 'detail_grade_not_10'])

    def test_matching_fields_are_not_certificate_authentication(self):
        evidence = grade_evidence('psa10', {'Graded': 'Yes', 'ProfessionalGrader': 'PSA', 'Grade': '10'})
        self.assertEqual(evidence['contradictions'], [])
        self.assertTrue(evidence['psaCompanyAndGradeExplicitlySupported'])
        self.assertFalse(evidence['certificateVerificationPerformed'])

    def test_missing_and_null_fields_are_not_contradictions(self):
        fields = parse_properties({'result': 1, 'data': [
            {'PropertyControlName': 'ProfessionalGrader', 'PropertyValue': None},
            {'PropertyControlName': 'Grade', 'PropertyValue': None},
        ]})
        self.assertEqual(grade_evidence('psa10', fields)['contradictions'], [])
        self.assertFalse(grade_evidence('psa10', fields)['psaCompanyAndGradeExplicitlySupported'])

    def test_good_and_very_good_cannot_establish_A(self):
        for condition in ('Good', 'Very Good'):
            self.assertEqual(grade_evidence('raw', {'Graded': 'No', 'CardCondition': condition})['contradictions'],
                             ['detail_condition_not_explicit_A_or_NM'])

    def test_graded_card_cannot_be_raw_A(self):
        self.assertIn('detail_says_graded', grade_evidence('raw', {'Graded': 'Yes'})['contradictions'])

    def test_conflicting_duplicate_attributes_fail_closed(self):
        with self.assertRaises(ValueError):
            parse_properties({'result': 1, 'data': [
                {'PropertyControlName': 'Graded', 'PropertyValue': 'Yes'},
                {'PropertyControlName': 'Graded', 'PropertyValue': 'No'},
            ]})

    def test_failed_lookup_cannot_be_an_empty_success(self):
        for payload in ({'result': 0, 'data': []}, {'result': 1, 'data': None}, {'result': True, 'data': []}):
            with self.assertRaises(ValueError):
                parse_properties(payload)

    def test_archive_scope_includes_each_independent_auction(self):
        records = [{'listingId': str(i), 'grade': grade, 'priceMinor': 300, 'sourceUrl': f'https://www.cardhobby.com.cn/market/item/{i}'}
                   for i, grade in ((1, 'psa10'), (2, 'raw'), (3, 'box'))]
        targets = accepted_targets({'source': 'cardhobby', 'currency': 'CNY', 'records': records})
        self.assertEqual([row['listingId'] for row in targets], ['1', '2', '3'])
        self.assertEqual([row['grade'] for row in targets], ['psa10', 'raw', 'box'])

    def test_explicit_foreign_version_conflicts_with_chinese_title(self):
        for version in ('ja', 'en', 'cht'):
            self.assertIn('detail_language_not_simplified_chinese',
                          grade_evidence('psa10', {'Graded': 'Yes', 'Version': version})['contradictions'])
        self.assertEqual(grade_evidence('psa10', {'Version': 'chs'})['contradictions'], [])

    def test_ensure_reuses_valid_fields_and_retains_unrelated_cache(self):
        detail = {'id': '1', 'sourceUrl': 'https://www.cardhobby.com.cn/market/item/1',
                  'propertiesUrl': f'{ENDPOINT}?id=1',
                  'observedAt': '2020-01-01T00:00:00+00:00', 'properties': []}
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / 'listing-details.json'
            cache.write_text(json.dumps({'schemaVersion': 1, 'source': 'cardhobby', 'endpoint': ENDPOINT, 'items': {'1': detail, '99': {'unrelated': True}}}), encoding='utf-8')
            with patch('chinese_listing_details.fetch_properties') as fetch:
                report = ensure_listing_details(folder, [{'listingId': '1', 'sourceUrl': detail['sourceUrl']}])
            fetch.assert_not_called()
            self.assertEqual(report['cachedCount'], 1)
            saved = json.loads(cache.read_text(encoding='utf-8'))
            self.assertTrue(saved['requirePublicAttributes'])
            self.assertEqual(saved['items']['99'], {'unrelated': True})

    def test_ensure_failure_stays_pending_and_preserves_existing_fields(self):
        original = {'schemaVersion': 1, 'source': 'cardhobby', 'endpoint': ENDPOINT, 'items': {'99': {'unrelated': True}}}
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / 'listing-details.json'
            cache.write_text(json.dumps(original), encoding='utf-8')
            with patch('chinese_listing_details.fetch_properties', side_effect=TimeoutError('public lookup timed out')):
                report = ensure_listing_details(folder, [{'listingId': '1', 'sourceUrl': 'https://www.cardhobby.com.cn/market/item/1'}])
            self.assertEqual(report['failedCount'], 1)
            self.assertNotIn('1', json.loads(cache.read_text(encoding='utf-8'))['items'])
            self.assertEqual(json.loads(cache.read_text(encoding='utf-8'))['items']['99'], original['items']['99'])

    def test_ensure_success_saves_original_public_rows(self):
        rows = [{'PropertyControlName': 'Graded', 'PropertyValue': 'No'}]
        with tempfile.TemporaryDirectory() as folder:
            with patch('chinese_listing_details.fetch_properties', return_value=({'result': 1, 'data': rows}, {'Graded': 'No'}, True)):
                report = ensure_listing_details(folder, [{'listingId': '1', 'sourceUrl': 'https://www.cardhobby.com.cn/market/item/1'}])
            saved = json.loads((Path(folder) / 'listing-details.json').read_text(encoding='utf-8'))
            self.assertEqual(report['fetchedCount'], 1)
            self.assertEqual(saved['items']['1']['properties'], rows)

    def test_ensure_interrupt_keeps_strict_policy_and_completed_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch('chinese_listing_details.fetch_properties', side_effect=KeyboardInterrupt):
                with self.assertRaises(KeyboardInterrupt):
                    ensure_listing_details(folder, [{'listingId': '1', 'sourceUrl': 'https://www.cardhobby.com.cn/market/item/1'}])
            saved = json.loads((Path(folder) / 'listing-details.json').read_text(encoding='utf-8'))
            self.assertTrue(saved['requirePublicAttributes'])
            self.assertNotIn('1', saved['items'])

    def test_ensure_wrong_endpoint_does_not_overwrite_existing_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            cache = Path(folder) / 'listing-details.json'
            cache.write_text(json.dumps({'schemaVersion': 1, 'source': 'cardhobby', 'endpoint': 'https://example.invalid/', 'items': {}}), encoding='utf-8')
            before = cache.read_bytes()
            with self.assertRaises(ValueError):
                ensure_listing_details(folder, [])
            self.assertEqual(cache.read_bytes(), before)


if __name__ == '__main__':
    unittest.main()
