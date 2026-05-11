"""
extract_jp_box_urls.py — tcgcollector 일본 박스 list 페이지에서
121개 옛날 박스의 정확한 URL + 실제 카드 수 추출 (selenium)

같은 사이트 패턴을 사용하는 기존 fetch_set_cards.py 와 동일한 방식.

흐름:
  1. selenium 으로 tcgcollector 일본 박스 list 페이지 열기 + 무한 스크롤
  2. 박스 카드 블록 추출 (영문명, URL, 카드 수)
  3. _pending-pokemon-boxes.json 의 영문명과 매칭
  4. 카드 수 비교 (사용자 예상치 vs 실제)
  5. 결과를 data/_tcgcollector-jp-box-urls.json 에 저장

사용:
  python scripts/extract_jp_box_urls.py
"""
import json
import re
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PENDING = ROOT / "data" / "_pending-pokemon-boxes.json"
OUTPUT = ROOT / "data" / "_tcgcollector-jp-box-urls.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")

JP_SETS_URL = "https://www.tcgcollector.com/sets/jp?cardCountMode=anyCardVariant&releaseDateOrder=newToOld&displayAs=images"


def make_driver():
    from selenium import webdriver
    from selenium.webdriver.chrome.options import Options
    opts = Options()
    opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument(f"--user-agent={UA}")
    opts.add_argument("--window-size=1920,3000")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    driver = webdriver.Chrome(options=opts)
    try:
        driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    except Exception:
        pass
    return driver


def scroll_all(driver, max_iter=30, sleep=1.2):
    """무한 스크롤 — 페이지 끝까지 (모든 박스 로드)"""
    last_h = 0
    for i in range(max_iter):
        driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(sleep)
        h = driver.execute_script("return document.body.scrollHeight")
        if h == last_h:
            print(f"  스크롤 완료 ({i+1} iter, height={h})")
            break
        last_h = h
    driver.execute_script("window.scrollTo(0, 0);")
    time.sleep(0.5)


def normalize_name(name: str) -> str:
    """매칭용 정규화 — 대소문자, 공백, 특수문자 무시"""
    return re.sub(r'[^a-z0-9]', '', name.lower())


def extract_boxes_from_html(html: str):
    """HTML 에서 박스 정보 추출
    tcgcollector 박스 카드 패턴:
      <a class="..." href="/sets/{id}/{slug}">{박스 영문명}</a>
      ...
      0/{카드수}  (또는 X/{카드수})
    """
    results = []
    # 박스 카드 블록 찾기 — 박스명 + URL + 카드 수 한 묶음
    # 좀 더 관대한 패턴 (HTML 구조 변경 대비)
    pattern = re.compile(
        r'<a[^>]+?href="(/sets/(\d+)/([a-z0-9\-]+))"[^>]*>\s*([^<]+?)\s*</a>'
        r'[\s\S]{0,1500}?'
        r'(\d+)\s*/\s*(\d+)',
        re.IGNORECASE,
    )
    seen = set()
    for m in pattern.finditer(html):
        path, internal_id, slug, name, _, total = m.groups()
        full_url = f"https://www.tcgcollector.com{path}"
        if full_url in seen:
            continue
        seen.add(full_url)
        try:
            card_count = int(total)
        except ValueError:
            card_count = 0
        results.append({
            "url": full_url,
            "internal_id": internal_id,
            "slug": slug,
            "name_en": name.strip(),
            "card_count": card_count,
        })
    return results


def main():
    # 1. pending 박스 로드
    with PENDING.open(encoding="utf-8") as f:
        pending_boxes = json.load(f)["boxes"]
    en_to_box = {}
    for b in pending_boxes:
        en = b.get("en_name", "").strip()
        if en:
            en_to_box[normalize_name(en)] = b
    print(f"[pending] {len(pending_boxes)}개 박스 (매칭 가능: {len(en_to_box)}개)")

    # 2. selenium 으로 일본 박스 list 페이지 열기
    print(f"\n[selenium] {JP_SETS_URL}")
    driver = make_driver()
    try:
        driver.get(JP_SETS_URL)
        time.sleep(3)
        print("  무한 스크롤 시작...")
        scroll_all(driver, max_iter=30)
        html = driver.page_source
        print(f"  HTML 크기: {len(html):,} bytes")
    finally:
        driver.quit()

    # 3. 박스 추출
    extracted = extract_boxes_from_html(html)
    print(f"\n[추출] 총 {len(extracted)}개 박스 발견 (tcgcollector 일본 list)")

    # 4. 매칭 (영문명 정규화 비교)
    matched = {}
    for ext in extracted:
        key = normalize_name(ext["name_en"])
        if key in en_to_box:
            box = en_to_box[key]
            matched[box["code"]] = {
                "url": ext["url"],
                "internal_id": ext["internal_id"],
                "slug": ext["slug"],
                "name_en_tcg": ext["name_en"],
                "name_en_pending": box["en_name"],
                "kr_name": box.get("kr_name", ""),
                "card_count_tcg": ext["card_count"],
                "card_count_pending": box.get("card_count", 0),
                "matched": True,
            }

    # 5. 미매칭 박스
    unmatched = []
    for box in pending_boxes:
        if box["code"] not in matched:
            unmatched.append({
                "code": box["code"],
                "en_name": box.get("en_name", ""),
                "kr_name": box.get("kr_name", ""),
            })

    # 6. 결과 저장
    with OUTPUT.open("w", encoding="utf-8") as f:
        json.dump({
            "matched_count": len(matched),
            "unmatched_count": len(unmatched),
            "matched": matched,
            "unmatched": unmatched,
        }, f, indent=2, ensure_ascii=False)

    # 7. 콘솔 리포트
    print(f"\n{'='*70}")
    print(f"  매칭 성공: {len(matched)}개 / {len(pending_boxes)}개")
    print(f"  매칭 실패: {len(unmatched)}개")
    print(f"{'='*70}\n")

    # 카드 수 비교
    print(f"=== 카드 수 비교 (tcgcollector 실제 vs 사용자 캡처 예상) ===")
    diffs = []
    for code, info in matched.items():
        actual = info["card_count_tcg"]
        expected = info["card_count_pending"]
        if actual == expected:
            flag = "✓"
        else:
            flag = f"⚠️  (예상 {expected} → 실제 {actual})"
            diffs.append((code, expected, actual))
        print(f"  {code:12s} {info['name_en_tcg']:45s} {actual:4d}장 {flag}")

    if diffs:
        print(f"\n=== 카드 수 불일치 ({len(diffs)}개) — 사용자 확인 필요 ===")
        for code, exp, act in diffs:
            print(f"  {code:12s}: 예상 {exp} → 실제 {act}")

    if unmatched:
        print(f"\n=== 미매칭 박스 ({len(unmatched)}개) — tcgcollector 에 없거나 영문명 불일치 ===")
        for u in unmatched:
            print(f"  {u['code']:12s} ({u['en_name']}) — {u['kr_name']}")

    print(f"\n[저장] {OUTPUT}")
    print(f"\n다음 단계: python scripts/add_old_boxes_to_pokemon_sets.py")


if __name__ == "__main__":
    main()
