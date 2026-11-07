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
SUBMIT_LABEL = re.compile(r'^(?:인증\s*(?:하기|완료|확인)|본인\s*인증하기|확인|로그인)$')
RESEND_LABEL = re.compile(r'^(?:인증번호\s*(?:다시\s*받기|재전송)|재전송|다시\s*요청)$')


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


def _code_input(page):
    return _one([
        page.locator('input[autocomplete="one-time-code"]'),
        page.get_by_placeholder(CODE_LABEL),
        page.get_by_label(CODE_LABEL),
    ])


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
    if _code_input(page) is not None:
        if not resend:
            return 'challenge_already_pending'
        button = _one([page.get_by_role('button', name=RESEND_LABEL)])
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
    button = _wait_for(page, lambda p: _one([p.get_by_role('button', name=REQUEST_LABEL)]))
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
    button = _one([page.get_by_role('button', name=SUBMIT_LABEL)])
    if button is None or not is_kream_page(page) or not button.is_enabled():
        return 'code_entered_waiting_for_confirmation'
    button.click(timeout=10000)
    return 'code_submitted'


def code_rejected(page):
    """Inspect only fixed error labels, never field values or whole-page dumps."""
    if not is_kream_page(page) or not login_form_open(page):
        return False
    label = re.compile(r'인증번호.{0,20}(?:일치하지|올바르지|틀렸|만료)|인증\s*시간.{0,10}(?:초과|만료)')
    return page.get_by_text(label).filter(visible=True).count() > 0
