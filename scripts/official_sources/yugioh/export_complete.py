"""Atomic native-printing export from explicit official detail tables.

The product list's IID is a representative image, not an artwork inventory.
Only detail-table PID/CID/IID/rarity/printed-number rows define printings.
No row position or image filename is interpreted as a card number.
"""
from __future__ import annotations
import collections, copy, gzip, hashlib, json, re, urllib.parse
from pathlib import Path
import collect_konami as c

ROOT=Path(__file__).resolve().parent

def atomic_json(path,value,pretty=False):
    data=json.dumps(value,ensure_ascii=False,indent=2 if pretty else None,separators=None if pretty else (',',':')).encode()
    temporary=path.with_name(path.name+'.tmp');temporary.write_bytes(data);temporary.replace(path)
    return data

def export_snapshot(products=None,mappings=None,errors=None):
    products=products if products is not None else c.load_index()
    mappings=mappings if mappings is not None else json.loads((ROOT/'reviewed_box_mappings.json').read_text())
    errors=errors or []
    wanted={pid for mapping in mappings for pid in mapping['productIds']}
    parsed={p.stem:json.loads(p.read_text()) for p in (ROOT/'parsed_products').glob('*.json') if p.stem in wanted}
    targets={card['cardId'] for p in parsed.values() for card in p['cards']}
    details={p.stem:json.loads(p.read_text()) for p in (ROOT/'parsed_details').glob('*.json') if p.stem in targets}
    lookup=collections.defaultdict(list)
    for cid,detail in details.items():
        if not detail.get('complete') or detail.get('cardId')!=cid:raise ValueError('Invalid detail identity '+cid)
        for index,printing in enumerate(detail['printings']):
            if printing['cardId']!=cid:raise ValueError('Printing/detail CID mismatch')
            if printing['productId'] in wanted:lookup[(printing['productId'],cid)].append((index,printing,detail))
    crosswalk=json.loads((ROOT/'manufacturer_code_crosswalk.json').read_text())
    by_market=collections.defaultdict(list)
    for mapping in mappings:
        for pid in mapping['productIds']:by_market[pid].append(mapping['boxId'])
    output=[];gaps=[];mismatches=[];source_duplicates=[];old_artwork_mismatches=0
    for pid,p in sorted(parsed.items()):
        members=collections.defaultdict(list)
        for card in p['cards']:members[card['cardId']].append(card)
        native=[];product_gaps=[];code_set=set()
        for cid,member_variants in members.items():
            representative=member_variants[0]
            member_rids={card['rarityId'] or card['rarity'] for card in member_variants}
            rows=lookup.get((pid,cid),[])
            if not rows:
                product_gaps.append({'productId':pid,'cardId':cid,'reason':'No explicit official product printing rows','detailCollected':cid in details})
            detail_rids={row['rarityId'] or row['rarity'] for _,row,_ in rows}
            missing_rids=member_rids-detail_rids
            extra_rids=detail_rids-member_rids
            if rows and (missing_rids or extra_rids):
                mismatches.append({'productId':pid,'cardId':cid,'membershipOnlyRarities':sorted(missing_rids),'detailOnlyRarities':sorted(extra_rids)})
            seen={}
            for source_index,row,detail in rows:
                number=row['number'] or None
                key=(row['artworkId'],row['rarityId'] or row['rarity'],number)
                if key in seen:
                    seen[key]['sourcePrintingIndexes'].append(source_index)
                    source_duplicates.append({'productId':pid,'cardId':cid,'artworkId':key[0],'rarityId':row['rarityId'],'number':number,'sourcePrintingIndex':source_index})
                    continue
                rare=next((x for x in member_variants if (x['rarityId'] or x['rarity'])==(row['rarityId'] or row['rarity'])),representative)
                token=urllib.parse.quote(number,safe='-') if number else 'UNNUMBERED'
                card={**copy.deepcopy(rare),'id':f'KONAMI:{pid}:{cid}:{row["artworkId"]}:R{row["rarityId"] or row["rarity"]}:N{token}',
                      'artworkId':row['artworkId'],'artworkVerified':True,'membershipArtworkId':representative['artworkId'],
                      'membershipRarityIds':sorted(member_rids),'number':number,'printedNumber':number,
                      'rarity':row['rarity'],'rarityId':row['rarityId'],'rarityLabel':row['rarityLabel'],'variant':row['rarityLabel'],
                      'image':row['image'],'url':row['sourceUrl']+'&iid='+row['artworkId'],
                      'numberVerified':bool(number),'numberStatus':'verified' if number else 'not-listed-by-manufacturer',
                      'printingSourceUrl':row['sourceUrl'],'printedNumberSource':row['sourceUrl'],
                      'printingSourceSha256':detail['sourceSha256'],'printingFetchedAt':detail.get('fetchedAt'),
                      'sourcePrintingIndexes':[source_index]}
                if row['artworkId']!=representative['artworkId']:old_artwork_mismatches+=1
                native.append(card);seen[key]=card
                if number and re.fullmatch(r'[A-Z0-9]+-[A-Z]*\d+',number):code_set.add(number.split('-')[0])
            # Preserve genuinely unresolved manufacturer rarity rows explicitly.
            # These are placeholders, never presented as verified artworks.
            for rare in member_variants:
                rid=rare['rarityId'] or rare['rarity']
                if rid in detail_rids:continue
                card={**copy.deepcopy(rare),'id':rare['id']+':UNRESOLVED','artworkVerified':False,
                      'membershipArtworkId':rare['artworkId'],'number':None,'printedNumber':None,
                      'numberVerified':False,'numberStatus':'unavailable','printedNumberSource':'unavailable'}
                native.append(card)
                if rows:product_gaps.append({'productId':pid,'cardId':cid,'rarityId':rid,'reason':'Membership rarity absent from explicit detail rows','detailCollected':True})
        result={**copy.deepcopy(p),'cards':native,'marketBoxIds':by_market[pid],'isAggregate':False,'language':'ja',
                'expectedMemberCount':p['officialCardCount'],'membershipRarityRowCount':len(p['cards']),
                'expectedCardCount':len(native),'cardCount':len(native),'printingCount':len(native),
                'membershipComplete':p['complete'],'rarityComplete':p['complete'] and not product_gaps,
                'printingInventoryComplete':p['complete'] and not product_gaps,
                'numberLookupComplete':not product_gaps,
                'numberCompleteness':all(card['numberStatus'] in ('verified','not-listed-by-manufacturer') for card in native),
                'allPrintingsNumbered':all(card['numberVerified'] for card in native),
                'codes':sorted(code_set),'sourceCountMethod':'Official total unique card members; native artwork/rarity/number rows from per-card printing tables',
                'provenance':{'url':p['sourceUrl'],'method':'GET','status':200,'fetchedAt':p['fetchedAt'],'sha256':p['sourceSha256']}}
        if len(code_set)==1:
            result['code']=next(iter(code_set));result['codeSource']='official per-card printing number'
        else:
            candidates=[x for x in crosswalk if any(q['id']==pid for q in x['officialProducts']) and re.fullmatch('[A-Z0-9]+',x['code'])]
            codes={x['code'] for x in candidates}
            if len(codes)==1:
                result['code']=next(iter(codes));result['codeSource']='official manufacturer product page identifier';result['codeSourceUrls']=[x['manufacturerUrl'] for x in candidates]
        output.append(result);gaps.extend(product_gaps)
    flat=[card for p in output for card in p['cards']]
    legacy_path=ROOT/'legacy_printing_identities.json';legacy_report={'matched':0,'ambiguous':[],'unmatched':[]}
    if legacy_path.exists():
        old_identities=json.loads(legacy_path.read_text());native_by_tuple=collections.defaultdict(list)
        for product in output:
            for card in product['cards']:
                if card.get('artworkVerified'):native_by_tuple[(product['id'],card['cardId'],card['artworkId'],card['rarityId'] or card['rarity'])].append(card)
        for old in old_identities['rows']:
            candidates=native_by_tuple.get((old['productId'],old['cardId'],old['artworkId'],old['rarityId'] or old['rarity']),[])
            if old['verifiedNumber']:candidates=[card for card in candidates if card['number']==old['verifiedNumber']]
            if len(candidates)==1:
                candidates[0].setdefault('legacyIds',[]).append(old['id']);legacy_report['matched']+=1
            elif len(candidates)>1:legacy_report['ambiguous'].append({'id':old['id'],'candidateIds':[card['id'] for card in candidates]})
            else:legacy_report['unmatched'].append(old['id'])
        legacy_report['sourceSha256']=old_identities['sourceSha256']
    explicit_source_keys={(row['productId'],cid,row['artworkId'],row['rarityId'] or row['rarity'],row['number'] or None)
                          for cid,detail in details.items() for row in detail['printings'] if row['productId'] in wanted}
    def native_image_matches(card):
        if not (card.get('image') or '').startswith('https://www.db.yugioh-card.com/yugiohdb/get_image.action?'):return False
        query=urllib.parse.parse_qs(urllib.parse.urlsplit(card['image']).query)
        return query.get('cid')==[card['cardId']] and query.get('ciid')==[card['artworkId']]
    statuses=collections.Counter(card['numberStatus'] for card in flat)
    coverage={'navigationBoxes':len(mappings),'mappedNavigationBoxes':sum(bool(m['productIds']) for m in mappings),
              'collectedProducts':len(output),'completeProducts':sum(p['complete'] for p in output),
              'officialMemberRows':sum(p['memberCount'] for p in output),'membershipRarityRows':sum(p['membershipRarityRowCount'] for p in output),
              'printingRows':len(flat),'verifiedPrintedNumbers':statuses['verified'],'knownUnnumberedPrintings':statuses['not-listed-by-manufacturer'],
              'unresolvedPrintedNumbers':statuses['unavailable'],'detailCardsCollected':len(details),'uniqueTargetCids':len(targets),
              'printingInventoryCompleteProducts':sum(p['printingInventoryComplete'] for p in output),
              'numberCompleteProducts':sum(p['numberCompleteness'] for p in output),
              'nativeArtworkRows':sum(len({(card['cardId'],card['artworkId']) for card in p['cards'] if card.get('artworkVerified')}) for p in output),
              'legacyIdAliases':legacy_report['matched'],'ambiguousLegacyIds':len(legacy_report['ambiguous'])}
    result={'schemaVersion':2,'game':'yugioh','source':'KONAMI OCG Japanese card database','sourceUrl':c.INDEX,
            'fetchedAt':c.now(),'complete':not errors and len(output)==len(wanted) and all(p['complete'] for p in output),
            'indexProductCount':len(products),'expectedProducts':len(wanted),'expectedMarketBoxes':len(mappings),
            'products':output,'boxMappings':mappings,'incompleteMarketBoxes':[m for m in mappings if not m['productIds']],
            'navigationCoverageComplete':all(m['productIds'] for m in mappings),'coverage':coverage,'errors':errors,
            'printingInventoryComplete':not gaps and len(details)==len(targets),
            'numberCompleteness':not statuses['unavailable'] and not gaps,
            'allPrintingsNumbered':all(card['numberVerified'] for card in flat),
            'numberCompletenessDefinition':'Every printing has an explicit official number or an explicitly blank manufacturer number. Blank differs from unavailable.',
            'limits':['Official product totals count unique card members, not physical card copies or artwork variants.',
                      'Native printings use explicit product/CID/artwork/rarity/printed-number detail rows.',
                      'The product membership IID is a representative image and never limits the printing artwork inventory.',
                      'Blank official printing numbers remain null with not-listed-by-manufacturer status.',
                      'Future products absent from the official index remain pending. No printed number is inferred from row order.']}
    checks={'expected_products_match':len(output)==len(wanted),'all_source_totals_match':all(p['officialCardCount']==p['memberCount']==len({x['cardId'] for x in p['cards']}) for p in output),
            'unique_product_ids':len({p['id'] for p in output})==len(output),'unique_printing_ids':len({x['id'] for x in flat})==len(flat),
            'verified_numbers_have_source':all(x.get('printingSourceUrl') and x.get('printingSourceSha256') for x in flat if x['numberVerified']),
            'known_unnumbered_have_detail_source':all(x.get('printingSourceUrl') and not x['number'] for x in flat if x['numberStatus']=='not-listed-by-manufacturer'),
            'all_images_native_official':all((x.get('image') or '').startswith('https://www.db.yugioh-card.com/yugiohdb/get_image.action?') for x in flat),
            'all_verified_images_match_card_and_artwork':all(native_image_matches(x) for x in flat if x.get('artworkVerified')),
            'every_native_printing_has_exact_detail_tuple':all((p['id'],x['cardId'],x['artworkId'],x['rarityId'] or x['rarity'],x['number']) in explicit_source_keys for p in output for x in p['cards'] if x.get('artworkVerified')),
            'no_unmapped_market_assignment':all(p['marketBoxIds'] for p in output),'all_ids_japanese_ocg':all(p['kind']=='ocg' and p['language']=='ja' for p in output),
            'all_target_details_collected':len(details)==len(targets),'no_unresolved_printing_numbers':not statuses['unavailable'],'all_product_rarities_resolved':not gaps}
    raw_audit=json.loads((ROOT/'detail_raw_audit.json').read_text()) if (ROOT/'detail_raw_audit.json').exists() else {}
    checks['all_raw_sources_independently_audited']=bool(raw_audit.get('allAvailableSourcesPass') and raw_audit.get('allTargetsAvailable') and raw_audit.get('productFilesAudited')==len(wanted) and raw_audit.get('detailFilesAudited')==len(targets))
    aliases=[alias for card in flat for alias in card.get('legacyIds',[])]
    checks['legacy_aliases_are_unique']=len(aliases)==len(set(aliases))
    report={'coverage':coverage,'checks':checks,'codes':dict(collections.Counter(p.get('codeSource','unavailable') for p in output)),
            'numberStatus':dict(statuses),'printingGaps':gaps,'rarityMismatches':mismatches,'deduplicatedSourceRows':source_duplicates,
            'printingRowsWhoseActualArtworkDiffersFromMembershipRepresentative':old_artwork_mismatches,
            'futureUnmapped':[{'id':m['boxId'],'name':m['name']} for m in mappings if not m['productIds']],
            'outputs':{'integration':'yugioh.json','details':'official_printings.json','collector':'collect_all_details.py','nativeExporter':'export_complete.py'}}
    for name,value in [('validation_report.json',report),('coverage_report.json',{'coverage':coverage,'unmappedBoxes':result['incompleteMarketBoxes'],'errors':errors}),('verified_product_codes.json',{p['id']:p['codes'] for p in output if p['codes']}),('legacy_alias_report.json',legacy_report)]:atomic_json(ROOT/name,value,True)
    atomic_json(ROOT/'official_printings.json',{'source':result['source'],'cards':[details[cid] for cid in sorted(details,key=int)]})
    data=atomic_json(ROOT/'yugioh.json',result)
    compressed=ROOT/'yugioh.json.gz.tmp';compressed.write_bytes(gzip.compress(data,compresslevel=9,mtime=0));compressed.replace(ROOT/'yugioh.json.gz')
    atomic_json(ROOT/'snapshot_manifest.json',{'createdAt':c.now(),'integrationSha256':hashlib.sha256(data).hexdigest(),'gzipSha256':hashlib.sha256((ROOT/'yugioh.json.gz').read_bytes()).hexdigest(),'coverage':coverage,'allValidationChecksPass':all(checks.values())},True)
    print(json.dumps({'coverage':coverage,'checks':checks},ensure_ascii=False),flush=True)
    return result

if __name__=='__main__':export_snapshot()
