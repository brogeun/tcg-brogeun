"""
fetch_pokemon_names.py — PokéAPI 에서 1,025마리 한/영/일 이름 수집

출력: data/pokemon-names-pokeapi.json
포맷: [{ "id": 1, "en": "Bulbasaur", "ko": "이상해씨", "ja": "フシギダネ" }, ...]

소요 시간: 약 3~5분 (PokéAPI rate limit 여유)
"""
import json
import time
import urllib.request
import urllib.error
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
OUT_FILE = DATA_DIR / "pokemon-names-pokeapi.json"

API = "https://pokeapi.co/api/v2/pokemon-species/{id}"
TOTAL = 1025  # Gen 1-9 (Pecharunt 까지)

UA = "Mozilla/5.0 TCG-Hub Pokemon Name Fetcher"


def fetch_one(pid):
    url = API.format(id=pid)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read().decode("utf-8"))


def extract_names(species_data):
    out = {"en": None, "ko": None, "ja": None}
    for n in species_data.get("names", []):
        lang = (n.get("language") or {}).get("name", "")
        name = n.get("name") or ""
        if lang == "en":
            out["en"] = name
        elif lang == "ko":
            out["ko"] = name
        elif lang in ("ja", "ja-Hrkt"):
            # ja-Hrkt 가 일본 발음 (가타카나/히라가나) — SNKRDUNK 에서 쓰는 형태
            if not out["ja"] or lang == "ja-Hrkt":
                out["ja"] = name
    return out


def main():
    DATA_DIR.mkdir(exist_ok=True)
    results = []
    failed = []

    print(f"================================================")
    print(f"PokéAPI 포켓몬 이름 수집 시작 — 1~{TOTAL}")
    print(f"================================================\n")

    t0 = time.time()
    for pid in range(1, TOTAL + 1):
        try:
            data = fetch_one(pid)
            names = extract_names(data)
            results.append({"id": pid, **names})

            if pid % 50 == 0:
                elapsed = time.time() - t0
                eta = elapsed / pid * (TOTAL - pid)
                print(f"  [{pid}/{TOTAL}] {names['en']} / {names['ko']} / {names['ja']} (ETA {int(eta)}s)")
            time.sleep(0.05)  # 부드럽게
        except urllib.error.HTTPError as e:
            print(f"  [{pid}] HTTP {e.code}: skip")
            failed.append(pid)
        except Exception as e:
            print(f"  [{pid}] 에러: {e}")
            failed.append(pid)

    OUT_FILE.write_text(
        json.dumps(results, ensure_ascii=False, indent=2),
        encoding="utf-8"
    )

    elapsed = int(time.time() - t0)
    print(f"\n================================================")
    print(f"완료: {len(results)} / {TOTAL} (실패 {len(failed)})")
    print(f"소요 시간: {elapsed//60}분 {elapsed%60}초")
    print(f"저장: {OUT_FILE}")
    if failed:
        print(f"실패한 ID: {failed[:20]}{'...' if len(failed) > 20 else ''}")
    print(f"================================================")


if __name__ == "__main__":
    main()
