"""Produce exact original-image pairs for explicit review; never auto-approve a listing."""
import hashlib,io,json,urllib.request,urllib.parse,urllib.error
from pathlib import Path
from PIL import Image,ImageOps,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[2]
def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def fetch(url,allowed):
 u=urllib.parse.urlparse(url)
 if u.scheme!='https'or u.hostname not in allowed:raise ValueError('Unexpected original image host')
 with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0'}),timeout=25)as r:
  if urllib.parse.urlparse(r.url).hostname!=u.hostname:raise ValueError('Unexpected image redirect')
  raw=r.read(4_000_001)
  if len(raw)>4_000_000:raise ValueError('Source image exceeds bounded limit')
 return raw
def run():
 manifest=read(ROOT/'data/onepiece-official-manifest.json');sources={}
 for s in manifest['sets']:
  if s['code']=='PROMO':
   for c in read(ROOT/'data/cards-by-set'/((s.get('fileCode')or s['code'])+'.json'))['cards']:sources[c['officialId']]=c
 refs={r['itemId']:r for r in read(ROOT/'data/mercari-references.json')['references']};seeds=read(ROOT/'data/onepiece-mercari-discovery-seeds.json')['items'];local=read(ROOT/'config/onepiece-local-artworks.json');rows=[]
 page=Image.new('RGB',(1100,900),'#ededed');draw=ImageDraw.Draw(page);font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',15)
 for i,seed in enumerate(seeds):
  c=sources[seed['printedNumber']];r=refs.get(seed['itemId'])
  if not r or r.get('fetchStatus')!='ok'or not r.get('imageUrl'):continue
  rec=local.get(c['officialId']);p=ROOT/rec['image'].lstrip('/')if rec else None
  raw=p.read_bytes()if p and p.exists()else fetch(c.get('officialImage')or c['image'],{'www.onepiece-cardgame.com'})
  if rec and p and p.exists()and hashlib.sha256(raw).hexdigest()!=rec['sha256']:raise ValueError('Official committed source hash mismatch')
  photo=fetch(r['imageUrl'],{'static.mercdn.net'});x=(i%2)*550;y=(i//2)*450
  draw.text((x+10,y+8),c['officialId']+' | '+r['itemId'],font=font,fill='black')
  for j,body in enumerate([raw,photo]):
   im=Image.open(io.BytesIO(body)).convert('RGB');im=ImageOps.contain(im,(255,380));page.paste(im,(x+10+j*270+(255-im.width)//2,y+40+(380-im.height)//2))
  rows.append({'officialId':c['officialId'],'itemId':r['itemId'],'marketName':r['title'],'marketImage':r['imageUrl'],'marketSHA256':hashlib.sha256(photo).hexdigest(),'sourceSHA256':hashlib.sha256(raw).hexdigest(),'officialImage':c['image'],'canonicalOfficialImage':c.get('officialImage')or c['image'],'sourceUrl':r['sourceUrl'],'sourceAsOf':r.get('observedAt'),'saleStatus':r.get('saleStatus'),'price':r.get('price'),'target':{**c,'game':'onepiece','brand':'onepiece','boxCode':'PROMO','fullNumber':c['officialId'].split('_')[0],'language':'ja','grade':'raw'},'reviewStatus':'pending-human-original-image-review'})
 out=ROOT/'docs/onepiece-market-links-20261101';out.mkdir(parents=True,exist_ok=True);page.save(out/'mercari-promo-review.jpg',quality=90)
 (ROOT/'data/onepiece-mercari-artwork-evidence.json').write_text(json.dumps({'schemaVersion':1,'reviews':rows},ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
 print(json.dumps({'reviewPairs':len(rows),'items':[{'id':r['itemId'],'officialId':r['officialId'],'status':r['saleStatus']}for r in rows]}))
if __name__=='__main__':run()
