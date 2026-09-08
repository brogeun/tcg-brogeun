"""Publish audited staged cards as static JSON and local contact sheets (20 cards/file)."""
import argparse
import hashlib
import json
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent.parent
STAGE = ROOT/'.cache/english-import'
W, H, COLS, ROWS = 320, 448, 5, 4

def build(entry, output):
    data = json.loads((STAGE/'data/cards-by-set'/f"{entry['code']}.json").read_text(encoding='utf-8'))
    cards = data['cards']
    # Rebuilding images must not revert a newer price import to the card-only stage.
    existing = output/'data/english-sets'/f"{entry['code']}.json"
    if existing.exists():
        prior = json.loads(existing.read_text(encoding='utf-8'))
        prices = {c['sourceId']: c.get('psa10') for c in prior['cards']}
        for card in cards:
            p = prices.get(card['sourceId'])
            old = card.get('psa10')
            if p and (not old or datetime.fromisoformat(p['fetchedAt'].replace('Z','+00:00')) >= datetime.fromisoformat(old['fetchedAt'].replace('Z','+00:00'))):
                card['psa10'] = p
        for key in ('priceStatus', 'priceCoverage', 'priceFetchedAt'):
            if key in prior: data[key] = prior[key]
    for start in range(0, len(cards), COLS*ROWS):
        batch = cards[start:start+COLS*ROWS]
        digest = hashlib.sha256(('sheet-v1:'+':'.join(c['image'] for c in batch)).encode()).hexdigest()[:14]
        relative = f"images/pokemon-en-sheets/{entry['code']}-{start//20:03d}-{digest}.webp"
        path = output/relative
        if not path.exists():
            sheet = Image.new('RGB',(W*COLS,H*ROWS),'white')
            for i, card in enumerate(batch):
                with Image.open(STAGE/card['image']) as image:
                    image = ImageOps.contain(image.convert('RGB'),(W,H),Image.Resampling.LANCZOS)
                    sheet.paste(image,((i%COLS)*W+(W-image.width)//2,(i//COLS)*H+(H-image.height)//2))
            path.parent.mkdir(parents=True,exist_ok=True)
            sheet.save(path,'WEBP',quality=85,method=3)
        for i, card in enumerate(batch):
            card['image'] = relative
            card['sprite'] = dict(col=i%COLS,row=i//COLS,cols=COLS,rows=ROWS,width=W,height=H)
    path = output/'data/english-sets'/f"{entry['code']}.json"
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(data,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    return {**entry,'cardCount':len(cards)}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=ROOT);args=parser.parse_args()
    audit=json.loads((STAGE/'audit.json').read_text(encoding='utf-8'))
    if not audit.get('ok'):raise SystemExit('Run audit_english_import.py successfully first')
    catalog=json.loads((STAGE/'catalog-ready.json').read_text(encoding='utf-8'))
    with ThreadPoolExecutor(max_workers=8) as pool:
        result=[]
        for i, entry in enumerate(pool.map(lambda e:build(e,args.output),catalog),1):
            result.append(entry)
            if i%25==0:print(f'Built {i}/{len(catalog)} sets',flush=True)
    manifest=dict(schemaVersion=1,sets=result,cardCount=sum(x['cardCount'] for x in result))
    (args.output/'data/english-catalog.json').write_text(json.dumps(manifest,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    from build_english_korean_names import build as build_names
    build_names(args.output, args.output)
    print(f"Ready: {len(result)} sets / {manifest['cardCount']} cards",flush=True)

if __name__=='__main__':main()
