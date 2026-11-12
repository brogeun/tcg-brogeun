"""Owner-authorized phone login through KREAM's ordinary rendered form.

No field value, password, cookie or browser storage is read. Supplied one-time
codes are used only on the login form and never returned in errors or evidence.
"""
import re
import time
from urllib.parse import urlparse

PHONE_URL = 'https://kream.co.kr/login/phone?returnUrl=/'
PHONE_LABEL = re.compile(r'(?:가입한\s*)?휴대(?:폰|전화)\s*번호|전화\s*번호|010')
CODE_LABEL = re.compile(r'인증\s*번호|verification\s*code|one.time.code', re.I)
REQUEST_LABEL = re.compile(r'^(?:본인\s*인증하기|인증번호\s*(?:받기|요청|전송)|(?:로그인|인증)\s*요청|인증하기|로그인)$')
SUBMIT_LABEL = re.compile(r'^(?:인증\s*(?:하기|완료|확인)|인증번호\s*확인|본인\s*인증하기|확인(?:하기)?|로그인(?:하기)?)$')
RESEND_LABEL = re.compile(r'^(?:인증번호\s*(?:다시\s*받기|재전송|재발송)|재전송|재발송|다시\s*요청)$')


def is_kream_page(page):
    parsed = urlparse(page.url)
    return parsed.scheme == 'https' and parsed.hostname in ('kream.co.kr', 'www.kream.co.kr')


def login_form_open(page):
    parsed = urlparse(page.url)
    return not is_kream_page(page) or bool(re.search(r'/(?:login|signin)(?:/|$)', parsed.path))


def _one(locators):
    """Choose one visible element; ambiguity never selects an arbitrary field."""
    for locator in locators:
        visible = locator.filter(visible=True)
        count = visible.count()
        if count > 1:
            return None
        if count == 1:
            return visible
    return None


def _phone_input(page):
    return _one([
        page.get_by_placeholder(PHONE_LABEL),
        page.get_by_label(PHONE_LABEL),
        page.locator('input[autocomplete="tel"]:not([autocomplete="one-time-code"])'),
        page.locator('input[type="tel"]:not([autocomplete="one-time-code"])'),
        page.locator('input[inputmode="tel"]:not([autocomplete="one-time-code"])'),
    ])


class CodeField:
    def __init__(self, scope, fields):
        self.scope, self.fields = scope, fields

    def fill(self, code, **kwargs):
        if not is_kream_page(self.scope):
            raise ValueError('Code destination changed')
        if len(self.fields) == 1:
            self.fields[0].fill(code, **kwargs)
            return
        if len(code) != len(self.fields):
            raise ValueError('Code length does not match this form')
        for target, digit in zip(self.fields, code):
            if not is_kream_page(self.scope):
                raise ValueError('Code destination changed')
            target.fill(digit, **kwargs)


def _auth_scopes(page):
    if not is_kream_page(page) or not login_form_open(page):
        return []
    scopes = [page]
    for frame in getattr(page, 'frames', []):
        if frame != getattr(page, 'main_frame', None) and is_kream_page(frame):
            scopes.append(frame)
    return scopes


def _field_info(target):
    # Values, HTML, browser storage and arbitrary attributes are never inspected.
    kind = (target.get_attribute('type') or 'text').lower()
    try:
        maximum = int(target.get_attribute('maxlength') or '-1')
    except ValueError:
        maximum = -1
    hints = ' '.join(target.get_attribute(name) or '' for name in
                     ('placeholder', 'aria-label', 'name', 'id'))
    code_hint = bool(CODE_LABEL.search(hints) or
                     re.search(r'otp|(?:auth|cert|verify|verification)[_-]?code', hints, re.I))
    return {
        'type': kind if kind in ('text', 'tel', 'number', 'email', 'password', 'search') else 'other',
        'max_length': maximum if -1 <= maximum <= 64 else -1,
        'phone_hint': bool((PHONE_LABEL.search(hints) or re.search(r'phone|mobile|telephone', hints, re.I))
                           and not code_hint),
        'code_hint': code_hint,
        'search_hint': bool(re.search(r'search|검색', hints, re.I)),
        'one_time_code': target.get_attribute('autocomplete') == 'one-time-code',
        'read_only': target.get_attribute('readonly') is not None,
    }


def _scope_code_input(scope):
    semantic = _one([
        scope.locator('input[autocomplete="one-time-code"]'),
        scope.get_by_placeholder(CODE_LABEL),
        scope.get_by_label(CODE_LABEL),
    ])
    candidates, digits, unspecified, eligible = [], [], [], []
    for target in scope.locator('input').filter(visible=True).all():
        info = _field_info(target)
        if (info['type'] not in ('text', 'tel', 'number') or info['read_only']
                or info['phone_hint'] or info['search_hint'] or not target.is_enabled()):
            continue
        maximum = info['max_length']
        if maximum > 8:
            continue
        eligible.append(target)
        if maximum == 1:
            digits.append(target)
        elif 4 <= maximum <= 8 or info['code_hint'] or info['one_time_code']:
            candidates.append(target)
        elif maximum == -1:
            unspecified.append(target)
    if (len(eligible) == 6
            and urlparse(scope.url).path.rstrip('/') == '/login/phone/verify'
            and scope.get_by_text(re.compile(r'^인증\s*번호\s*입력$')).filter(visible=True).count() == 1):
        return CodeField(scope, eligible)
    if 4 <= len(digits) <= 8 and not candidates and not unspecified:
        return CodeField(scope, digits)
    if semantic is not None and semantic.get_attribute('maxlength') != '1':
        return CodeField(scope, [semantic])
    if len(candidates) == 1 and not digits and not unspecified:
        return CodeField(scope, candidates)
    if len(unspecified) == 1 and not candidates and not digits:
        # A blank label is common in this form. Require the phone form or a
        # visible code heading as well as exactly one non-phone editable field.
        if (_phone_input(scope) is not None or
                scope.get_by_text(CODE_LABEL).filter(visible=True).count() > 0):
            return CodeField(scope, unspecified)
    return None


def _code_input(page):
    choices = []
    for scope in _auth_scopes(page):
        choice = _scope_code_input(scope)
        if choice is not None:
            choices.append(choice)
    return choices[0] if len(choices) == 1 else None


def describe_code_form(page):
    """Only non-sensitive field classifications, never labels/values/HTML."""
    summary = []
    for scope in _auth_scopes(page):
        fields = [_field_info(target) for target in
                  scope.locator('input').filter(visible=True).all()[:32]]
        summary.append({'fields': fields})
    return {'same_origin_scopes': len(summary), 'scopes': summary}


def _wait_for(page, find, *, timeout=6):
    deadline = time.monotonic() + timeout
    while True:
        if not is_kream_page(page):
            return None
        result = find(page)
        if result is not None:
            return result
        if time.monotonic() >= deadline:
            return None
        page.wait_for_timeout(150)


def request_phone_challenge(page, phone_number, *, resend=False):
    if not isinstance(phone_number, str) or not re.fullmatch(r'01[016789][0-9]{7,8}', phone_number):
        raise ValueError('Invalid owner phone configuration')
    if not is_kream_page(page):
        return 'owner_action_required'
    pending_field = _code_input(page)
    if pending_field is not None:
        if not resend:
            return 'challenge_already_pending'
        button = _one([
            pending_field.scope.get_by_role('button', name=RESEND_LABEL, disabled=False),
            pending_field.scope.get_by_role('link', name=RESEND_LABEL),
        ])
        if button is None or not button.is_enabled():
            return 'resend_not_available'
        button.click(timeout=10000)
        return 'challenge_submitted'
    if not urlparse(page.url).path.rstrip('/').endswith('/login/phone'):
        page.goto(PHONE_URL, wait_until='domcontentloaded', timeout=45000)
    phone = _wait_for(page, _phone_input)
    if phone is None or not is_kream_page(page):
        return 'phone_input_not_found'
    phone.fill(phone_number, timeout=10000)
    button = _wait_for(page, lambda p: _one([p.get_by_role('button', name=REQUEST_LABEL, disabled=False)]))
    if button is None or not is_kream_page(page) or not button.is_enabled():
        return 'phone_entered_owner_action_required'
    button.click(timeout=10000)
    # This confirms submission, not delivery of the notification to the phone.
    return 'challenge_submitted'


def submit_phone_code(page, code):
    if not isinstance(code, str) or not re.fullmatch(r'[0-9]{4,8}', code):
        return 'invalid_code_format'
    if not is_kream_page(page) or not login_form_open(page):
        return 'code_destination_not_ready'
    if page.locator('input[type="password"]').filter(visible=True).count():
        return 'owner_action_required'
    field = _wait_for(page, _code_input, timeout=3)
    if field is None or not is_kream_page(page):
        return 'code_input_not_found'
    field.fill(code, timeout=10000)
    if not login_form_open(page):
        return 'code_submitted'
    button = _wait_for(page, lambda p: _one([
        field.scope.get_by_role('button', name=SUBMIT_LABEL, disabled=False)]), timeout=3)
    if (button is None or not is_kream_page(page) or not is_kream_page(field.scope)
            or not button.is_enabled()):
        return 'code_entered_waiting_for_confirmation'
    button.click(timeout=10000)
    return 'code_submitted'


def code_rejected(page):
    """Inspect only fixed error labels, never field values or whole-page dumps."""
    if not is_kream_page(page) or not login_form_open(page):
        return False
    label = re.compile(r'인증번호.{0,20}(?:일치하지|올바르지|틀렸|만료)|인증\s*시간.{0,10}(?:초과|만료)')
    return page.get_by_text(label).filter(visible=True).count() > 0
