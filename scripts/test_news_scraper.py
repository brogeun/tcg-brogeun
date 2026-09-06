import importlib.util
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
SCRIPT = ROOT / "scripts" / "scrape_news.py"
spec = importlib.util.spec_from_file_location("scrape_news", SCRIPT)
scrape_news = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scrape_news)


assert scrape_news.parse_date("작성일 2026년 09월 04일") == "2026-09-04"
assert scrape_news.parse_date("2026.08.14") == "2026-08-14"
assert scrape_news.canonical_link(
    "https://www.pokemoncard.co.kr/_news?utm_source=test&id=21033"
) == "https://pokemoncard.co.kr/_news?id=21033"
assert scrape_news.canonical_link(
    "https://www.onepiece-cardgame.kr/topics/view.do?brdno=6269&utm_campaign=test"
) == "https://onepiece-cardgame.kr/topics/view.do?brdno=6269"
assert scrape_news.RETENTION_DAYS == 180
assert scrape_news.MAX_ITEMS == 100
assert any(
    source["key"] == "onepiece" and "extraValue=&" in source["url"]
    for source in scrape_news.NEWS_SOURCES
)

workflow = (ROOT / ".github" / "workflows" / "scrape.yml").read_text("utf-8")
assert "Run news scraper (한국 포켓몬·원피스 공식 소식)" in workflow
assert "run: python scripts/scrape_news.py" in workflow

pokemon = scrape_news.NEWS_SOURCES[0]
onepiece = scrape_news.NEWS_SOURCES[1]
items = scrape_news.parse_listing('''<li><a href="/_news?id=21033"><span>NEW</span>
<h3>실제 공지 제목</h3><ul class="list-split"><li>2026년 09월 04일</li></ul>
<img src="https://data1.pokemonkorea.co.kr/banner.png"></a></li>''', pokemon)
assert items[0]["title"] == "실제 공지 제목"
assert items[0]["date"] == "2026-09-04"
assert items[0]["link"].endswith("/_news?id=21033")
op_items = scrape_news.parse_listing('''<a class="item" href="topics/view.do?brdno=6517">
<span class="cate">CAMPAIGN</span><span class="tit">정확한 원피스 공지</span>
<span class="date">2026-08-28</span><img src="/image/dummy/notice_dummy.png"></a>''', onepiece)
assert op_items[0]["title"] == "정확한 원피스 공지"
assert op_items[0]["image"] == ""
assert scrape_news.parse_date("2026-02-31") is None
assert scrape_news.canonical_link("javascript:alert(1)") == ""
assert scrape_news.detail_image('<header><img src="logo.png"></header><div class="bx-board"><img src="/banner.png"></div>', items[0]["link"]) == "https://pokemoncard.co.kr/banner.png"

now = datetime(2026, 9, 6, tzinfo=timezone.utc)
old_failed = {"source": "onepiece", "link": "https://onepiece-cardgame.kr/topics/view.do?brdno=1", "date": "2025-01-01", "title": "Preserve on failure"}
stale = {**items[0], "title": "stale title", "link": items[0]["link"].replace('://', '://www.')}
merged = scrape_news.merge_items([old_failed, stale], items, {"pokemon"}, now)
assert len(merged) == 2
assert old_failed in merged
assert merged[0]["title"] == "실제 공지 제목"
assert scrape_news.merge_items(merged, items, {"pokemon"}, now) == merged
print("news scraper parsing, duplicate refresh, image extraction, failed-source preservation: ok")
