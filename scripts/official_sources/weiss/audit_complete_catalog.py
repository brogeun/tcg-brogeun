"""Audit literal official JSON rows and propose only exact-code/kind box mappings."""
from pathlib import Path
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import re

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT.parents[2] / 'data/tcg-card-info.json'
BASE = 'https://ws-tcg.com/wordpress/wp-content/images/cardlist/'
SOURCE = 'https://ws-tcg.com/manage/CardListUser/searchJson'

def dump(name, value):
    (ROOT/name).write_text(json.dumps(value, ensure_ascii=False, separators=(',', ':'))+'\n')

def setcode(number):
    m = re.match(r'^([A-Za-z0-9]+/[A-Za-z0-9]+)-', number or '')
    return m.group(1) if m else None

def market_kind(name):
    name = name.lower()
    if 'premium booster' in name: return 'premium-booster'
    if 'extra booster' in name: return 'extra-booster'
    if 'booster pack' in name: return 'booster-pack'
    if 'trial deck' in name: return 'trial-deck'
    if 'collection pack' in name: return 'other'
    return None

filters = json.loads((ROOT/'official-filter-options.json').read_text())
expansions = {str(e['id']):e for e in filters['expansions']}
categories = {str(e['id']):e['name'] for e in filters['categories']}
kinds = {'1':'booster-pack','2':'extra-booster','3':'trial-deck','4':'other','5':'promo','6':'premium-booster'}
pages, cards, page_audit = [], [], []
for path in sorted((ROOT/'card-pages').glob('page-*.json')):
    raw = path.read_bytes()
    page = json.loads(raw)
    no = int(path.stem.split('-')[1])
    assert page['page'] == no
    assert page['total'] == 66462 and page['page_count'] == 554 and page['limit'] == 120
    assert len(page['items']) == (102 if no == 554 else 120)
    pages.append(no); cards.extend(page['items'])
    page_audit.append({'page':no,'rows':len(page['items']),'sha256':hashlib.sha256(raw).hexdigest(),'file':str(path.relative_to(ROOT))})
assert pages == list(range(1,555))
assert len(cards) == 66462 and len({c['id'] for c in cards}) == 66462
assert len({(c['id'],c['variation'],c['picture']) for c in cards}) == 66462
by_exp = defaultdict(list)
for c in cards: by_exp[str(c['expansion'])].append(c)
assert set(by_exp) == set(expansions)

products=[]
for eid,e in expansions.items():
    rows=by_exp[eid]
    product={'id':'ws-jp:'+eid,'officialId':eid,'name':e['name'],'kind':kinds.get(str(e['category'])),
      'categoryId':str(e['category']),'categoryName':categories.get(str(e['category'])),
      'url':'https://ws-tcg.com/cardlist/search/?expansion='+eid,
      'sourceUrl':SOURCE+'?expansion='+eid,'complete':True,'membershipComplete':True,
      'packMembershipComplete':False,'membershipSemantics':'Complete literal manufacturer expansion assignment; a PR assignment does not independently establish sealed-pack inclusion.',
      'officialMetadata':e,'printedSetCodes':sorted({setcode(c['card_number']) for c in rows if setcode(c['card_number'])}),
      'rarityCounts':dict(Counter(c['rare'].strip() for c in rows)),'cardCount':len(rows),
      'marketBoxIds':[], 'cards':[{'id':str(c['id']),'officialId':str(c['id']),'number':c['card_number'],
        'cardNumber':c['card_number'],'name':c['card_name'],'rarity':c['rare'].strip(),'sourceRarity':c['rare'],
        'variation':c['variation'],'parallelParam':c['parallel_param'],
        'isParallel':c['parallel_param']=='〇','picture':c['picture'],'image':BASE+c['picture'],
        'officialProductId':eid,'sourceUrl':'https://ws-tcg.com/cardlist/?cardno='+c['card_number'].replace('/','%2F'),
        'url':'https://ws-tcg.com/cardlist/?cardno='+c['card_number'].replace('/','%2F'),
        'officialRaw':c} for c in rows]}
    products.append(product)

manifest=json.loads(MANIFEST.read_text())
sets={s['id']:s for g in manifest['games'] for s in g.get('sets',[]) if s.get('sourceGame')=='weiss_schwarz'}
boxes=next(g['boxes'] for g in manifest['games'] if g['id']=='weiss_schwarz')
manual={'BOX:887688':'564','BOX:778223':'548','BOX:336674':'238','BOX:122977':'420',
        'BOX:723718':'532','BOX:370994':'494','BOX:122979':'419','BOX:173035':'357',
        'BOX:173037':'383','BOX:184935':'464'}
# Hololive Re:Mix has no separate expansion; NIKKE reprint is handled by an explicit derived edition.
special={'BOX:343239':'Re:Mix has no independent official expansion; original groups contain 757 rows / 680 non-PR rows, so neither is its advertised 648 printing membership.',
         'BOX:567465':'NIKKE reprint requires a derived 494 edition excluding the sole AGR, supported by the explicit official first/reprint specification.'}
mapping=[]
for box in boxes:
    code=box.get('code') or ''
    legacy_codes=sorted({sets[s]['code'] for s in box.get('setIds',[]) if s in sets and re.fullmatch(r'[A-Za-z0-9]+/[A-Za-z0-9]+',sets[s].get('code',''))})
    mk=market_kind(box['name']); codes=[code] if re.fullmatch(r'[A-Za-z0-9]+/[A-Za-z0-9]+',code) else legacy_codes
    candidates=[p for p in products if mk==p['kind'] and codes and set(codes).issubset(p['printedSetCodes'])]
    row={'boxId':box['id'],'name':box['name'],'marketCode':code,'marketKind':mk,
      'legacyFullSetCodes':legacy_codes,'candidateIds':[p['officialId'] for p in candidates],
      'mappingComplete':False,'reviewed':False}
    if box['id'] in special:
        row['status']='requires-edition-membership-review';row['reason']=special[box['id']]
    elif box['id'] in manual:
        eid=manual[box['id']];p=next(p for p in products if p['officialId']==eid)
        row.update(status='reviewed-official-product-identity',reviewed=True,mappingComplete=True,
          officialProductIds=[eid],evidence='Existing manufacturer product specification identifies this exact market box; native expansion/product name and printed codes verified.')
        p['marketBoxIds'].append(box['id'])
    elif len(candidates)==1 and len(codes)==1:
        p=candidates[0];row.update(status='unique-exact-full-set-code-and-kind',reviewed=True,
          mappingComplete=True,officialProductIds=[p['officialId']],evidence='Exact full printed set code and independently observed manufacturer package kind identify one native expansion; no franchise-prefix or fuzzy-title matching.')
        p['marketBoxIds'].append(box['id'])
    else:
        row['status']='ambiguous-or-unmatched';row['reason']='No single exact full-set-code and package-kind identity; requires explicit product evidence.'
    mapping.append(row)

audit={'checkedAt':datetime.now(timezone.utc).isoformat(),'sourceUrl':SOURCE,
 'inventoryComplete':True,'rawRows':len(cards),'uniqueNativeIds':len({c['id'] for c in cards}),
 'uniqueIdVariationPictureKeys':len({(c['id'],c['variation'],c['picture']) for c in cards}),
 'duplicateLiteralPrintingKeys':sum(n-1 for n in Counter((c['card_number'],c['rare'],c['picture'],c['expansion']) for c in cards).values() if n>1),
 'pagesExpected':554,'pagesCollected':len(pages),'missingPages':[],
 'expansionsExpected':len(expansions),'expansionsWithRows':len(by_exp),'unknownExpansionIds':[],
 'missingPrintedNumbers':sum(not str(c.get('card_number') or '').strip() for c in cards),
 'missingRarities':sum(not str(c.get('rare') or '').strip() for c in cards),
 'missingImages':sum(not str(c.get('picture') or '').strip() for c in cards),
 'variationCounts':dict(Counter(str(c['variation']) for c in cards)),
 'rawRarityWhitespaceAnomalies':[{'id':c['id'],'number':c['card_number'],'sourceRarity':c['rare']} for c in cards if c['rare']!=c['rare'].strip()],
 'mappingStatusCounts':dict(Counter(x['status'] for x in mapping)),
 'uniqueTargetBoxes':len(boxes),'boxesMapped':sum(x['mappingComplete'] for x in mapping),
 'manifestPath':str(MANIFEST),'manifestSha256':hashlib.sha256(MANIFEST.read_bytes()).hexdigest(),
 'packMembershipComplete':False,'pages':page_audit}
dump('official-catalog-audit.json',audit)
dump('official-cards-full.json',cards)
dump('official-box-mapping-review.json',{'summary':audit['mappingStatusCounts'],'boxes':mapping})
dump('weiss-official-products.json',{'schemaVersion':1,'game':'weiss_schwarz','language':'ja',
 'source':'Bushiroad Weiss Schwarz official Japanese JSON catalogue','sourceUrl':SOURCE,
 'fetchedAt':audit['checkedAt'],'complete':True,'evidenceType':'manufacturer-json-expansion-membership',
 'imageBaseEvidence':dict(json.loads((ROOT/'official-card-image-base-evidence.json').read_text()),
   evidenceType='manufacturer-product-image-links',sourceUrl='https://ws-tcg.com/products/bdy_bp/'),'limitations':[
 'Expansion assignment is preserved exactly and includes PR rows; sealed-pack role requires separate product evidence.',
 'Re:Mix is not an independent expansion and cannot be built by combining original groups.',
 'Official variation is numeric zero in all rows; no additional E1/E5 printing qualifiers are inferred.'],
 'products':products})
print(json.dumps({k:v for k,v in audit.items() if k!='pages'},ensure_ascii=False,indent=2))
