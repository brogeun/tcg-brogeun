"""
discover_tcgdex_sets.py — TCGdex API 의 일본어 세트 목록 받기

목적: 우리 코드 (M4, SV9 등) 와 TCGdex 의 set ID 를 매핑하기 위함.
한 번 실행 → 세트 목록 확인 → 매핑 테이블 작성.

API 문서: https://tcgdex.dev/rest/sets

사용:
  python scripts/discover_tcgdex_sets.py
"""
import json
import urllib.request


def try_fetch(url):
    """URL fetch 시도"""
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


def main():
    print("━━━ TCGdex 세트 목록 디스커버리 ━━━")

    # 여러 가능한 URL 시도 (TCGdex 가 v1/v2 + jp/ja/en 다양함)
    candidates = [
        ("일본어 ja", "https://api.tcgdex.net/v2/ja/sets"),
        ("일본어 jp", "https://api.tcgdex.net/v2/jp/sets"),
        ("영어 en", "https://api.tcgdex.net/v2/en/sets"),
        ("v1 ja", "https://api.tcgdex.net/v1/ja/sets"),
    ]

    data = None
    used_url = None
    for label, url in candidates:
        print(f"  시도: {url}")
        try:
            d = try_fetch(url)
            if isinstance(d, list) and len(d) > 0:
                data = d
                used_url = url
                print(f"  ✓ {label} 성공! ({len(d)}개 세트)\n")
                break
            else:
                print(f"  → 응답 비어있음 (skip)")
        except Exception as e:
            print(f"  → 실패: {e}")

    if not data:
        print("\n❌ 모든 URL 실패. tcgdex.dev 문서 확인 필요.")
        return

    print(f"━━━ {used_url} 결과 ━━━")

    # 우리 코드 → TCGdex ID 자동 매칭 시도
    print(f"\n총 {len(data)}개 세트 발견\n")

    OUR_SETS = {
        "M5": ["abyss eye", "アビスアイ"],
        "M4": ["ninja spinner", "ニンジャスピナー", "ニンジャスピン"],
        "M3": ["nullifying zero", "ヌリゼロ", "ヌルキスゼロ"],
        "M2a": ["mega dream", "メガドリーム"],
        "M2": ["inferno x", "インフェルノ"],
        "M1L": ["mega brave", "メガブレイブ"],
        "M1S": ["mega symphonia", "メガシンフォニア"],
        "SV11B": ["black bolt", "ブラックボルト"],
        "SV11W": ["white flare", "ホワイトフレア"],
        "SV10": ["team rocket", "ロケット団"],
        "SV9a": ["hot air arena", "熱風", "アレナ"],
        "SV9": ["battle partners", "バトルパートナーズ"],
        "SV8a": ["terastal festival", "テラスタル"],
        "SV8": ["super electric breaker", "超電ブレイカー"],
        "SV7a": ["paradise dragona", "パラダイスドラゴナ"],
        "SV7": ["stellar miracle", "ステラミラクル"],
        "SV6a": ["night wanderer", "ナイトワンダラー"],
        "SV6": ["mask of change", "変幻の仮面"],
        "SV5a": ["crimson haze", "クリムゾンヘイズ"],
        "SV5M": ["cyber judge", "サイバージャッジ"],
    }

    print("━━━ 우리 코드 ↔ TCGdex ID 자동 매칭 ━━━")
    print(f"{'우리 코드':<8} {'TCGdex ID':<14} {'카드 수':>6}  TCGdex 이름")
    print("─" * 80)
    for our_code, keywords in OUR_SETS.items():
        match = None
        for s in data:
            name = (s.get("name") or "").lower()
            if any(kw.lower() in name for kw in keywords):
                match = s
                break
        if match:
            sid = match.get("id", "?")
            count = match.get("cardCount", {}).get("total", "?") if isinstance(match.get("cardCount"), dict) else "?"
            print(f"  {our_code:<6} {sid:<14} {count:>6}  {match.get('name', '?')}")
        else:
            print(f"  {our_code:<6} ❌ 매칭 안 됨")

    print(f"\n━━━ 최근 30개 세트 (참고) ━━━")
    for s in data[-30:]:
        sid = s.get("id", "?")
        name = s.get("name", "?")
        count = s.get("cardCount", {}).get("total", "?") if isinstance(s.get("cardCount"), dict) else "?"
        print(f"  {sid:<14} {count:>6}  {name}")

    print("\n💡 매칭 안 된 코드들 — 위 30개 세트 중 이름 보고 수동 매핑하면 됨")


if __name__ == "__main__":
    main()
