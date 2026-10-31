"""Add directly observed product specifications, explicit box identities and card roles."""
from pathlib import Path
from collections import defaultdict, Counter
import copy, html, json, re, unicodedata

R=Path(__file__).resolve().parent
def read(p): return json.loads((R/p).read_text())
def write(p,v): (R/p).write_text(json.dumps(v,ensure_ascii=False,separators=(',',':'))+'\n')
data=read('weiss-official-products.json'); products={p['officialId']:p for p in data['products']}
meta=[]
for f in sorted((R/'product-details').glob('batch-*.json')):meta.extend(json.loads(f.read_text())['results'])
meta.extend(read('official-special-product-pages.json')['results'])
meta.extend(json.loads(read('explicit-special-spec-pages.json')['content'][0]['text'])['results'])
meta=list({m['url']:m for m in meta}.values())
prefix=r'^(?:\[TD\+?\]|\[CB\]|プレミアムブースター|ブースターパック|エクストラブースター|エクストラパック|トライアルデッキ\+?\(?プラス\)?|ポートレートブースター|スペシャルパック|カムバックブースター|コレクションパック)\s*'
def key(s):
 s=unicodedata.normalize('NFKC',s);s=re.sub(prefix,'',s);return re.sub(r'\s+','',s).casefold()
def flat(s):return unicodedata.normalize('NFKC',html.unescape(re.sub('<[^>]+>',' ',s)))
name_idx=defaultdict(list); url_idx={}; direct=defaultdict(list)
for m in meta:
 h=re.search(r'<h1[^>]*>(.*?)</h1>',m['text'],re.S)
 name=html.unescape(re.sub('<[^>]+>','',h.group(1))) if h else m['title'].split(' - 商品情報')[0].split('｜')[0]
 title=m['title'];kind='premium-booster' if title.startswith('プレミアムブースター') else 'extra-booster' if title.startswith(('エクストラブースター','エクストラパック')) else 'booster-pack' if title.startswith(('ブースターパック','カムバックブースター')) else 'trial-deck' if title.startswith('トライアルデッキ') else 'other'
 m.update(parsedName=name,parsedKind=kind);name_idx[(key(name),kind)].append(m);url_idx[m['url']]=m
 for u in m['links']:
  z=re.search(r'https://ws-tcg.com/cardlist/search/\?expansion=(\d+)',u)
  if z:direct[z.group(1)].append(m)

force_urls={'20':'https://ws-tcg.com/products/lbe_eb/','99':'https://ws-tcg.com/products/dc3_eb/',
 '357':'https://ws-tcg.com/products/hol_bp/','419':'https://ws-tcg.com/products/hol_vol2_bp/',
 '494':'https://ws-tcg.com/ex/nik_jp/','542':'https://ws-tcg.com/products/vrg_eb/'}
selected={}
for eid,p in products.items():
 matches=name_idx[(key(p['name']),p['kind'])]
 if eid in force_urls and force_urls[eid] in url_idx:selected[eid]=url_idx[force_urls[eid]]
 elif len(matches)==1:selected[eid]=matches[0]
 elif len(direct[eid])==1:selected[eid]=direct[eid][0]

normal={'RR','R','U','C','CR','CC','N','TD'}
def specs(m):
 text=flat(m['text']); pairs=[]
 pat=r'(?:カード種類数\s*[:：]?\s*)?(?:(?:ノーマル|全)\s*)?(\d+)\s*種\s*[+＋]\s*(?:パラレル|箔押しカード)\s*[:：]?\s*(\d+)\s*種'
 for x in re.finditer(pat,text):
  # Box/carton bonus normal+parallel subtotals are not the pack specification.
  before=text[max(0,x.start()-70):x.start()]
  if 'カード種類数' not in x.group(0) and not re.search(r'種類数[^0-9]{0,30}$',before):continue
  tail=text[x.end():x.end()+100]
  if re.match(r'\s*(?:以上|程度|\(予定\))',tail):continue
  # Additional named foil classes are explicitly additive on old product specifications.
  extra=re.match(r'\s*[+＋]\s*(?:スペシャル|箔押しサインカード)\s*(\d+)\s*種',tail)
  n,par=int(x[1]),int(x[2])+(int(extra[1]) if extra else 0)
  pairs.append({'normal':n,'parallel':par,'total':n+par,'sourceExcerpt':text[max(0,x.start()-15):x.end()+(extra.end() if extra else 0)]})
 # Some premium packs publish N + named foil classes rather than a parallel subtotal.
 rare_matches=defaultdict(set)
 for x in re.finditer(r'(?<![A-Z])([A-Z][A-Z0-9@+]{0,5})\s*\([^)]{1,35}\)\s*(?:…|:)?\s*(\d+)\s*種',text):rare_matches[x[1]].add(int(x[2]))
 rare={k:next(iter(v)) for k,v in rare_matches.items() if len(v)==1}
 if 'N' in rare and len(rare)>1 and not pairs:
  par=sum(v for k,v in rare.items() if k not in normal and k not in {'PR','PR+'})
  if par:pairs.append({'normal':rare['N'],'parallel':par,'total':rare['N']+par,'sourceExcerpt':'Literal N and separately named foil rarity counts on this official page.','rarityCounts':rare})
 pairs=list({(x['normal'],x['parallel']):x for x in pairs}.values())
 return pairs,rare

for eid,p in products.items():
 p['coreCardIds']=[];p['relatedCardIds']=[];p['includedBonusIds']=[]
 for c in p['cards']:
  promo=c['rarity'] in {'PR','PR+'}
  if p['kind']=='promo':role='related-promo';p['relatedCardIds'].append(c['id'])
  elif p['kind']=='trial-deck':role='trial-product-membership';p['coreCardIds'].append(c['id'])
  elif promo:role='related-promo-unverified-inclusion';p['relatedCardIds'].append(c['id'])
  else:role='pack-candidate';p['coreCardIds'].append(c['id'])
  c['inclusionRole']=role
 p['corePrintingCount']=len(p['coreCardIds']);p['relatedPrintingCount']=len(p['relatedCardIds'])
 m=selected.get(eid)
 if m:
  p['productPageUrl']=m['url'];pairs,rare=specs(m);p['advertisedPackSpecifications']=pairs;p['advertisedRarityCounts']=rare
  p['productPageTitle']=m['title']
  if eid=='542':
   p['nativeCategoryConflict']={'apiCategoryId':p['categoryId'],'apiKind':p['kind'],'productPageKind':m['parsedKind']}
   p['kind']='extra-booster';p['kindEvidenceUrl']=m['url']
  core=[c for c in p['cards'] if c['id'] in set(p['coreCardIds'])]
  nc=[c for c in core if c['rarity'] in normal];pc=[c for c in core if c['rarity'] not in normal]
  p['actualNormalPrintingCount']=len(nc);p['actualParallelPrintingCount']=len(pc)
  p['officialParallelFlagCounts']=dict(Counter(c['parallelParam'] for c in core))
  # Preserve all actual numbered art variants. This derived comparison never creates card IDs/codes.
  group=defaultdict(list)
  for c in core:
   z=re.match(r'^(.*\d)[a-z]$',c['number'])
   if z:group[(z[1],c['rarity'],c['name'],c['officialRaw']['text'])].append(c)
  arts=[v for v in group.values() if len(v)>1]
  p['artVariantGroups']=[{'literalNumbers':[c['number'] for c in v],'cardIds':[c['id'] for c in v],'rarity':v[0]['rarity'],'name':v[0]['name']} for v in arts]
  normal_extra=sum(len(v)-1 for v in arts if v[0]['rarity'] in normal)
  parallel_extra=sum(len(v)-1 for v in arts if v[0]['rarity'] not in normal)
  p['normalConceptTypeCount']=len(nc)-normal_extra;p['parallelConceptTypeCount']=len(pc)-parallel_extra
  if arts:
   p['conceptTypeCountPolicyEvidence']={'sourceUrls':['https://ws-tcg.com/ex/aoh/','https://ws-tcg.com/ex/td_bp_gim/'],
    'statement':'The manufacturer explicitly states that differing final alphabet letters on normal card numbers are not counted as different advertised normal types. Actual literal printing rows remain separate.'}
  matching=[x for x in pairs if (x['normal'],x['parallel']) in [(len(nc),len(pc)),(len(nc)-normal_extra,len(pc)-parallel_extra)]]
  if pairs and pc==[] and any(x['normal']==len(nc) and x['parallel']>0 for x in pairs):
   p['parallelFinishesNotIndividuallyRepresented']=True
   p['finishRepresentationNote']='Manufacturer advertises additional parallel finishes, while the official API supplies only the normal printed-code/image rows. No synthetic printing ID or number has been created.'
  if matching and p['kind'] in {'booster-pack','premium-booster','extra-booster','other'}:
   p['packMembershipComplete']=True;p['packSpecificationMatch']=matching[0]
   p['packVerificationMethod']='Complete literal official expansion rows; PR family separated; normal/parallel specifications agree with actual printing counts or explicitly preserved same-design lettered art variants.'
   for c in core:c['inclusionRole']='pack'

# These corrections were reviewed using the literal full legacy set code plus exact official
# product identity/package kind; primary product pages are retained above. No fuzzy matching.
extra={
 'BOX:835156':'554','BOX:773937':'542','BOX:703256':'528','BOX:483514':'510',
 'BOX:439394':'503','BOX:439391':'499','BOX:760198':'499','BOX:343237':'491',
 'BOX:343235':'489','BOX:343232':'487','BOX:343228':'485','BOX:274644':'471',
 'BOX:163503':'462','BOX:155791':'455','BOX:152503':'448','BOX:285534':'407',
 'BOX:280011':'400','BOX:482638':'384','BOX:482640':'372','BOX:314715':'361',
 'BOX:321395':'323','BOX:344719':'233','BOX:347215':'213','BOX:278017':'199',
 'BOX:343926':'178','BOX:337917':'131','BOX:358304':'99','BOX:470238':'36',
 'BOX:469858':'30','BOX:469860':'31','BOX:469862':'23','BOX:470230':'24',
 'BOX:470236':'22','BOX:470234':'25','BOX:470232':'21','BOX:334073':'20','BOX:469856':'19'}
review=read('official-box-mapping-review.json')
for row in review['boxes']:
 bid=row['boxId']
 if bid in extra:
  eid=extra[bid];p=products[eid]
  row.update(status='reviewed-explicit-official-product-identity',reviewed=True,mappingComplete=True,
    officialProductIds=[eid],evidence='Manual identity review: exact native product name, full legacy printed codes and manufacturer package kind; conflicting market labels retained as corrections.',
    officialProductPageUrl=p.get('productPageUrl'),officialPrintedSetCodes=p['printedSetCodes'])
  if bid not in p['marketBoxIds']:p['marketBoxIds'].append(bid)
  if bid=='BOX:358304':row['correctionEvidence']='Market date 2013-08-16 and Extra Booster identity match the official anime D.C.III product (DC3/WE16); DC3/W18 is the distinct 2012-05-25 Booster Pack.'
  if bid=='BOX:334073':row['correctionEvidence']='Market date 2008-08-28 and Extra Pack identity match official lbe_eb; LB/W06 is a different later Booster Pack. Preserve the corrected native LB/W02 extra-product group.'
  if bid=='BOX:760198':row['editionMembershipComplete']=False;row['editionNote']='Product identity is established; separate resale printing/foil treatment is not inferred from the original native rows.'

# NIKKE reprint is a publisher-documented edition: same rarity breakdown except no AGR.
orig=products['494'];agr=[c for c in orig['cards'] if c['rarity']=='AGR'];assert len(agr)==1
reprint=copy.deepcopy(orig);reprint.pop('officialId',None)
reprint.update(id='ws-jp:494:reprint',derived=True,derivedFromOfficialId='494',nativeExpansionId='494',
 name='勝利の女神：NIKKE（再版）',edition='reprint',marketBoxIds=['BOX:567465'],
 sourceUrl='https://ws-tcg.com/ex/nik_jp/',productPageUrl='https://ws-tcg.com/ex/nik_jp/')
reprint['cards']=[c for c in reprint['cards'] if c['rarity']!='AGR']
reprint['cardCount']=len(reprint['cards']);reprint['coreCardIds']=[c['id'] for c in reprint['cards']]
reprint['corePrintingCount']=len(reprint['cards']);reprint['relatedCardIds']=[];reprint['relatedPrintingCount']=0
reprint['rarityCounts']=dict(Counter(c['rarity'] for c in reprint['cards']))
reprint['actualNormalPrintingCount']=115;reprint['actualParallelPrintingCount']=173
reprint['normalConceptTypeCount']=115;reprint['parallelConceptTypeCount']=173
reprint['officialParallelFlagCounts']=dict(Counter(c['parallelParam'] for c in reprint['cards']))
reprint['advertisedRarityCounts']=reprint['rarityCounts'].copy()
reprint['membershipSemantics']='Publisher-documented reprint edition derived from literal native expansion 494 by excluding its sole AGR; original native IDs, printed numbers and pictures are preserved.'
reprint['advertisedPackSpecifications']=[{'normal':115,'parallel':173,'total':288}]
reprint['packSpecificationMatch']={'normal':115,'parallel':173,'total':288}
reprint['editionEvidence']={'sourceUrl':'https://ws-tcg.com/ex/nik_jp/',
 'statement':'The official reprint section explicitly states 115 normal + 173 parallel, no AGR, no box bonus and no 3-box campaign.',
 'excludedNativeCardIds':[c['id'] for c in agr],'excludedLiteralNumbers':[c['number'] for c in agr]}
reprint['editionEvidence']['provenance']=read('nikke-reprint-provenance.json')
assert reprint['cardCount']==288
reprint['complete']=True;reprint['packMembershipComplete']=True
for c in reprint['cards']:c['inclusionRole']='pack';c['edition']='reprint'
data['derivedProducts']=[reprint]
data['futureProducts']=read('future-products-evidence.json')
for row in review['boxes']:
 if row['boxId']=='BOX:567465':row.update(status='reviewed-manufacturer-reprint-rule',reviewed=True,mappingComplete=True,
  officialProductIds=['494'],derivedProductId=reprint['id'],excludedOfficialCardIds=[c['id'] for c in agr],edition='reprint',
  evidence=reprint['editionEvidence'],officialProductPageUrl=reprint['productPageUrl'])
 if row.get('mappingComplete'):
  pp=reprint if row['boxId']=='BOX:567465' else products[row['officialProductIds'][0]]
  if 'resale' in row['name'].lower() and row['boxId']!='BOX:567465':
   row['editionMembershipComplete']=False
   row['directImportMembershipAllowed']=False
   row['editionNote']='Original manufacturer product identity is verified; the resale edition printing/foil identity has not been established by an explicit publisher rule.'
   pp['relatedMarketBoxIds']=sorted(set(pp.get('relatedMarketBoxIds',[])+[row['boxId']]))
   pp['marketBoxIds']=[b for b in pp['marketBoxIds'] if b!=row['boxId']]
  row['coreCardIds']=pp['coreCardIds'];row['relatedCardIds']=pp['relatedCardIds'];row['includedBonusIds']=pp['includedBonusIds']
  row['packMembershipComplete']=pp['packMembershipComplete'] and row.get('editionMembershipComplete',True)
review['summary']=dict(Counter(x['status'] for x in review['boxes']))
data['inventoryComplete']=True
data['allMarketBoxesMapped']=all(x['mappingComplete'] for x in review['boxes'])
data['allPackMembershipComplete']=all(x.get('packMembershipComplete',False) for x in review['boxes'])
data['coverageScope']='Complete native manufacturer expansion catalogue plus an explicitly documented NIKKE reprint edition; market box and sealed-pack verification are separate.'
write('official-box-mapping-review.json',review)
write('official-product-pages-normalized.json',meta)
write('weiss-official-products.json',data)
summary={'officialProductPagesRead':len(meta),'nativeProducts':len(products),'derivedEditions':1,
 'productsWithProductPageEvidence':len(selected),'nativeProductsPackVerified':sum(p['packMembershipComplete'] for p in products.values()),
 'boxesMapped':sum(x['mappingComplete'] for x in review['boxes']),'boxesPackVerified':sum(x.get('packMembershipComplete',False) for x in review['boxes']),
 'boxesWithDirectReviewedMembership':len({b for p in data['products']+data['derivedProducts'] for b in p['marketBoxIds']}),
 'editionUnverifiedBoxes':[x['boxId'] for x in review['boxes'] if x.get('editionMembershipComplete') is False],
 'unmappedBoxes':[{'id':x['boxId'],'name':x['name'],'reason':x.get('reason')} for x in review['boxes'] if not x['mappingComplete']],
 'mappingStatusCounts':review['summary'],'nikkeReprint':reprint['editionEvidence'],
 'scope':'Core/related classification preserves all raw native cards. No specific PR is asserted as an included box bonus without literal role evidence.'}
write('membership-role-audit.json',summary)
audit=read('official-catalog-audit.json')
audit.update(boxesMapped=summary['boxesMapped'],boxesPackVerified=summary['boxesPackVerified'],
 mappingStatusCounts=review['summary'],officialProductPagesRead=len(meta),productPageInventoryComplete=True,
 nativeProductsPackVerified=summary['nativeProductsPackVerified'],derivedEditions=1,
 allMarketBoxesMapped=data['allMarketBoxesMapped'],allPackMembershipComplete=data['allPackMembershipComplete'])
write('official-catalog-audit.json',audit)
print(json.dumps(summary,ensure_ascii=False,indent=2))
