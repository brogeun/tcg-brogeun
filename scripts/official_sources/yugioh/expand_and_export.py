"""Bounded navigation crosswalk, official member collection, integration export."""
from __future__ import annotations
import concurrent.futures, json, re
from pathlib import Path
import collect_konami as c

# Reviewed title translations, not values copied from the old set associations.
# Official identities below are independently indexed in products.json.
REVIEWED = {
 'BOX:910566':['1000009626000','1000009627000'],
 'BOX:855165':['1000009601000','1000009602000'],
 'BOX:783305':['1000009580000','1000009581000'],
 'BOX:754768':['1000009559000','1000009560000'],
 'BOX:131228':['1000009001000','1000009001001'],
 'BOX:40802':['1000008603000','1000008603001'],
 'BOX:912876':['1000009613000'], 'BOX:912874':['1000009611000'], 'BOX:912875':['1000009612000'],
 'BOX:886014':['1000009617000'], 'BOX:847245':['1000009588000'], 'BOX:742159':['1000009541000'],
 'BOX:684303':['1000009542000'], 'BOX:553397':['1000009512000'], 'BOX:499164':['1000007420000'],
 'BOX:273613':['1000006811000'], 'BOX:146498':['1000000529000'],
 'BOX:137801':['1000000891000','1000000892000'], 'BOX:135484':['1000007418000'],
 'BOX:115409':['1000006810000'], 'BOX:111102':['1000004328000'],
 'BOX:98036':['1000007722000','1000007723000'], 'BOX:97254':['1000007721000'],
 'BOX:89513':['1000007416000'], 'BOX:76682':['1000006809000'], 'BOX:69035':['1000004327000'],
 'BOX:56022':['1000007415000'], 'BOX:21828':['1000007719000','1000007720000'],
 'BOX:12918':['1000006808000'], 'BOX:14210':['3304010'], 'BOX:14213':['3304011','3304012'],
 'BOX:538822':['3314007'], 'BOX:557412':['3314006'], 'BOX:13187':['3320001'],
 'BOX:561858':['3314005'], 'BOX:562866':['3319001'], 'BOX:64492':['111117000'],
 'BOX:49881':['3317005'], 'BOX:49882':['3317004'], 'BOX:62202':['3309016'],
 'BOX:49890':['3314003'], 'BOX:64495':['3304003'], 'BOX:16163':['1118003'],
 'BOX:58310':['111116000'], 'BOX:49883':['3317003'], 'BOX:49884':['3317002'],
 'BOX:16161':['1118001'], 'BOX:62203':['3309015'], 'BOX:49891':['3314002'],
 'BOX:16182':['3315003'], 'BOX:16181':['3315004'], 'BOX:64496':['3318000'],
 'BOX:49885':['3317001'], 'BOX:49887':['3315002'], 'BOX:49886':['3317000'],
 'BOX:49893':['3314001'], 'BOX:64497':['3316000'], 'BOX:49889':['3315000'],
 'BOX:49888':['3315001'], 'BOX:62204':['3309014'], 'BOX:62205':['3309013'],
 'BOX:60145':['3314000'], 'BOX:62206':['3309012'], 'BOX:60918':['3310004'],
 'BOX:64474':['111112000'], 'BOX:62296':['3309011'], 'BOX:60177':['3312003'],
 'BOX:60178':['3312002'], 'BOX:15409':['1113002'], 'BOX:62298':['3309010'],
 'BOX:62297':['3309009'], 'BOX:62299':['3309008'], 'BOX:64488':['111109000'],
 'BOX:62300':['3309007'], 'BOX:86504':['3309005'], 'BOX:919099':['3309006'],
 'BOX:857521':['2202001','111107008'], 'BOX:86502':['3309003'], 'BOX:86503':['3309002'],
 'BOX:86501':['3309004'], 'BOX:852370':['2202000','111106004'], 'BOX:86505':['3309000'],
 'BOX:86500':['3309001'], 'BOX:86405':['3305004'], 'BOX:16190':['3305003'],
 'BOX:13882':['1105002'], 'BOX:13881':['1105001'], 'BOX:16187':['3305000'],
 'BOX:13880':['1105000'], 'BOX:13208':['1104004'], 'BOX:13207':['1104003'],
 'BOX:13206':['1104002'], 'BOX:13205':['1104001'], 'BOX:13204':['1104000'],
 'BOX:86404':['3302003'], 'BOX:13203':['1103003'], 'BOX:86403':['111103000'],
 'BOX:16186':['3302002'], 'BOX:13202':['1103002'], 'BOX:86402':['3302001'],
 'BOX:13201':['1103001'], 'BOX:16184':['3302000'], 'BOX:13200':['1103000'],
 'BOX:16185':['111101001'], 'BOX:12909':['3309022'], 'BOX:12914':['1000004325000'],
 'BOX:12928':['3319004'], 'BOX:12922':['1000007414000'], 'BOX:12926':['3319006'],
}

def mappings(products):
 prior=json.loads((c.ROOT/'reviewed_box_mappings.json').read_text())
 boxes=[{'id':m['boxId'],'code':m.get('code') or ''} for m in prior]
 by={p['id']:p for p in products};cross=json.loads((c.ROOT/'manufacturer_code_crosswalk.json').read_text())
 for b,m in zip(boxes,prior):
  m.pop('setIds',None)
  if b['id'] in REVIEWED:
   m['productIds']=REVIEWED[b['id']];m['method']='reviewed-title-translation'
  elif not m['productIds']:
   matches=[x for x in cross if x['code']==b['code'].upper().removesuffix('-JP')]
   ids=list(dict.fromkeys(p['id'] for x in matches for p in x['officialProducts']))
   if ids:
    m['productIds']=ids;m['method']='explicit-market-product-code-and-official-manufacturer-title'
    m['manufacturerSources']=[x['manufacturerUrl'] for x in matches]
  m['officialProducts']=[{'id':pid,'name':by[pid]['name'],'url':by[pid]['url']} for pid in m['productIds']]
  # The future product is absent from the published Japanese card index.
  if not m['productIds']:m['incompleteReason']='No reviewed match to a currently indexed official Japanese OCG product.'
 return prior

def main():
 products=c.load_index();by={p['id']:p for p in products};ms=mappings(products)
 (c.ROOT/'reviewed_box_mappings.json').write_text(json.dumps(ms,ensure_ascii=False,indent=2))
 wanted={pid for m in ms for pid in m['productIds']};errors=[]
 print(json.dumps({'reviewedMappedBoxes':sum(bool(m['productIds']) for m in ms),'requestedProducts':len(wanted)}),flush=True)
 with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
  fut={pool.submit(c.collect_one_product,by[pid]):pid for pid in wanted}
  for i,f in enumerate(concurrent.futures.as_completed(fut),1):
   try:f.result()
   except Exception as ex:errors.append({'productId':fut[f],'error':str(ex)})
   if i%25==0:print(json.dumps({'productsFinished':i,'errors':len(errors)}),flush=True)
 parsed=[json.loads(p.read_text()) for p in (c.ROOT/'parsed_products').glob('*.json')]
 # Prefer high-reprint cards so each bounded card detail request verifies more
 # product printings. Never synthesize a printed number from list position.
 existing={p.stem for p in (c.ROOT/'parsed_details').glob('*.json')};coverage={}
 for p in parsed:
  for card in p['cards']:coverage[card['cardId']]=coverage.get(card['cardId'],0)+1
 representatives=list(dict.fromkeys(p['cards'][0]['cardId'] for p in parsed if p['cards']))
 selected=list(dict.fromkeys(representatives+sorted(coverage,key=lambda cid:coverage[cid],reverse=True)))
 selected=[cid for cid in selected if cid not in existing]
 print(json.dumps({'additionalDetailsRequested':len(selected),'alreadyCached':len(existing)}),flush=True)
 with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
  fut={pool.submit(c.collect_one_detail,cid):cid for cid in selected}
  for i,f in enumerate(concurrent.futures.as_completed(fut),1):
   try:f.result()
   except Exception as ex:errors.append({'cardId':fut[f],'error':str(ex)})
   if i%25==0:print(json.dumps({'detailsFinished':i,'errors':len(errors)}),flush=True)
 export_snapshot(products,ms,errors)

def export_snapshot(products,ms,errors):
 # The membership IID is representative. Use explicit detail-table artwork,
 # rarity and printed-number identities for the native printing inventory.
 import export_complete
 return export_complete.export_snapshot(products,ms,errors)

if __name__=='__main__':main()
