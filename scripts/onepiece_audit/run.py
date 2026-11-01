"""Rebuild One Piece image evidence on an isolated branch, retaining all original quotes."""
from __future__ import annotations
import concurrent.futures,collections,hashlib,json,os,re,threading,time,unicodedata,urllib.request,urllib.parse,urllib.error
from pathlib import Path
from geometry import normalize,features,compare,passes
ROOT=Path(__file__).resolve().parents[2];CACHE=ROOT/'.cache/onepiece-audit';OUT=ROOT/'data/onepiece-market-link-audit-20261101.json'
def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def write(p,d):
 p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(d,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
def norm(t):return re.sub('[^a-z0-9]','',unicodedata.normalize('NFKC',t).lower()).replace('promotional','promotion')
def codes(t):return [a+b.zfill(2)for a,b in re.findall(r'(PRB|OP|EB|ST)[-－ー\s]?(\d{1,3})',t)]
def tail(t):return t.split(']')[-1].strip()
def ct(t):
 t=norm(t)
 for prefix in ['promotioncard','specialgoodsset']:
  if t.startswith(prefix):t=t[len(prefix):]
 return t
BLOCKED={
'PRB02-006_p2':('656335','PRB02-006_p1'),'OP01-120_p2':('328422','OP01-120_p5'),
'OP05-074_p3':('332164','OP05-074_r2'),'OP10-030_p2':('428667','OP10-030_p1'),
'OP09-118_p2':('349471','OP09-118_p1'),'OP07-015_p2':('204966','OP07-015_p1'),
'OP05-002_p2':('135403','OP05-002_p1'),'OP05-119_p2':('135438','OP05-119_p1'),
'OP02-099_p2':('102422','OP02-099'),'OP01-073_p2':('142651','OP01-073'),
'OP09-051_p3':('599907','OP09-051_r1'),'ST02-007_p3':('119386','ST02-007'),
'OP01-021':('110721','OP01-021_p1'),'OP01-013_p2':('94917','OP01-013_p1'),
'OP01-016_p2':('94918','OP01-016_p1'),'OP02-013_p2':('300060','OP02-013_p5'),
'OP02-120_p2':('140966','OP02-120_p3'),'OP05-093_p2':('435346','OP05-093_p3'),
'OP07-051_p2':('562155','OP07-051_p5'),'OP09-119_p2':('744321','OP09-119_p4')}
HELD={'OP13-080_p1','OP05-098','OP10-084_r1','P-084_r1','OP03-112_r1','P-030_r1'}
class Images:
 def __init__(self):
  self.data={};self.errors={};self.lock=threading.Lock();self.next={};self.blocked=set();self.requests=collections.Counter();self.folder=CACHE/'images';self.folder.mkdir(parents=True,exist_ok=True)
 def load(self,item):
  key,url,local=item
  try:
   u=urllib.parse.urlparse(url)
   if u.scheme!='https'or u.hostname not in {'www.onepiece-cardgame.com','cdn.snkrdunk.com','card.yuyu-tei.jp'}or u.username or u.password:raise ValueError('Untrusted original image URL')
   path=ROOT/local.lstrip('/')if local and local.startswith('/')and not local.startswith('/api/')else self.folder/(hashlib.sha256(url.encode()).hexdigest()+'.bin')
   if path.is_file():raw=path.read_bytes()
   else:
    with self.lock:
     if u.hostname in self.blocked:raise RuntimeError('Source circuit open')
     now=time.monotonic();at=max(now,self.next.get(u.hostname,0));self.next[u.hostname]=at+{'www.onepiece-cardgame.com':.4,'cdn.snkrdunk.com':.2,'card.yuyu-tei.jp':.4}[u.hostname]
    time.sleep(max(0,at-time.monotonic()))
    with self.lock:
     if u.hostname in self.blocked:raise RuntimeError('Source circuit open')
     self.requests[u.hostname]+=1
    req=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Referer':'https://www.onepiece-cardgame.com/'if u.hostname=='www.onepiece-cardgame.com'else'https://snkrdunk.com/'if u.hostname=='cdn.snkrdunk.com'else'https://yuyu-tei.jp/'})
    try:
     with urllib.request.urlopen(req,timeout=25)as response:
      if urllib.parse.urlparse(response.url).hostname!=u.hostname:raise ValueError('Unexpected source redirect')
      raw=response.read(4_000_001)
      if len(raw)>4_000_000:raise ValueError('Image exceeds size limit')
    except urllib.error.HTTPError as e:
     if e.code in (403,429):
      with self.lock:self.blocked.add(u.hostname)
     raise
    path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(raw)
   im=normalize(raw);self.data[key]={'sha256':hashlib.sha256(raw).hexdigest(),'url':url,'localPath':str(path.relative_to(ROOT)),'image':im,'features':features(im)}
  except Exception as e:
   with self.lock:self.errors[key]=str(e)[:200]
 def collect(self,items):
  unique=list({i[0]:i for i in items if i[0]not in self.data and i[0]not in self.errors}.values())
  with concurrent.futures.ThreadPoolExecutor(max_workers=12)as pool:
   for i,_ in enumerate(pool.map(self.load,unique),1):
    if i%300==0:print(json.dumps({'imageStage':i,'required':len(unique),'usable':len(self.data),'errors':len(self.errors),'blocked':sorted(self.blocked)}),flush=True)
 def evidence(self,a,b):
  if a not in self.data or b not in self.data:return {'registered':False,'quality':0.0,'imageUnavailable':True}
  x,y=self.data[a],self.data[b];return compare(x['image'],y['image'],x['features'],y['features'])
def learn_contexts(data):
 products={p['id']:p for s in data['sources']for p in s['candidates']};count=collections.defaultdict(collections.Counter)
 for c in data['catalogue']['cards']:
  p=products.get(str(c.get('productId')));cs=codes(c.get('acquisition',''))
  if not p or '_'in c['officialId']or len(cs)!=1 or not c['officialId'].startswith(cs[0]+'-'):continue
  code=cs[0];t=ct(tail(p['name']));genre=next(k for k in ['PRB','OP','EB','ST']if code.startswith(k))
  if t.startswith({'OP':('boosterpack',),'EB':('extrabooster',),'PRB':('premiumbooster',),'ST':('startdeck','starterdeck','ultimatedeck')}[genre]):count[code][t]+=1
 return {k:{t:n for t,n in v.items()if n>=max(1 if k.startswith('ST')else 2,max(v.values())*.2)}for k,v in count.items()}
def acquisition(source,p,known,shop=False):
 s=source['card']['acquisition'];title=p.get('name','');t=ct(tail(title));cs=codes(s)
 if shop:
  sc=str(p['sourceSetCode']).upper().replace('-','')
  if len(cs)==1 and sc==cs[0]:return {'kind':'exact-source-series','code':sc}
  # Different numbered reprints and separate promotional volumes must retain their own source set.
  sn=p.get('sourceSetName','');a=re.sub(r'[^\w]','',unicodedata.normalize('NFKC',s));b=re.sub(r'[^\w]','',unicodedata.normalize('NFKC',sn))
  if len(a)>=8 and(a in b or b in a)and len(b)>=8:return {'kind':'exact-official-acquisition-label'}
  return None
 if len(cs)==1:
  code=cs[0]
  if t in known.get(code,{}):return {'kind':'base-card-acquisition-context','code':code,'referenceCount':known[code][t]}
  if code in {'PRB01','PRB02'}and'premiumbooster'in norm(title)and'onepiececardthebest'in norm(title)and(('vol2'in norm(title))==(code=='PRB02')):return {'kind':'explicit-premium-booster-volume','code':code}
  return None
 if 'ファミリーデッキセット'in s and'familydeckset'in t:return {'kind':'family-deck'}
 for jp,en in [('プロモーションパックEX','promotionpackex'),('プロモーションパック','promotionpack'),('スタンダードバトルパック','standardbattlepack')]:
  if jp in s:
   vol=re.search(r'vol\.?\s*(\d+)',s,re.I)
   return {'kind':'promotion-pack-volume','volume':vol[1]}if vol and en+'vol'+vol[1]in t else None
 if 'フラッグシップ'in s and'flagship'in norm(title):
  if '優勝'in s and re.search(r'victory|winner|first place',title,re.I)and not re.search(r'top\s*8',title,re.I):return {'kind':'flagship-winner'}
  if re.search('ベスト8|ベスト８',s)and re.search(r'top\s*8',title,re.I)and not re.search(r'victory|winner',title,re.I):return {'kind':'flagship-top-eight'}
 if 'プロモーションカードセット'in s:
  year=re.search(r'20\d{2}',s)
  if year and'promotioncardset'+year[0]in t:return {'kind':'promotion-card-set-year','year':year[0]}
  if not year and re.fullmatch(r'promotioncardset[123]?',t):return {'kind':'promotion-card-set'}
 if 'プレミアムカードコレクション'in s:
  vol=re.search(r'vol\.?\s*(\d+)',s,re.I)
  if 'ベストセレクション'in s and vol and'premiumcardcollectionbestselectionvol'+vol[1]in t:return {'kind':'best-selection-volume','volume':vol[1]}
  for jp,en in [('25周年','25thanniversaryedition'),('FILM RED','onepiecefilmred'),('ガールズエディション','girlsedition'),('ウタ','uta')]:
   if jp in s and t=='premiumcardcollection'+en:return {'kind':'premium-collection-edition','edition':en}
 for jp,en in [('始めようキャンペーン','letsgetstartedcampaignpromotionpack'),('フィナーレセット','onepiecefilmredfinaleset'),('アンコールパック','onepiececardgameencorepack'),('3周年！ワンピースカードトレジャー','3thonepiececardtreasurecampaign'),('BASE SHOPリミテッドカードコレクションvol.1','limitedcardcollectionbaseshopvol1'),('ONE PIECE カードゲーム China 2nd ANNIVERSARY SET','onepiececardgamechina2ndanniversarysetjapanesever'),('ONE PIECE カードゲーム English 2nd ANNIVERSARY SET','anniversarysetenglish2ndanniversarysetjapanesever')]:
  if jp in s and t==en:return {'kind':'explicit-acquisition-translation','officialAcquisition':s}
 if 'ストレージボックスセット'in s and'storageboxset'in t and'onepiececardthebest'in t:return {'kind':'best-storage-box'}
 for ordinal in ['1st','2nd','3rd']:
  if ordinal+' ANNIVERSARY SET'in s and t in {ordinal+'anniversaryset','onepiececardgame'+ordinal+'anniversaryset'}and'China'not in s and'English'not in s:return {'kind':'japanese-anniversary-ordinal','ordinal':ordinal}
 return None
def original(p):
 u=urllib.parse.urlparse(p['thumbnailUrl'])
 if u.scheme!='https'or u.hostname!='cdn.snkrdunk.com':raise ValueError('Invalid market source')
 return urllib.parse.urlunparse(u._replace(query='',fragment=''))
def run():
 data=read(CACHE/'input.json');sources={s['officialId']:s for s in data['sources']};old={c['officialId']:c for c in data['catalogue']['cards']};pending=[s for s in data['sources']if not old[s['officialId']].get('productId')];known=learn_contexts(data)
 relevant={s['printedNumber']for s in pending}|{sources[k]['printedNumber']for k in BLOCKED if k in sources}
 siblings=collections.defaultdict(list)
 for s in data['sources']:siblings[s['printedNumber']].append(s)
 images=Images();local=read(ROOT/'config/onepiece-local-artworks.json');items=[]
 for s in data['sources']:
  if s['printedNumber']in relevant:
   c=s['card'];items.append(('official:'+s['officialId'],c.get('officialImage')or c['image'],local.get(s['officialId'],{}).get('image')))
 for s in pending:
  for p in s['candidates']:
   items.append(('market:'+p['id'],original(p),None))
 images.collect(items);memo={}
 def ev(oid,pid):
  key=(oid,pid)
  if key not in memo:memo[key]=images.evidence('official:'+oid,'market:'+pid)
  return memo[key]
 accepted=[];rows=[]
 for i,s in enumerate(pending,1):
  ranked=[]
  for p in s['candidates']:
   a=acquisition(s,p,known)
   if a:ranked.append({'product':p,'acquisition':a,'evidence':ev(s['officialId'],p['id'])})
  ranked.sort(key=lambda x:x['evidence']['quality'],reverse=True);reason='no-collected-japanese-candidate'if not s['candidates']else'acquisition-needs-review'
  chosen=None
  if ranked:
   best=ranked[0];e=best['evidence'];p=best['product'];runner=ranked[1]['evidence']['quality']if len(ranked)>1 else 0
   rival=max((ev(o['officialId'],p['id'])['quality']for o in siblings[s['printedNumber']]if o['officialId']!=s['officialId']and acquisition(o,p,known)),default=0)
   if not passes(e):reason='image-evidence-insufficient'
   elif e['quality']-runner<.10:reason='multiple-market-printings-close'
   elif e['quality']-rival<.10:reason='multiple-official-printings-close'
   elif s['officialId']in HELD:reason='existing-product-printing-conflict'
   else:reason='verified-artwork-and-acquisition';chosen=best
  row={'officialId':s['officialId'],'boxCode':s['boxCode'],'printedNumber':s['printedNumber'],'candidateCount':len(s['candidates']),'reason':reason,'accepted':bool(chosen)}
  if chosen:row.update({'productId':chosen['product']['id'],'evidence':chosen['evidence'],'acquisitionEvidence':chosen['acquisition']});accepted.append((s,chosen))
  rows.append(row)
  if i%200==0:print(json.dumps({'snkrCompared':i,'total':len(pending),'accepted':len(accepted),'uniqueImagePairs':len(memo)}),flush=True)
 # A new link cannot duplicate an existing different official printing's market product.
 prior=collections.defaultdict(list)
 for c in old.values():
  if c.get('productId'):prior[str(c['productId'])].append(c['officialId'])
 blocked=[];safe=[]
 for s,b in accepted:
  pid=b['product']['id'];conflicts=[o for o in prior.get(pid,[])if o!=s['officialId']];clear=[]
  for oid in conflicts:
   check=BLOCKED.get(oid)
   if check==(pid,s['officialId'])and ev(oid,pid)['quality']<.5:clear.append(oid)
  if len(clear)!=len(conflicts):
   next(r for r in rows if r['officialId']==s['officialId']).update({'accepted':False,'reason':'existing-product-printing-conflict'});continue
  for oid in clear:blocked.append({'officialId':oid,'blockedProductId':pid,'correctOfficialId':s['officialId'],'evidence':ev(oid,pid)})
  safe.append((s,b))
 counts=collections.Counter(b['product']['id']for s,b in safe)
 safe2=[]
 for s,b in safe:
  if counts[b['product']['id']]>1:next(r for r in rows if r['officialId']==s['officialId']).update({'accepted':False,'reason':'new-product-printing-conflict'})
  else:safe2.append((s,b))
 safe=safe2;safeids={s['officialId']for s,b in safe};blocked=[b for b in blocked if b['correctOfficialId']in safeids]
 links=[]
 for s,b in safe:
  p=b['product'];sm=images.data['official:'+s['officialId']];mm=images.data['market:'+p['id']];target=s['target'];config=local.get(s['officialId'],{})
  links.append({'brand':'onepiece','language':'ja','boxCode':target['boxCode'],'setCode':target['setCode'],'number':target['number'],'fullId':target['fullId'],'officialId':s['officialId'],'image':target['image'],'id':p['id'],'marketName':p['name'],'marketProductNumber':p['productNumber'],'marketImage':p['thumbnailUrl'],'sourceSHA256':config.get('sourceSHA256',sm['sha256']),'marketSHA256':mm['sha256'],'comparedSourceSHA256':sm['sha256'],'comparedMarketImage':mm['url'],'acquisition':s['card']['acquisition'],'sourceUrl':s['card']['sourceUrl'],'method':'registered-original-image-and-acquisition','reviewStatus':'verified-same-japanese-artwork-and-acquisition','auditRun':'20261101-recovery','evidenceId':s['officialId']+'|'+p['id']})
 proofpath=ROOT/'data/onepiece-reviewed-promo-links.json';proof=read(proofpath);proof['links']=[r for r in proof['links']if r.get('auditRun')!='20261101-recovery']+links;write(proofpath,proof)
 for b in blocked:
  s=sources[b['officialId']];p=ROOT/'data/cards-by-set'/(s['fileCode']+'.json');doc=read(p)
  for c in doc['cards']:
   if c.get('officialId')==b['officialId']:c.update({'marketLinkPolicy':'verified-only','marketLinkBlockedProductId':b['blockedProductId'],'marketLinkReviewReason':'Original market image has a different illustration. Independent artwork verification is required.','marketLinkAudit':'onepiece-market-link-audit-20261101'})
  write(p,doc)
 report={'schemaVersion':1,'baselineSHA256':data['baselineSHA256'],'officialCards':len(sources),'previouslyLinked':data['catalogue']['linkedProducts'],'audited':len(pending),'additionalConfirmed':len(links),'blockedPreviousLinks':blocked,'remaining':len(pending)-len(links)+len(blocked),'linkedAfter':data['catalogue']['linkedProducts']+len(links)-len(blocked),'snkrImagePairs':len(memo),'reasonCounts':dict(collections.Counter(r['reason']for r in rows)),'cards':rows,'marketProducts':data['marketProducts'],'shopCoverage':data['shopCoverage'],'imagesUsable':len(images.data),'imageErrors':images.errors,'sourceRequestCounts':dict(images.requests),'sourceCircuits':sorted(images.blocked),'originalPricesChanged':False}
 write(OUT,report);write(CACHE/'snkr-pairs.json',[{'officialId':oid,'productId':pid,**e}for(oid,pid),e in memo.items()])
 # Independently bind shop printings. Exact original product IDs survive source price refreshes.
 shop_by=collections.defaultdict(list)
 for p in data['yuyutei']:
  if p.get('image')and p.get('cardNumber'):shop_by[p['cardNumber']].append(p)
 shop_sources=[s for s in data['sources']if shop_by.get(s['printedNumber'])]
 shop_items=[('official:'+s['officialId'],s['card'].get('officialImage')or s['card']['image'],local.get(s['officialId'],{}).get('image'))for s in shop_sources]
 for p in data['yuyutei']:
  if p.get('image')and p.get('cardNumber')in siblings:shop_items.append(('shop:'+p['id'],p['image'],None))
 images.collect(shop_items);shop_memo={};bindings={};shop_rows=[]
 def sev(oid,pid):
  k=(oid,pid)
  if k not in shop_memo:shop_memo[k]=images.evidence('official:'+oid,'shop:'+pid)
  return shop_memo[k]
 for i,s in enumerate(shop_sources,1):
  ranked=[{'product':p,'evidence':sev(s['officialId'],p['id']),'acquisition':acquisition(s,p,known,True)}for p in shop_by[s['printedNumber']]if acquisition(s,p,known,True)]
  ranked.sort(key=lambda x:x['evidence']['quality'],reverse=True)
  if not ranked:continue
  b=ranked[0];e=b['evidence'];p=b['product'];runner=ranked[1]['evidence']['quality']if len(ranked)>1 else 0
  rival=max((sev(o['officialId'],p['id'])['quality']for o in siblings[s['printedNumber']]if o['officialId']!=s['officialId']and acquisition(o,p,known,True)),default=0)
  if passes(e,True)and e['quality']-runner>=.10 and e['quality']-rival>=.10:
   t=s['target'];key=':'.join(['onepiece',str(t.get('setCode')or t['boxCode']).upper(),t['fullNumber'].upper(),unicodedata.normalize('NFKC',str(t.get('rarity',''))).upper().replace(' ',''),str(t.get('fullId')or t.get('variant','')).upper()])
   binding={'language':'ja','officialId':s['officialId'],'officialImage':t['image'],'yuyuteiId':p['id'],'cardNumber':p['cardNumber'],'sourceSetCode':p['sourceSetCode'],'rarity':p['rarity'],'marketName':p['name'],'marketImage':p['image'],'sourceSHA256':images.data['official:'+s['officialId']]['sha256'],'marketSHA256':images.data['shop:'+p['id']]['sha256'],'verification':'original-image-and-acquisition','evidence':e,'sourceUrl':p['sourceUrl']}
   bindings[key]=binding;shop_rows.append({'officialId':s['officialId'],'productId':p['id'],'sourceAsOf':p.get('sourceAsOf'),'price':p.get('price'),'evidence':e})
  if i%300==0:print(json.dumps({'shopCompared':i,'total':len(shop_sources),'confirmedBindings':len(bindings),'shopImagePairs':len(shop_memo)}),flush=True)
 write(ROOT/'data/onepiece-reviewed-fallback-links.json',{'schemaVersion':1,'source':'onepiece-original-image-audit','bindings':bindings})
 report.update({'shopConfirmedBindings':len(bindings),'shopImagePairs':len(shop_memo),'shopBindingEvidence':shop_rows,'imagesUsable':len(images.data),'imageErrors':images.errors,'sourceRequestCounts':dict(images.requests),'sourceCircuits':sorted(images.blocked)})
 write(OUT,report);write(CACHE/'shop-pairs.json',[{'officialId':oid,'productId':pid,**e}for(oid,pid),e in shop_memo.items()])
 write(CACHE/'image-evidence.json',{k:{p:v for p,v in d.items()if p not in {'image','features'}}for k,d in images.data.items()})
 print(json.dumps({k:v for k,v in report.items()if k not in {'cards','blockedPreviousLinks','imageErrors','shopBindingEvidence'}},ensure_ascii=False),flush=True)
if __name__=='__main__':run()
