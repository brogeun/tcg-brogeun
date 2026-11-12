"""Offline recovery checks; no browser, phone request or GitHub write is made."""
from datetime import datetime, timedelta
import json
from pathlib import Path
import shutil
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import collect_with_diagnostics as diagnostic
from kream_login_alerts import LoginAlerts, MARKER, PREFIX
from kream_phone_login import request_phone_challenge
from kream_recovery_control import ACTION_SCRIPT, RecoveryController

sys.path.insert(0, str(diagnostic.RELEASE))
import run_kream_local as runner


class Locator:
    def __init__(self, count=0):
        self.n = count
        self.filled = []
        self.clicks = 0

    def filter(self, **kwargs): return self
    def count(self): return self.n
    def all(self): return []
    def is_enabled(self): return True
    def fill(self, value, **kwargs): self.filled.append(value)
    def click(self, **kwargs): self.clicks += 1


class Page:
    def __init__(self, *, action='', closed=False):
        self.url = 'https://kream.co.kr/products/1096144'
        self.action = action
        self.closed = closed
        self.waits = []

    def get_by_placeholder(self, *a, **k): return Locator()
    def get_by_label(self, *a, **k): return Locator()
    def goto(self, url, **kwargs): self.url = url
    def get_by_role(self, *a, **k): return Locator()
    def get_by_text(self, *a, **k): return Locator()
    def evaluate(self, script, *args):
        if script == ACTION_SCRIPT:
            action, self.action = self.action, ''
            return {'present': True, 'action': action}
        return None
    def is_closed(self): return self.closed
    def wait_for_timeout(self, milliseconds): self.waits.append(milliseconds)


class RecoveryChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=diagnostic.ROOT / 'recovery')
        self.root = Path(self.temporary.name)
        (self.root / 'recovery').mkdir()
        self.events = []
        self.runtime = SimpleNamespace(collector=runner.collector, verify_full_history_access=Mock())
        self.control = RecoveryController(self.runtime, self.root,
            lambda code, **details: self.events.append((code, details)), wait_seconds=1, clock=lambda: 0)

    def tearDown(self): self.temporary.cleanup()

    def test_login_wait_resumes_after_actual_history_verification(self):
        page = Page(action='retry')
        self.control.wait_for_owner(page, login=True)
        self.runtime.verify_full_history_access.assert_called_once()
        self.assertFalse(page.closed)
        self.assertIn('resuming_after_owner_login', [code for code, details in self.events])

    def test_timeout_is_not_reported_as_expired_login(self):
        page = Page()
        self.runtime.verify_full_history_access.side_effect = TimeoutError()
        with patch.object(self.control, 'wait_for_owner', side_effect=RuntimeError('observed wait')) as wait:
            with self.assertRaisesRegex(RuntimeError, 'observed wait'):
                self.control.ensure_authenticated(page)
        self.assertEqual(self.runtime.verify_full_history_access.call_count, 2)
        self.assertFalse(wait.call_args.kwargs['login'])
        self.assertFalse(page.closed)

    def test_confirmed_expiration_waits_for_phone_login(self):
        self.runtime.verify_full_history_access.side_effect = runner.collector.CollectionError('session_expired', 'fixed failure')
        with patch.object(self.control, 'wait_for_owner') as wait:
            self.control.ensure_authenticated(Page())
        self.assertTrue(wait.call_args.kwargs['login'])

    def test_rendering_failure_is_not_misclassified_as_expired_login(self):
        with patch.object(runner.collector, 'require_login_access', side_effect=TimeoutError()):
            self.assertFalse(self.control.auth_missing(Page(), TimeoutError()))

    def test_owner_close_stops_without_retrying_authentication(self):
        with self.assertRaises(runner.collector.CollectionError) as raised:
            self.control.wait_for_owner(Page(closed=True), login=False)
        self.assertEqual(raised.exception.code, 'owner_closed_browser')
        self.runtime.verify_full_history_access.assert_not_called()

    def test_phone_challenge_is_not_repeated_after_process_restart(self):
        self.control.settings = {'phone_login_enabled': True, 'phone_number': '01000000000'}
        with patch('kream_recovery_control.request_phone_challenge', return_value='challenge_submitted') as request:
            self.control.phone_request(Page())
            second = RecoveryController(self.runtime, self.root, lambda *a, **k: None)
            second.settings = self.control.settings
            second.phone_request(Page())
            second.phone_request(Page(), resend=True)
        self.assertEqual(request.call_count, 1)
        state = json.loads(self.control.request_path.read_bytes())
        self.assertNotIn('phone_number', state)

    def test_explicit_resend_is_allowed_after_cooldown(self):
        self.control.settings = {'phone_login_enabled': True, 'phone_number': '01000000000'}
        self.control.save(self.control.request_path, {'schemaVersion': 1, 'resolved': False,
            'attempted_at': (datetime.now(runner.collector.KST)-timedelta(minutes=6)).isoformat(),
            'status': 'challenge_submitted'})
        with patch('kream_recovery_control.request_phone_challenge', return_value='challenge_submitted') as request:
            self.control.phone_request(Page(), resend=True)
        request.assert_called_once()

    def test_a_failed_field_lookup_is_not_cached_forever(self):
        self.control.settings = {'phone_login_enabled': True, 'phone_number': '01000000000'}
        self.control.save(self.control.request_path, {'schemaVersion': 1, 'resolved': False,
            'attempted_at': datetime.now(runner.collector.KST).isoformat(),
            'status': 'phone_input_not_found'})
        with patch('kream_recovery_control.request_phone_challenge', return_value='challenge_submitted') as request:
            self.assertEqual(self.control.phone_request(Page()), 'challenge_submitted')
        request.assert_called_once()

    def test_uncertain_submission_is_not_automatically_repeated(self):
        self.control.settings = {'phone_login_enabled': True, 'phone_number': '01000000000'}
        with patch('kream_recovery_control.request_phone_challenge', side_effect=TimeoutError()) as request:
            self.assertEqual(self.control.phone_request(Page()), 'request_outcome_unknown')
            self.assertEqual(self.control.phone_request(Page()), 'request_outcome_unknown')
        self.assertEqual(request.call_count, 1)

    def test_a_previous_days_phone_challenge_does_not_block_a_new_run(self):
        self.control.settings = {'phone_login_enabled': True, 'phone_number': '01000000000'}
        self.control.save(self.control.request_path, {'schemaVersion': 1, 'resolved': False,
            'attempted_at': (datetime.now(runner.collector.KST)-timedelta(days=1)).isoformat(),
            'status': 'challenge_submitted'})
        with patch('kream_recovery_control.request_phone_challenge', return_value='challenge_submitted') as request:
            self.control.phone_request(Page())
        request.assert_called_once()

    def test_failed_product_does_not_block_six_verified_products(self):
        generation = self.root / 'generation'
        shutil.copytree(diagnostic.ROOT / 'recovery' / 'verified-baseline', generation)
        calls = []
        review_states = []
        failed_once = set()

        def collect(page, card, old):
            calls.append(card['id'])
            if card['id'] == '893073' and card['id'] not in failed_once:
                failed_once.add(card['id'])
                raise ValueError('Incomplete current source')
            now=datetime.now(runner.collector.KST).isoformat()
            old.update(snapshot_started_at=now,last_observed_at=now,target_count=len(old['rows']))
            return old

        def review(page, **kwargs):
            review_states.append((set(calls), kwargs))

        page = Page()
        with patch.object(self.control, 'ensure_authenticated'), \
             patch.object(self.control, 'wait_for_owner', side_effect=review), \
             patch.object(runner.collector, 'collect', side_effect=collect):
            result = self.control.collect_generation(SimpleNamespace(pages=[page]), generation, lambda *a, **k: None)
        self.assertEqual(len(result['cards']), 7)
        self.assertEqual(result['collected_trade_count'], 16363)
        self.assertEqual(review_states, [])
        self.assertEqual(result['refresh']['status'],'partial')
        self.assertEqual(result['refresh']['failed_product_ids'],['893073'])
        self.assertEqual(calls.count('1096144'), 1)
        self.assertEqual(calls.count('893073'), 1)
        self.assertFalse(page.closed)


class Api:
    def __init__(self):
        self.calls = []
        self.pull = None
        self.creation_count = 0
        self.fail_after_create = False

    def __call__(self, endpoint, *, method='GET', payload=None):
        self.calls.append((endpoint, method, payload))
        if endpoint == 'git/ref/heads/main': return {'object': {'sha': 'a'*40}}
        if endpoint.startswith('git/commits/') and method == 'GET': return {'tree': {'sha': 'b'*40}}
        if endpoint == 'git/trees': return {'sha': 'c'*40}
        if endpoint == 'git/commits': return {'sha': 'd'*40}
        if endpoint == 'git/refs': return {}
        if endpoint.startswith('pulls?'): return [self.pull] if self.pull and self.pull['state']=='open' else []
        if endpoint == 'pulls' and method == 'POST':
            self.creation_count += 1
            self.pull = {'number': 123, 'state': 'open', 'title': payload['title'],
                'head': {'ref': payload['head']}, 'base': {'ref': payload['base']},
                'body': payload['body'], 'html_url': 'https://github.com/brogeun/tcg-brogeun/pull/123'}
            if self.fail_after_create:
                self.fail_after_create = False
                raise RuntimeError('Simulated lost response')
            return self.pull
        if endpoint == 'pulls/123':
            if method == 'PATCH': self.pull['state'] = payload['state']
            return self.pull
        raise AssertionError('Unexpected endpoint: ' + endpoint)


class AlertChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir=diagnostic.ROOT / 'recovery')
        self.root = Path(self.temporary.name)
        self.api = Api()
        self.alerts = LoginAlerts(self.api, self.root,
            lambda path, value: runner.collector.replace_file(path, runner.collector.encoded(value)))

    def tearDown(self): self.temporary.cleanup()

    def test_one_event_per_incident_and_only_notification_file_is_written(self):
        first = self.alerts.ensure_open('challenge_submitted')
        second = self.alerts.ensure_open('challenge_submitted')
        self.assertEqual(first['incident_id'], second['incident_id'])
        self.assertEqual(self.api.creation_count, 1)
        trees = [payload for endpoint, method, payload in self.api.calls if endpoint == 'git/trees']
        self.assertEqual([entry['path'] for entry in trees[0]['tree']], [MARKER])
        serialized = json.dumps(self.api.calls)
        self.assertNotIn('01000000000', serialized)
        self.assertNotIn('phone_number', serialized)
        self.alerts.resolve()
        self.assertEqual(self.api.pull['state'], 'closed')
        self.assertTrue(json.loads(self.alerts.path.read_bytes())['resolved'])

    def test_lost_creation_response_does_not_create_a_second_pr(self):
        self.api.fail_after_create = True
        with self.assertRaises(RuntimeError): self.alerts.ensure_open('challenge_submitted')
        self.alerts.ensure_open('challenge_submitted')
        self.assertEqual(self.api.creation_count, 1)

    def test_unrelated_pr_cannot_be_closed(self):
        self.alerts.ensure_open('challenge_submitted')
        self.api.pull['head']['ref'] = 'unrelated-branch'
        with self.assertRaises(ValueError): self.alerts.resolve()
        self.assertFalse(any(method == 'PATCH' for endpoint, method, payload in self.api.calls))

    def test_new_relay_readiness_replaces_the_failed_notification_once(self):
        first = self.alerts.ensure_open('phone_input_not_found')
        second = self.alerts.ensure_open('challenge_submitted', relay_ready=True,
                                         relay_expires_at='2026-11-08T01:00:00+09:00')
        third = self.alerts.ensure_open('challenge_submitted', relay_ready=True)
        self.assertEqual(self.api.creation_count, 2)
        self.assertNotEqual(first['incident_id'], second['incident_id'])
        self.assertEqual(second['incident_id'], third['incident_id'])

    def test_expired_login_incident_does_not_hide_the_next_notification(self):
        self.alerts.ensure_open('challenge_submitted')
        state = self.alerts._read()
        state['created_at'] = (datetime.now(runner.collector.KST)-timedelta(hours=2)).isoformat()
        self.alerts._store(state)
        self.alerts.ensure_open('challenge_submitted')
        self.assertEqual(self.api.creation_count, 2)


class PhoneChecks(unittest.TestCase):
    def test_phone_is_filled_only_on_kream_and_codes_are_not_read(self):
        phone, button = Locator(1), Locator(1)
        page = Page()
        page.url = 'https://kream.co.kr/login'
        page.locator = lambda selector: phone if selector.startswith('input[type="tel"]') else Locator()
        page.get_by_role = lambda *a, **k: button
        self.assertEqual(request_phone_challenge(page, '01000000000'), 'challenge_submitted')
        self.assertEqual(phone.filled, ['01000000000'])
        self.assertEqual(button.clicks, 1)

    def test_other_origin_never_receives_the_phone_number(self):
        page = Page()
        page.url = 'https://example.org/login'
        self.assertEqual(request_phone_challenge(page, '01000000000'), 'owner_action_required')


if __name__ == '__main__': unittest.main()
