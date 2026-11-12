"""Dummy-code checks: real local IPC and isolated, fully intercepted browser forms."""
import contextlib
from datetime import datetime
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import kream_phone_login as phone
from kream_chat_bridge import (AuthBridge, BridgeError, Command, current_sid,
                               original_owner_sid, send)
from kream_recovery_control import RecoveryController
from submit_kream_code import main as submit_main
import collect_with_diagnostics as diagnostic
from test_kream_recovery_control import Page

sys.path.insert(0, str(diagnostic.RELEASE))
import run_kream_local as runner


class PipeChecks(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / 'recovery').mkdir()
        self.owner = current_sid()
        self.bridge = AuthBridge(self.root, owner_sid=self.owner, client_sid=self.owner)
        self.bridge.set_state('awaiting_code', new_challenge=True)
        self.stop = threading.Event()
        self.commands = []
        self.failure = []

        def poll():
            try:
                while not self.stop.is_set():
                    command = self.bridge.poll()
                    if command is not None:
                        self.commands.append(command)
                    self.stop.wait(0.01)
            except Exception as error:
                self.failure.append(type(error).__name__)

        self.thread = threading.Thread(target=poll, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.stop.set()
        self.thread.join(2)
        self.bridge.close()
        self.assertFalse(self.thread.is_alive())
        self.assertEqual(self.failure, [])
        self.temporary.cleanup()

    def send(self, action, **kwargs):
        return send(self.root, action, owner_sid=self.owner, **kwargs)

    def test_real_pipe_accepts_one_code_and_disk_contains_no_code(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            result = self.send('submit_code', code='123456')
        self.assertEqual(result['result'], 'accepted')
        self.assertEqual(len(self.commands), 1)
        self.assertEqual(self.commands[0].code, '123456')
        self.assertNotIn('123456', repr(self.commands[0]))
        self.assertNotIn('123456', output.getvalue())
        for path in self.root.rglob('*'):
            if path.is_file():
                self.assertNotIn('123456', path.read_text(encoding='utf-8'))

    def test_status_does_not_consume_or_include_a_code(self):
        result = self.send('status')
        self.assertEqual(result['result'], 'status')
        self.assertEqual(self.commands, [])
        self.assertEqual(result['state'], 'awaiting_code')

    def test_second_submission_is_blocked_until_a_rejection_or_new_challenge(self):
        self.assertEqual(self.send('submit_code', code='123456')['result'], 'accepted')
        self.assertEqual(self.send('submit_code', code='654321')['result'],
                         'code_destination_not_ready')
        self.assertEqual(len(self.commands), 1)

    def test_resend_command_contains_no_code(self):
        self.assertEqual(self.send('resend')['result'], 'accepted')
        self.assertEqual(self.commands[0].action, 'resend')
        self.assertEqual(self.commands[0].code, '')

    def test_attempt_limit_prevents_automatic_guessing(self):
        for _ in range(3):
            self.bridge.set_state('code_rejected')
            self.assertEqual(self.send('submit_code', code='123456')['result'], 'accepted')
        self.bridge.set_state('code_rejected')
        self.assertEqual(self.send('submit_code', code='123456')['result'], 'attempt_limit_reached')
        self.assertEqual(len(self.commands), 3)

    def test_expired_request_never_consumes_a_code(self):
        self.bridge.deadline = time.time() - 1
        self.assertEqual(self.send('submit_code', code='123456')['result'], 'challenge_expired')
        self.assertEqual(self.send('status')['state'], 'challenge_expired')
        self.assertEqual(self.commands, [])

    def test_changed_server_process_is_rejected_before_transmission(self):
        record = self.bridge.snapshot()
        record['server_pid'] += 1
        self.bridge.path.write_text(json.dumps(record), encoding='utf-8')
        with self.assertRaisesRegex(BridgeError, '^owner_bridge_identity_mismatch$'):
            self.send('submit_code', code='123456')
        self.assertEqual(self.commands, [])

    def test_invalid_code_is_never_sent(self):
        with self.assertRaisesRegex(BridgeError, '^invalid_code_format$'):
            self.send('submit_code', code='not a code')
        self.assertEqual(self.commands, [])

    def test_old_owner_process_requires_restart_before_receiving_a_code(self):
        record = self.bridge.snapshot()
        record.pop('auth_form_version')
        self.bridge.path.write_text(json.dumps(record), encoding='utf-8')
        with self.assertRaisesRegex(BridgeError, '^owner_bridge_update_required$'):
            self.send('submit_code', code='123456')
        self.assertEqual(self.commands, [])

    def test_pipe_client_cannot_create_an_extra_server_instance(self):
        import win32security
        descriptor = win32security.GetSecurityInfo(self.bridge.handle,
            win32security.SE_KERNEL_OBJECT, win32security.DACL_SECURITY_INFORMATION)
        acl = descriptor.GetSecurityDescriptorDacl()
        trustees = []
        limited = []
        for index in range(acl.GetAceCount()):
            _, mask, sid = acl.GetAce(index)
            trustees.append(win32security.ConvertSidToStringSid(sid))
            if mask & 4 == 0:
                limited.append(mask)
        self.assertEqual(set(trustees), {self.owner})
        self.assertTrue(limited)
        self.assertTrue(all(mask & 0x3 == 0x3 for mask in limited))

    def test_wrong_incident_and_duplicate_packet_are_not_accepted(self):
        packet = {'action': 'submit_code', 'incident_id': '0'*32,
                  'challenge_id': self.bridge.challenge, 'request_id': '1'*32,
                  'code': '123456'}
        command, result = self.bridge._command(json.dumps(packet).encode())
        self.assertIsNone(command)
        self.assertEqual(result, 'different_login_request')
        packet['incident_id'] = self.bridge.incident
        self.assertEqual(self.bridge._command(json.dumps(packet).encode())[1], 'accepted')
        self.assertEqual(self.bridge._command(json.dumps(packet).encode())[1], 'already_received')

    def test_arbitrary_commands_and_payload_fields_are_rejected(self):
        packet = {'action': 'run', 'incident_id': self.bridge.incident,
                  'challenge_id': self.bridge.challenge, 'request_id': '1'*32,
                  'command': 'not allowed'}
        self.assertEqual(self.bridge._command(json.dumps(packet).encode())[1], 'invalid_message')

    def test_normal_installed_bridge_cannot_run_as_the_alternate_account(self):
        if self.owner == original_owner_sid():
            self.skipTest('This check requires the alternate test account')
        with self.assertRaisesRegex(BridgeError, '^original_owner_required$'):
            AuthBridge(self.root)


FORM = r'''<!doctype html><html lang="ko"><meta charset="utf-8"><body><main id="form"></main><output id="state">idle</output>
<script>
window.requests = 0;
function showPhone() {
document.getElementById('form').innerHTML =
'<h1>휴대폰 로그인</h1><label>휴대폰 번호<input id="phone" type="text" placeholder="가입한 휴대폰 번호"></label>' +
'<button id="request" disabled>본인인증하기</button>';
document.getElementById('phone').oninput = () => {
document.getElementById('request').disabled = !/^01[0-9]{9}$/.test(document.getElementById('phone').value); };
document.getElementById('request').onclick = () => {
window.requests++; document.getElementById('state').textContent='requested';
document.getElementById('form').innerHTML =
'<input id="code" type="text" autocomplete="one-time-code" placeholder="인증번호 입력">' +
'<button id="confirm">인증하기</button><button id="resend">인증번호 재전송</button>';
document.getElementById('confirm').onclick = () => {
if (document.getElementById('code').value === '123456') {
document.getElementById('form').textContent='인증 완료';
document.getElementById('state').textContent='authenticated';
history.replaceState({},'', '/'); }
else {document.getElementById('state').textContent='인증번호가 일치하지 않습니다';} };
document.getElementById('resend').onclick = () => {window.requests++;}; };
}
setTimeout(showPhone, DELAY);
</script></body></html>'''


class BrowserFormChecks(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from playwright.sync_api import sync_playwright
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(channel='msedge', headless=True,
            args=['--disable-background-networking'])

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context()
        self.delay = 0
        self.context.route('**/*', lambda route: route.fulfill(
            content_type='text/html; charset=utf-8', body=FORM.replace('DELAY', str(self.delay))))
        self.page = self.context.new_page()

    def tearDown(self):
        self.context.close()

    def test_observed_text_input_and_identity_button_request_and_submit(self):
        self.page.goto(phone.PHONE_URL)
        self.assertEqual(phone.request_phone_challenge(self.page, '01000000000'), 'challenge_submitted')
        self.assertEqual(self.page.locator('#state').text_content(), 'requested')
        self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_submitted')
        self.assertEqual(self.page.locator('#state').text_content(), 'authenticated')

    def test_delayed_phone_field_is_waited_for(self):
        self.delay = 350
        self.page.goto(phone.PHONE_URL)
        self.assertEqual(phone.request_phone_challenge(self.page, '01000000000'), 'challenge_submitted')

    def test_existing_code_form_does_not_send_another_notification(self):
        self.page.goto(phone.PHONE_URL)
        phone.request_phone_challenge(self.page, '01000000000')
        self.assertEqual(phone.request_phone_challenge(self.page, '01000000000'), 'challenge_already_pending')
        self.assertEqual(self.page.evaluate('window.requests'), 1)

    def test_code_rejection_is_observable_without_reading_input_values(self):
        self.page.goto(phone.PHONE_URL)
        phone.request_phone_challenge(self.page, '01000000000')
        phone.submit_phone_code(self.page, '000000')
        self.assertTrue(phone.code_rejected(self.page))

    def test_foreign_origin_never_receives_phone_or_code(self):
        self.page.goto('https://example.org/login/phone')
        self.assertEqual(phone.request_phone_challenge(self.page, '01000000000'), 'owner_action_required')
        self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_destination_not_ready')
        self.assertEqual(self.page.locator('#state').text_content(), 'idle')

    def test_entry_login_routes_to_the_known_phone_form(self):
        self.page.goto('https://kream.co.kr/login')
        self.assertEqual(phone.request_phone_challenge(self.page, '01000000000'), 'challenge_submitted')
        self.assertEqual(self.page.url, phone.PHONE_URL)

    def test_explicit_resend_is_separate_from_normal_request(self):
        self.page.goto(phone.PHONE_URL)
        phone.request_phone_challenge(self.page, '01000000000')
        self.assertEqual(phone.request_phone_challenge(self.page, '01000000000', resend=True),
                         'challenge_submitted')
        self.assertEqual(self.page.evaluate('window.requests'), 2)

    def set_code_form(self, fields):
        self.page.goto(phone.PHONE_URL)
        self.page.set_content('<meta charset="utf-8">' + fields +
            '<button id="confirm">로그인하기</button><output id="state">idle</output>'
            '<script>document.getElementById("confirm").onclick=()=>{'
            'document.getElementById("state").textContent="authenticated";'
            'history.replaceState({},"","/");};</script>')

    def test_blank_placeholder_and_six_digit_field_are_supported(self):
        self.set_code_form('<input type="text" maxlength="11" placeholder="가입한 휴대폰 번호">'
                           '<input type="tel" maxlength="6" placeholder="">')
        self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_submitted')
        self.assertEqual(self.page.locator('#state').text_content(), 'authenticated')

    def test_phone_auth_code_name_is_not_mistaken_for_phone_number(self):
        self.set_code_form('<input name="phone_auth_code" type="text">')
        self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_submitted')

    def test_six_separate_digit_fields_are_supported(self):
        self.set_code_form(''.join('<input type="tel" maxlength="1" id="d%d">' % index
                                  for index in range(6)))
        self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_submitted')
        self.assertEqual(self.page.locator('#state').text_content(), 'authenticated')

    def test_autocomplete_on_first_box_does_not_collapse_six_fields_into_one(self):
        self.set_code_form(''.join('<input type="tel" maxlength="1" id="d%d"%s>' %
            (index, ' autocomplete="one-time-code"' if index == 0 else '') for index in range(6)))
        self.page.evaluate('()=>{document.getElementById("confirm").onclick=()=>{'
            'const code=Array.from(document.querySelectorAll("input")).map(i=>i.value).join("");'
            'document.getElementById("state").textContent=code==="123456"?"authenticated":"wrong";};}')
        self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_submitted')
        self.assertEqual(self.page.locator('#state').text_content(), 'authenticated')

    def test_observed_verify_page_six_boxes_and_resend_link(self):
        self.set_code_form('<h1>인증 번호 입력</h1>' +
            ''.join('<input type="text" id="n%d">' % index for index in range(6)) +
            '<a id="resend-link" href="#">재발송</a>')
        self.page.evaluate('()=>{history.replaceState({},"","/login/phone/verify?returnUrl=/");'
            'window.resends=0;document.getElementById("resend-link").onclick=(e)=>{'
            'e.preventDefault();window.resends++;};'
            'document.getElementById("confirm").textContent="인증 완료";'
            'document.getElementById("confirm").onclick=()=>{'
            'const code=Array.from(document.querySelectorAll("input")).map(i=>i.value).join("");'
            'document.getElementById("state").textContent=code==="123456"?"authenticated":"wrong";};}')
        self.assertEqual(phone.request_phone_challenge(self.page, '01000000000', resend=True),
                         'challenge_submitted')
        self.assertEqual(self.page.evaluate('window.resends'), 1)
        self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_submitted')
        self.assertEqual(self.page.locator('#state').text_content(), 'authenticated')

    def test_one_blank_field_next_to_phone_is_supported_without_reading_values(self):
        self.set_code_form('<input maxlength="11" placeholder="가입한 휴대폰 번호">'
                           '<input type="text">')
        self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_submitted')

    def test_ambiguous_blank_code_fields_are_not_filled(self):
        self.set_code_form('<input maxlength="6"><input maxlength="6">')
        with patch.object(phone, '_wait_for', side_effect=lambda page, find, **kw: find(page)):
            self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_input_not_found')
        self.assertEqual(self.page.locator('#state').text_content(), 'idle')

    def test_same_origin_frame_is_supported(self):
        self.set_code_form('<iframe src="/otp-frame"></iframe>')
        inner = self.page.frames[1]
        inner.wait_for_load_state()
        inner.locator('body').evaluate('(body)=>{body.innerHTML='
            "'<input maxlength=\"6\"><button id=\"go\">인증하기</button><output>idle</output>';"
            'document.getElementById("go").onclick=()=>{document.querySelector("output").textContent="submitted";};}')
        self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_submitted')
        self.assertEqual(inner.locator('output').text_content(), 'submitted')

    def test_foreign_frame_is_not_a_code_destination(self):
        self.set_code_form('<iframe src="https://example.org/otp-frame"></iframe>')
        inner = self.page.frames[1]
        inner.wait_for_load_state()
        inner.locator('body').evaluate('(body)=>{body.innerHTML='
            "'<input maxlength=\"6\"><button>인증하기</button>';}")
        with patch.object(phone, '_wait_for', side_effect=lambda page, find, **kw: find(page)):
            self.assertEqual(phone.submit_phone_code(self.page, '123456'), 'code_input_not_found')

    def test_form_summary_omits_values_labels_and_identifiers(self):
        self.set_code_form('<input maxlength="6" placeholder="private-looking-label" '
                           'id="private-looking-id" value="123456">')
        summary = json.dumps(phone.describe_code_form(self.page))
        self.assertNotIn('123456', summary)
        self.assertNotIn('private-looking-label', summary)
        self.assertNotIn('private-looking-id', summary)
        self.assertIn('max_length', summary)


class ControllerChecks(unittest.TestCase):
    def test_invalid_command_arguments_never_echo_a_code(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.assertEqual(submit_main(['--submit', '123456']), 2)
        self.assertEqual(json.loads(output.getvalue()), {'result': 'invalid_arguments'})
        self.assertNotIn('123456', output.getvalue())

    def test_a_chat_code_resumes_only_after_real_history_verification(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'recovery').mkdir()
            runtime = SimpleNamespace(collector=runner.collector, verify_full_history_access=Mock())
            events = []
            tick = [0]
            control = RecoveryController(runtime, root,
                lambda code, **details: events.append((code, details)),
                wait_seconds=20, clock=lambda: tick[0])
            control.settings = {'phone_login_enabled': True}
            bridge = SimpleNamespace(state='awaiting_code', closed=False)
            commands = [Command('submit_code', 'a'*32, '123456')]
            bridge.poll = lambda: commands.pop(0) if commands else None
            bridge.set_state = lambda state, **kwargs: setattr(bridge, 'state', state)
            bridge.close = lambda: setattr(bridge, 'closed', True)
            page = Page()
            page.url = phone.PHONE_URL
            page.wait_for_timeout = lambda milliseconds: tick.__setitem__(0, tick[0]+1)

            def submit(page, code):
                self.assertEqual(code, '123456')
                page.url = 'https://kream.co.kr/'
                return 'code_submitted'

            with patch.object(control, 'phone_request', return_value='challenge_submitted'), \
                    patch.object(control, 'start_chat_bridge',
                                 side_effect=lambda status: setattr(control, 'bridge', bridge)), \
                    patch('kream_recovery_control.submit_phone_code', side_effect=submit):
                control.wait_for_owner(page, login=True)
            runtime.verify_full_history_access.assert_called_once()
            self.assertEqual(bridge.state, 'authenticated')
            self.assertTrue(bridge.closed)
            self.assertNotIn('123456', json.dumps(events))
            self.assertIn('resuming_after_owner_login', [event[0] for event in events])


if __name__ == '__main__':
    unittest.main()
