#!/usr/bin/env python3
"""Bounded official evidence for second editions and unpublished future lists."""
import json,sys,hashlib
from pathlib import Path
from lxml import html
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import collect_bandai_official as o

root=Path(__file__).resolve().parent;o.configure(root,root.parent/'cache')
e=root/'evidence';e.mkdir(exist_ok=True)
data=json.loads((root/'union_arena.json').read_text());products={p['id']:p for p in data['products']}
specs=[('UA36BT','570136','841643','mcr-1','img_02.jpg',['UA36BT_MCR-1-AP01_p1','UA36BT_MCR-1-AP02_p1']),
       ('UA18BT','570118','345233','nik-1','img_01.jpg',['UA18BT_NIK-1-AP06_s']),
       ('UA23BT','570123','426516','aot-1','img_02.jpg',['UA23BT_AOT-1-AP01_s','UA23BT_AOT-1-AP02_s'])]
derived=[];evidence=[]
for code,pid,mid,slug,img,excluded in specs:
    mid='BOX:'+mid
    page_url=f'https://www.unionarena-tcg.com/jp/products/boosters/{slug}.php'
    page,pi=o.fetch('union_arena','evidence-'+code+'-product-page',page_url);(e/(code+'-product.html')).write_bytes(page)
    image_url=f'https://www.unionarena-tcg.com/jp/images/products/boosters/{slug}/{img}'
    body,ii=o.fetch('union_arena','evidence-'+code+'-reprint-image',image_url)
    original=products[pid];byid={c['id']:c for c in original['cards']}
    assert set(excluded)<=set(byid)
    exclusions=[]
    for cid in excluded:
        c=byid[cid]
        b,ci=o.fetch('union_arena','evidence-card-image-'+cid,c['image']);(e/(cid+'.png')).write_bytes(b)
        exclusions.append({'id':cid,'number':c['number'],'image':c['image'],'reason':'Official second-edition notice explicitly excludes serial-numbered limited action-point cards; the notice artwork was visually matched to this exact official image.','noticeImageProvenance':ii,'cardImageProvenance':ci,'visualMatchVerified':True})
    cards=[c for c in original['cards'] if c['id'] not in excluded]
    product={'id':'derived:union_arena:second-edition:'+code,'name':original['name']+' 第二版','code':code,'codeSource':'official first-edition product code; edition determined by official second-edition notice','kind':original['kind'],'language':'ja','edition':'second','sourceNativeProductId':pid,'sourceCategoryIds':[pid],'isDerivedProduct':True,'isAggregate':False,'idSource':'derived from official second-edition exclusion notice','marketBoxIds':[mid],'reviewedBoxIds':[mid],'marketCodeAliases':[code+'2'],'cards':cards,'cardCount':len(cards),'expectedCardCount':len(cards),'complete':True,'isBonus':False,'rarityComplete':all(c.get('rarity') or c.get('rarityNotApplicable') for c in cards),'classificationComplete':all(c.get('classificationSources') for c in cards),'exactParallelRarityComplete':all(c.get('rarityOrigin')=='official-detail' or c.get('rarityNotApplicable') for c in cards if c.get('variant')!='base'),'sourceCountMethod':'official-second-edition-explicit-exclusion','membershipMethod':'official-native-inventory-minus-explicit-second-edition-serial-AP-exclusions','independentlyDeclaredCount':False,'excludedCardIds':excluded,'exclusions':exclusions,'originalCardCount':len(original['cards']),'originalContainsAllExcludedSerialCards':True,'sourceProvenance':[original['provenance'],pi,ii],'provenanceSources':[original['provenance'],pi,ii],'officialNoticeImageUrl':image_url,'officialNoticeImageSha256':ii['sha256'],'url':page_url}
    derived.append(product)
    evidence.append({'code':code,'marketBoxId':mid,'sourceNativeProductId':pid,'status':'different-from-first-edition','difference':'Serial-numbered limited ACTION POINT cards are excluded from products marked 第二版.','originalCardCount':len(original['cards']),'secondEditionPrintingRows':len(cards),'excludedCardIds':excluded,'sourceProductProvenance':pi,'noticeImageProvenance':ii})
    print(json.dumps({'edition':code,'original':len(original['cards']),'derived':len(cards),'excluded':excluded}),flush=True)

landing,li=o.fetch('union_arena','evidence-current-inventory-2026-10-31',o.BASES['union_arena']);(e/'current-inventory.html').write_bytes(landing)
tree=html.fromstring(landing);selectors=[{'id':x.get('value'),'name':o.text(x)} for x in tree.xpath('//select[@name="series"]/option[@value]') if x.get('value')]
future=[]
for code,mid,slug in [('EX18BT','931807','ex_mgs'),('UA58BT','931809','dgm-1')]:
    mid='BOX:'+mid
    u=f'https://www.unionarena-tcg.com/jp/products/boosters/{slug}.php';b,info=o.fetch('union_arena','evidence-'+code+'-product-page',u);(e/(code+'-product.html')).write_bytes(b)
    t=html.fromstring(b);text=o.text(t)
    assert code in text and '2026年11月27日' in text
    matches=[s for s in selectors if code in s['name']]
    assert not matches
    future.append({'code':code,'marketBoxId':mid,'status':'official-full-card-inventory-not-yet-published','productAnnouncementPublished':True,'cardInventoryPublished':False,'fetchFailed':False,'releaseDate':'2026-11-27','matchingOfficialSelectors':matches,'selectorCountChecked':len(selectors),'inventoryProvenance':li,'announcementProvenance':info,'scope':'No official series selector/full printing membership is published for this code as of the captured 200 response. The official product announcement exists; declared rarity-kind counts are not a full printing list.'})
result={'fetchedAt':o.now(),'complete':True,'derivedProducts':derived,'reprintEvidence':evidence,'futureProducts':future,'inventorySelectors':selectors}
(root/'union_arena-edition-evidence.json').write_text(json.dumps(result,ensure_ascii=False,separators=(',',':')))
print(json.dumps({'derivedProducts':len(derived),'futureProducts':len(future),'selectors':len(selectors)}),flush=True)
