"""Build Korean display names without changing source names/price identities.

Species names come from the existing 1,025-species Korean/PokeAPI dictionary.
Trainer/energy card titles without species names remain in their source language.
"""
import argparse
import json
import re
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

def normalize(text):
    return unicodedata.normalize('NFC', ''.join(c for c in unicodedata.normalize('NFKD', text.replace('’', "'")) if not unicodedata.combining(c)))

OWNERS = {
    "Team Rocket's": '로켓단의', "Rocket's": '로켓단의', "Team Aqua's": '아쿠아단의', "Team Magma's": '마그마단의',
    "Misty's": '이슬의', "Brock's": '웅의', "Erika's": '민화의', "Blaine's": '강연의', "Sabrina's": '초련의',
    "Koga's": '독수의', "Lt. Surge's": '마티스의', "Giovanni's": '비주기의', "Cynthia's": '난천의',
    "Ethan's": '심향의', "Steven's": '성호의', "Marnie's": '마리의', "Lillie's": '릴리에의', "Iono's": '모야모의',
    "Arven's": '페퍼의', "Hop's": '호브의', "Larry's": '청목의', "N's": 'N의', "Ash's": '지우의',
    "Bruno's": '시바의', "Bugsy's": '호일의', "Chuck's": '사도의', "Clair's": '이향의', "Falkner's": '비상의',
    "Janine's": '도희의', "Jasmine's": '규리의', "Karen's": '카렌의', "Lance's": '목호의', "Morty's": '유빈의',
    "Pryce's": '류옹의', "Whitney's": '꼭두의', "Will's": '일목의', "Holon's": '홀론의', "Imakuni?'s": '이마쿠니의',
}
PREFIXES = {
    'Origin Forme ': '오리진', 'Mega ': '메가', 'M ': '메가', 'Primal ': '원시',
    'Alolan ': '알로라', 'Galarian ': '가라르', 'Hisuian ': '히스이', 'Paldean ': '팔데아',
    'Radiant ': '찬란한', 'Shining ': '빛나는', 'Dark ': '나쁜', 'Light ': '착한',
    'Flying ': '공중날기', 'Surfing ': '파도타기', 'Detective ': '명탐정',
}

def translator(root=ROOT):
    rows = json.loads((root/'data/pokemon-names-pokeapi.json').read_text('utf-8'))
    assert len(rows) == 1025 and all(r['en'] and r['ko'] for r in rows)
    names = {normalize(r['en']).casefold(): r['ko'] for r in rows}
    # Source spelling/spacing variants, not fuzzy matching.
    for source, species in [('Nidoran ♂', 'Nidoran♂'), ('Nidoran ♀', 'Nidoran♀'), ('Belossom', 'Bellossom'), ('Mr.Mime', 'Mr. Mime'), ('Mime Jr', 'Mime Jr.')]:
        names[normalize(source).casefold()] = names[normalize(species).casefold()]
    pattern = re.compile(r'(?<![A-Za-z])(' + '|'.join(re.escape(k) for k in sorted(names, key=len, reverse=True)) + r')(?![A-Za-z])', re.I)
    def translate(original):
        text = normalize(original)
        text, count = pattern.subn(lambda m: names[m[0].casefold()], text)
        if not count: return original
        for en, ko in OWNERS.items():
            text = text.replace(en+' ', ko+' ')
        for en, ko in PREFIXES.items():
            text = re.sub(r'(?<![A-Za-z])'+re.escape(en)+r'(?=[가-힣])', ko, text)
        text = re.sub(r'(?<=[가-힣]) and (?=[가-힣])', ' & ', text)
        return text
    return translate

def build(output=ROOT, cards_root=ROOT):
    translate=translator()
    files=sorted((cards_root/'data/english-sets').glob('*.json'))
    cards=[c for path in files for c in json.loads(path.read_text('utf-8'))['cards']]
    names={n:translate(n) for n in sorted({c['name'] for c in cards})}
    mapped={k:v for k,v in names.items() if k!=v}
    payload=dict(schemaVersion=1,source='data/pokemon-names-pokeapi.json (1025 species)',names=mapped)
    target=output/'data/english-card-names-ko.json';target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(payload,ensure_ascii=False,separators=(',',':')),encoding='utf-8')
    count=sum(c['name'] in mapped for c in cards)
    print(f'{len(files)} sets / {count} card entries / {len(mapped)} distinct translated names; source names preserved')

def main():
    p=argparse.ArgumentParser();p.add_argument('--output',type=Path,default=ROOT);p.add_argument('--cards-root',type=Path,default=ROOT);args=p.parse_args()
    build(args.output,args.cards_root)

if __name__=='__main__': main()
