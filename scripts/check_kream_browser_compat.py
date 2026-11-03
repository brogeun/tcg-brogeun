"""Check one installed browser against normal KREAM full-history access.

This diagnostic does not collect prices, publish files, or change authentication.
It emits only fixed status fields, public browser configuration, and row counts.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from urllib.parse import urlparse

try:
    from scripts.collect_kream_promos import (
        CollectionError, browser_context_for_session, open_history_drawer,
        require_login_access, session_state,
    )
except ModuleNotFoundError:
    from collect_kream_promos import (
        CollectionError, browser_context_for_session, open_history_drawer,
        require_login_access, session_state,
    )


PRODUCT_URL = 'https://kream.co.kr/products/1096144'
TRADE_ROWS = '.drawer .tab_content.show .price_body .body_list'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--channel', choices=('chrome', 'msedge'), required=True,
                        help='Use the browser already installed on the runner')
    parser.add_argument('--headed', action='store_true',
                        help='Launch a normal visible browser window')
    args = parser.parse_args(argv)
    config = {'platform': sys.platform, 'channel': args.channel,
              'headless': not args.headed}
    stage = 'validate_session'
    http_status = None

    def report(**fields):
        print(json.dumps(dict(config, **fields), ensure_ascii=True, sort_keys=True), flush=True)

    report(status='starting', stage=stage)
    try:
        state = session_state(os.environ.get('KREAM_STORAGE_STATE'))
        stage = 'load_browser_runtime'
        from playwright.sync_api import sync_playwright

        with sync_playwright() as pw:
            stage = 'launch_browser'
            browser = pw.chromium.launch(channel=args.channel, headless=not args.headed)
            try:
                config['browser_version'] = browser.version
                stage = 'restore_session'
                context = browser_context_for_session(
                    browser, state, locale='ko-KR', timezone_id='Asia/Seoul',
                    viewport={'width': 1440, 'height': 1080})
                page = context.new_page()
                stage = 'open_product'
                # One navigation only. No HTTP-error retries in this diagnostic.
                response = page.goto(PRODUCT_URL, wait_until='domcontentloaded', timeout=45000)
                http_status = response.status if response else 0
                report(status='http_response', stage=stage, http_status=http_status)
                if http_status != 200:
                    code = 'access_denied' if http_status in (401, 403, 429) else 'source_http_error'
                    report(status='failed', stage=stage, failure_code=code,
                           http_status=http_status)
                    return 1
                require_login_access(page)
                location = urlparse(page.url)
                if (location.scheme != 'https'
                        or location.netloc not in ('kream.co.kr', 'www.kream.co.kr')
                        or location.path != '/products/1096144'):
                    report(status='failed', stage=stage, failure_code='unexpected_redirect',
                           http_status=http_status)
                    return 1
                stage = 'open_trade_drawer'
                open_history_drawer(page)
                stage = 'verify_sixth_trade'
                rows = page.locator(TRADE_ROWS)
                try:
                    rows.nth(5).wait_for(state='visible', timeout=20000)
                except Exception as error:
                    require_login_access(page)
                    report(status='failed', stage=stage, failure_code='full_history_unavailable',
                           error_type=type(error).__name__, http_status=http_status,
                           rows=rows.count())
                    return 1
                require_login_access(page)
                report(status='success', stage=stage, http_status=http_status, rows=rows.count())
                return 0
            finally:
                # Cleanup failures must not print raw browser exceptions.
                try:
                    browser.close()
                except Exception:
                    pass
    except CollectionError as error:
        report(status='failed', stage=stage, failure_code=error.code, http_status=http_status)
        return 1
    except Exception as error:
        # Never print exception messages, request URLs, headers, or browser state.
        report(status='failed', stage=stage, failure_code='compatibility_check_failed',
               error_type=type(error).__name__, http_status=http_status)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
