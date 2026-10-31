"""Independent XPath audit of cached official printing evidence (offline)."""
import collections, gzip, hashlib, html as html_std, json, re, urllib.parse
from pathlib import Path
from lxml import html

ROOT=Path(__file__).resolve().parent
def nodes(element,cls):return element.xpath('.//*[contains(concat(" ",normalize-space(@class)," ")," '+cls+' ")]')
def clean(value):return ' '.join(value.split())

def main():
    target={card['cardId'] for path in (ROOT/'parsed_products').glob('*.json') for card in json.loads(path.read_text())['cards']}
    errors=[];rows=0;audited=0;classes=collections.Counter()
    paths=[path for path in (ROOT/'parsed_details').glob('*.json') if path.stem in target]
    for path in paths:
        cid=path.stem
        try:
            detail=json.loads(path.read_text());raw=gzip.decompress((ROOT/'cache_details'/(cid+'.html.gz')).read_bytes()).decode()
            if hashlib.sha256(raw.encode()).hexdigest()!=detail['sourceSha256']:raise ValueError('Raw HTML hash mismatch')
            page=html.fromstring(raw)
            canonical=page.xpath('//meta[@property="og:url"]/@content')
            if len(canonical)!=1 or urllib.parse.parse_qs(urllib.parse.urlsplit(canonical[0]).query).get('cid')!=[cid]:raise ValueError('Canonical CID mismatch')
            tables=page.xpath('//*[@id="update_list"]')
            if len(tables)!=1:raise ValueError('Missing/duplicate printing table')
            explicit=[]
            for row in nodes(tables[0],'t_row'):
                number=nodes(row,'card_number');links=row.xpath('.//input[contains(concat(" ",normalize-space(@class)," ")," link_value ")]/@value')
                pack=nodes(row,'pack_name');iids=[x[len('pack_iid_'):] for x in row.get('class','').split() if x.startswith('pack_iid_')]
                if len(number)!=1 or len(links)!=1 or len(pack)!=1 or len(iids)!=1:raise ValueError('Incomplete explicit printing identity')
                query=urllib.parse.parse_qs(urllib.parse.urlsplit(html_std.unescape(links[0])).query)
                pid=query.get('pid',[None])[0]
                if not pid:raise ValueError('No printing PID')
                rarities=nodes(row,'lr_icon')
                if not rarities:raise ValueError('No explicit printing rarity')
                for rare in rarities:
                    rids=[x[4:] for x in rare.get('class','').split() if re.fullmatch('rid_\\d+',x)]
                    if len(rids)!=1:raise ValueError('No unique rarity ID')
                    explicit.append((pid,cid,iids[0],rids[0],clean(number[0].text_content())))
                    classes[rids[0]]+=1
            parsed=[(p['productId'],p['cardId'],p['artworkId'],p['rarityId'],p['number']) for p in detail['printings']]
            if explicit!=parsed:raise ValueError('XPath source tuples differ from parsed detail tuples')
            rows+=len(explicit);audited+=1
        except Exception as ex:errors.append({'cardId':cid,'error':repr(ex)})
    product_audited=0;product_rows=0;member_rarities=0
    for path in (ROOT/'parsed_products').glob('*.json'):
        try:
            product=json.loads(path.read_text());raw=gzip.decompress((ROOT/'cache_products'/(path.stem+'.html.gz')).read_bytes()).decode()
            if hashlib.sha256(raw.encode()).hexdigest()!=product['sourceSha256']:raise ValueError('Product raw HTML hash mismatch')
            page=html.fromstring(raw);tables=page.xpath('//*[@id="card_list"]')
            if len(tables)!=1:raise ValueError('Missing/duplicate membership table')
            source_rows=nodes(tables[0],'t_row');explicit=[]
            if len(source_rows)!=product['officialCardCount']:raise ValueError('Official member total differs from source row count')
            for row in source_rows:
                links=row.xpath('.//input[contains(concat(" ",normalize-space(@class)," ")," link_value ")]/@value')
                if len(links)!=1:raise ValueError('No unique membership identity link')
                query=urllib.parse.parse_qs(urllib.parse.urlsplit(html_std.unescape(links[0])).query)
                cid=query['cid'][0];iid=query.get('iid',['1'])[0]
                groups=nodes(row,'rarity')
                preferred=[group for group in groups if 'pack_r' in group.get('class','').split()]
                rarities=[rare for group in (preferred or groups) for rare in nodes(group,'lr_icon')]
                for rare in rarities:
                    rids=[x[4:] for x in rare.get('class','').split() if re.fullmatch('rid_\\d+',x)]
                    if len(rids)!=1:raise ValueError('No unique membership rarity ID')
                    explicit.append((cid,iid,rids[0]))
            parsed=[(card['cardId'],card['artworkId'],card['rarityId']) for card in product['cards']]
            if explicit!=parsed:raise ValueError('XPath source memberships differ from parsed product tuples')
            product_audited+=1;product_rows+=len(source_rows);member_rarities+=len(explicit)
        except Exception as ex:errors.append({'productId':path.stem,'error':repr(ex)})
    report={'targetCids':len(target),'detailFilesExamined':len(paths),'detailFilesAudited':audited,'explicitPrintingRowsAudited':rows,'productFilesAudited':product_audited,'memberRowsAudited':product_rows,'membershipRarityRowsAudited':member_rarities,'rarityIds':dict(classes),'errors':errors,'allAvailableSourcesPass':not errors,'allTargetsAvailable':audited==len(target)}
    temp=ROOT/'detail_raw_audit.json.tmp';temp.write_text(json.dumps(report,ensure_ascii=False,indent=2));temp.replace(ROOT/'detail_raw_audit.json')
    print(json.dumps(report,ensure_ascii=False),flush=True)
    if errors:raise SystemExit(2)

if __name__=='__main__':main()
