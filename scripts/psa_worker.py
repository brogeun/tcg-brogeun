"""
psa_worker.py — 가정용 IP + 진짜 Chrome 으로 PSA cert 페이지를 받아 서버 캐시를 채우는 워커

배경:
  PSA(psacard.com)는 Cloudflare JS 챌린지로 데이터센터(Cloudflare/깃헙/curl)를 막는다.
  진짜 브라우저(JS 실행) + 가정용 IP 만 통과한다. 그래서 이 PC 에서 돌린다.

흐름:
  1) 서버 대기열 GET /api/psa/queue (워커 키로 보호)
  2) 각 cert → Playwright(시스템 Chrome)로 psacard.com/cert/{번호} 열어 챌린지 통과 후 HTML 획득
  3) HTML 을 POST /api/psa/cache 로 전송 → 서버가 파싱·캐시 저장·대기열 제거
  무한 루프 (POLL_SEC 마다). 작업 스케줄러 "로그온 시" 로 등록해두면 set & forget.

준비:
  pip install playwright requests
  (Playwright 는 channel="chrome" 로 시스템 Chrome 사용 — 별도 브라우저 다운로드 불필요)

환경변수:
  PSA_WORKER_KEY  : Cloudflare 시크릿과 동일한 값 (필수)
  SITE            : 기본 https://tcghub.kr
  PSA_HEADED      : 1 이면 브라우저 창 보이게 (챌린지 안 풀릴 때 시도)
"""
import os
import time
import requests
from playwright.sync_api import sync_playwright

SITE = os.environ.get("SITE", "https://tcghub.kr").rstrip("/")
WORKER_KEY = os.environ.get("PSA_WORKER_KEY", "")
HEADED = os.environ.get("PSA_HEADED", "") == "1"
POLL_SEC = 20
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

if not WORKER_KEY:
    raise SystemExit("PSA_WORKER_KEY 환경변수가 필요합니다 (Cloudflare 시크릿과 동일하게).")


def get_queue():
    try:
        r = requests.get(f"{SITE}/api/psa/queue",
                         headers={"x-psa-worker-key": WORKER_KEY}, timeout=20)
        if r.status_code == 401:
            print("  [!] 401 — 워커 키 불일치 (Cloudflare PSA_WORKER_KEY 와 같게)")
            return []
        return r.json().get("certs", [])
    except Exception as e:
        print(f"  [!] queue 조회 실패: {e}")
        return []


def fetch_html(page, cert):
    """실제 cert 데이터가 보일 때만 HTML 반환. 챌린지/로딩만 보이면 None
    → 캐시 오염(멀쩡한 cert 를 '없음'으로 영구 저장) 방지. None 이면 대기열에 남겨 다음 주기 재시도."""
    page.goto(f"https://www.psacard.com/cert/{cert}",
              wait_until="domcontentloaded", timeout=60000)
    # Cloudflare 챌린지 자동 통과 대기 — Item Grade / Brand/Title 라벨이 뜨면 실제 페이지
    for _ in range(40):
        html = page.content()
        low = html.lower()
        if "item grade" in low or "brand/title" in low:
            return html  # 실제 데이터 확보 → 전송
        page.wait_for_timeout(1000)
    return None  # 40초 동안 실제 데이터 못 봄 (챌린지/없는 cert) → 전송 안 함


def post_cache(cert, html):
    try:
        r = requests.post(f"{SITE}/api/psa/cache",
                          headers={"x-psa-worker-key": WORKER_KEY,
                                   "content-type": "application/json"},
                          json={"cert_number": cert, "html": html}, timeout=30)
        return r.json()
    except Exception as e:
        return {"ok": False, "error": str(e)}


def main():
    print(f"PSA worker 시작 — {SITE} (headed={HEADED}). {POLL_SEC}초마다 대기열 확인.")
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=not HEADED)
        ctx = browser.new_context(user_agent=UA, locale="en-US",
                                  viewport={"width": 1280, "height": 900})
        page = ctx.new_page()
        while True:
            certs = get_queue()
            if certs:
                print(f"대기열 {len(certs)}건: {certs}")
                for cert in certs:
                    try:
                        html = fetch_html(page, cert)
                        if not html:
                            print(f"  {cert} — 실제 데이터 못 받음(챌린지?), 건너뜀(다음 주기 재시도)")
                            continue  # 대기열에 남김 → 캐시 오염 방지
                        res = post_cache(cert, html)
                        print(f"  {cert} -> {res}")
                    except Exception as e:
                        print(f"  {cert} 실패: {e}")
                    time.sleep(1)
            time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
