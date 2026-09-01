"""
fetch_set_cards.py — 세트별 풀 카드 데이터 (모든 variants 포함) 수집

검증된 셀렉터:
  - tcgcollector.com:  .card-image-grid-item (공식 카드 그리드)
  - tcgrepublic.com:   카드 그리드 a 태그 (요소별 추출)

displayAs=images 모드로 모든 카드 (RR, AR, SAR, SR 등) 한 페이지에 표시.

출력: data/cards-by-set/{code}.json
포맷:
{
  "code": "M4",
  "name": "닌자 스페너",
  "fetchedAt": "2026-05-05T...",
  "cardCount": 120,
  "cards": [
    {"number": "001/083", "name": "Weedle", "image": "https://...", "rarity": "C", "url": "https://..."}
  ]
}

사용:
  python scripts/fetch_set_cards.py            # 전체
  python scripts/fetch_set_cards.py M4 OP15    # 특정 세트만
  python scripts/fetch_set_cards.py --force    # 기존 덮어쓰기
  python scripts/fetch_set_cards.py --pokemon  # 포켓몬만
  python scripts/fetch_set_cards.py --onepiece # 원피스만
"""

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.chrome.options import Options


ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "cards-by-set"
OUT_DIR.mkdir(parents=True, exist_ok=True)

def _atomic_save(path, payload):
    """validate-before-replace"""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(payload, encoding="utf-8")
    try:
        json.loads(tmp.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"    [atomic abort] {path.name}: {e}")
        tmp.unlink(missing_ok=True)
        return False
    os.replace(tmp, path)
    return True



UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

POKEMON_SETS = [
    ("M6", "스톰 에메랄다", "https://www.tcgcollector.com/sets/11929/storm-emeralda"),
    ("M5", "어비스아이", "https://www.tcgcollector.com/sets/11810/abyss-eye"),
    ("M4", "닌자 스페너", "https://www.tcgcollector.com/sets/11800/ninja-spinner"),
    ("M3", "무니키스 제로", "https://www.tcgcollector.com/sets/11684/nullifying-zero"),
    ("M2a", "메가 드림 ex", "https://www.tcgcollector.com/sets/11678/mega-dream-ex"),
    ("M2", "인페르노 X", "https://www.tcgcollector.com/sets/11675/inferno-x"),
    ("M1L", "메가 브레이브", "https://www.tcgcollector.com/sets/11660/mega-brave"),
    ("M1S", "메가 심포니아", "https://www.tcgcollector.com/sets/11661/mega-symphonia"),
    ("SV11B", "블랙 볼트", "https://www.tcgcollector.com/sets/11652/black-bolt"),
    ("SV11W", "화이트 플레어", "https://www.tcgcollector.com/sets/11653/white-flare"),
    ("SV10", "로켓단의 영광", "https://www.tcgcollector.com/sets/11649/the-glory-of-team-rocket"),
    ("SV9a", "열풍의 아레나", "https://www.tcgcollector.com/sets/11648/hot-air-arena"),
    ("SV9", "배틀 파트너즈", "https://www.tcgcollector.com/sets/11643/battle-partners"),
    ("SV8a", "테라스탈 페스티벌 ex", "https://www.tcgcollector.com/sets/11640/terastal-festival-ex"),
    ("SV8", "초전 브레이커", "https://www.tcgcollector.com/sets/11638/super-electric-breaker"),
    ("SV7a", "파라다이스 드래고나", "https://www.tcgcollector.com/sets/11635/paradise-dragona"),
    ("SV7", "스텔라 미라클", "https://www.tcgcollector.com/sets/11629/stellar-miracle"),
    ("SV6a", "나이트 원더러", "https://www.tcgcollector.com/sets/11626/night-wanderer"),
    ("SV6", "변환의 가면", "https://www.tcgcollector.com/sets/11624/mask-of-change"),
    ("SV5a", "크림슨 헤이즈", "https://www.tcgcollector.com/sets/11622/crimson-haze"),
    ("SV5M", "사이버 저지", "https://www.tcgcollector.com/sets/11604/cyber-judge"),
    ("SV5K", "와일드 포스", "https://www.tcgcollector.com/sets/11603/wild-force"),
    ("SV4a", "샤이니 트레저 ex", "https://www.tcgcollector.com/sets/11602/shiny-treasure-ex"),
    ("SV4M", "미래의 일섬", "https://www.tcgcollector.com/sets/11593/future-flash"),
    ("SV4K", "고대의 포효", "https://www.tcgcollector.com/sets/11592/ancient-roar"),
    ("SV3a", "레이징 서프", "https://www.tcgcollector.com/sets/11583/raging-surf"),
    ("SV3", "흑염의 지배자", "https://www.tcgcollector.com/sets/11578/ruler-of-the-black-flame"),
    ("SV2a", "포켓몬 카드 151", "https://www.tcgcollector.com/sets/11575/pokemon-card-151"),
    ("SV2D", "클레이 버스트", "https://www.tcgcollector.com/sets/11570/clay-burst"),
    ("SV2P", "스노우 해저드", "https://www.tcgcollector.com/sets/11569/snow-hazard"),
    ("SV1a", "트리플렛 비트", "https://www.tcgcollector.com/sets/11566/triplet-beat"),
    # ─── Sword & Shield Era (대문자 S — 실제 파일명 케이스 일치) ───
    ("S12a", "VSTAR 유니버스", "https://www.tcgcollector.com/sets/11503/vstar-universe"),
    ("S12", "패러다임 트리거", "https://www.tcgcollector.com/sets/11499/paradigm-trigger"),
    ("S11a", "백휘의 아르카나", "https://www.tcgcollector.com/sets/11497/incandescent-arcana"),
    ("S11", "로스트 어비스", "https://www.tcgcollector.com/sets/11484/lost-abyss"),
    ("S10b", "포켓몬 GO", "https://www.tcgcollector.com/sets/11481/pokemon-go"),
    ("S10a", "다크 판타즈마", "https://www.tcgcollector.com/sets/11469/dark-phantasma"),
    ("S9a", "배틀 리전", "https://www.tcgcollector.com/sets/11456/battle-region"),
    ("S9", "스타 버스", "https://www.tcgcollector.com/sets/11452/star-birth"),
    ("S8b", "VMAX 클라이맥스", "https://www.tcgcollector.com/sets/11449/vmax-climax"),
    ("S8", "퓨전 아츠", "https://www.tcgcollector.com/sets/11437/fusion-arts"),
    ("S7R", "블루 스카이 스트림", "https://www.tcgcollector.com/sets/11430/blue-sky-stream"),
    ("S7D", "마천의 퍼펙트", "https://www.tcgcollector.com/sets/11429/skyscraping-perfection"),
    ("S6a", "이브이 히어로즈", "https://www.tcgcollector.com/sets/11424/eevee-heroes"),
    # ─── S6a 이전 옛날 박스 (S6H ~ Base Set 1996) — extract_jp_box_urls.py 자동 생성 ───
    ("S6H", "백은의 랜스", "https://www.tcgcollector.com/sets/11421/silver-lance"),
    ("S6K", "칠흑의 가이스트", "https://www.tcgcollector.com/sets/11422/jet-black-spirit"),
    ("S5a", "쌍벽의 파이터", "https://www.tcgcollector.com/sets/11412/matchless-fighters"),
    ("S5R", "연격마스터", "https://www.tcgcollector.com/sets/11388/rapid-strike-master"),
    ("S5I", "일격마스터", "https://www.tcgcollector.com/sets/11387/single-strike-master"),
    ("S4a", "샤이니스타 V", "https://www.tcgcollector.com/sets/11383/shiny-star-v"),
    ("S4", "앙천의 볼트태클", "https://www.tcgcollector.com/sets/11379/amazing-volt-tackle"),
    ("S3a", "전설의 고동", "https://www.tcgcollector.com/sets/11377/legendary-heartbeat"),
    ("S3", "무한존", "https://www.tcgcollector.com/sets/11376/infinity-zone"),
    ("S2a", "폭염워커", "https://www.tcgcollector.com/sets/11375/explosive-walker"),
    ("S2", "반역크래시", "https://www.tcgcollector.com/sets/11374/rebellion-crash"),
    ("S1a", "VMAX 라이징", "https://www.tcgcollector.com/sets/11370/vmax-rising"),
    ("S1H", "실드", "https://www.tcgcollector.com/sets/11340/shield"),
    ("S1W", "소드", "https://www.tcgcollector.com/sets/11339/sword"),
    ("SM12a", "태그올스타즈", "https://www.tcgcollector.com/sets/11211/tag-all-stars"),
    ("SM12", "얼터제네시스", "https://www.tcgcollector.com/sets/11185/alter-genesis"),
    ("SM11b", "드림리그", "https://www.tcgcollector.com/sets/11176/dream-league"),
    ("SM11a", "리믹스바우트", "https://www.tcgcollector.com/sets/11268/remix-bout"),
    ("SM11", "미라클트윈", "https://www.tcgcollector.com/sets/11191/miracle-twin"),
    ("SM10b", "스카이레전드", "https://www.tcgcollector.com/sets/11298/sky-legend"),
    ("SM10a", "GG엔드", "https://www.tcgcollector.com/sets/11171/gg-end"),
    ("SM10", "더블블레이즈", "https://www.tcgcollector.com/sets/11180/double-blaze"),
    ("SM9b", "풀메탈월", "https://www.tcgcollector.com/sets/11203/full-metal-wall"),
    ("SM9a", "나이트유니즌", "https://www.tcgcollector.com/sets/11178/night-unison"),
    ("SM9", "태그볼트", "https://www.tcgcollector.com/sets/11296/tag-bolt"),
    ("SM8b", "GX 울트라샤이니", "https://www.tcgcollector.com/sets/11217/gx-ultra-shiny"),
    ("SM8a", "다크오더", "https://www.tcgcollector.com/sets/11294/dark-order"),
    ("SM8", "초폭임팩트", "https://www.tcgcollector.com/sets/11253/super-burst-impact"),
    ("SM7b", "페어리라이즈", "https://www.tcgcollector.com/sets/11204/fairy-rise"),
    ("SM7a", "신뢰의 스파크", "https://www.tcgcollector.com/sets/11285/thunderclap-spark"),
    ("SM7", "창공의 카리스마", "https://www.tcgcollector.com/sets/11224/sky-splitting-charisma"),
    ("SM6b", "챔피언로드", "https://www.tcgcollector.com/sets/11260/champion-road"),
    ("SM6a", "드래곤스톰", "https://www.tcgcollector.com/sets/11235/dragon-storm"),
    ("SM6", "금단의 빛", "https://www.tcgcollector.com/sets/11305/forbidden-light"),
    ("SM5+", "울트라포스", "https://www.tcgcollector.com/sets/11212/ultra-force"),
    ("SM5M", "울트라문", "https://www.tcgcollector.com/sets/11164/ultra-moon"),
    ("SM5S", "울트라썬", "https://www.tcgcollector.com/sets/11306/ultra-sun"),
    ("SM4+", "GX 배틀부스트", "https://www.tcgcollector.com/sets/11239/gx-battle-boost"),
    ("SM4S", "이차원의 초수", "https://www.tcgcollector.com/sets/11250/ultradimensional-beasts"),
    ("SM4A", "각성의 용사", "https://www.tcgcollector.com/sets/11163/awakened-heroes"),
    ("SM3+", "빛나는 전설", "https://www.tcgcollector.com/sets/11206/shining-legends"),
    ("SM3H", "어둠을 밝힌 무지개", "https://www.tcgcollector.com/sets/11284/to-have-seen-the-battle-rainbow"),
    ("SM3N", "빛을 삼킨 어둠", "https://www.tcgcollector.com/sets/11265/darkness-that-consumes-light"),
    ("SM2+", "새로운 시련", "https://www.tcgcollector.com/sets/11289/facing-a-new-trial"),
    ("SM2L", "알로라의 달빛", "https://www.tcgcollector.com/sets/11277/alolan-moonlight"),
    ("SM2K", "알로라의 햇빛", "https://www.tcgcollector.com/sets/11170/islands-await-you"),
    ("SM1+", "썬&문 강화확장팩", "https://www.tcgcollector.com/sets/11272/sun-and-moon-enhanced-expansion-pack"),
    ("SM1M", "문 컬렉션", "https://www.tcgcollector.com/sets/11216/collection-moon"),
    ("SM1S", "썬 컬렉션", "https://www.tcgcollector.com/sets/11229/collection-sun"),
    ("XY11-Br", "냉혹한 반역자", "https://www.tcgcollector.com/sets/11257/cruel-traitor"),
    ("XY11-Bb", "타오르는 투사", "https://www.tcgcollector.com/sets/11195/fever-burst-fighter"),
    ("XY10", "초능력의 제왕", "https://www.tcgcollector.com/sets/11256/awakening-psychic-king"),
    ("XY9", "천공의 분노", "https://www.tcgcollector.com/sets/11237/rage-of-the-broken-heavens"),
    ("XY8-Br", "붉은 섬광", "https://www.tcgcollector.com/sets/11241/red-flash"),
    ("XY8-Bb", "푸른 충격", "https://www.tcgcollector.com/sets/11236/blue-shock"),
    ("XY7", "밴디트링", "https://www.tcgcollector.com/sets/11269/bandit-ring"),
    ("XY6", "에메랄드 브레이크", "https://www.tcgcollector.com/sets/11267/emerald-break"),
    ("XY5-Bt", "타이달 스톰", "https://www.tcgcollector.com/sets/11197/tidal-storm"),
    ("XY5-Bg", "가이아 볼케이노", "https://www.tcgcollector.com/sets/11174/gaia-volcano"),
    ("XY4", "팬텀게이트", "https://www.tcgcollector.com/sets/11232/phantom-gate"),
    ("XY3", "라이징피스트", "https://www.tcgcollector.com/sets/11208/rising-fist"),
    ("XY2", "와일드 블레이즈", "https://www.tcgcollector.com/sets/11273/wild-blaze"),
    ("XY1-By", "컬렉션 Y", "https://www.tcgcollector.com/sets/11228/collection-y"),
    ("XY1-Bx", "컬렉션 X", "https://www.tcgcollector.com/sets/11258/collection-x"),
    ("BW9", "메갈로캐논", "https://www.tcgcollector.com/sets/11251/megalo-cannon"),
    ("BW8-Brn", "라이덴너클", "https://www.tcgcollector.com/sets/11220/thunder-knuckle"),
    ("BW8-Brf", "라센포스", "https://www.tcgcollector.com/sets/11301/spiral-force"),
    ("BW7", "플라스마게일", "https://www.tcgcollector.com/sets/11207/plasma-gale"),
    ("BW6-Bf", "프리즈볼트", "https://www.tcgcollector.com/sets/11215/freeze-bolt"),
    ("BW6-Bc", "콜드플레어", "https://www.tcgcollector.com/sets/11307/cold-flare"),
    ("BW5-Brz", "드래곤블래스트", "https://www.tcgcollector.com/sets/11274/dragon-blast"),
    ("BW5-Brn", "드래곤블레이드", "https://www.tcgcollector.com/sets/11245/dragon-blade"),
    ("BW4", "다크러시", "https://www.tcgcollector.com/sets/11230/dark-rush"),
    ("BW3-Bh", "헤일블리자드", "https://www.tcgcollector.com/sets/11209/hail-blizzard"),
    ("BW3-Bp", "사이코드라이브", "https://www.tcgcollector.com/sets/11199/psycho-drive"),
    ("BW2", "레드컬렉션", "https://www.tcgcollector.com/sets/11166/red-collection"),
    ("BW1-Bw", "화이트컬렉션", "https://www.tcgcollector.com/sets/11202/white-collection"),
    ("BW1-Bb", "블랙컬렉션", "https://www.tcgcollector.com/sets/11167/black-collection"),
    ("L3", "정상대격돌", "https://www.tcgcollector.com/sets/11297/clash-at-the-summit"),
    ("L2", "되살아나는 전설", "https://www.tcgcollector.com/sets/11226/reviving-legends"),
    ("L1-Bss", "소울실버 컬렉션", "https://www.tcgcollector.com/sets/11300/soulsilver-collection"),
    ("L1-Bhg", "하트골드 컬렉션", "https://www.tcgcollector.com/sets/11259/heartgold-collection"),
    ("Pt4", "아르세우스 광림", "https://www.tcgcollector.com/sets/11196/advent-of-arceus"),
    ("Pt3", "프론티어의 고동", "https://www.tcgcollector.com/sets/11169/beat-of-the-frontier"),
    ("Pt2", "시간의 끝의 인연", "https://www.tcgcollector.com/sets/11261/bonds-to-the-end-of-time"),
    ("Pt1", "은하의 패자", "https://www.tcgcollector.com/sets/11221/galactics-conquest"),
    ("DP6", "파공의 격투", "https://www.tcgcollector.com/sets/11213/intense-fight-in-the-destroyed-sky"),
    ("DP5", "비경의 외침", "https://www.tcgcollector.com/sets/11255/cry-from-the-mysterious"),
    ("DP4-Bd", "새벽의 질주", "https://www.tcgcollector.com/sets/11247/dawn-dash"),
    ("DP4-Bm", "월광의 추적", "https://www.tcgcollector.com/sets/11291/moonlit-pursuit"),
    ("DP3", "빛나는 어둠", "https://www.tcgcollector.com/sets/11231/shining-darkness"),
    ("DP2", "호수의 기적", "https://www.tcgcollector.com/sets/11210/secret-of-the-lakes"),
    ("DP1", "시공의 창조", "https://www.tcgcollector.com/sets/11244/space-time-creation"),
    ("PCG9", "사이하테의 공방", "https://www.tcgcollector.com/sets/11295/offense-and-defense-of-the-furthest-ends"),
    ("PCG8", "기적의 결정", "https://www.tcgcollector.com/sets/11278/miracle-crystal"),
    ("PCG7", "홀론의 환영", "https://www.tcgcollector.com/sets/11299/holon-phantom"),
    ("PCG6", "홀론의 연구탑", "https://www.tcgcollector.com/sets/11186/holon-research-tower"),
    ("PCG5", "마보로시의 숲", "https://www.tcgcollector.com/sets/11254/mirage-forest"),
    ("PCG4", "금의 하늘, 은의 바다", "https://www.tcgcollector.com/sets/11193/golden-sky-silvery-ocean"),
    ("PCG3", "로켓단 역습", "https://www.tcgcollector.com/sets/11179/team-rocket-strikes-back"),
    ("PCG2", "창공의 격돌", "https://www.tcgcollector.com/sets/11181/clash-of-the-blue-sky"),
    ("PCG1", "전설의 비상", "https://www.tcgcollector.com/sets/11225/flight-of-legends"),
    ("ADV4", "마그마단 VS 아쿠아단 두 개의 야망", "https://www.tcgcollector.com/sets/11233/magma-vs-aqua-two-ambitions"),
    ("ADV3", "천공의 패자", "https://www.tcgcollector.com/sets/11281/rulers-of-the-heavens"),
    ("ADV2", "사막의 기적", "https://www.tcgcollector.com/sets/11222/miracle-of-the-desert"),
    ("ADV1", "제1탄 확장팩 (Ruby & Sapphire)", "https://www.tcgcollector.com/sets/11165/adv-expansion-pack"),
    ("e5", "신비한 산", "https://www.tcgcollector.com/sets/11183/mysterious-mountains"),
    ("e4", "갈라진 대지", "https://www.tcgcollector.com/sets/11188/split-earth"),
    ("e3", "바다로부터의 바람", "https://www.tcgcollector.com/sets/11227/wind-from-the-sea"),
    ("e2", "지도에 없는 마을", "https://www.tcgcollector.com/sets/11218/the-town-on-no-map"),
    ("e1", "기본 확장팩", "https://www.tcgcollector.com/sets/11205/base-expansion-pack"),
    ("Neo4", "어둠 그리고 빛", "https://www.tcgcollector.com/sets/11252/darkness-and-to-light"),
    ("Neo3", "눈 뜨는 전설", "https://www.tcgcollector.com/sets/11173/awakening-legends"),
    ("Neo2", "유적을 넘어", "https://www.tcgcollector.com/sets/11266/crossing-the-ruins"),
    ("Neo1", "금, 은, 신세계로", "https://www.tcgcollector.com/sets/11290/gold-silver-to-a-new-world"),
    ("Gym2", "포켓몬 짐 확장 제2탄: 암흑으로부터의 도전", "https://www.tcgcollector.com/sets/11302/challenge-from-the-darkness"),
    ("Gym1", "포켓몬 짐 확장 제1탄: 리더즈 스타디움", "https://www.tcgcollector.com/sets/11242/leaders-stadium"),
    ("CL4", "로켓단", "https://www.tcgcollector.com/sets/11249/team-rocket"),
    ("CL3", "화석의 비밀", "https://www.tcgcollector.com/sets/11172/mystery-of-the-fossils"),
    ("CL2", "포켓몬 정글", "https://www.tcgcollector.com/sets/11201/pokemon-jungle"),
    ("CL1", "포켓몬 카드 게임 제1탄", "https://www.tcgcollector.com/sets/11182/expansion-pack"),
]

ONEPIECE_SETS = [
    ("OP15", "OP-15", "https://tcgrepublic.com/category/subcategory_page_10948.html"),
    ("EB04", "Extra Booster 04", "https://tcgrepublic.com/category/subcategory_page_10895.html"),
    ("OP14", "OP-14", "https://tcgrepublic.com/category/subcategory_page_10744.html"),
    ("EB03", "Extra Booster 03", "https://tcgrepublic.com/category/subcategory_page_10671.html"),
    ("OP13", "계승된 의지", "https://tcgrepublic.com/category/subcategory_page_10545.html"),
    ("OP12", "마스터의 유산", "https://tcgrepublic.com/category/subcategory_page_10336.html"),
    ("OP11", "신속의 일격", "https://tcgrepublic.com/category/subcategory_page_10172.html"),
    ("EB02", "애니메이션 25주년", "https://tcgrepublic.com/category/subcategory_page_10091.html"),
    ("OP10", "로열 블러드", "https://tcgrepublic.com/category/subcategory_page_9987.html"),
    ("OP09", "신세계의 황제들", "https://tcgrepublic.com/category/subcategory_page_9758.html"),
    ("OP08", "두 전설", "https://tcgrepublic.com/category/subcategory_page_9499.html"),
    ("OP07", "500년 후의 미래", "https://tcgrepublic.com/category/subcategory_page_9138.html"),
    ("EB01", "메모리얼 컬렉션", "https://tcgrepublic.com/category/subcategory_page_9054.html"),
    ("OP06", "선장의 날개", "https://tcgrepublic.com/category/category_page_67.html"),
    ("OP05", "새로운 시대의 개막", "https://tcgrepublic.com/category/subcategory_page_8690.html"),
    ("OP04", "음모의 왕국", "https://tcgrepublic.com/category/subcategory_page_8492.html"),
    ("OP03", "힘의 기둥", "https://tcgrepublic.com/category/subcategory_page_8014.html"),
    ("OP02", "정상 전쟁", "https://tcgrepublic.com/category/subcategory_page_7712.html"),
    ("OP01", "로맨스 던", "https://tcgrepublic.com/category/subcategory_page_7322.html"),
]


def make_driver(headless: bool = True):
    opts = Options()
    if headless:
        opts.add_argument("--headless=new")
    opts.add_argument("--no-sandbox")
    opts.add_argument("--disable-dev-shm-usage")
    opts.add_argument("--window-size=1920,3000")
    opts.add_argument("--disable-blink-features=AutomationControlled")
    opts.add_argument(f"--user-agent={UA}")
    driver = webdriver.Chrome(options=opts)
    try:
        driver.execute_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
    except Exception:
        pass
    return driver


def scroll_to_bottom(driver, max_iter=20, sleep=1.0):
    """무한 스크롤 — 페이지 끝까지"""
    last_h = 0
    for _ in range(max_iter):
        driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
        time.sleep(sleep)
        h = driver.execute_script("return document.body.scrollHeight")
        if h == last_h:
            break
        last_h = h
    driver.execute_script("window.scrollTo(0, 0);")
    time.sleep(0.5)


def scrape_pokemon_set(driver, code: str, name: str, url: str) -> dict:
    """tcgcollector — .card-image-grid-item 직접 매칭 (SR/HR/SAR 까지 전부)"""
    # 옵션:
    #   displayAs=images — 카드 이미지 그리드
    #   pageSize=300 — 한 페이지에 300개까지 (default 30 → SR/HR 잘림)
    #   cardCardCountModeForCardSet 제거 (anyCardVariant 빼면서 부작용)
    sep = "&" if "?" in url else "?"
    full_url = f"{url}{sep}displayAs=images&pageSize=300"
    print(f"  fetching {full_url}")
    driver.get(full_url)

    # 첫 grid item 등장 대기 — 최대 30초
    for i in range(30):
        time.sleep(1)
        count = driver.execute_script("return document.querySelectorAll('.card-image-grid-item').length")
        if count > 0:
            print(f"    첫 그리드 {count}개 감지 ({i+1}초)")
            break
    else:
        title = driver.execute_script("return document.title")
        print(f"    ⚠ 그리드 못 찾음. title: {title}")
        return {"code": code, "name": name, "brand": "pokemon",
                "source": "tcgcollector.com", "fetchedAt": datetime.now(timezone.utc).isoformat(),
                "cardCount": 0, "cards": []}

    # 핵심 — grid count 안정화 감지 (scroll + lazy load 다 끝날 때까지)
    last_count = 0
    stable = 0
    max_loops = 180  # 최대 3분
    for i in range(max_loops):
        # 다양한 scroll 패턴
        driver.execute_script("window.scrollBy(0, 800);")
        time.sleep(0.6)
        # 끝까지 가면 다시 위→아래 반복 (lazy load 재트리거)
        if i % 20 == 19:
            driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
            time.sleep(1.2)
            driver.execute_script("window.scrollTo(0, 0);")
            time.sleep(0.8)
        count = driver.execute_script("return document.querySelectorAll('.card-image-grid-item').length")
        if count == last_count:
            stable += 1
            if stable >= 8:  # 8회 연속 변화 없으면 안정
                print(f"    → 안정 {count}장 (loop {i+1})")
                break
        else:
            stable = 0
            if count != last_count and i % 5 == 0:
                print(f"    loop {i+1}: {count}장 (변화 +{count - last_count})")
        last_count = count

    # "Load more" / "Show all" 버튼 있으면 클릭 (tcgcollector pagination)
    for btn_sel in ['button.load-more', 'button.show-all', '.pagination-next:not(.disabled) a',
                    'a[rel="next"]', 'button[class*="LoadMore"]']:
        try:
            btns = driver.execute_script(f"return document.querySelectorAll('{btn_sel}').length")
            if btns:
                for _ in range(20):  # 최대 20번 click
                    clicked = driver.execute_script(
                        f"const b=document.querySelector('{btn_sel}');"
                        f"if(b&&b.offsetParent!==null){{b.click();return true}}return false;")
                    if not clicked: break
                    time.sleep(1.5)
                print(f"    {btn_sel} 클릭 시도 완료")
        except Exception:
            pass

    # 마지막 한 번 더 끝까지 scroll
    driver.execute_script("window.scrollTo(0, document.body.scrollHeight);")
    time.sleep(2)
    final_count = driver.execute_script("return document.querySelectorAll('.card-image-grid-item').length")
    if final_count > last_count:
        print(f"    최종 안정화 후 {last_count} → {final_count}장")

    js = r"""
        const out = [];
        // tcgcollector 의 공식 카드 그리드 클래스 (검증됨)
        const items = document.querySelectorAll('.card-image-grid-item');
        for (const item of items) {
            // 카드 링크
            const a = item.querySelector('a[href*="/cards/"]');
            const href = a ? a.href : '';
            // 이미지
            const img = item.querySelector('img');
            if (!img) continue;
            const imgSrc = img.src || img.dataset.src || img.getAttribute('data-src') || '';
            if (!imgSrc) continue;
            // 카드 번호 (001/083 패턴)
            const text = (item.innerText || '').trim();
            const numMatch = text.match(/(\d{1,3}\/\d{1,3})/);
            const number = numMatch ? numMatch[1] : '';
            // 이름 (img alt 또는 카드 이름 영역)
            let cardName = (img.alt || '').trim();
            if (!cardName) {
                const nameEl = item.querySelector('.card-image-grid-item-name, .card-name');
                if (nameEl) cardName = (nameEl.innerText || '').trim();
            }
            // rarity (가능하면)
            const rarityEl = item.querySelector('.card-image-grid-item-rarity, [class*="rarity"]');
            const rarity = rarityEl ? (rarityEl.innerText || rarityEl.title || '').trim() : '';
            out.push({number, name: cardName, image: imgSrc, rarity, url: href});
        }
        return out;
    """
    cards = driver.execute_script(js) or []
    return {
        "code": code,
        "name": name,
        "brand": "pokemon",
        "source": "tcgcollector.com",
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "cardCount": len(cards),
        "cards": cards,
    }


def scrape_onepiece_page(driver, page_url: str) -> list:
    """tcgrepublic 한 페이지 카드 추출"""
    print(f"    page: {page_url}")
    driver.get(page_url)
    time.sleep(3)
    scroll_to_bottom(driver, max_iter=5)

    js = r"""
        const out = [];
        const seen = new Set();
        // tcgrepublic 다양한 패턴 시도
        const anchors = document.querySelectorAll('a[href*="goods_view"], a[href*="product_detail"], a[href*="/product/"]');
        for (const a of anchors) {
            const href = a.href;
            if (seen.has(href)) continue;
            const img = a.querySelector('img') || a.parentElement?.querySelector('img');
            if (!img) continue;
            const imgSrc = img.src || img.dataset.src || img.getAttribute('data-src') || '';
            if (!imgSrc) continue;
            const w = img.naturalWidth || img.width || 0;
            if (w > 0 && w < 80) continue;
            const alt = (img.alt || '').trim();
            const card = a.closest('li, article, .item, .product, .goods, div') || a;
            const cardText = (card.innerText || alt || '').trim();
            const numMatch = cardText.match(/(?:OP|EB|ST|STK|OPK|EB)\d*[-_\s]?\d{1,4}/i);
            const number = numMatch ? numMatch[0] : '';
            seen.add(href);
            out.push({
                number,
                name: alt || cardText.slice(0, 100).trim().split('\n')[0],
                image: imgSrc,
                rarity: '',
                url: href,
            });
        }
        return out;
    """
    return driver.execute_script(js) or []


def scrape_onepiece_set(driver, code: str, name: str, url: str) -> dict:
    """tcgrepublic — 페이지네이션 처리 (?p=1, ?p=2, ...)"""
    print(f"  scraping {code} from {url}")
    all_cards = []
    seen_urls = set()
    max_pages = 10  # 안전장치
    for page in range(1, max_pages + 1):
        page_url = url if page == 1 else (url + ("&" if "?" in url else "?") + f"p={page}")
        cards = scrape_onepiece_page(driver, page_url)
        if not cards:
            break
        # 중복 제거 (이전 페이지와 동일한 카드면 끝)
        new_cards = [c for c in cards if c["url"] not in seen_urls]
        if not new_cards:
            print(f"    페이지 {page}: 새 카드 없음 → 종료")
            break
        for c in new_cards:
            seen_urls.add(c["url"])
            all_cards.append(c)
        print(f"    페이지 {page}: +{len(new_cards)}건 (누적 {len(all_cards)})")
        time.sleep(0.5)

    return {
        "code": code,
        "name": name,
        "brand": "onepiece",
        "source": "tcgrepublic.com",
        "fetchedAt": datetime.now(timezone.utc).isoformat(),
        "cardCount": len(all_cards),
        "cards": all_cards,
    }


def main():
    args_no_flag = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    only_pokemon = "--pokemon" in sys.argv
    only_onepiece = "--onepiece" in sys.argv
    visible = "--visible" in sys.argv  # 브라우저 보이게 (디버깅)
    legacy_refetch = "--legacy-refetch" in sys.argv
    all_old = "--all-old-boxes" in sys.argv

    if all_old:
        boxes = json.loads((ROOT/"data"/"_pending-pokemon-boxes.json").read_text(encoding="utf-8"))["boxes"]
        args_no_flag = [b["code"] for b in boxes]
        force = True
        only_pokemon = True
        print(f"[--all-old-boxes] {len(boxes)} legacy boxes force-refetch")
    elif legacy_refetch:
        rf = ROOT/"data"/"_old-boxes-need-refetch.json"
        if not rf.exists():
            print(f"[ERROR] {rf} not found")
            return
        codes = json.loads(rf.read_text(encoding="utf-8"))
        args_no_flag = list(codes)
        force = True
        only_pokemon = True
        print(f"[--legacy-refetch] {len(codes)} boxes force-refetch")

    # case-insensitive 매칭 — POKEMON_SETS 의 코드 (SV3a, S8b 같은 mixed case) 와 비교 위해
    only_codes = set(a.upper() for a in args_no_flag) if args_no_flag else None

    print("=" * 60)
    print(f"세트별 풀 카드 데이터 수집 → {OUT_DIR.relative_to(ROOT)}/")
    if only_codes:
        print(f"필터: {only_codes}")
    print("=" * 60)

    driver = make_driver(headless=not visible)
    success, failed = 0, 0
    set_counter = 0
    try:
        if not only_onepiece:
            print("\n━━━ 포켓몬 (tcgcollector.com) ━━━")
            for code, name, url in POKEMON_SETS:
                if only_codes and code.upper() not in only_codes:
                    continue
                out_path = OUT_DIR / f"{code}.json"
                if out_path.exists() and not force:
                    try:
                        existing = json.loads(out_path.read_text("utf-8"))
                        if existing.get("cardCount", 0) > 0:
                            print(f"  {code:7s} skip (exists, {existing['cardCount']} 카드)")
                            continue
                        else:
                            print(f"  {code:7s} 0 카드 → 재시도")
                    except Exception:
                        pass

                # 매 세트마다 driver 재시작 (세션 누적 = 카드 0건 원인)
                if set_counter > 0:
                    driver.quit()
                    time.sleep(1)
                    driver = make_driver(headless=not visible)

                try:
                    data = scrape_pokemon_set(driver, code, name, url)
                    _atomic_save(out_path, json.dumps(data, ensure_ascii=False, indent=2))
                    print(f"  {code:7s} â {data['cardCount']} ì¹´ë")
                    success += 1
                except Exception as e:
                    print(f"  {code:7s} â {e}")
                    failed += 1
                set_counter += 1
                time.sleep(3)

        if not only_pokemon:
            print("\nâââ ìí¼ì¤ (tcgrepublic.com) âââ")
            for code, name, url in ONEPIECE_SETS:
                if only_codes and code.upper() not in only_codes:
                    continue
                out_path = OUT_DIR / f"{code}.json"
                if out_path.exists() and not force:
                    try:
                        existing = json.loads(out_path.read_text("utf-8"))
                        if existing.get("cardCount", 0) > 0:
                            print(f"  {code:7s} skip (exists, {existing['cardCount']} ì¹´ë)")
                            continue
                    except Exception:
                        pass
                if set_counter > 0:
                    driver.quit()
                    time.sleep(1)
                    driver = make_driver(headless=not visible)
                try:
                    data = scrape_onepiece_set(driver, code, name, url)
                    _atomic_save(out_path, json.dumps(data, ensure_ascii=False, indent=2))
                    print(f"  {code:7s} â {data['cardCount']} ì¹´ë")
                    success += 1
                except Exception as e:
                    print(f"  {code:7s} â {e}")
                    failed += 1
                set_counter += 1
                time.sleep(3)
    finally:
        driver.quit()

    print(f"\nìë£: ì±ê³µ {success} / ì¤í¨ {failed}")
    print(f"íì¼: {OUT_DIR.relative_to(ROOT)}/")


if __name__ == "__main__":
    main()
