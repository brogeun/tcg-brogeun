"""
SNKRDUNK 가격 히스토리 백필 — 1단계: 구조 탐사 (로컬 PC 실행 전용)

목적: SNKRDUNK 상품 상세 페이지의 데이터 구조를 파악하여
      백필 스크립트를 정확하게 짤 수 있도록 한다.

사용법:
1. snkrdunk.com 에 로그인 (Chrome 등 브라우저)
2. 임의의 카드 상품 페이지 열기 — 가격 차트가 보이는 페이지
   예: https://snkrdunk.com/jp/products/12345 (실제 ID 사용)
3. F12 (DevTools) → Console 탭 → 아래 한 줄 붙여넣고 Enter:

   copy(JSON.stringify(document.cookie.split(';').map(c=>{const[n,...rest]=c.trim().split('=');return{name:n,value:rest.join('=')}})))

4. cookies.json 새 파일 만들어 붙여넣기 (프로젝트 루트에)
5. python scripts/inspect_snkrdunk.py <PRODUCT_ID>
   예: python scripts/inspect_snkrdunk.py 5547899
6. debug/ 폴더의 nextdata-*.json 과 page-*.html, network-*.txt 파일을
   Claude 에게 공유 → 정확한 백필 스크립트 작성

cookies.json 은 .gitignore 에 들어가 있어 git 에 올라가지 않음.
"""

import json
import sys
import re
import time
import urllib.request
import urllib.error
from pathlib import Path
from datetime import datetime

# Selenium 은 옵션 — 페이지에 JS 렌더링이 필요한 경우
try:
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    HAS_SELENIUM = True
except ImportError:
    HAS_SELENIUM = False

ROOT = Path(__file__).resolve().parent.parent
DEBUG_DIR = ROOT / "debug"
DEBUG_DIR.mkdir(exist_ok=True)
COOKIES_FILE = ROOT / "cookies.json"

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)


def load_cookies():
    if not COOKIES_FILE.exists():
        print("⚠ cookies.json 이 없습니다. 로그인 안 된 상태로 진행합니다 — 일부 데이터 가려질 수 있음.")
        print("  → 로그인 + 쿠키 추출 방법은 이 파일 상단 주석 참고")
        return []
    try:
        return json.loads(COOKIES_FILE.read_text("utf-8"))
    except Exception as e:
        print(f"⚠ cookies.json 파싱 실패: {e}")
        return []


def cookie_header(cookies):
    if not cookies:
        return ""
    return "; ".join(f"{c['name']}={c['value']}" for c in cookies if c.get('name'))


def fetch_html(url, cookies):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8",
        "Cookie": cookie_header(cookies),
    })
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read().decode("utf-8", errors="replace"), dict(r.headers)


def extract_next_data(html):
    """Next.js __NEXT_DATA__ 스크립트 태그 추출"""
    m = re.search(
        r'<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)</script>',
        html, re.S
    )
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except Exception as e:
        print(f"⚠ __NEXT_DATA__ JSON 파싱 실패: {e}")
        return None


def find_history_keys(obj, path=""):
    """JSON 트리에서 가격/거래 히스토리로 보이는 키들을 찾아냄"""
    KEYWORDS = [
        'history', 'transactions', 'sold', 'soldList', 'priceHistory',
        'listings', 'usedListings', 'soldListings', 'trades', 'tradeHistory',
        'chart', 'chartData', 'priceData', 'recentSales', 'salesHistory',
    ]
    found = []
    if isinstance(obj, dict):
        for k, v in obj.items():
            if any(kw.lower() in k.lower() for kw in KEYWORDS):
                size = len(v) if isinstance(v, (list, dict)) else 1
                preview = str(v)[:200] if not isinstance(v, (list, dict)) else f"({type(v).__name__}, len={size})"
                found.append((f"{path}.{k}" if path else k, preview))
            found.extend(find_history_keys(v, f"{path}.{k}" if path else k))
    elif isinstance(obj, list) and obj:
        # 리스트의 첫 요소만 검사
        found.extend(find_history_keys(obj[0], f"{path}[0]"))
    return found


def try_selenium_xhr_capture(url, cookies):
    """Selenium 으로 페이지 로드 + XHR 요청 캡처"""
    if not HAS_SELENIUM:
        print("⚠ selenium 미설치 — pip install selenium 후 다시 실행")
        return None
    print("→ Selenium 으로 페이지 로드 + 네트워크 캡처...")
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument(f"--user-agent={UA}")
    # devtools 통한 네트워크 로그 활성화
    opts.set_capability("goog:loggingPrefs", {"performance": "ALL"})
    driver = webdriver.Chrome(options=opts)
    try:
        # 쿠키 적용 위해 도메인 먼저 방문
        driver.get("https://snkrdunk.com/")
        for c in cookies:
            try:
                driver.add_cookie({
                    "name": c["name"],
                    "value": c["value"],
                    "domain": c.get("domain", ".snkrdunk.com"),
                    "path": c.get("path", "/"),
                })
            except Exception:
                pass
        driver.get(url)
        time.sleep(6)  # XHR 발사 대기
        # 페이지 스크롤 — 차트가 lazy load 되는 경우 대비
        driver.execute_script("window.scrollTo(0, 800);")
        time.sleep(3)
        driver.execute_script("window.scrollTo(0, 1600);")
        time.sleep(3)
        # 네트워크 로그 추출
        logs = driver.get_log("performance")
        xhrs = []
        for entry in logs:
            try:
                msg = json.loads(entry["message"])["message"]
                if msg["method"] == "Network.responseReceived":
                    resp = msg["params"]["response"]
                    rurl = resp.get("url", "")
                    if any(kw in rurl for kw in ["/api/", "/v1/", "/v2/", "history", "sold", "listings", "transactions", ".json"]):
                        xhrs.append({
                            "url": rurl,
                            "method": resp.get("requestMethod", "GET"),
                            "type": resp.get("mimeType"),
                            "status": resp.get("status"),
                        })
            except Exception:
                pass
        # 최종 렌더된 HTML
        rendered_html = driver.page_source
        return {"xhrs": xhrs, "rendered_html": rendered_html}
    finally:
        driver.quit()


def main():
    if len(sys.argv) < 2:
        print("사용법: python scripts/inspect_snkrdunk.py <PRODUCT_ID>")
        print("예시:   python scripts/inspect_snkrdunk.py 5547899")
        sys.exit(1)

    product_id = sys.argv[1]
    cookies = load_cookies()
    if cookies:
        print(f"✓ cookies.json 로드 완료 ({len(cookies)}개 쿠키)")

    # 1) 단순 HTML fetch
    url = f"https://snkrdunk.com/jp/products/{product_id}"
    print(f"\n[1/3] HTML fetch: {url}")
    try:
        html, headers = fetch_html(url, cookies)
        page_path = DEBUG_DIR / f"page-{product_id}.html"
        page_path.write_text(html, encoding="utf-8")
        print(f"  ✓ {page_path.name} ({len(html):,} bytes)")
    except Exception as e:
        print(f"  ⚠ {e}")
        html = ""

    # 2) __NEXT_DATA__ 추출
    print(f"\n[2/3] __NEXT_DATA__ 추출")
    next_data = extract_next_data(html) if html else None
    if next_data:
        nd_path = DEBUG_DIR / f"nextdata-{product_id}.json"
        nd_path.write_text(json.dumps(next_data, ensure_ascii=False, indent=2), encoding="utf-8")
        size = nd_path.stat().st_size
        print(f"  ✓ {nd_path.name} ({size:,} bytes)")
        # 히스토리 관련 키 자동 탐색
        keys = find_history_keys(next_data)
        if keys:
            print(f"  ✓ 히스토리 의심 키 {len(keys)}개 발견:")
            for path, preview in keys[:20]:
                print(f"    - {path}: {preview}")
            keys_path = DEBUG_DIR / f"keys-{product_id}.txt"
            keys_path.write_text(
                "\n".join(f"{p}\n  → {pre}\n" for p, pre in keys),
                encoding="utf-8"
            )
            print(f"  → {keys_path.name} 에 전체 목록 저장")
        else:
            print("  ⚠ 히스토리 관련 키 없음 — 페이지가 JS 렌더링에 의존할 수 있음")
    else:
        print("  ⚠ __NEXT_DATA__ 없음 (HTML이 비어있거나 다른 프레임워크)")

    # 3) Selenium 으로 XHR 캡처
    print(f"\n[3/3] Selenium XHR 캡처")
    sel_result = try_selenium_xhr_capture(url, cookies)
    if sel_result:
        xhr_path = DEBUG_DIR / f"network-{product_id}.txt"
        lines = ["=== Captured XHR / API requests ==="]
        for x in sel_result["xhrs"]:
            lines.append(f"[{x['status']}] {x['method']} {x['url']}  ({x['type']})")
        xhr_path.write_text("\n".join(lines), encoding="utf-8")
        print(f"  ✓ {xhr_path.name} — XHR {len(sel_result['xhrs'])}건 캡처")
        for x in sel_result["xhrs"][:15]:
            print(f"    [{x['status']}] {x['url'][:120]}")
        # 최종 렌더된 HTML 도 저장
        rendered_path = DEBUG_DIR / f"page-rendered-{product_id}.html"
        rendered_path.write_text(sel_result["rendered_html"], encoding="utf-8")
        print(f"  ✓ {rendered_path.name} (렌더 후 HTML, JS 결과 포함)")

    print(f"\n=========================================")
    print(f"✅ debug/ 폴더의 다음 파일들을 Claude 에게 공유해주세요:")
    for f in sorted(DEBUG_DIR.iterdir()):
        if f.name.startswith(("nextdata-", "keys-", "network-")):
            print(f"   - debug/{f.name}")
    print(f"=========================================")


if __name__ == "__main__":
    main()
