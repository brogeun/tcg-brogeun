"""Exercise scoped session restoration and normal drawer opening without a browser."""
import copy
import json
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import collect_kream_promos as collector


class SessionStorageTests(unittest.TestCase):
    native = {
        'cookies': [{'domain': '.kream.co.kr', 'name': 'test', 'value': 'DUMMY-ONLY'}],
        'origins': [],
    }

    def state(self, entries=None):
        state = copy.deepcopy(self.native)
        if entries is not None:
            state['sessionStorage'] = entries
        return state

    def test_legacy_state_shape_and_native_context_remain_unchanged(self):
        state = self.state()
        checked = collector.session_state(json.dumps(state))
        self.assertEqual(checked, state)
        self.assertNotIn('sessionStorage', checked)
        browser = mock.Mock()
        context = collector.browser_context_for_session(browser, state, locale='ko-KR')
        browser.new_context.assert_called_once_with(storage_state=state, locale='ko-KR')
        context.add_init_script.assert_not_called()
        context.new_page.assert_not_called()

    def test_only_exact_first_party_session_origins_are_retained(self):
        expected = {'https://kream.co.kr': {'key': 'value'},
                    'https://www.kream.co.kr': {'second': 'value'}}
        entries = dict(expected)
        entries.update({
            'https://evil-kream.co.kr': {'key': 'FOREIGN-PRIVATE'},
            'https://kream.co.kr.evil.example': 'malformed foreign entry',
            'https://login.kream.co.kr': {'key': 'FOREIGN-PRIVATE'},
            'http://kream.co.kr': {'key': 'FOREIGN-PRIVATE'},
            'https://kream.co.kr/': {'key': 'FOREIGN-PRIVATE'},
        })
        checked = collector.session_state(json.dumps(self.state(entries)))
        self.assertEqual(checked['sessionStorage'], expected)
        self.assertNotIn('FOREIGN-PRIVATE', json.dumps(checked))

    def test_invalid_first_party_entries_have_fixed_credential_free_errors(self):
        for entries in (None, [], 'PRIVATE-VALUE',
                        {'https://kream.co.kr': []},
                        {'https://kream.co.kr': {'key': 123}},
                        {'https://www.kream.co.kr': {'key': {'nested': 'PRIVATE-VALUE'}}}):
            with self.subTest(kind=type(entries).__name__):
                state = self.state()
                state['sessionStorage'] = entries
                with self.assertRaises(collector.CollectionError) as caught:
                    collector.session_state(json.dumps(state))
                self.assertEqual(caught.exception.code, 'session_invalid')
                self.assertNotIn('PRIVATE-VALUE', str(caught.exception))

    def test_session_storage_alone_is_valid_only_with_nonempty_first_party_data(self):
        state = {'cookies': [], 'origins': [],
                 'sessionStorage': {'https://kream.co.kr': {'key': 'DUMMY-ONLY'}}}
        self.assertEqual(collector.session_state(json.dumps(state)), state)
        for entries in ({}, {'https://foreign.example': {'key': 'DUMMY-ONLY'}},
                        {'https://kream.co.kr': {}}):
            state['sessionStorage'] = entries
            with self.assertRaises(collector.CollectionError):
                collector.session_state(json.dumps(state))

    def test_extra_storage_is_not_passed_to_playwright_and_script_precedes_page(self):
        state = self.state({'https://kream.co.kr': {'key': 'DUMMY-ONLY'}})
        original = copy.deepcopy(state)
        order = []
        context = mock.Mock()
        context.add_init_script.side_effect = lambda **_kwargs: order.append('init-script')
        context.new_page.side_effect = lambda: order.append('new-page')
        browser = mock.Mock()
        browser.new_context.side_effect = lambda **_kwargs: (order.append('context') or context)
        restored = collector.browser_context_for_session(browser, state, timezone_id='Asia/Seoul')
        self.assertEqual(order, ['context', 'init-script'])
        restored.new_page()
        self.assertEqual(order, ['context', 'init-script', 'new-page'])
        self.assertEqual(browser.new_context.call_args.kwargs,
                         {'storage_state': self.native, 'timezone_id': 'Asia/Seoul'})
        self.assertEqual(state, original)

    def test_restore_errors_never_include_private_browser_messages(self):
        browser = mock.Mock()
        browser.new_context.return_value.add_init_script.side_effect = RuntimeError('PRIVATE-SCRIPT')
        with self.assertRaises(collector.CollectionError) as caught:
            collector.browser_context_for_session(
                browser, self.state({'https://kream.co.kr': {'key': 'DUMMY-ONLY'}}))
        self.assertEqual(caught.exception.code, 'session_invalid')
        self.assertNotIn('PRIVATE', str(caught.exception))
        browser.new_context.return_value.close.assert_called_once_with()

    def restored_script(self, entries):
        browser = mock.Mock()
        context = collector.browser_context_for_session(browser, self.state(entries))
        return context.add_init_script.call_args.kwargs['script']

    @unittest.skipUnless(shutil.which('node'), 'Node is required to execute the init script')
    def test_json_safe_script_restores_data_without_executing_values(self):
        entries = {'https://kream.co.kr': {
            'quotes"\\\n': "'); globalThis.injected = true; //\u2028\u2029",
            '__proto__': 'plain-data',
        }}
        script = self.restored_script(entries)
        harness = r'''
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(0, 'utf8'));
const values = new Map();
globalThis.window = {location: {origin: 'https://kream.co.kr'}, sessionStorage: {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, value)
}};
eval(data.script);
process.stdout.write(JSON.stringify({values: Object.fromEntries(values), injected: globalThis.injected === true}));
'''
        result = subprocess.run([shutil.which('node'), '-e', harness],
                                input=json.dumps({'script': script}), text=True,
                                capture_output=True, check=True, timeout=5)
        actual = json.loads(result.stdout)
        self.assertEqual(actual['values'], entries['https://kream.co.kr'])
        self.assertFalse(actual['injected'])

    @unittest.skipUnless(shutil.which('node'), 'Node is required to execute the init script')
    def test_script_preserves_rotated_values_and_never_seeds_another_origin(self):
        script = self.restored_script({'https://kream.co.kr': {'token': 'old', 'new-key': 'seed'}})
        harness = r'''
const fs = require('fs');
const {script} = JSON.parse(fs.readFileSync(0, 'utf8'));
function run(origin, initial) {
  const values = new Map(Object.entries(initial));
  globalThis.window = {location: {origin}, sessionStorage: {
    getItem: key => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, value)
  }};
  eval(script);
  return Object.fromEntries(values);
}
process.stdout.write(JSON.stringify({
  first: run('https://kream.co.kr', {token: 'rotated'}),
  second: run('https://kream.co.kr', {token: 'rotated-again', 'new-key': 'also-rotated'}),
  foreign: run('https://kream.co.kr.evil.example', {}),
  other: run('https://www.kream.co.kr', {})
}));
'''
        result = subprocess.run([shutil.which('node'), '-e', harness],
                                input=json.dumps({'script': script}), text=True,
                                capture_output=True, check=True, timeout=5)
        actual = json.loads(result.stdout)
        self.assertEqual(actual['first'], {'token': 'rotated', 'new-key': 'seed'})
        self.assertEqual(actual['second'], {'token': 'rotated-again', 'new-key': 'also-rotated'})
        self.assertEqual(actual['foreign'], {})
        self.assertEqual(actual['other'], {})


class DrawerPage:
    def __init__(self, *, opens_on_click=1, deny_after_click=False, opens_during_load=False):
        self.url = 'https://kream.co.kr/products/1096144'
        self.opens_on_click, self.deny_after_click = opens_on_click, deny_after_click
        self.opens_during_load = opens_during_load
        self.clicks, self.loads, self.visible = 0, 0, False
        self.drawer = self.Drawer(self)

    class Drawer:
        def __init__(self, page):
            self.page = page

        def filter(self, *, visible):
            assert visible is True
            return self

        @property
        def first(self):
            return self

        def wait_for(self, *, state, timeout):
            assert state == 'visible'
            if not self.page.visible:
                raise TimeoutError('The click had no effect')

        def is_visible(self):
            return self.page.visible

    class Button:
        def __init__(self, page):
            self.page = page

        def wait_for(self, *, state, timeout):
            assert state == 'visible'

        def click(self):
            self.page.clicks += 1
            if self.page.deny_after_click:
                self.page.url = 'https://kream.co.kr/login'
            elif self.page.clicks >= self.page.opens_on_click:
                self.page.visible = True

    def get_by_text(self, _name):
        return SimpleNamespace(all=lambda: [])

    def locator(self, selector):
        if selector != '.drawer':
            raise AssertionError('Unexpected selector')
        return self.drawer

    def wait_for_load_state(self, state, *, timeout):
        assert state == 'load'
        self.loads += 1
        if self.opens_during_load:
            self.visible = True


class DrawerOpeningTests(unittest.TestCase):
    def test_normal_drawer_needs_one_click_and_no_hydration_retry(self):
        page = DrawerPage()
        with mock.patch.object(collector, 'full_history_button', return_value=page.Button(page)):
            self.assertIs(collector.open_history_drawer(page), page.drawer)
        self.assertEqual((page.clicks, page.loads), (1, 0))

    def test_ignored_first_click_retries_once_after_load(self):
        page = DrawerPage(opens_on_click=2)
        with mock.patch.object(collector, 'full_history_button', return_value=page.Button(page)):
            self.assertIs(collector.open_history_drawer(page), page.drawer)
        self.assertEqual((page.clicks, page.loads), (2, 1))

    def test_no_drawer_after_two_clicks_is_a_fixed_failure(self):
        page = DrawerPage(opens_on_click=99)
        with mock.patch.object(collector, 'full_history_button', return_value=page.Button(page)):
            with self.assertRaises(collector.CollectionError) as caught:
                collector.open_history_drawer(page)
        self.assertEqual(caught.exception.code, 'trade_drawer_unavailable')
        self.assertEqual((page.clicks, page.loads), (2, 1))

    def test_drawer_opening_during_load_is_not_clicked_closed(self):
        page = DrawerPage(opens_on_click=99, opens_during_load=True)
        with mock.patch.object(collector, 'full_history_button', return_value=page.Button(page)):
            self.assertIs(collector.open_history_drawer(page), page.drawer)
        self.assertEqual((page.clicks, page.loads), (1, 1))

    def test_login_requirement_after_click_stops_without_retry(self):
        page = DrawerPage(deny_after_click=True)
        with mock.patch.object(collector, 'full_history_button', return_value=page.Button(page)):
            with self.assertRaises(collector.CollectionError) as caught:
                collector.open_history_drawer(page)
        self.assertEqual(caught.exception.code, 'session_expired')
        self.assertEqual((page.clicks, page.loads), (1, 0))

    def test_denied_product_page_never_opens_or_retries_the_drawer(self):
        for status in (401, 403, 429):
            with self.subTest(status=status):
                page = DrawerPage()
                page.goto = mock.Mock(return_value=SimpleNamespace(status=status))
                with self.assertRaises(collector.CollectionError) as caught:
                    collector.collect(page, {'id': '1096144', 'source_url': page.url}, {'rows': []})
                self.assertEqual(caught.exception.code, 'access_denied')
                page.goto.assert_called_once()
                self.assertEqual((page.clicks, page.loads), (0, 0))


if __name__ == '__main__':
    unittest.main()
