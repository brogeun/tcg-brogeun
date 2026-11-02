"""Run on the owner's computer: sign in normally, then connect an Actions secret.

No password, session file, browser profile, or session value is printed or saved.
Requires Python Playwright Chromium and an already authenticated GitHub CLI.
"""
import json
import re
import shutil
import subprocess
import sys

try:
    from scripts.collect_kream_promos import CollectionError, open_product, require_login_access, session_state
except ModuleNotFoundError:
    from collect_kream_promos import CollectionError, open_product, require_login_access, session_state

REPO = 'brogeun/tcg-brogeun'
SECRET = 'KREAM_STORAGE_STATE'
PRODUCT = {'id': '1096144', 'source_url': 'https://kream.co.kr/products/1096144'}

def verify_full_history_access(page):
    open_product(page, PRODUCT)
    more = page.get_by_text(re.compile(r'(?:체결|거래)\s*내역\s*더보기')).first
    more.wait_for(state='visible', timeout=20000)
    more.click()
    require_login_access(page)
    # A public five-trade preview is not evidence of full-history access.
    page.locator('.drawer .tab_content.show .price_body .body_list').nth(5).wait_for(state='visible', timeout=20000)
    require_login_access(page)

def upload_session(state):
    # Restrict the saved session to KREAM, excluding third-party sign-in state.
    payload = json.dumps(session_state(json.dumps(state)), separators=(',', ':')).encode()
    if len(payload) > 48 * 1024:
        raise RuntimeError('KREAM session exceeds the GitHub secret size limit; nothing was uploaded.')
    result = subprocess.run(['gh', 'secret', 'set', SECRET, '--repo', REPO],
                            input=payload, capture_output=True)
    if result.returncode:
        raise RuntimeError('GitHub secret registration failed. Check GitHub CLI access to the repository.')

def main():
    if not shutil.which('gh'):
        print('Install GitHub CLI and run gh auth login on your own computer first.')
        return 1
    if subprocess.run(['gh', 'auth', 'status'], capture_output=True).returncode:
        print('Run gh auth login on your own computer first, then rerun this script.')
        return 1
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=False)
            context = browser.new_context(locale='ko-KR', timezone_id='Asia/Seoul')
            page = context.new_page()
            page.goto('https://kream.co.kr', wait_until='domcontentloaded', timeout=45000)
            input('열린 KREAM 창에서 직접 로그인한 뒤, 이 터미널에서 Enter를 누르세요. ')
            verify_full_history_access(page)
            state = session_state(json.dumps(context.storage_state(indexed_db=True)))
            # Prove the exported state works after restoring into a fresh context.
            # In-memory-only login state must not be uploaded as a working session.
            restored = browser.new_context(storage_state=state, locale='ko-KR', timezone_id='Asia/Seoul')
            verify_full_history_access(restored.new_page())
            upload_session(state)
            browser.close()
        print('KREAM 세션을 GitHub Actions 비밀값에 등록했습니다. 세션은 화면이나 파일에 출력하지 않았습니다.')
        result = subprocess.run(['gh', 'workflow', 'run', 'kream-promos-daily.yml', '--repo', REPO], capture_output=True)
        if result.returncode:
            print('자동 수집 시작 요청은 실패했습니다. GitHub Actions의 KREAM Korean Promos Daily에서 Run workflow를 눌러주세요.')
        else:
            print('전체 7종 수집을 요청했습니다. 수집 및 배포 성공 여부는 GitHub Actions에서 확인하세요.')
        return 0
    except CollectionError as error:
        print(str(error))
    except (KeyboardInterrupt, EOFError):
        print('연결을 취소했습니다.')
    except Exception:
        print('연결을 완료하지 못했습니다. 브라우저의 로그인·접근 상태와 로컬 설치를 확인하세요. 보호된 접근은 우회하지 않습니다.')
    return 1

if __name__ == '__main__':
    sys.exit(main())
