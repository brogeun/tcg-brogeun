"""Read-only deployed official inventory gate, independent of registered market cards."""
import concurrent.futures, hashlib, json, os, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
ORIGIN=os.environ.get('PRICE_VERIFY_ORIGIN','https://tcghub.kr')
def get(path,as_json=True):
    req=urllib.request.Request(ORIGIN+'/'+path,headers={'User-Agent':'Mozilla/5.0 TCGHUB-InventoryAudit','Cache-Control':'no-cache'})
    with urllib.request.urlopen(req,timeout=30)as r:raw=r.read()
    return json.loads(raw)if as_json else raw
def main():
    expected=json.loads((ROOT/'data/onepiece-official-manifest.json').read_text(encoding='utf-8'))
    manifest=get('data/onepiece-official-manifest.json')
    assert manifest==expected,'Stale production official manifest'
    search=get('data/onepiece-official-search.json')
    assert len(search['cards'])==manifest['officialCards'] and len({c['officialId']for c in search['cards']})==manifest['officialCards']
    def check(s):
        d=get('data/cards-by-set/'+s.get('fileCode',s['code'])+'.json')
        official=[c for c in d['cards']if c.get('officialId')]
        assert len(official)==s['officialCardCount'],s['code']
        assert all(c.get('rarity')and c.get('printedNumber')and c.get('acquisition')for c in official),s['code']
        return len(official)
    with concurrent.futures.ThreadPoolExecutor(max_workers=4)as pool:total=sum(pool.map(check,manifest['sets']))
    assert total==manifest['officialCards']
    for file in ['assets/onepiece-official-catalog.js','assets/card-price-fallback.js','assets/contained-card-prices.js']:
        assert hashlib.sha256(get(file,False)).digest()==hashlib.sha256((ROOT/file).read_bytes()).digest(),file
    print(json.dumps({'origin':ORIGIN,'officialSets':len(manifest['sets']),'officialArtworks':total,'missingOfficialArtworks':0}))
if __name__=='__main__':main()
