"""Calibrate bounded image matching against 158 independently reviewed OP17 artworks."""
import base64
import json
import re
from pathlib import Path
from build_contained_card_artwork_links import ROOT, WORK, CACHE, read, fill, distance
cache={}
for line in CACHE.read_text(encoding='utf8').splitlines():
    value=json.loads(line);cache[value.pop('image')]=value
products={str(p['id']):p for p in read(ROOT/'data/all-cards.json')['details']}
calibration=read(WORK/'calibration.json')
fill([r['image'] for r in calibration],cache,'calibration-source')
fill([products[id].get('thumbnailUrl') or products[id].get('image') for r in calibration for id in r['candidateIds']],cache,'calibration-market')
def scores(row):
    own=cache.get(row['image'],{})
    if 'phash' not in own:return [],0
    result=[]
    for id in row['candidateIds']:
        p=products[id];proof=cache.get(p.get('thumbnailUrl') or p.get('image'),{})
        if 'phash' not in proof:continue
        result.append({'id':id,'distance':distance(own,proof,'phash'),'detailDistance':distance(own,proof,'dhash'),'artDistance':distance(own,proof,'art')})
    result.sort(key=lambda x:(x['distance'],x['detailDistance']))
    return result,(result[1]['distance']-result[0]['distance'] if len(result)>1 else 64)
def acceptable(best,margin):
    return best['distance']<=14 and best['detailDistance']<=18 and best['artDistance']<=18 and margin>=10
checks=[]
for row in calibration:
    candidates,margin=scores(row)
    if not candidates:continue
    best=candidates[0]
    checks.append({'fullId':row['fullId'],'expectedId':row['expectedId'],**best,'margin':margin,'accepted':acceptable(best,margin)})
wrong=[r for r in checks if r['accepted'] and r['id']!=r['expectedId']]
accepted=[r for r in checks if r['accepted']]
assert len(checks)==158,('Missing calibration images',len(checks))
assert len(accepted)>=100,('Insufficient reviewed control coverage',len(accepted))
assert not wrong,('Incorrect accepted control artwork',wrong)
document=read(ROOT/'data/contained-card-market-links.json')
keys={(r['brand'],r['boxCode'],r['fullId'],r['image']) for r in document['links']}
new=[]
for row in read(ROOT/'audit/card-info-price/pending-artworks.json'):
    if row['brand']!='onepiece' or not re.fullmatch(r'(?:OP|EB|PRB)\d+-\d+(?:_p\d+)?',row.get('fullId','')):continue
    if row['boxCode']=='EB05':continue
    key=(row['brand'],row['boxCode'],row['fullId'],row['image'])
    if key in keys:continue
    candidates,margin=scores(row)
    if not candidates or not acceptable(candidates[0],margin):continue
    best=candidates[0];p=products[best['id']];market=p.get('thumbnailUrl') or p.get('image')
    if re.search(r'1ED|1ST|FIRST EDITION|NO RARITY|UNLIMITED|SERIAL|SIGNED|ANNIVERSARY|WINNER|FLAGSHIP|CHAMPION|STAMP|PREMIUM CARD',p['name'],re.I):continue
    record={k:row.get(k,'') for k in ['brand','boxCode','setCode','number','fullId','image']}
    record.update(id=best['id'],marketName=p['name'],marketProductNumber=p.get('productNumber',''),marketImage=market,sourceSHA256=cache[row['image']]['sha256'],marketSHA256=cache[market]['sha256'],method='op17-calibrated-artwork-comparison',margin=margin,**{k:v for k,v in best.items() if k!='id'})
    new.append(record);keys.add(key)
document['links']+=new
report={'controlArtworks':len(checks),'acceptedControls':len(accepted),'falseAcceptedControls':len(wrong),'newLinks':len(new),'checks':checks}
(ROOT/'audit/card-info-price/artwork-calibration.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
(ROOT/'audit/card-info-price/calibrated-links.json').write_text(json.dumps(new,ensure_ascii=False,indent=2),encoding='utf8')
(ROOT/'data/contained-card-market-links.json').write_text(json.dumps(document,ensure_ascii=False,separators=(',',':')),encoding='utf8')
for file in (ROOT/'audit/card-info-price').glob('review-op16-*.jpg'):
    file.with_suffix('.b64.txt').write_text(base64.b64encode(file.read_bytes()).decode(),encoding='ascii')
print(json.dumps({k:v for k,v in report.items() if k!='checks'}),flush=True)
