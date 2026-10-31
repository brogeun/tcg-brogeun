#!/usr/bin/env python3
"""Offline integrity check of the deliverable against frozen input and raw sources."""
import collections,gzip,hashlib,json
from pathlib import Path
ROOT=Path(__file__).resolve().parent
def load(p):return json.loads(p.read_text())
def main():
    checks=[]
    expected={'dragon_ball_fusion_world':(27,3230,{'verified':2934,'not_applicable':296}),'digimon':(78,7502,{'verified':7496,'not_applicable':6})}
    for game,(categories,rows,statuses) in expected.items():
        old=load(ROOT/'input'/(game+'.json'));new=load(ROOT/'final-complete'/(game+'.json'))
        identity=lambda d:[(p['id'],[(c['id'],c['number'],c['name'],c['image'],c['url']) for c in p['cards']]) for p in d['products']]
        assert identity(old)==identity(new),(game,'membership/order/identity changed')
        assert len(new['products'])==categories
        cs=[c for p in new['products'] for c in p['cards']];assert len(cs)==rows
        assert dict(collections.Counter(c['rarityStatus'] for c in cs))==statuses
        assert all(c['numberStatus']=='verified' and c['number'] for c in cs)
        assert all((c.get('rarity') and c['rarityStatus']=='verified') or (not c.get('rarity') and c['rarityStatus']=='not_applicable' and c.get('rarityNotApplicable')) for c in cs)
        assert all(not any(k in c for k in ['price','prices','marketPrice','yuyutei','snkrdunk']) for c in cs)
        assert new['metadataAudit']['complete'] and new['metadataAudit']['allExactImagesMatched']
        if game=='digimon':
            rarities={c['id']:c.get('rarity') for c in cs}
            assert {k:rarities[k] for k in ['BT18-092_P1','BT21-098_P1','BT21-060_P1']}=={'BT18-092_P1':'U','BT21-098_P1':'C','BT21-060_P1':'U'}
        checks.append({'game':game,'categories':categories,'rows':rows,'rarityStatusCounts':statuses,'nativeNumberVerified':rows})
    manifest=load(ROOT/'final-complete/source-manifest.json')
    for row in manifest:
        body=gzip.decompress((ROOT/row['file']).read_bytes());assert len(body)==row['bytes'];assert hashlib.sha256(body).hexdigest()==row['sha256']
    assert load(ROOT/'final-complete/validation.json')['passed']
    out={'passed':True,'games':checks,'immutableRawSourceResponses':len(manifest),'unknownRarityRows':0,'unknownNumberRows':0,'originalMembershipAndOrderPreserved':True,'marketFieldsAdded':False}
    (ROOT/'final-complete/independent-validation.json').write_text(json.dumps(out,ensure_ascii=False,indent=2));print(json.dumps(out,ensure_ascii=False,indent=2))
if __name__=='__main__':main()
