"""
link_box_snkrdunk_ids.py — 121 옛 박스에 SNKRDUNK ID 매핑

사용자가 직접 SNKRDUNK 에서 따온 121개 ID 를 manual-boxes-pokemon.json
의 각 박스 product 에 id + url 필드로 채워넣음.

규칙:
1. 기존 34개 박스 (S6a 이후) 절대 안 건드림
2. 121 옛 박스의 product.id = SNKRDUNK ID
3. product.url = https://snkrdunk.com/en/trading-cards/{id}?slide=right
4. lastPrice 는 null 유지 (cron 이 자동 갱신)
5. atomic write
"""
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANUAL = ROOT / "data" / "manual-boxes-pokemon.json"

# 사용자 제공 SNKRDUNK ID 매핑 (DP1 누락)
SNKRDUNK_IDS = {
    "S6H": "12880", "S6K": "12881", "S5a": "12878", "S5R": "12876", "S5I": "12877",
    "S4a": "12875", "S4": "12879", "S3a": "14668", "S3": "14669", "S2a": "14670",
    "S2": "12890", "S1a": "14671", "S1H": "14673", "S1W": "14672",
    "SM12a": "12894", "SM12": "12900", "SM11b": "12898", "SM11a": "15570", "SM11": "15568",
    "SM10b": "12895", "SM10a": "12896", "SM10": "15549", "SM9b": "12899", "SM9a": "15544",
    "SM9": "20487", "SM8b": "12893", "SM8a": "15540", "SM8": "15535", "SM7b": "12897",
    "SM7a": "15532", "SM7": "15530", "SM6b": "15526", "SM6a": "15440", "SM6": "15439",
    "SM5+": "15438", "SM5M": "15436", "SM5S": "15437", "SM4+": "13961", "SM4S": "15237",
    "SM4A": "15239", "SM3+": "13962", "SM3H": "13963", "SM3N": "15236", "SM2+": "14124",
    "SM2L": "15224", "SM2K": "15235", "SM1+": "15223",
    "XY11-Br": "15242", "XY11-Bb": "15243", "XY10": "14475", "XY9": "14646",
    "XY8-Br": "14645", "XY8-Bb": "14640", "XY7": "480208", "XY6": "14639",
    "XY5-Bt": "14469", "XY5-Bg": "14466", "XY4": "14239", "XY3": "14237",
    "XY2": "14122", "XY1-By": "15221", "XY1-Bx": "15222",
    "BW9": "86177", "BW8-Brn": "86174", "BW8-Brf": "86175", "BW7": "86173",
    "BW6-Bf": "86172", "BW6-Bc": "86171", "BW5-Brz": "86009", "BW5-Brn": "86008",
    "BW4": "86006", "BW3-Bh": "86004", "BW3-Bp": "86005", "BW2": "86003",
    "BW1-Bw": "86001", "BW1-Bb": "86002",
    "L3": "85952", "L2": "85950", "L1-Bss": "85948", "L1-Bhg": "85949",
    "Pt4": "14215", "Pt3": "85947", "Pt2": "85946", "Pt1": "85944",
    "DP6": "85942", "DP5": "85940", "DP4-Bd": "14228", "DP4-Bm": "14459",
    "DP3": "85938", "DP2": "85937", "DP1": "85935",
    "PCG9": "85823", "PCG8": "85822", "PCG7": "91753", "PCG6": "85820",
    "PCG5": "85819", "PCG4": "85818", "PCG3": "491691", "PCG2": "85816", "PCG1": "491694",
    "ADV4": "85813", "ADV3": "85812", "ADV2": "85811", "ADV1": "85810",
    "e5": "85447", "e4": "85446", "e3": "85445", "e2": "85444", "e1": "85443",
    "Neo4": "85442", "Neo3": "85441", "Neo2": "85440", "Neo1": "85439",
    "Gym2": "85438", "Gym1": "85437",
    "CL4": "85436", "CL3": "85435", "CL2": "16219", "CL1": "85434",
}


def atomic_write(path: Path, content: str):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(content, encoding="utf-8")
    json.loads(tmp.read_text(encoding="utf-8"))
    os.replace(tmp, path)


def main():
    print("=" * 70)
    print(f"  121 옛 박스 SNKRDUNK ID 매핑")
    print("=" * 70)
    print(f"\n  매핑 데이터: {len(SNKRDUNK_IDS)}개")

    manual = json.loads(MANUAL.read_text(encoding="utf-8"))
    updated = 0
    skipped_no_id = []
    skipped_not_legacy = 0
    for prod in manual["products"]:
        code = prod.get("code")
        if code not in SNKRDUNK_IDS:
            # 매핑 없는 박스 (기존 34개 + DP1)
            if not prod.get("legacy"):
                skipped_not_legacy += 1  # 기존 박스 — 안 건드림
            else:
                skipped_no_id.append(code)  # 121 중 매핑 없는 박스 (DP1)
            continue
        new_id = SNKRDUNK_IDS[code]
        new_url = f"https://snkrdunk.com/en/trading-cards/{new_id}?slide=right"
        if prod.get("id") != new_id or prod.get("url") != new_url:
            prod["id"] = new_id
            prod["url"] = new_url
            updated += 1
            print(f"  ✓ {code:10s} id={new_id}")

    atomic_write(MANUAL, json.dumps(manual, ensure_ascii=False, indent=2))

    print(f"\n{'='*70}")
    print(f"  ✓ id 매핑: {updated}개")
    print(f"  ⊘ 기존 박스 (변경 안 함): {skipped_not_legacy}개")
    if skipped_no_id:
        print(f"  ⚠ 매핑 없는 옛 박스: {skipped_no_id}")
    print(f"{'='*70}")


if __name__ == "__main__":
    main()
