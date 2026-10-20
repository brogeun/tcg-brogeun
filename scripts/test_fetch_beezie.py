import copy
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

import fetch_beezie as target
from verify_beezie_snapshot import validate


def catalogue(rows):
    data = ['$', '$L1', None, {'state': {'queries': [
        {'queryKey': ['get-minimal-claws'], 'state': {'status': 'success', 'data': rows}}]}}]
    packet = [1, '19:' + json.dumps(data) + '\n']
    return ('<script>self.__next_f.push(' + json.dumps(packet) + ')</script>').encode()


def machine(cid=100, name='Gold TCG', status='paused', stock=0):
    return {'id': cid, 'name': name, 'status': status, 'clawStockCount': stock,
            'priceUsdc': 250000000, 'averageValue': 999999999}


class BeezieCollectorTests(unittest.TestCase):
    def fixture(self, rows):
        def fetch(url):
            if url == target.CATALOGUE_URL:
                return catalogue(rows)
            cid = int(url.rsplit('/', 1)[-1])
            return json.dumps({'claw': next(row for row in rows if row['id'] == cid)}).encode()
        return fetch

    def test_current_all_paused_catalogue_has_no_invented_price_average_or_ev(self):
        rows = [machine(98, 'Wildcard'), machine(100, 'Gold TCG'), machine(104, 'Silver')]
        def no_browser(_):
            raise AssertionError('Paused current machines require no browser/average calculation')
        payload = target.collect_snapshot(self.fixture(rows), no_browser, now=lambda: 1000)
        self.assertTrue(validate(payload, 1001))
        self.assertEqual(payload['status'], 'unavailable')
        self.assertFalse(payload['pricesFresh'])
        self.assertEqual([row['tier'] for row in payload['results']], ['Wildcard', 'Gold TCG', 'Silver TCG'])
        self.assertTrue(all(row['price'] is None and row['avg'] is None and row['ev'] is None for row in payload['results']))

    def test_active_machine_uses_only_rendered_labelled_average(self):
        row = machine(status='active', stock=2)
        row['priceUsdc'] = 10000000
        payload = target.collect_snapshot(self.fixture([row]),
            lambda slug: (12, 'official-page-labelled-average'), now=lambda: 1000)
        quote = payload['results'][0]
        self.assertEqual((quote['price'], quote['avg'], quote['ev']), (10, 12, 20))
        self.assertTrue(validate(payload, 1001))
        with self.assertRaises(ValueError):
            target.collect_snapshot(self.fixture([row]), lambda slug: (None, 'no-match'))

    def test_parser_does_not_substitute_a_nearby_pull_price(self):
        self.assertEqual(target.parse_labelled_average('Average Value:\n\n$1,234.56\nClaw Price: $10'), 1234.56)
        self.assertIsNone(target.parse_labelled_average('Average Value:\n--\nClaw Price: $250'))
        self.assertIsNone(target.parse_labelled_average('Average Value: $0'))

    def test_empty_duplicate_invalid_and_wrong_query_catalogues_fail(self):
        for rows in ([], [machine(), machine()], [machine(cid=-1)], [machine(name='')],
                     [machine(cid=i + 1, name='Machine ' + str(i)) for i in range(17)]):
            with self.assertRaises(ValueError):
                target.discover_machines(catalogue(rows).decode())
        with self.assertRaises(ValueError):
            target.discover_machines(catalogue([machine()]).decode().replace('get-minimal-claws', 'wrong-query'))

    def test_catalogue_api_identity_and_unknown_states_fail_closed(self):
        descriptor = target.discover_machines(catalogue([machine()]).decode())[0]
        for row in [machine(cid=92), machine(name='Other'), machine(status='unknown'), machine(stock=-1)]:
            with self.assertRaises(ValueError):
                target.machine_result(descriptor, {'claw': row}, None, 1000000)

    def test_retired_machine_http_400_retains_previous_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder) / 'beezie-prices.json'
            output.write_bytes(b'previous exact quote bytes')
            def fetch(url):
                if url == target.CATALOGUE_URL:
                    return catalogue([machine()])
                raise urllib.error.HTTPError(url, 400, 'Claw is not available', {}, None)
            with patch.object(target, 'OUT', output), patch.object(target, 'public_get', fetch):
                self.assertEqual(target.main(), 1)
            self.assertEqual(output.read_bytes(), b'previous exact quote bytes')

    def test_paused_snapshot_requires_source_proof_and_null_current_quotes(self):
        payload = target.collect_snapshot(self.fixture([machine()]), None, now=lambda: 1000)
        for mutate in [lambda p: p['results'][0].update(avg=0),
                       lambda p: p['results'][0].update(price=250),
                       lambda p: p['results'][0]['sourceEvidence'].update(httpStatus=400),
                       lambda p: p['catalogue'].update(machineIds=[92]),
                       lambda p: p.update(pricesFresh=True)]:
            invalid = copy.deepcopy(payload); mutate(invalid)
            with self.assertRaises(ValueError):
                validate(invalid, 1001)

    def test_saved_actual_official_catalogue_and_all_three_api_responses(self):
        sources = Path(__file__).resolve().parents[2] / 'samples/beezie-public'
        if not (sources / 'claw-index.txt').is_file():
            self.skipTest('Audit-only official source samples are not packaged with the application')
        def fetch(url):
            name = 'claw-index' if url == target.CATALOGUE_URL else 'api-' + url.rsplit('/', 1)[-1]
            return (sources / (name + '.txt')).read_bytes()
        payload = target.collect_snapshot(fetch, None, now=lambda: 1000)
        self.assertTrue(validate(payload, 1001))
        self.assertEqual(payload['catalogue']['machineIds'], [98, 100, 104])
        self.assertEqual([row['status'] for row in payload['results']], ['paused'] * 3)


if __name__ == '__main__':
    unittest.main()
