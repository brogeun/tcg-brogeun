"""Reconcile official artwork inventories, preserving reviewed marketplace bindings.

The committed compressed source is independent of the marketplace feed. No price
is inferred from an official number, a parallel suffix, or an acquisition title.
"""
from __future__ import annotations
import argparse, gzip, json, re
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
SNAPSHOT='config/onepiece-official-snapshot.json.gz'
LABELS={'PROMO':'프로모션 카드','LIMITED':'한정상품 수록 카드','FAMILY':'패밀리 덱 세트',
        'PRB01':'ONE PIECE CARD THE BEST','PRB02':'ONE PIECE CARD THE BEST Vol.2'}
ST_NAMES=['밀짚모자 일당','최악의 세대','왕하칠무해','백수 해적단','ONE PIECE FILM edition','해군','빅 맘 해적단','몽키 D. 루피','야마토','삼선장 집결','우타','조로 & 상디','삼형제의 유대','3D2Y','에드워드 뉴게이트','우타','돈키호테 도플라밍고','몽키 D. 루피','스모커','샬롯 카타쿠리','기어5','에이스 & 뉴게이트','샹크스','쥬얼리 보니','버기','몽키 D. 루피','마샬 D. 티치','야마토','EGGHEAD','루피 & 에이스','몽키 D. 루피','롤로노아 조로','쿠잔','샬롯 카타쿠리','사보','유스타스 키드']
def read(path,default=None):
    return json.loads(path.read_text(encoding='utf-8')) if path.exists() else default
def write(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes((json.dumps(data,ensure_ascii=False,separators=(',',':'))+'\n').encode('utf-8'))
def load_snapshot(root):
    current=root/'data/onepiece-official-source.json'
    if current.exists():data=read(current)
    else:
        with gzip.open(root/SNAPSHOT,'rt',encoding='utf-8')as f:data=json.load(f)
    assert data.get('schemaVersion')==1 and len(data.get('sets',[]))>=63,'Official inventory unavailable'
    codes=set();ids=set()
    for s in data['sets']:
        assert s['code'] not in codes and s['cards'],'Empty or duplicate official set'
        codes.add(s['code']);seen=set()
        for c in s['cards']:
            assert c['officialId'] not in seen and c['rarity'] and c['name'],'Incomplete artwork identity'
            assert re.fullmatch(r'(?:OP|EB|PRB|ST)\d+-\d+(?:_[A-Za-z0-9]+)*|P-\d+(?:_[A-Za-z0-9]+)*',c['officialId']),c['officialId']
            assert c['image'].startswith('https://www.onepiece-cardgame.com/images/cardlist/card/'),'Untrusted official image'
            assert c['boxCode']==s['code'] and c['language']=='ja'
            seen.add(c['officialId']);ids.add(c['officialId'])
    return data
def build(root=ROOT,validate_only=False):
    data=load_snapshot(root);manifest=[];missing=[];names={}
    repair=read(root/'data/card-catalog-repairs.json',{})
    product_images=read(root/'config/onepiece-product-images.json',{})
    local_artworks=read(root/'config/onepiece-local-artworks.json',{})
    for s in data['sets']:
        code=s['code'];storage_code='ONEPIECE-'+code if code in {'PROMO','LIMITED','FAMILY'} else code
        dest=root/'data/cards-by-set'/f'{storage_code}.json';old=read(dest,{'cards':[]})
        previous={str(c.get('officialId')or c.get('fullId')or'').upper():c for c in old['cards']}
        cards=[]
        for source in s['cards']:
            prior=previous.get(source['officialId'].upper(),{})
            # Keep source artwork paths used in independently reviewed image proofs.
            card={**prior,**source,'image':prior.get('image')or source['image'],
                  'fullId':prior.get('fullId')or source['fullId'],
                  'number':prior.get('number')or source['number'],
                  'baseNumber':prior.get('baseNumber')or source['baseNumber'],
                  'printedRarity':source['rarity'],'rarity':prior.get('rarity')or source['rarity'],
                  'officialImage':source['image'],'sourceUrl':s['sourceUrl']}
            card.pop('metadata',None);card.pop('sourceImage',None)
            if source['officialId'] in local_artworks:
                card['localImage']=local_artworks[source['officialId']]['image']
            cards.append(card)
        known={c['fullId'].upper()for c in cards}
        for card in old['cards']:
            if card.get('cardType')=='DON' or '-DON' in str(card.get('fullId','')).upper():
                if card['fullId'].upper()not in known:cards.append(card);known.add(card['fullId'].upper())
        for card in repair.get('onepieceDon',[]):
            if card.get('boxCode',card.get('setCode'))==code and card['fullId'].upper()not in known:
                cards.append(card);known.add(card['fullId'].upper())
        if validate_only:
            saved=read(dest,{'cards':[]});actual={c.get('officialId')or c.get('fullId'):c for c in saved['cards']}
            for c in s['cards']:
                found=actual.get(c['officialId'])
                if not found or found.get('printedRarity',found.get('rarity'))!=c['rarity'] or found.get('printedNumber')!=c['printedNumber'] or found.get('acquisition')!=c.get('acquisition'):
                    missing.append({'code':code,'officialId':c['officialId']})
        else:
            write(dest,{'code':code,'source':'onepiece-cardgame.com official artwork inventory','fetchedAt':data['collectedAt'],
                        'sourceUrl':s['sourceUrl'],'officialComplete':True,'officialCardCount':len(s['cards']),
                        'cardCount':len(cards),'cards':cards})
        name=LABELS.get(code,('스타트덱 '+ST_NAMES[int(code[2:])-1])if code.startswith('ST')and 1<=int(code[2:])<=len(ST_NAMES)else s['name'])
        manifest.append({'code':code,'fileCode':storage_code,'name':name,'nameJa':s['name'],'category':s['category'],
                         'url':s['sourceUrl'],'officialCardCount':len(s['cards']),'cardCount':len(cards),
                         'officialComplete':True,'image':product_images.get(code,{}).get('image'),
                         'packagingType':product_images.get(code,{}).get('packagingType')})
    assert not missing,'Official artworks or identity metadata missing: '+json.dumps(missing[:10])
    report={'schemaVersion':1,'generatedAt':data['collectedAt'],'source':'onepiece-cardgame.com',
            'officialComplete':True,'officialCards':sum(len(s['cards'])for s in data['sets']),
            'sets':manifest,'missingOfficialArtworks':[]}
    if not validate_only:write(root/'data/onepiece-official-manifest.json',report)
    return {'sets':len(manifest),'officialCards':report['officialCards'],'missing':0,'validateOnly':validate_only}
if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--root',type=Path,default=ROOT);p.add_argument('--validate-only',action='store_true');a=p.parse_args()
    print(json.dumps(build(a.root,a.validate_only)))
