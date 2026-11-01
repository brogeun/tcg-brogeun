"""Bounded original Mercari search discovery; retain observations and never infer valuations."""
from __future__ import annotations
import argparse,datetime as dt,json,re,time,urllib.request,urllib.parse,urllib.error
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
def read(p):return json.loads(Path(p).read_text(encoding='utf-8'))
def write(p,d):
 p=Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(d,ensure_ascii=False,separators=(',',':'))+'\n',encoding='utf-8')
def stamp():return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00','Z')
def combine_watchlist(manual,prior,new,maximum=20):
 items=[];seen=set()
 for r in manual+new+sorted(prior,key=lambda x:x.get('lastAttemptAt','')):
  item=r.get('itemId');url=r.get('sourceUrl')
  if not isinstance(item,str)or not re.fullmatch(r'm\d{11}',item)or url!='https://jp.mercari.com/item/'+item or item in seen:continue
  seen.add(item);items.append({'itemId':item,'sourceUrl':url,'game':r.get('game')or r.get('identity',{}).get('game')or r.get('matchHints',{}).get('game')or'onepiece','enabled':True})
  if len(items)>=maximum:break
 return {'schemaVersion':1,'source':'mercari','items':items}
def merge_references(previous,fresh):
 result=dict(previous);rows={r['itemId']:r for r in previous.get('references',[])}
 for r in fresh.get('references',[]):
  old=rows.get(r['itemId'])
  if old and r.get('fetchStatus')=='error':
   if(old.get('lastSuccessfulAt')or old.get('observedAt')or'')>(r.get('lastAttemptAt')or''):continue
   retained=dict(old);retained.update({'lastAttemptAt':r.get('lastAttemptAt'),'fetchStatus':'error','stale':True,'lastError':r.get('lastError'),'lastKnownSaleStatus':old.get('saleStatus','unknown'),'saleStatus':'unknown','statusEvidence':None,'soldAt':None,'valuationEligible':False,'verification':'unverified'})
   retained['issues']=sorted(set(old.get('issues',[])+['refresh_failed','canonical_identity_not_verified']));rows[r['itemId']]=retained;continue
  if old and(old.get('lastSuccessfulAt')or old.get('observedAt')or'')>(r.get('lastSuccessfulAt')or r.get('observedAt')or''):continue
  rows[r['itemId']]=r
 result['references']=list(rows.values());result['updatedAt']=fresh['updatedAt'];coverage={**previous.get('coverage',{}),**fresh.get('coverage',{})}
 coverage.update({'mode':'bounded_public_discovery','discovery':'public_search_html_and_retained_urls','trackedCount':len(rows),'fetchedThisRun':fresh.get('coverage',{}).get('fetchedCount',0),'verifiedQuoteCount':len(result.get('verifiedQuotes',[])),'notes':['Original public URLs only; full-game coverage and exact printing identity are not inferred.','Untouched prior observations retain their original observation and attempt times.']})
 result['coverage']=coverage;return result
def prepare(root=ROOT,fetch=None):
 reportpath=root/'data/onepiece-mercari-discovery.json';previous=read(reportpath)if reportpath.exists()else{}
 watch=read(root/'data/mercari-reference-watchlist.json');prior_doc=read(root/'data/mercari-references.json');prior=prior_doc.get('references',[])
 saved=prior_doc.get('coverage',{}).get('onepieceDiscovery',{})
 if saved.get('generatedAt','')>previous.get('generatedAt',''):previous=saved
 known={r['itemId']for r in watch['items']+prior}
 cards=read(root/'data/onepiece-official-search.json')['cards'];targets=[];numbers=set()
 for c in cards:
  if c.get('productId'):continue
  n=c['officialId'].split('_')[0]
  if n not in numbers and re.fullmatch(r'(?:PRB|OP|EB|ST)\d+-\d+|P-\d+',n):numbers.add(n);targets.append((c,n))
 offset=int(previous.get('nextOffset',0))%max(1,len(targets));selected=(targets[offset:]+targets[:offset])[:20]
 checks=[];new=[];blocked=None
 def original(url):
  time.sleep(2);request=urllib.request.Request(url,headers={'User-Agent':'Mozilla/5.0','Accept':'text/html'})
  with urllib.request.urlopen(request,timeout=20)as response:
   u=urllib.parse.urlparse(response.url)
   if u.scheme!='https'or u.hostname!='jp.mercari.com':raise ValueError('Unexpected source redirect')
   raw=response.read(4_000_001)
   if len(raw)>4_000_000:raise ValueError('Public result exceeds bounded limit')
  return raw.decode('utf-8')
 fetch=fetch or original
 for c,n in selected:
  query=n+' '+c['name']+' ワンピース';url='https://jp.mercari.com/search?'+urllib.parse.urlencode({'keyword':query})
  try:
   text=fetch(url);ids=list(dict.fromkeys(re.findall(r'/item/(m\d{11})(?!\d)',text)))[:3];checks.append({'officialId':c['officialId'],'printedNumber':n,'query':query,'sourceUrl':url,'checkedAt':stamp(),'publicItemIds':ids,'status':'observed-public-html'})
   for item in ids:
    if item not in known and all(r['itemId']!=item for r in new):new.append({'itemId':item,'sourceUrl':'https://jp.mercari.com/item/'+item,'game':'onepiece','enabled':True})
  except urllib.error.HTTPError as e:
   checks.append({'officialId':c['officialId'],'sourceUrl':url,'checkedAt':stamp(),'status':'http-error','httpStatus':e.code})
   if e.code in (403,429):blocked={'httpStatus':e.code,'observedAt':stamp(),'sourceUrl':url};break
  except (OSError,ValueError,UnicodeError)as e:checks.append({'officialId':c['officialId'],'sourceUrl':url,'checkedAt':stamp(),'status':'failed','error':str(e)[:180]})
 outcome={'schemaVersion':1,'source':'mercari','generatedAt':stamp(),'scope':'Original public search HTML only. No undocumented API, proxy, login, settlement inference, or automatic valuation.','queries':checks,'queryCount':len(checks),'newPublicItems':len(new),'blocked':blocked,'nextOffset':(offset+len(checks))%max(1,len(targets)),'status':'deferred'if blocked else'partial','searchTargets':len(targets),'newVerifiedQuotes':0}
 write(root/'.cache/onepiece-mercari-watchlist.json',combine_watchlist(watch['items'],prior,new));write(reportpath,outcome)
 print(json.dumps(outcome,ensure_ascii=False));return outcome
def merge(root=ROOT):
 fresh=read(root/'.cache/onepiece-mercari-fresh.json');previous=read(root/'data/mercari-references.json')
 if fresh.get('source')!='mercari'or fresh.get('schemaVersion')!=1:raise ValueError('Wrong collector output')
 result=merge_references(previous,fresh)
 discovery=read(root/'data/onepiece-mercari-discovery.json');result['coverage']['onepieceDiscovery']={k:discovery[k]for k in ['generatedAt','nextOffset','queryCount','newPublicItems','status','blocked']}
 write(root/'data/mercari-references.json',result);print(json.dumps({'trackedCount':len(result['references']),'fetchedThisRun':result['coverage']['fetchedThisRun']}))
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('--merge',action='store_true');args=p.parse_args()
 if args.merge:merge()
 elif prepare().get('blocked'):raise SystemExit(3)
