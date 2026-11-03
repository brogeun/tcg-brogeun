"""Exercise the manual-login wait without a browser or authentication state."""
import contextlib
import copy
import io
import threading
from types import SimpleNamespace
import unittest
from unittest import mock

from scripts import collect_kream_promos as collector
from scripts import setup_kream_session as setup
from scripts.setup_kream_session import wait_for_owner_login


class ResponsiveHistoryPage:
    """The mobile copy precedes the usable desktop control in DOM order."""
    class Button:
        def __init__(self, name, visible, events):
            self.name, self.visible, self.events = name, visible, events

        def wait_for(self, *, state, timeout):
            if state != 'visible' or not self.visible:
                raise TimeoutError('The first responsive copy is hidden')

        def click(self):
            if not self.visible:
                raise AssertionError('A hidden responsive control was clicked')
            self.events.append(self.name + '.clicked')

    class Buttons:
        def __init__(self, candidates):
            self.candidates = candidates

        def filter(self, *, visible):
            return type(self)([node for node in self.candidates if node.visible == visible])

        @property
        def first(self):
            return self.candidates[0]

    class Rows:
        def __init__(self, page):
            self.page = page

        def nth(self, index):
            self.page.requested_rows.append(index)
            page = self.page

            class Row:
                def wait_for(self, *, state, timeout):
                    if state != 'visible' or index >= page.row_count:
                        raise TimeoutError('Only a five-trade preview is available')
                    page.events.append('row.' + str(index) + '.verified')

            return Row()

        def count(self):
            return self.page.row_count

    class Drawer:
        def __init__(self, page):
            self.page = page

        def filter(self, *, visible):
            return self

        @property
        def first(self):
            return self

        def is_visible(self):
            return 'visible.clicked' in self.page.events

        def wait_for(self, *, state, timeout):
            if state != 'visible' or not self.is_visible():
                raise TimeoutError('Drawer has not opened')

    def __init__(self, row_count=6):
        self.events, self.role_requests, self.requested_rows = [], [], []
        self.row_count = row_count
        self.url = setup.PRODUCT['source_url']
        self.hidden = self.Button('hidden', False, self.events)
        self.visible = self.Button('visible', True, self.events)

    def get_by_role(self, role, *, name):
        self.role_requests.append(role)
        if role != 'button' or not name.search('거래 내역 더보기'):
            raise AssertionError('The trade-history button was not requested')
        return self.Buttons([self.hidden, self.visible])

    def get_by_text(self, _name):
        # Model the previous selector: .first resolves to the hidden mobile copy.
        if not _name.search('거래 내역 더보기'):
            return SimpleNamespace(all=lambda: [])
        return self.Buttons([self.hidden, self.visible])

    def locator(self, selector):
        if selector == '.drawer':
            return self.Drawer(self)
        if selector != '.drawer .tab_content.show .price_body .body_list':
            raise AssertionError('Unexpected trade-row selector')
        return self.Rows(self)


class ResponsiveHistoryControlTests(unittest.TestCase):
    def test_shared_selector_skips_hidden_first_responsive_copy(self):
        page = ResponsiveHistoryPage()
        selected = collector.full_history_button(page)
        self.assertIs(selected, page.visible)
        self.assertEqual(page.role_requests, ['button'])

    def test_setup_opens_visible_control_and_verifies_sixth_trade(self):
        page = ResponsiveHistoryPage(row_count=6)
        with mock.patch.object(setup, 'open_product') as open_product, \
                mock.patch.object(setup, 'require_login_access') as require_login:
            setup.verify_full_history_access(page)
        open_product.assert_called_once_with(page, setup.PRODUCT)
        self.assertGreaterEqual(require_login.call_count, 2)
        self.assertEqual(page.role_requests, ['button'])
        self.assertEqual(page.requested_rows, [5])
        self.assertEqual(page.events, ['visible.clicked', 'row.5.verified'])

    def test_setup_rejects_public_five_trade_preview(self):
        page = ResponsiveHistoryPage(row_count=5)
        with mock.patch.object(setup, 'open_product'), \
                mock.patch.object(setup, 'require_login_access'):
            with self.assertRaises(collector.CollectionError) as caught:
                setup.verify_full_history_access(page)
        self.assertEqual(caught.exception.code, 'history_rows_unavailable')
        self.assertEqual(page.requested_rows, [5])
        self.assertEqual(page.events, ['visible.clicked'])

    def test_sixth_trade_failure_identifies_source_or_restored_phase(self):
        for phase in ('source', 'restored'):
            with self.subTest(phase=phase):
                page = ResponsiveHistoryPage(row_count=5)
                stages = []
                with mock.patch.object(setup, 'open_product'), \
                        mock.patch.object(setup, 'require_login_access'):
                    with self.assertRaises(collector.CollectionError):
                        setup.verify_full_history_access(
                            page, on_stage=stages.append, phase=phase)
                self.assertTrue(stages)
                self.assertEqual(stages[-1], phase + '_verify_sixth_trade')
                self.assertTrue(all(stage.startswith(phase + '_') for stage in stages))

    def test_daily_collector_also_opens_visible_control(self):
        page = ResponsiveHistoryPage()
        stop_after_opening = RuntimeError('Stop before collecting any rows')
        original_locator = page.locator

        def stop_at_rows(selector):
            if selector == '.drawer .tab_content.show .price_body .body_list':
                raise stop_after_opening
            return original_locator(selector)

        with mock.patch.object(collector, 'open_product'), \
                mock.patch.object(collector, 'require_login_access'), \
                mock.patch.object(page, 'locator', side_effect=stop_at_rows):
            with self.assertRaises(RuntimeError) as caught:
                collector.collect(page, setup.PRODUCT, {'rows': []})
        self.assertIs(caught.exception, stop_after_opening)
        self.assertEqual(page.role_requests, ['button'])
        self.assertEqual(page.events, ['visible.clicked'])


class OwnerLoginWaitTests(unittest.TestCase):
    def test_popup_progress_continues_while_console_input_waits(self):
        owner_thread = threading.current_thread()
        input_started = threading.Event()
        popup_ready = threading.Event()
        input_returned = threading.Event()
        input_threads = []
        browser_threads = []
        popup_events = []
        test = self

        def confirm(_prompt):
            input_threads.append(threading.current_thread())
            input_started.set()
            if not popup_ready.wait(2):
                raise EOFError('Popup never progressed while console input waited')
            input_returned.set()
            return ''

        class FakePage:
            def wait_for_timeout(self, milliseconds):
                browser_threads.append(threading.current_thread())
                test.assertIs(threading.current_thread(), owner_thread)
                test.assertEqual(milliseconds, 100)
                test.assertTrue(input_started.wait(2))
                if not popup_events:
                    popup_events.append('created')
                elif len(popup_events) == 1:
                    popup_events.append('loaded')
                    popup_ready.set()
                    test.assertTrue(input_returned.wait(2))

        with mock.patch('builtins.input', side_effect=confirm) as console_input:
            wait_for_owner_login(FakePage(), 'Confirm after manual login: ')

        console_input.assert_called_once_with('Confirm after manual login: ')
        self.assertEqual(popup_events, ['created', 'loaded'])
        self.assertTrue(browser_threads)
        self.assertEqual(len(input_threads), 1)
        self.assertIsNot(input_threads[0], owner_thread)
        self.assertTrue(input_threads[0].daemon)
        input_threads[0].join(2)
        self.assertFalse(input_threads[0].is_alive())

    def test_console_eof_is_propagated_to_the_owner_thread(self):
        owner_thread = threading.current_thread()
        release_input = threading.Event()
        input_raised = threading.Event()
        expected = EOFError('Console was closed')
        test = self

        def closed_console(_prompt):
            if not release_input.wait(2):
                raise EOFError('Browser event pump never ran')
            input_raised.set()
            raise expected

        class FakePage:
            def wait_for_timeout(self, milliseconds):
                test.assertIs(threading.current_thread(), owner_thread)
                test.assertEqual(milliseconds, 100)
                release_input.set()
                test.assertTrue(input_raised.wait(2))

        with mock.patch('builtins.input', side_effect=closed_console):
            with self.assertRaises(EOFError) as caught:
                wait_for_owner_login(FakePage(), 'Confirm: ')
        self.assertIs(caught.exception, expected)

    def test_page_closure_is_propagated_while_input_is_still_pending(self):
        owner_thread = threading.current_thread()
        input_started = threading.Event()
        release_input = threading.Event()
        input_threads = []
        expected = RuntimeError('Browser page has been closed')
        test = self

        def waiting_console(_prompt):
            input_threads.append(threading.current_thread())
            input_started.set()
            release_input.wait(2)
            return ''

        class ClosedPage:
            def wait_for_timeout(self, milliseconds):
                test.assertIs(threading.current_thread(), owner_thread)
                test.assertEqual(milliseconds, 100)
                test.assertTrue(input_started.wait(2))
                test.assertFalse(release_input.is_set())
                raise expected

        try:
            with mock.patch('builtins.input', side_effect=waiting_console):
                with self.assertRaises(RuntimeError) as caught:
                    wait_for_owner_login(ClosedPage(), 'Confirm: ')
                self.assertIs(caught.exception, expected)
        finally:
            release_input.set()
            for thread in input_threads:
                thread.join(2)
                self.assertFalse(thread.is_alive())


class SessionReplaySelectionTests(unittest.TestCase):
    native = {'cookies': [{'domain': '.kream.co.kr', 'value': 'PRIVATE-TEST'}], 'origins': []}
    candidate = {**native, 'sessionStorage': {'https://kream.co.kr': {'token': 'PRIVATE-TAB-TEST'}}}

    def source_context(self):
        return mock.Mock(storage_state=mock.Mock(side_effect=lambda **_: copy.deepcopy(self.native)))

    def test_native_success_never_captures_additional_tab_state(self):
        context, page = self.source_context(), mock.Mock()
        with mock.patch.object(setup, 'verify_restored_state') as verify, \
                mock.patch.object(setup, 'capture_tab_state') as capture:
            result = setup.choose_restorable_state(mock.Mock(), context, page)
        self.assertEqual(result, self.native)
        verify.assert_called_once()
        capture.assert_not_called()

    def test_tab_only_login_can_be_verified_without_native_state(self):
        context = mock.Mock(storage_state=mock.Mock(return_value={'cookies': [], 'origins': []}))
        candidate = {'cookies': [], 'origins': [], 'sessionStorage': {'https://kream.co.kr': {'token': 'PRIVATE-TAB-ONLY'}}}
        with mock.patch.object(setup, 'verify_restored_state') as verify, \
                mock.patch.object(setup, 'capture_tab_state', return_value=candidate):
            result = setup.choose_restorable_state(mock.Mock(), context, mock.Mock())
        self.assertEqual(result, candidate)
        verify.assert_called_once()
        self.assertEqual(verify.call_args.args[1], candidate)
        self.assertEqual(verify.call_args.kwargs['phase'], 'restored_with_tab_storage')

    def test_authentication_or_http_denial_does_not_retry_or_capture(self):
        for code in ('access_denied', 'source_http_error', 'unexpected_redirect'):
            with self.subTest(code=code):
                error = collector.CollectionError(code, 'Safe failure')
                with mock.patch.object(setup, 'verify_restored_state', side_effect=error) as verify, \
                        mock.patch.object(setup, 'capture_tab_state') as capture:
                    with self.assertRaises(collector.CollectionError) as caught:
                        setup.choose_restorable_state(mock.Mock(), self.source_context(), mock.Mock())
                self.assertIs(caught.exception, error)
                verify.assert_called_once()
                capture.assert_not_called()

    def test_empty_tab_state_preserves_the_original_restore_error(self):
        error = collector.CollectionError('history_rows_unavailable', 'Safe failure')
        with mock.patch.object(setup, 'verify_restored_state', side_effect=error) as verify, \
                mock.patch.object(setup, 'capture_tab_state', return_value=None):
            with self.assertRaises(collector.CollectionError) as caught:
                setup.choose_restorable_state(mock.Mock(), self.source_context(), mock.Mock())
        self.assertIs(caught.exception, error)
        verify.assert_called_once()

    def test_additional_state_is_returned_only_after_its_own_replay_passes(self):
        initial = collector.CollectionError('session_expired', 'Safe failure')
        with mock.patch.object(setup, 'verify_restored_state', side_effect=[initial, None]) as verify, \
                mock.patch.object(setup, 'capture_tab_state', return_value=self.candidate):
            result = setup.choose_restorable_state(mock.Mock(), self.source_context(), mock.Mock())
        self.assertEqual(result, self.candidate)
        self.assertEqual(verify.call_count, 2)
        self.assertEqual(verify.call_args.args[1], self.candidate)
        self.assertEqual(verify.call_args.kwargs['phase'], 'restored_with_tab_storage')

    def test_failed_additional_replay_cannot_return_a_working_state(self):
        initial = collector.CollectionError('session_expired', 'Safe failure')
        final = collector.CollectionError('history_rows_unavailable', 'Still unavailable')
        with mock.patch.object(setup, 'verify_restored_state', side_effect=[initial, final]) as verify, \
                mock.patch.object(setup, 'capture_tab_state', return_value=self.candidate), \
                mock.patch.object(setup, 'upload_session') as upload:
            with self.assertRaises(collector.CollectionError) as caught:
                setup.choose_restorable_state(mock.Mock(), self.source_context(), mock.Mock())
        self.assertIs(caught.exception, final)
        self.assertEqual(verify.call_count, 2)
        upload.assert_not_called()

    def test_unclassified_runtime_error_does_not_capture_or_retry(self):
        error = RuntimeError('PRIVATE-RUNTIME-ERROR')
        with mock.patch.object(setup, 'verify_restored_state', side_effect=error) as verify, \
                mock.patch.object(setup, 'capture_tab_state') as capture:
            with self.assertRaises(RuntimeError) as caught:
                setup.choose_restorable_state(mock.Mock(), self.source_context(), mock.Mock())
        self.assertIs(caught.exception, error)
        verify.assert_called_once()
        capture.assert_not_called()

    def test_failed_restored_context_is_closed(self):
        context = mock.Mock()
        error = collector.CollectionError('history_rows_unavailable', 'Safe failure')
        with mock.patch.object(setup, 'browser_context_for_session', return_value=context), \
                mock.patch.object(setup, 'verify_full_history_access', side_effect=error):
            with self.assertRaises(collector.CollectionError):
                setup.verify_restored_state(mock.Mock(), self.native)
        context.close.assert_called_once()

    def test_foreign_snapshot_is_not_exported(self):
        context, page = self.source_context(), mock.Mock()
        page.evaluate.return_value = {'origin': 'https://unrelated.example', 'entries': {'token': 'PRIVATE-FOREIGN'}}
        self.assertIsNone(setup.capture_tab_state(context, page))
        context.storage_state.assert_not_called()

    def test_tab_capture_stays_in_memory_and_does_not_print_values(self):
        context, page = self.source_context(), mock.Mock()
        page.evaluate.return_value = {'origin': 'https://kream.co.kr', 'entries': {'token': 'PRIVATE-TAB-TEST'}}
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = setup.capture_tab_state(context, page)
        self.assertEqual(result, self.candidate)
        self.assertNotIn('PRIVATE', output.getvalue())
        expression = page.evaluate.call_args.args[0]
        self.assertLess(expression.index('allowed.includes'), expression.index('window.sessionStorage'))


class CredentialFreeDiagnosticsTests(unittest.TestCase):
    def test_final_size_limit_covers_additional_tab_state(self):
        state = {'cookies': [], 'origins': [], 'sessionStorage': {'https://kream.co.kr': {'token': 'x' * (50 * 1024)}}}
        with mock.patch.object(setup.subprocess, 'run') as run:
            with self.assertRaises(collector.CollectionError) as caught:
                setup.upload_session(state)
        self.assertEqual(caught.exception.code, 'session_too_large')
        run.assert_not_called()

    def test_browser_exception_reports_stage_without_raw_private_message(self):
        manager = mock.MagicMock()
        manager.__enter__.return_value.chromium.launch.side_effect = RuntimeError('PRIVATE-URL-AND-TOKEN')
        runtime = SimpleNamespace(sync_playwright=lambda: manager)
        output = io.StringIO()
        with mock.patch.dict('sys.modules', {'playwright': SimpleNamespace(), 'playwright.sync_api': runtime}), \
                mock.patch.object(setup.shutil, 'which', return_value='gh'), \
                mock.patch.object(setup.subprocess, 'run', return_value=SimpleNamespace(returncode=0)), \
                contextlib.redirect_stdout(output):
            self.assertEqual(setup.main([]), 1)
        self.assertIn('failed_stage=launch_browser; error_type=RuntimeError', output.getvalue())
        self.assertNotIn('PRIVATE-URL-AND-TOKEN', output.getvalue())

    def test_secret_registration_failure_has_fixed_public_code(self):
        state = {'cookies': [{'domain': '.kream.co.kr', 'value': 'PRIVATE-SESSION'}], 'origins': []}
        with mock.patch.object(setup.subprocess, 'run', return_value=SimpleNamespace(returncode=1, stderr=b'PRIVATE-CLI-ERROR')):
            with self.assertRaises(collector.CollectionError) as caught:
                setup.upload_session(state)
        self.assertEqual(caught.exception.code, 'secret_upload_failed')
        self.assertNotIn('PRIVATE', str(caught.exception))


if __name__ == '__main__':
    unittest.main()
