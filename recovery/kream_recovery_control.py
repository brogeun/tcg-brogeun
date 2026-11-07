"""Keep the owner browser alive, recover login, and resume validated products."""
from datetime import datetime, timedelta
import json
from pathlib import Path
import time

from kream_login_alerts import LoginAlerts
from kream_phone_login import (is_kream_page, login_form_open, request_phone_challenge,
                               submit_phone_code, code_rejected, describe_code_form)
from kream_chat_bridge import AuthBridge

PANEL_SCRIPT = r'''({message, login}) => {
  let box = document.getElementById('tcghub-recovery-panel');
  if (box) box.remove();
  box = document.createElement('section');
  box.id = 'tcghub-recovery-panel';
  box.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:2147483647;max-width:360px;padding:16px;background:#17202a;color:white;border-radius:12px;font:14px/1.6 sans-serif;box-shadow:0 4px 24px #0005';
  const title = document.createElement('strong'); title.textContent = 'TCGHUB 수집 대기'; box.append(title);
  const text = document.createElement('p'); text.textContent = message; box.append(text);
  const add = (label, action) => {
    const button = document.createElement('button'); button.textContent = label;
    button.style.cssText = 'margin:4px 8px 0 0;padding:7px 10px;border:0;border-radius:6px;background:#fff;color:#17202a;cursor:pointer';
    button.onclick = () => { box.dataset.action = action; }; box.append(button);
  };
  add(login ? '인증 완료 확인' : '수집 다시 시도', 'retry');
  if (login) add('휴대폰 인증 다시 요청', 'resend');
  document.documentElement.append(box);
}'''
ACTION_SCRIPT = r'''() => {
  const box = document.getElementById('tcghub-recovery-panel');
  const action = box?.dataset.action || '';
  if (box) delete box.dataset.action;
  return {present: !!box, action};
}'''


class RecoveryController:
    def __init__(self, runner, root, emit, *, wait_seconds=5400, clock=time.monotonic):
        self.runner = runner
        self.collector = runner.collector
        self.root = Path(root)
        self.emit = emit
        self.wait_seconds = wait_seconds
        self.clock = clock
        self.alerts = None
        self.generation_entered = False
        self.bridge = None
        self.settings = {}
        settings_path = self.root / 'recovery' / 'owner-settings.json'
        if settings_path.is_file():
            self.settings = json.loads(settings_path.read_bytes())
        self.request_path = self.root / 'recovery' / 'phone-request.json'
        self.checkpoints = self.root / 'recovery' / 'product-checkpoints'
        self.checkpoints.mkdir(exist_ok=True)

    def save(self, path, value):
        self.collector.replace_file(path, self.collector.encoded(value))

    def auth_missing(self, page, error=None):
        if getattr(error, 'code', None) == 'session_expired':
            return True
        try:
            self.collector.require_login_access(page)
        except self.collector.CollectionError as access_error:
            return access_error.code == 'session_expired'
        except Exception:
            # A rendering failure is not proof that the owner's login expired.
            return False
        try:
            return page.get_by_role('link', name='로그인', exact=True).filter(visible=True).count() > 0
        except Exception:
            return False

    def verify_access(self, page):
        self.runner.verify_full_history_access(
            page, on_stage=lambda stage: self.emit('authentication_check', stage=stage), phase='local')

    def recovered(self):
        if self.request_path.is_file():
            state = json.loads(self.request_path.read_bytes())
            state['resolved'] = True
            self.save(self.request_path, state)
        if (self.alerts is None and self.settings.get('chatgpt_login_alerts_enabled')
                and (self.root / 'recovery' / 'login-alert.json').is_file()):
            self.alerts = LoginAlerts(self.runner.GhApi(r'C:\Program Files\GitHub CLI\gh.exe'),
                                      self.root / 'recovery', self.save)
        if self.alerts is not None:
            try:
                self.alerts.resolve()
            except Exception as error:
                self.emit('login_notification_resolution_pending', error_type=type(error).__name__)
        self.emit('authenticated_history_verified')
        if self.bridge is not None:
            self.bridge.set_state('authenticated')

    def phone_request(self, page, *, resend=False):
        if not self.settings.get('phone_login_enabled'):
            return 'owner_action_required'
        previous = json.loads(self.request_path.read_bytes()) if self.request_path.is_file() else None
        now = datetime.now(self.collector.KST)
        if previous and not previous.get('resolved'):
            age = now - datetime.fromisoformat(previous['attempted_at'])
            uncertain_or_sent = previous['status'] in (
                'challenge_submitted', 'challenge_already_pending',
                'request_in_progress', 'request_outcome_unknown')
            if not resend and uncertain_or_sent and age < timedelta(minutes=5):
                return previous['status']
            if resend and uncertain_or_sent and age < timedelta(minutes=5):
                self.emit('phone_request_cooldown')
                return previous['status']
        state = {'schemaVersion': 1, 'attempted_at': now.isoformat(),
                 'resolved': False, 'status': 'request_in_progress'}
        # Persist intent before submitting: a process restart cannot spam requests.
        self.save(self.request_path, state)
        try:
            state['status'] = request_phone_challenge(page, self.settings['phone_number'],
                                                      resend=resend)
        except Exception as error:
            state['status'] = 'request_outcome_unknown'
            self.emit('phone_request_needs_owner', error_type=type(error).__name__)
        self.save(self.request_path, state)
        self.emit('phone_login_request_status', status=state['status'])
        return state['status']

    def notify_login(self, phone_status):
        if not self.settings.get('chatgpt_login_alerts_enabled'):
            return
        if self.alerts is None:
            self.alerts = LoginAlerts(self.runner.GhApi(r'C:\Program Files\GitHub CLI\gh.exe'),
                                      self.root / 'recovery', self.save)
        try:
            ready = self.bridge is not None and self.bridge.state == 'awaiting_code'
            expires_at = self.bridge.snapshot()['expires_at'] if ready else None
            event = self.alerts.ensure_open(phone_status, relay_ready=ready,
                                           relay_expires_at=expires_at)
            self.emit('chatgpt_login_notification_event_created',
                      incident_id=event['incident_id'], pull_request=event['pull_request'])
        except Exception as error:
            self.emit('chatgpt_login_notification_event_failed', error_type=type(error).__name__)

    def panel(self, page, login, message):
        try:
            if is_kream_page(page):
                page.evaluate(PANEL_SCRIPT, {'message': message, 'login': login})
        except Exception:
            # Visible-page navigation must never turn a recoverable wait into exit.
            pass

    def start_chat_bridge(self, phone_status):
        if not self.settings.get('phone_login_enabled'):
            return
        try:
            self.bridge = AuthBridge(self.root)
            if phone_status in ('challenge_submitted', 'challenge_already_pending'):
                self.bridge.set_state('awaiting_code', new_challenge=True)
            self.emit('chat_verification_bridge_ready',
                      accepts_code=self.bridge.state == 'awaiting_code')
        except Exception as error:
            if self.bridge is not None:
                self.bridge.close()
                self.bridge = None
            self.emit('chat_verification_bridge_unavailable', error_type=type(error).__name__)

    def wait_for_owner(self, page, *, login, product_ids=None):
        try:
            return self._wait_for_owner(page, login=login, product_ids=product_ids)
        finally:
            if self.bridge is not None:
                try:
                    self.bridge.close()
                except Exception as error:
                    self.emit('chat_verification_bridge_cleanup_pending',
                              error_type=type(error).__name__)
                self.bridge = None

    def _wait_for_owner(self, page, *, login, product_ids=None):
        if login:
            status = self.phone_request(page)
            self.start_chat_bridge(status)
            self.notify_login(status)
            message = '휴대폰 인증을 완료해 주세요. 인증이 확인되면 중단된 상품부터 자동으로 이어집니다. 이전 거래 자료는 그대로 보존됩니다.'
            code = 'waiting_for_owner_phone_login'
            if self.bridge is not None and self.bridge.state == 'awaiting_code':
                message = '휴대폰으로 받은 크림 인증번호를 이 ChatGPT 대화에 보내 주세요. 인증이 확인되면 수집이 자동으로 이어집니다.'
        else:
            message = '거래 화면을 읽거나 이전 내역을 대조하지 못했습니다. 기존 자료를 보존하고 창을 유지합니다. 화면을 확인한 뒤 다시 시도해 주세요.'
            code = 'waiting_for_source_review'
        self.emit(code, product_ids=product_ids or [], browser_kept_open=True)
        self.panel(page, login, message)
        deadline = self.clock() + self.wait_seconds
        last_check = self.clock()
        phone_attempts = 1
        last_phone_attempt = self.clock()
        while self.clock() < deadline:
            if page.is_closed():
                raise self.collector.CollectionError('owner_closed_browser', 'The owner closed the recovery browser; prior data retained.')
            action = ''
            try:
                if is_kream_page(page):
                    state = page.evaluate(ACTION_SCRIPT)
                    action = state.get('action', '')
                    if not state.get('present'):
                        self.panel(page, login, message)
            except Exception:
                pass
            if login and self.bridge is not None:
                command = self.bridge.poll()
                if command is not None and command.action == 'resend':
                    action = 'resend'
                elif command is not None and command.action == 'submit_code':
                    supplied_code, command.code = command.code, ''
                    self.emit('chat_verification_code_received', request_id=command.request_id)
                    try:
                        submission = submit_phone_code(page, supplied_code)
                    except Exception:
                        submission = 'owner_action_required'
                    finally:
                        supplied_code = None
                    self.bridge.set_state(submission)
                    self.emit('chat_verification_code_submitted', status=submission,
                              request_id=command.request_id)
                    if submission in ('code_input_not_found', 'code_entered_waiting_for_confirmation'):
                        try:
                            summary = describe_code_form(page)
                        except Exception:
                            summary = {'unavailable': True}
                        self.emit('phone_code_form_review_required', form_summary=summary)
                    # Verify only after the login form has completed its own flow.
                    last_check = self.clock() - 13
                if self.bridge.state in ('code_submitted', 'code_entered_waiting_for_confirmation'):
                    if code_rejected(page):
                        self.bridge.set_state('code_rejected')
                        self.emit('chat_verification_code_rejected')
            retryable_phone_states = ('phone_input_not_found', 'phone_method_not_found',
                                      'phone_entered_owner_action_required')
            if (login and status in retryable_phone_states and phone_attempts < 3
                    and self.clock() - last_phone_attempt >= 5):
                phone_attempts += 1
                last_phone_attempt = self.clock()
                status = self.phone_request(page)
                if self.bridge is not None and status in ('challenge_submitted', 'challenge_already_pending'):
                    self.bridge.set_state('awaiting_code', new_challenge=True)
            if login and action == 'resend':
                before = json.loads(self.request_path.read_bytes()) if self.request_path.is_file() else {}
                status = self.phone_request(page, resend=True)
                after = json.loads(self.request_path.read_bytes()) if self.request_path.is_file() else {}
                if (self.bridge is not None and status in ('challenge_submitted', 'challenge_already_pending')
                        and after.get('attempted_at') != before.get('attempted_at')):
                    self.bridge.set_state('awaiting_code', new_challenge=True)
                self.panel(page, login, message)
            if not login and action == 'retry':
                self.emit('owner_requested_source_retry')
                return
            # Do not navigate while the owner is entering a phone code or using
            # a third-party sign-in page. Only ordinary KREAM history proves login.
            should_verify = login and (action == 'retry' or (
                self.clock() - last_check >= 15 and not login_form_open(page)))
            if should_verify:
                last_check = self.clock()
                try:
                    self.verify_access(page)
                except Exception:
                    self.panel(page, login, message)
                else:
                    self.recovered()
                    self.emit('resuming_after_owner_login')
                    return
            page.wait_for_timeout(1000)
        self.emit('owner_wait_expired', browser_kept_open_seconds=self.wait_seconds)
        raise self.collector.CollectionError('owner_wait_expired', 'The owner recovery wait expired; prior data retained.')

    def ensure_authenticated(self, page):
        attempts = 0
        while True:
            try:
                self.verify_access(page)
            except Exception as error:
                if self.auth_missing(page, error):
                    self.wait_for_owner(page, login=True)
                    return
                if type(error).__name__ == 'TimeoutError' and attempts == 0:
                    attempts += 1
                    self.emit('authentication_page_timeout_retry')
                    page.wait_for_timeout(2000)
                    continue
                self.emit('authentication_page_unavailable',
                          failure_code=getattr(error, 'code', 'page_timeout_or_layout'),
                          error_type=type(error).__name__)
                self.wait_for_owner(page, login=False)
                attempts = 0
            else:
                self.recovered()
                return

    def cached(self, card, old):
        path = self.checkpoints / (card['id'] + '.json')
        if not path.is_file():
            return None
        try:
            cached = json.loads(path.read_bytes())
            if cached.get('baseline_version') != card['version']:
                return None
            data = self.collector.validate_history(cached['history'], card['id'])
            observed = datetime.fromisoformat(data['last_observed_at'].replace('Z', '+00:00'))
            age = datetime.now(self.collector.KST) - observed
            if not timedelta(0) <= age <= timedelta(hours=2):
                return None
            self.collector.validate_new_rows(old, data['rows'])
            return data
        except Exception:
            return None

    def collect_generation(self, context, root, emit):
        self.generation_entered = True
        manifest = self.collector.validate_bundle(root)
        page = context.pages[0] if context.pages else context.new_page()
        self.ensure_authenticated(page)
        staged = {}
        attempted = datetime.now(self.collector.KST).isoformat()
        while len(staged) < len(manifest['cards']):
            failed = []
            for card in manifest['cards']:
                ident = card['id']
                if ident in staged:
                    continue
                old = self.collector.unpack_history(json.loads((root / card['file'].lstrip('/')).read_bytes()))
                data = self.cached(card, old)
                if data is not None:
                    staged[ident] = data
                    self.emit('product_checkpoint_reused', product_id=ident, rows=len(data['rows']))
                    continue
                transient_attempt = 0
                while True:
                    emit('collecting_product', product_id=ident)
                    try:
                        data = self.collector.collect(page, card, old)
                    except Exception as error:
                        if page.is_closed():
                            raise self.collector.CollectionError('owner_closed_browser', 'Owner closed the recovery browser.') from None
                        if self.auth_missing(page, error):
                            self.wait_for_owner(page, login=True, product_ids=[ident])
                            transient_attempt = 0
                            continue
                        if type(error).__name__ == 'TimeoutError' and transient_attempt == 0:
                            transient_attempt += 1
                            self.emit('product_page_timeout_retry', product_id=ident)
                            page.wait_for_timeout(2000)
                            continue
                        self.emit('product_retained_for_review', product_id=ident,
                                  failure_code=getattr(error, 'code', 'source_validation_or_layout'),
                                  error_type=type(error).__name__)
                        failed.append(ident)
                        break
                    else:
                        staged[ident] = data
                        self.save(self.checkpoints / (ident + '.json'),
                                  {'baseline_version': card['version'], 'history': data})
                        emit('product_complete', product_id=ident, rows=len(data['rows']))
                        break
            if failed:
                if staged and hasattr(self.collector, 'publish_partial_generation'):
                    source_attempted=min([attempted]+[data['snapshot_started_at'] for data in staged.values()],
                                         key=lambda value:datetime.fromisoformat(value.replace('Z','+00:00')))
                    self.collector.publish_partial_generation(root,manifest,staged,source_attempted)
                    self.emit('partial_generation_validated',completed_products=len(staged),
                              retained_products=len(failed))
                    return self.collector.validate_bundle(root)
                self.wait_for_owner(page, login=False, product_ids=failed)
        # Unmodified validators still require all seven products and every prior
        # trade multiplicity before any nine-file publication can be requested.
        source_attempted=min([attempted]+[data['snapshot_started_at'] for data in staged.values()],
                             key=lambda value:datetime.fromisoformat(value.replace('Z','+00:00')))
        self.collector.publish_generation(root, manifest, staged, source_attempted)
        return self.collector.validate_bundle(root)
