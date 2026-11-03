"""Exercise the manual-login wait without a browser or authentication state."""
import threading
import unittest
from unittest import mock

from scripts.setup_kream_session import wait_for_owner_login


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


if __name__ == '__main__':
    unittest.main()
