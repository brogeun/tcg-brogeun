"""Run on the owner's computer: sign in normally, then connect an Actions secret.

No password, session file, browser profile, or session value is printed or saved.
Requires Python Playwright Chromium and an already authenticated GitHub CLI.
"""
import argparse
import json
import re
import shutil
import subprocess
import sys
import threading

try:
    from scripts.collect_kream_promos import CollectionError, browser_context_for_session, open_history_drawer, open_product, require_login_access, session_state
except ModuleNotFoundError:
    from collect_kream_promos import CollectionError, browser_context_for_session, open_history_drawer, open_product, require_login_access, session_state

REPO = 'brogeun/tcg-brogeun'
SECRET = 'KREAM_STORAGE_STATE'
PRODUCT = {'id': '1096144', 'source_url': 'https://kream.co.kr/products/1096144'}

def verify_full_history_access(page, *, on_stage=None, phase='source'):
    def mark(step):
        if on_stage:
            on_stage(phase + '_' + step)

    mark('open_product')
    open_product(page, PRODUCT)
    mark('open_trade_drawer')
    open_history_drawer(page)
    mark('drawer_visible')
    require_login_access(page)
    # A public five-trade preview is not evidence of full-history access.
    mark('verify_sixth_trade')
    rows = page.locator('.drawer .tab_content.show .price_body .body_list')
    try:
        rows.nth(5).wait_for(state='visible', timeout=20000)
    except Exception as error:
        if type(error).__name__ != 'TimeoutError':
            raise
        require_login_access(page)
        print('[KREAM] history_rows=' + str(rows.count()), flush=True)
        raise CollectionError('history_rows_unavailable', 'The trade drawer opened but full authenticated history was not available.') from None
    require_login_access(page)

def capture_tab_state(context, page):
    """Capture only this owner's dedicated KREAM tab, never a personal profile."""
    snapshot = page.evaluate('''() => {
        const allowed = ['https://kream.co.kr', 'https://www.kream.co.kr'];
        if (!allowed.includes(window.location.origin)) return null;
        return {origin: window.location.origin, entries: Object.fromEntries(Object.entries(window.sessionStorage))};
    }''')
    if not isinstance(snapshot, dict) or snapshot.get('origin') not in ('https://kream.co.kr', 'https://www.kream.co.kr'):
        return None
    if not snapshot.get('entries'):
        return None
    state = context.storage_state(indexed_db=True)
    state['sessionStorage'] = {snapshot['origin']: snapshot['entries']}
    return session_state(json.dumps(state))

def verify_restored_state(browser, state, *, on_stage=None, phase='restored'):
    context = browser_context_for_session(browser, state, locale='ko-KR', timezone_id='Asia/Seoul')
    try:
        verify_full_history_access(context.new_page(), on_stage=on_stage, phase=phase)
    finally:
        context.close()

def choose_restorable_state(browser, context, page, *, on_stage=None):
    def mark(stage):
        if on_stage:
            on_stage(stage)

    def restore_tab_candidate():
        candidate = capture_tab_state(context, page)
        if candidate is None:
            return None
        mark('restore_session_with_tab_storage')
        verify_restored_state(browser, candidate, on_stage=on_stage, phase='restored_with_tab_storage')
        return candidate

    mark('export_session_in_memory')
    try:
        state = session_state(json.dumps(context.storage_state(indexed_db=True)))
    except CollectionError as error:
        # A tab-only login can have no first-party native state at all. The
        # additional candidate must still pass sanitization and a full replay.
        if error.code != 'session_invalid':
            raise
        candidate = restore_tab_candidate()
        if candidate is None:
            raise
        return candidate
    mark('restore_session')
    try:
        verify_restored_state(browser, state, on_stage=on_stage)
        return state
    except CollectionError as error:
        if error.code not in ('session_expired', 'trade_drawer_unavailable', 'history_rows_unavailable'):
            raise
        # Only a failed legitimate session replay may use additional tab state.
        # HTTP/access failures are never retried by this fallback.
        candidate = restore_tab_candidate()
        if candidate is None:
            raise
        return candidate

def upload_session(state):
    # Restrict the saved session to KREAM, excluding third-party sign-in state.
    payload = json.dumps(session_state(json.dumps(state)), separators=(',', ':')).encode()
    if len(payload) > 48 * 1024:
        raise CollectionError('session_too_large', 'KREAM session exceeds the GitHub secret size limit; nothing was uploaded.')
    result = subprocess.run(['gh', 'secret', 'set', SECRET, '--repo', REPO],
                            input=payload, capture_output=True)
    if result.returncode:
        raise CollectionError('secret_upload_failed', 'GitHub secret registration failed. Check GitHub CLI access to the repository.')

def wait_for_owner_login(page, prompt):
    """Keep sync Playwright dispatching while the owner signs in manually."""
    # Only console input runs on this thread. Playwright stays on its owner thread.
    finished = threading.Event()
    errors = []

    def read_confirmation():
        try:
            input(prompt)
        except EOFError as error:
            errors.append(error)
        finally:
            finished.set()

    threading.Thread(target=read_confirmation, daemon=True).start()
    while not finished.is_set():
        page.wait_for_timeout(100)
    if errors:
        raise errors[0]

def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--browser', choices=('chromium', 'msedge', 'chrome'), default='chromium',
                        help='Use an installed Edge/Chrome browser or bundled Chromium')
    args = parser.parse_args(argv)
    if not shutil.which('gh'):
        print('Install GitHub CLI and run gh auth login on your own computer first.')
        return 1
    if subprocess.run(['gh', 'auth', 'status'], capture_output=True).returncode:
        print('Run gh auth login on your own computer first, then rerun this script.')
        return 1
    stage = 'start'

    def mark_stage(value):
        nonlocal stage
        stage = value
        print('[KREAM] stage=' + value, flush=True)

    try:
        mark_stage('load_browser_runtime')
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            mark_stage('launch_browser')
            launch_options = {'headless': False}
            if args.browser != 'chromium':
                launch_options['channel'] = args.browser
            browser = pw.chromium.launch(**launch_options)
            context = browser.new_context(locale='ko-KR', timezone_id='Asia/Seoul')
            page = context.new_page()
            mark_stage('open_homepage')
            page.goto('https://kream.co.kr', wait_until='domcontentloaded', timeout=45000)
            mark_stage('waiting_for_owner_login')
            wait_for_owner_login(page, '열린 KREAM 창에서 직접 로그인한 뒤, 이 터미널에서 Enter를 누르세요. ')
            verify_full_history_access(page, on_stage=mark_stage, phase='source')
            # Prove the exported state works after restoring into a fresh context.
            # In-memory-only login state must not be uploaded as a working session.
            state = choose_restorable_state(browser, context, page, on_stage=mark_stage)
            mark_stage('register_actions_secret')
            upload_session(state)
            browser.close()
        print('KREAM 세션을 GitHub Actions 비밀값에 등록했습니다. 세션은 화면이나 파일에 출력하지 않았습니다.')
        mark_stage('dispatch_collection')
        result = subprocess.run(['gh', 'workflow', 'run', 'kream-promos-daily.yml', '--repo', REPO], capture_output=True)
        if result.returncode:
            print('자동 수집 시작 요청은 실패했습니다. GitHub Actions의 KREAM Korean Promos Daily에서 Run workflow를 눌러주세요.')
        else:
            print('전체 7종 수집을 요청했습니다. 수집 및 배포 성공 여부는 GitHub Actions에서 확인하세요.')
        return 0
    except CollectionError as error:
        print('[KREAM] failed_stage=' + stage + '; failure_code=' + error.code)
        print(str(error))
    except (KeyboardInterrupt, EOFError):
        print('연결을 취소했습니다.')
    except Exception as error:
        # Raw browser/CLI exception text can contain credentials or signed URLs.
        print('[KREAM] failed_stage=' + stage + '; error_type=' + type(error).__name__)
        print('연결을 완료하지 못했습니다. 브라우저의 로그인·접근 상태와 로컬 설치를 확인하세요. 보호된 접근은 우회하지 않습니다.')
    return 1

if __name__ == '__main__':
    sys.exit(main())

