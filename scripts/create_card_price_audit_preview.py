"""Side-by-side evidence for the five remaining OP16 artwork candidates."""
import io
import json
import urllib.request
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
ROOT=Path(__file__).resolve().parent.parent
def read(path): return json.loads(path.read_text(encoding='utf8'))
def picture(address):
    if address.startswith('/'): payload=(ROOT/address.lstrip('/')).read_bytes()
    else:
        with urllib.request.urlopen(urllib.request.Request(address,headers={'User-Agent':'Mozilla/5.0'}),timeout=15) as response: payload=response.read()
    image=Image.open(io.BytesIO(payload)).convert('RGBA')
    return image.crop(image.getchannel('A').getbbox())
rows=[r for r in read(ROOT/'audit/card-info-price/pending-artworks.json') if r['boxCode']=='OP16']
products={str(p['id']):p for p in read(ROOT/'data/all-cards.json')['details']}
hashes={}
cache=ROOT/'.cache/price-link-audit/image-hashes.jsonl'
if cache.exists():
    for line in cache.read_text(encoding='utf8').splitlines():
        r=json.loads(line);hashes[r.pop('image')]=r
records=[]
for start in range(0,len(rows),3):
    batch=rows[start:start+3];canvas=Image.new('RGB',(900,410*len(batch)),'#eeeeee');draw=ImageDraw.Draw(canvas)
    for y,row in enumerate(batch):
        images=[(row['fullId']+' source',picture(row['image']))]
        for score in row['scores'][:2]:
            p=products[score['id']];images.append((p['id']+' score '+str(score['distance']),picture(p.get('thumbnailUrl') or p.get('image'))))
        for x,(label,image) in enumerate(images):
            image=ImageOps.contain(image,(274,378));canvas.paste(image,(x*300+(300-image.width)//2,y*410+28),image);draw.text((x*300+8,y*410+7),label,fill='black')
        best=row['scores'][0];p=products[best['id']];market=p.get('thumbnailUrl') or p.get('image')
        if row['image'] in hashes and market in hashes:
            records.append({'brand':row['brand'],'boxCode':row['boxCode'],'setCode':row['setCode'],'number':row.get('number',''),'fullId':row.get('fullId',''),'image':row['image'],'id':p['id'],'marketName':p['name'],'marketProductNumber':p.get('productNumber',''),'marketImage':market,'sourceSHA256':hashes[row['image']]['sha256'],'marketSHA256':hashes[market]['sha256'],'method':'pending-visual-review','margin':row['margin'],**{k:v for k,v in best.items() if k!='id'}})
    canvas.save(ROOT/f'audit/card-info-price/review-op16-{start//3}.jpg',quality=90)
(ROOT/'audit/card-info-price/op16-manual-candidates.json').write_text(json.dumps(records,ensure_ascii=False,indent=2),encoding='utf8')
