"""Export exact comparison sheets for human review; preserve actual source-image hashes."""
import hashlib,io,json,random,time,urllib.parse,urllib.request
from pathlib import Path
from PIL import Image,ImageOps,ImageDraw,ImageFont
ROOT=Path(__file__).resolve().parents[2];CACHE=ROOT/'.cache/onepiece-audit'
def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def original(url):
 u=urllib.parse.urlparse(url);return urllib.parse.urlunparse(u._replace(query='',fragment=''))
def run():
 report=read(ROOT/'data/onepiece-market-link-audit-20261101.json');proofs=[p for p in read(ROOT/'data/onepiece-reviewed-promo-links.json')['links']if p.get('auditRun')=='20261101-recovery'];byid={r['officialId']:r for r in report['cards']};sources={s['officialId']:s for s in read(CACHE/'input.json')['sources']};local=read(ROOT/'config/onepiece-local-artworks.json');out=ROOT/'docs/onepiece-market-links-20261101';out.mkdir(parents=True,exist_ok=True)
 def body(url):
  path=CACHE/'images'/(hashlib.sha256(url.encode()).hexdigest()+'.bin')
  if not path.exists():
   u=urllib.parse.urlparse(url)
   if u.scheme!='https'or u.hostname not in {'www.onepiece-cardgame.com','cdn.snkrdunk.com','card.yuyu-tei.jp'}:raise ValueError('Unexpected original image host')
   time.sleep(.3)
   req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Referer':'https://yuyu-tei.jp/'if u.hostname=='card.yuyu-tei.jp'else'https://snkrdunk.com/'})
   with urllib.request.urlopen(req,timeout=25)as response:
    if urllib.parse.urlparse(response.url).hostname!=u.hostname:raise ValueError('Unexpected redirect')
    raw=response.read(4_000_001)
    if len(raw)>4_000_000:raise ValueError('Oversized original')
   path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
  return path.read_bytes()
 def source(oid):
  c=sources[oid]['card'];p=ROOT/local[oid]['image'].lstrip('/')if oid in local else None
  return p.read_bytes()if p and p.exists()else body(c.get('officialImage')or c['image'])
 def market(p):return body(original(p['marketImage']))
 magazines=[p for p in proofs if byid.get(p['officialId'],{}).get('acquisitionEvidence',{}).get('kind')in{'previously-image-reviewed-giga-girls-acquisition','explicit-magazine-issue-month-and-year','explicit-weekly-jump-issue-and-year'}]
 weakest=sorted([p for p in proofs if p not in magazines],key=lambda p:byid.get(p['officialId'],{}).get('evidence',{}).get('quality',0))[:16]
 remaining=[p for p in proofs if p not in magazines and p not in weakest];sample=magazines+weakest+random.Random(20261101).sample(remaining,min(16,len(remaining)))
 font=ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',13)
 def sheets(rows,prefix,triplet=False):
  per=6;paths=[]
  for start in range(0,len(rows),per):
   width=1440 if triplet else 1000;page=Image.new('RGB',(width,1128),'#eee');draw=ImageDraw.Draw(page)
   for j,(label,pics)in enumerate(rows[start:start+per]):
    x=(j%2)*(width//2);y=(j//2)*376;draw.text((x+6,y+6),label,font=font,fill='black')
    for k,pic in enumerate(pics):
     im=Image.open(io.BytesIO(pic)).convert('RGB');im=ImageOps.contain(im,(230,330));page.paste(im,(x+6+k*240+(230-im.width)//2,y+32+(330-im.height)//2))
   path=out/(prefix+'-%02d.jpg'%(start//per+1));page.save(path,quality=88);paths.append(str(path.relative_to(ROOT)))
  return paths
 rows=[]
 for p in sample:
  raw=source(p['officialId']);photo=market(p)
  if hashlib.sha256(raw).hexdigest()!=p.get('comparedSourceSHA256',p['sourceSHA256'])or hashlib.sha256(photo).hexdigest()!=p['marketSHA256']:raise ValueError('Image evidence changed')
  rows.append((p['officialId']+' | '+p['id'],[raw,photo]))
 snkrpages=sheets(rows,'snkr-review')
 proposals=read(ROOT/'data/onepiece-artwork-review-candidates-20261101.json')['proposals'];manualrows=[]
 for p in proposals:
  raw=source(p['officialId']);photo=market(p)
  if hashlib.sha256(raw).hexdigest()!=p['comparedSourceSHA256']or hashlib.sha256(photo).hexdigest()!=p['marketSHA256']:raise ValueError('Proposed original image changed')
  manualrows.append((p['officialId']+' | '+p['id'],[raw,photo]))
 manualpages=sheets(manualrows,'manual-candidate-review')
 bindings=read(ROOT/'data/onepiece-reviewed-fallback-links.json')['bindings'];shop=[b for b in bindings.values()if b.get('yuyuteiId')];shop=sorted(shop,key=lambda b:b['evidence']['quality'])[:16]
 shoppages=sheets([(b['officialId']+' | '+b['yuyuteiId'],[source(b['officialId']),body(b['marketImage'])])for b in shop],'shop-review')
 lookup={p['officialId']:p for p in proofs};collision=[]
 for b in report['blockedPreviousLinks']:
  p=lookup.get(b['correctOfficialId']);correct=b['correctOfficialId'];pid=b['blockedProductId']
  product=next(p for p in sources[correct]['candidates']if p['id']==pid);photo=body(original(product['thumbnailUrl']))
  collision.append((b['officialId']+' | '+correct+' | '+pid,[source(b['officialId']),source(correct),photo]))
 collisionpages=sheets(collision,'collision-review',True)
 report['humanReviewSheets']={'snkrArtworks':len(sample),'shopArtworks':len(shop),'blockedOldArtworks':len(collision),'manualCandidateArtworks':len(proposals),'paths':snkrpages+shoppages+collisionpages+manualpages,'status':'awaiting-explicit-visual-review'};(ROOT/'data/onepiece-market-link-audit-20261101.json').write_text(json.dumps(report,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
 print(json.dumps(report['humanReviewSheets']))
if __name__=='__main__':run()
