"""Independent read-only verification of saved price-index outputs.
No import from the builder. Reconstructs source records and normal equations.
Only an optional verification artifact is written; source/index files stay intact.
"""
from __future__ import annotations
import argparse, hashlib, json, math, re, statistics, tempfile, unittest
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
BRANDS=('pokemon','onepiece')
GRADES=('raw','psa10')
FOREIGN=re.compile(r'\[(?:EN|ENG|KR|KOR|KO|ZH|CN|CHN|SC|TC|CH|TW|TWN|FR|FRA|DE|GER|IT|ITA|ES|SPA|PT|POR|TH|THA|ID|IND|VI|VIE)\]|\b(?:English|Korean|Chinese|French|German|Italian|Spanish|Portuguese|Thai|Indonesian|Vietnamese)\s+(?:Ver(?:sion)?\.?|Edition)\b|(?:英語版|韓国語版|中国語版)',re.I)
FOREIGN_LANG={'en','eng','english','英語','英語版','ko','kr','kor','korean','韓国語','韓国語版','zh','cn','chn','tw','twn','chinese','中国語','中国語版','fr','french','de','german','it','italian','es','spanish','pt','portuguese','th','thai','id','indonesian','vi','vietnamese'}
KINDS={'card','single','single-card','single_card','single card'}
JST=timezone(timedelta(hours=9))
LIVE_PATH='data/market-price-index-live-history.json'

def check(ok,message):
    if not ok: raise AssertionError(message)

def verify_live_scope(overlay,admitted):
    records=overlay.get('records');declared=overlay.get('scopeSummary')
    check(isinstance(records,list) and isinstance(declared,dict),'Invalid live scope summary')
    check(all(isinstance(r,dict) for r in records),'Invalid live condition record')
    keys=[(str(r.get('id')),r.get('grade')) for r in records]
    check(len(keys)==len(set(keys)),'Live scope repeats product-condition pairs')
    actual={'attemptedProducts':len({key[0] for key in keys}),'attemptedConditions':len(records),
        'succeededConditions':sum(r.get('status')=='ok' for r in records),
        'failedConditions':sum(r.get('status')=='failed' for r in records),
        'emptyConditions':sum(r.get('status')=='ok' and isinstance(r.get('history'),list) and not r['history'] for r in records)}
    check(actual['succeededConditions']+actual['failedConditions']==len(records),'Invalid live status')
    for key,value in actual.items():
        if key in declared:check(type(declared[key]) is int and declared[key]==value,'Live declared count differs: '+key)
    check(type(declared.get('complete')) is bool,'Invalid live completeness flag')
    if declared['complete']:
        expected={(cid,grade) for cid in admitted for grade in GRADES}
        check(set(keys)==expected and actual['failedConditions']==0,'Live complete scope missing expected conditions')
        check(all(key in declared for key in actual),'Live complete declared counts missing')
    return actual

def read_sources(root,as_of,overlay_path=None):
    catalog=json.loads((root/'data/cards-meta.json').read_text(encoding='utf-8'))
    groups=defaultdict(list)
    for c in catalog['cards']:groups[str(c['id'])].append(c)
    prices={};admitted={}
    for cid,cards in groups.items():
        if len(cards)!=1:continue
        c=cards[0]
        if c.get('brand') not in BRANDS or str(c.get('kind','')).lower() not in KINDS:continue
        if FOREIGN.search(str(c.get('name',''))):continue
        if any(str(c.get(k,'')).lower().replace('_','-').split('-')[0] in FOREIGN_LANG for k in ('language','cardLanguage','editionLanguage')):continue
        admitted[cid]=c
        path=root/'data/history'/f'{cid}.json'
        if not path.exists():continue
        h=json.loads(path.read_text(encoding='utf-8'));source=str(h.get('source',''))
        if not source.startswith(('backfill v2','card history v3 (grade chart + complete sales pages)')):continue
        if str(h.get('id'))!=cid or h.get('currency','JPY')!='JPY':continue
        legacy=source.startswith('backfill v2') and h.get('historyTimezone')!='Asia/Tokyo'
        values={g:{} for g in GRADES};conflicts={g:set() for g in GRADES}
        for row in h.get('history',[]):
            if not isinstance(row,dict) or row.get('currency','JPY')!='JPY':continue
            text=row.get('date')
            if not isinstance(text,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',text):continue
            try:d=date.fromisoformat(text)+timedelta(days=int(legacy))
            except (ValueError,OverflowError):continue
            if d>as_of:continue
            for g in GRADES:
                p=row.get(g+'_price')
                if type(p) not in (int,float) or not math.isfinite(p) or p<=0 or d in conflicts[g]:continue
                if d in values[g] and values[g][d]!=p:
                    values[g].pop(d);conflicts[g].add(d)
                else:values[g][d]=float(p)
        if any(values.values()):prices[cid]={'brand':c['brand'],'values':values}
    selected_path=Path(LIVE_PATH if overlay_path is None else overlay_path)
    if not selected_path.is_absolute():selected_path=root/selected_path
    selected_path=selected_path.resolve()
    check(selected_path.is_relative_to(root.resolve()),'Live chart source path escapes workspace')
    if overlay_path is not None:check(selected_path.is_file(),'Selected live chart source is missing')
    if selected_path.exists():
        overlay=json.loads(selected_path.read_text(encoding='utf-8'))
        check(all(overlay.get(k)==v for k,v in {'schemaVersion':1,'reportKind':'market-price-index-live-history','source':'SNKRDUNK','currency':'JPY','timezone':'Asia/Tokyo'}.items()),'Invalid live chart source contract')
        check(overlay.get('targetFingerprint')==hashlib.sha256((root/'data/cards-meta.json').read_bytes()).hexdigest(),'Live chart catalog differs')
        check(overlay.get('grades')==list(GRADES),'Live chart grade scope differs')
        verify_live_scope(overlay,admitted)
        seen=set()
        for record in overlay['records']:
            cid=str(record.get('id'));grade=record.get('grade');key=(cid,grade)
            check(grade in GRADES and record.get('conditionCode')=={'raw':18,'psa10':22}[grade],'Live chart grade code differs')
            check(key not in seen,'Duplicate live chart condition');seen.add(key)
            if record.get('status')=='failed':continue
            check(record.get('status')=='ok','Invalid live chart status')
            if cid not in admitted:continue
            check(record.get('brand')==admitted[cid]['brand'],'Live chart brand differs')
            check(record.get('range')=='all','Invalid live chart range')
            values={};conflicts=set()
            for row in record.get('history',[]):
                if not isinstance(row,dict):continue
                text=row.get('date');amount=row.get('price');stamp=row.get('sourceTimestampMs')
                if not isinstance(text,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',text):continue
                try:
                    d=date.fromisoformat(text)
                    if type(stamp) not in (int,float) or not math.isfinite(stamp):continue
                    timestamp_day=datetime.fromtimestamp(stamp/1000,timezone.utc).astimezone(JST).date()
                    if timestamp_day!=d:continue
                except (ValueError,OverflowError,OSError):continue
                if d>as_of or type(amount) not in (int,float) or not math.isfinite(amount) or amount<=0 or d in conflicts:continue
                if d in values and values[d]!=amount:values.pop(d);conflicts.add(d)
                else:values[d]=float(amount)
            if values:
                x=prices.setdefault(cid,{'brand':admitted[cid]['brand'],'values':{}})
                x['values'].setdefault(grade,{}).update(values)
    return prices

def panel(prices,brand,frequency,as_of):
    histories={}
    for cid,x in prices.items():
        if x['brand']!=brand:continue
        for grade,days in x['values'].items():
            if frequency=='weekly':
                weeks=defaultdict(list)
                for d,p in days.items():
                    end=d+timedelta(days=6-d.weekday())
                    if end<=as_of:weeks[end].append(math.log(p))
                days={end:math.exp(math.fsum(logs)/len(logs)) for end,logs in weeks.items()}
            if len(days)>=2:histories[cid+':'+grade]=days
    return histories

def verify_fit(series,histories):
    effects=series['conditionEffects'];points={date.fromisoformat(p['date']):p for p in series['points']}
    base=date.fromisoformat(series['baseDate'])
    check(points[base]['value']==100,'Base index is not 100')
    # Discover the base-linked observation graph independently.
    parent={}
    def find(x):
        parent.setdefault(x,x)
        if parent[x]!=x:parent[x]=find(parent[x])
        return parent[x]
    def union(a,b):
        a,b=find(a),find(b)
        if a!=b:parent[b]=a
    for days in histories.values():
        keys=list(days);first=keys[0]
        for d in keys:union(first,d)
    comp=find(base)
    expected={item:h for item,h in histories.items() if find(next(iter(h)))==comp}
    check(set(effects)==set(expected),'Included repeated conditions differ from independent raw scope')
    available=Counter((item.split(':')[0],d) for item,h in expected.items() for d in h)
    grad_item=defaultdict(float);grad_date=defaultdict(float)
    rhs_item=defaultdict(float);rhs_date=defaultdict(float)
    n=0;sum_sq=weight_sum=0.0
    by_date=defaultdict(lambda:defaultdict(dict))
    for item,h in expected.items():
        cid,grade=item.split(':')
        for d,p in h.items():
            point=points[d]
            check(point['logIndex'] is not None,'Connected observed date unexpectedly missing')
            check(abs(point['value']-100*math.exp(point['logIndex']))<5.1e-8,'Index is not exp(date coefficient)')
            w=1/available[(cid,d)];y=math.log(p)
            residual=effects[item]+point['logIndex']-y
            grad_item[item]+=w*residual;rhs_item[item]+=w*y
            if d!=base:grad_date[d]+=w*residual;rhs_date[d]+=w*y
            sum_sq+=w*residual*residual;weight_sum+=w;n+=1
            by_date[d][cid][grade]=p
    gs=list(grad_item.values())+list(grad_date.values())
    rhs=list(rhs_item.values())+list(rhs_date.values())
    score=math.sqrt(math.fsum(g*g for g in gs))/max(1,math.sqrt(math.fsum(y*y for y in rhs)))
    check(score<1e-10,'Fitted coefficients do not solve the independently reconstructed least squares equations')
    check(n==series['diagnostics']['fittedObservations'],'Observation count mismatch')
    check(abs(math.sqrt(sum_sq/weight_sum)-series['diagnostics']['weightedLogRMSE'])<1e-9,'Weighted residual mismatch')
    stride=timedelta(days=7 if any('weeklyReturn' in p for p in points.values()) else 1)
    breadth_checked=0
    for d,p in points.items():
        prev=points.get(d-stride)
        key='weeklyReturn' if stride.days==7 else 'dailyReturn'
        expected_return=math.expm1(p['logIndex']-prev['logIndex'])*100 if prev and p['logIndex'] is not None and prev['logIndex'] is not None else None
        check((p.get(key) is None)==(expected_return is None),'Missing return replaced or valid return removed')
        if expected_return is not None:check(abs(p[key]-expected_return)<5.1e-8,'Return differs from shared index endpoints')
        current=by_date.get(d,{});before=by_date.get(d-stride,{})
        up=down=flat=matched=conds=0
        for cid,grades in current.items():
            changes=[math.log(v)-math.log(before[cid][g]) for g,v in grades.items() if cid in before and g in before[cid]]
            if not changes:continue
            matched+=1;conds+=len(changes);change=math.fsum(changes)/len(changes)
            if abs(change)<1e-12:flat+=1
            elif change>0:up+=1
            else:down+=1
        for k,v in {'up':up,'down':down,'flat':flat,'matchedProducts':matched,'matchedConditions':conds,'observedProducts':len(current),'observedConditions':sum(len(g) for g in current.values())}.items():
            check(p[k]==v,f'Independent breadth differs at {d}: {k}')
        check(p['upRatio']==(up/matched if matched else None),'Breadth without a real denominator')
        breadth_checked+=1
    return {'fittedObservations':n,'fittedProducts':len({i.split(':')[0] for i in expected}),'fittedConditions':len(expected),'normalEquationRelativeResidual':score,'weightedLogRMSE':math.sqrt(sum_sq/weight_sum),'datesChecked':breadth_checked}

def select_overlay(root,payload,requested=None):
    """Use the declared immutable source, never silently fall back after an explicit selection."""
    collection=payload.get('sourceSummary',{}).get('liveCollection') or {}
    declared=collection.get('sourcePath')
    if declared is not None:check(isinstance(declared,str) and bool(declared),'Invalid declared live source path')
    selected=requested if requested is not None else declared if declared is not None else LIVE_PATH
    path=Path(selected)
    if not path.is_absolute():path=root/path
    path=path.resolve();check(path.is_relative_to(root.resolve()),'Selected live source escapes workspace')
    relative=path.relative_to(root.resolve()).as_posix()
    if declared is not None:
        bound=Path(declared)
        if not bound.is_absolute():bound=root/bound
        check(path==bound.resolve(),'CLI live source differs from the payload source')
    if declared is not None or requested is not None:check(path.is_file(),'Selected live source does not exist')
    if path.exists():
        fingerprints=payload.get('inputFingerprints',{})
        check(relative in fingerprints,'Selected live source is not bound to input fingerprints')
        sha=hashlib.sha256(path.read_bytes()).hexdigest()
        check(fingerprints[relative]==sha,'Selected live source fingerprint differs')
        if collection.get('sourceSha256') is not None:check(collection['sourceSha256']==sha,'Live source summary fingerprint differs')
    return path


def observed_window_median(history,period_end):
    start=period_end-timedelta(days=29)
    values=[float(p) for day,p in history.items()
            if isinstance(day,date) and start<=day<=period_end
            and type(p) in (int,float) and math.isfinite(p) and p>0]
    return statistics.median(values) if values else None


def reconstruct_price_comparison(prices,brand,baseline_end,recent_end):
    """All starting conditions must reappear; no carry, replacement grade or zero return."""
    original=original_conditions=compared_conditions=0;relatives=[]
    for product in prices.values():
        if product['brand']!=brand:continue
        baselines={grade:observed_window_median(product['values'].get(grade,{}),baseline_end)
                   for grade in GRADES}
        baselines={grade:value for grade,value in baselines.items() if value is not None}
        if not baselines:continue
        original+=1;original_conditions+=len(baselines)
        current={grade:observed_window_median(product['values'].get(grade,{}),recent_end)
                 for grade in baselines}
        if any(value is None for value in current.values()):continue
        ratios=[current[grade]/value for grade,value in baselines.items()]
        if any(not math.isfinite(ratio) or ratio<=0 for ratio in ratios):continue
        relative=math.fsum(ratios)/len(ratios)
        if math.isclose(relative,1,abs_tol=1e-12,rel_tol=0):relative=1.0
        relatives.append(relative);compared_conditions+=len(baselines)
    count=len(relatives)
    bins=dict.fromkeys(('below1','oneTo2','twoTo5','fiveTo10','tenTo20','twentyOrMore'),0)
    for ratio in relatives:
        key=('below1' if ratio<1 else 'oneTo2' if ratio<2 else 'twoTo5' if ratio<5
             else 'fiveTo10' if ratio<10 else 'tenTo20' if ratio<20 else 'twentyOrMore')
        bins[key]+=1
    return {
        'windows':{'baseline':{'start':(baseline_end-timedelta(days=29)).isoformat(),'end':baseline_end.isoformat()},
                   'recent':{'start':(recent_end-timedelta(days=29)).isoformat(),'end':recent_end.isoformat()}},
        'originalProducts':original,'originalConditions':original_conditions,
        'comparedProducts':count,'comparedConditions':compared_conditions,'excludedProducts':original-count,
        'coveragePct':count/original*100 if original else None,
        'arithmeticMultiple':math.fsum(relatives)/count if count else None,
        'medianMultiple':statistics.median(relatives) if count else None,
        'geometricMultiple':math.exp(math.fsum(math.log(x) for x in relatives)/count) if count else None,
        'up':sum(x>1 for x in relatives),'down':sum(x<1 for x in relatives),'flat':sum(x==1 for x in relatives),
        'belowHalfCount':sum(x<.5 for x in relatives),'bins':bins,
    }


def compare_evidence(actual,expected,path):
    if isinstance(expected,dict):
        check(isinstance(actual,dict),'Missing evidence object: '+path)
        for key,value in expected.items():
            check(key in actual,'Missing evidence field: '+path+'.'+key)
            compare_evidence(actual[key],value,path+'.'+key)
    elif type(expected) is float:
        check(type(actual) in (int,float) and math.isfinite(actual)
              and math.isclose(actual,expected,rel_tol=1e-12,abs_tol=1e-10),'Independent evidence value differs: '+path)
    else:
        check(type(actual) is type(expected) and actual==expected,'Independent evidence field differs: '+path)


def reconstruct_index_path(series,source_day):
    base_date=date(2024,1,1)
    points=sorted((p for p in series['points'] if p['date']>=base_date.isoformat()
                   and p['date']<=source_day.isoformat() and type(p.get('value')) in (int,float)
                   and math.isfinite(p['value']) and p['value']>0),key=lambda p:p['date'])
    check(bool(points),'No observed model points for evidence path')
    base=next((p for p in points if p['date']==base_date.isoformat()),None)
    check(base is not None,'Model evidence baseline is missing')
    peak=max(points,key=lambda p:p['value']);current=points[-1]
    def item(point):return {key:point[key] for key in ('date','value','observedProducts','observedConditions','provisional')}
    return {'base':{'date':base['date'],'value':base['value']},'peak':item(peak),'current':item(current),
            'drawdownPct':(current['value']/peak['value']-1)*100,
            'sinceBasePct':(current['value']/base['value']-1)*100,'peakPeriod':'since-2024-base'}


def verify_price_evidence(payload,prices,validation):
    method=payload.get('priceEvidenceMethodology')
    check(isinstance(method,dict),'Price evidence methodology missing')
    contract={'id':'same-product-fixed-baseline-condition-30day-median-price-relative-v1','windowDays':30,
              'fullFixedBasketPerformance':False,'representativeMarketPerformance':False,
              'carryDays':0,'historicalRevisions':True}
    compare_evidence(method,contract,'priceEvidenceMethodology')
    check(validation.get('priceEvidenceMethodId')==contract['id'],'Evidence/data method differs')
    reported_checks=validation.get('priceEvidenceChecks')
    check(isinstance(reported_checks,list),'Evidence validation checks missing')
    expected_ids={f'price-evidence-{brand}-{kind}' for brand in BRANDS
                  for kind in ('baseline','peakComparison','indexPath')}
    check(len(reported_checks)==6 and {c.get('id') for c in reported_checks if isinstance(c,dict)}==expected_ids
          and all(c.get('passed') is True for c in reported_checks),'Evidence validation checks incomplete')
    check(isinstance(payload.get('priceEvidence'),dict) and set(payload['priceEvidence'])==set(BRANDS),'Evidence brand scope differs')
    source_day=date.fromisoformat(payload['sourceAsOf']);result={}
    for brand in BRANDS:
        path=reconstruct_index_path(payload['series'][brand],source_day)
        expected={'baseline':reconstruct_price_comparison(prices,brand,date(2024,1,1),source_day),
                  'peakComparison':reconstruct_price_comparison(prices,brand,date.fromisoformat(path['peak']['date']),source_day),
                  'indexPath':path}
        compare_evidence(payload['priceEvidence'][brand],expected,'priceEvidence.'+brand)
        result[brand]=expected
    return result


class EvidenceTests(unittest.TestCase):
    start=date(2024,1,1);end=date(2026,10,10)

    def product(self,raw=None,psa=None,brand='pokemon'):
        return {'brand':brand,'values':{'raw':raw or {},'psa10':psa or {}}}

    def compare(self,prices):return reconstruct_price_comparison(prices,'pokemon',self.start,self.end)

    def test_same_product_conditions_share_one_initial_product_weight(self):
        prices={'two':self.product({self.start:100,self.end:200},{self.start:10000,self.end:5000}),
                'one':self.product({self.start:50,self.end:100})}
        result=self.compare(prices)
        self.assertEqual(result['comparedProducts'],2);self.assertEqual(result['comparedConditions'],3)
        self.assertEqual(result['arithmeticMultiple'],1.625)
        self.assertAlmostEqual(result['geometricMultiple'],math.sqrt(2.5))

    def test_a_new_recent_condition_does_not_change_the_starting_condition_mix(self):
        result=self.compare({'a':self.product({self.start:100,self.end:200},{self.end:999999})})
        self.assertEqual(result['originalConditions'],1);self.assertEqual(result['comparedConditions'],1)
        self.assertEqual(result['arithmeticMultiple'],2)

    def test_missing_one_starting_condition_excludes_the_entire_product(self):
        result=self.compare({'a':self.product({self.start:100,self.end:200},{self.start:10000})})
        self.assertEqual(result['originalProducts'],1);self.assertEqual(result['originalConditions'],2)
        self.assertEqual(result['excludedProducts'],1);self.assertEqual(result['comparedConditions'],0)
        self.assertIsNone(result['arithmeticMultiple']);self.assertEqual(sum(result['bins'].values()),0)

    def test_raw_cannot_be_replaced_by_a_psa_price_and_other_brands_are_excluded(self):
        result=self.compare({'a':self.product({self.start:100},{self.end:200}),
                             'other':self.product({self.start:100,self.end:10000},brand='onepiece')})
        self.assertEqual(result['originalProducts'],1);self.assertEqual(result['comparedProducts'],0)

    def test_actual_window_median_and_inclusive_thirtieth_day(self):
        history={self.start-timedelta(days=30):999999,self.start-timedelta(days=29):10,
                 self.start-timedelta(days=1):20,self.start:100,self.start+timedelta(days=1):999999}
        self.assertEqual(observed_window_median(history,self.start),20)
        result=self.compare({'a':self.product({**history,self.end:40})})
        self.assertEqual(result['arithmeticMultiple'],2)

    def test_zero_negative_nonfinite_and_boolean_prices_never_enter_the_median(self):
        values=(0,-10,float('nan'),float('inf'),True,'100')
        history={self.start-timedelta(days=i):p for i,p in enumerate(values)}
        self.assertIsNone(observed_window_median(history,self.start))
        history[self.start-timedelta(days=10)]=100
        self.assertEqual(observed_window_median(history,self.start),100)

    def test_no_carry_or_future_price_can_replace_an_empty_recent_window(self):
        result=self.compare({'a':self.product({self.start:100,self.end-timedelta(days=30):200,
                                               self.end+timedelta(days=1):300})})
        self.assertEqual(result['originalProducts'],1);self.assertEqual(result['comparedProducts'],0)
        self.assertIsNone(result['medianMultiple']);self.assertIsNone(result['geometricMultiple'])
        self.assertEqual(result['coveragePct'],0)

    def test_empty_comparison_has_no_fabricated_zero_or_one_multiple(self):
        result=self.compare({})
        self.assertEqual(result['originalProducts'],0);self.assertIsNone(result['coveragePct'])
        for key in ('arithmeticMultiple','medianMultiple','geometricMultiple'):self.assertIsNone(result[key])
        self.assertEqual(result['flat'],0)

    def test_bin_boundaries_and_flat_tolerance_are_applied_to_product_relatives(self):
        ratios=(.49,.5,1,2,5,10,20,1+5e-13)
        result=self.compare({str(i):self.product({self.start:100,self.end:r*100}) for i,r in enumerate(ratios)})
        self.assertEqual(result['bins'],{'below1':2,'oneTo2':2,'twoTo5':1,'fiveTo10':1,'tenTo20':1,'twentyOrMore':1})
        self.assertEqual((result['up'],result['down'],result['flat']),(4,2,2))
        self.assertEqual(result['belowHalfCount'],1)

    def test_model_path_uses_since_base_peak_earliest_tie_and_observed_current(self):
        def point(day,value):return {'date':day,'value':value,'observedProducts':3,'observedConditions':4,'provisional':False}
        series={'points':[point('2023-12-31',999),point('2024-01-01',100),point('2024-01-02',200),
                          point('2024-01-03',200),point('2024-01-04',150),point('2024-01-05',None),point('2024-01-06',999)]}
        result=reconstruct_index_path(series,date(2024,1,5))
        self.assertEqual(result['peak']['date'],'2024-01-02');self.assertEqual(result['current']['date'],'2024-01-04')
        self.assertEqual(result['drawdownPct'],-25);self.assertEqual(result['sinceBasePct'],50)

    def test_comparison_detects_missing_fields_counts_bins_and_nonfinite_numbers(self):
        expected=self.compare({'a':self.product({self.start:100,self.end:200})})
        for change in ({'comparedProducts':True},{'comparedProducts':2},{'arithmeticMultiple':float('nan')},
                       {'bins':{**expected['bins'],'twoTo5':0}}):
            changed={**expected,**change}
            with self.assertRaises(AssertionError):compare_evidence(changed,expected,'fixture')
        changed=dict(expected);changed.pop('excludedProducts')
        with self.assertRaises(AssertionError):compare_evidence(changed,expected,'fixture')

    def test_selected_overlay_is_fingerprint_bound_and_cannot_fall_back(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'data').mkdir()
            old=root/LIVE_PATH;old.write_text('{}',encoding='utf-8')
            selected=root/'data/new-live-history.json';selected.write_text('{"new":true}',encoding='utf-8')
            relative=selected.relative_to(root).as_posix();sha=hashlib.sha256(selected.read_bytes()).hexdigest()
            payload={'sourceSummary':{'liveCollection':{'sourcePath':relative,'sourceSha256':sha}},'inputFingerprints':{relative:sha}}
            self.assertEqual(select_overlay(root,payload),selected.resolve())
            self.assertEqual(select_overlay(root,payload,Path(relative)),selected.resolve())
            with self.assertRaises(AssertionError):select_overlay(root,payload,LIVE_PATH)
            selected.unlink()
            with self.assertRaises(AssertionError):select_overlay(root,payload)
            with self.assertRaises(AssertionError):select_overlay(root,payload,'../outside.json')

    def test_old_alias_remains_the_default_but_still_requires_its_fingerprint(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);(root/'data').mkdir();old=root/LIVE_PATH;old.write_text('{}',encoding='utf-8')
            payload={'inputFingerprints':{LIVE_PATH:hashlib.sha256(old.read_bytes()).hexdigest()}}
            self.assertEqual(select_overlay(root,payload),old.resolve())
            payload['inputFingerprints'][LIVE_PATH]='0'*64
            with self.assertRaises(AssertionError):select_overlay(root,payload)

    def source_fixture(self,root,rows,code=18):
        (root/'data').mkdir();catalog={'cards':[{'id':'1','brand':'pokemon','kind':'card','name':'Japanese candidate'}]}
        raw=json.dumps(catalog).encode();(root/'data/cards-meta.json').write_bytes(raw)
        overlay={'schemaVersion':1,'reportKind':'market-price-index-live-history','source':'SNKRDUNK',
                 'currency':'JPY','timezone':'Asia/Tokyo','grades':list(GRADES),'targetFingerprint':hashlib.sha256(raw).hexdigest(),
                 'scopeSummary':{'complete':False},'records':[{'id':'1','brand':'pokemon','grade':'raw','conditionCode':code,
                   'range':'all','status':'ok','history':rows}]}
        path=root/'data/selected.json';path.write_text(json.dumps(overlay),encoding='utf-8');return path

    def test_raw_loader_reads_the_explicit_overlay_and_discards_conflicting_dates(self):
        stamp=datetime(2026,10,10,tzinfo=JST).timestamp()*1000
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);path=self.source_fixture(root,[{'date':'2026-10-10','price':200,'sourceTimestampMs':stamp}])
            self.assertEqual(read_sources(root,self.end,path)['1']['values']['raw'][self.end],200)
            payload=json.loads(path.read_text());payload['records'][0]['history'].append({'date':'2026-10-10','price':300,'sourceTimestampMs':stamp})
            path.write_text(json.dumps(payload),encoding='utf-8')
            self.assertEqual(read_sources(root,self.end,path),{})

    def test_raw_loader_rejects_a_condition_code_for_another_grade(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder);path=self.source_fixture(root,[],22)
            with self.assertRaises(AssertionError):read_sources(root,self.end,path)


def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--root',type=Path,default=ROOT);ap.add_argument('--output',type=Path)
    ap.add_argument('--live-overlay',type=Path,help='Explicit live source; must match the source declared by the payload')
    ap.add_argument('--self-test',action='store_true',help='Run independent evidence and source-selection fixtures only')
    args=ap.parse_args()
    if args.self_test:
        result=unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(EvidenceTests))
        check(result.wasSuccessful(),'Independent evidence fixture tests failed')
        print(json.dumps({'status':'passed','unitTests':result.testsRun,'marketReady':False}))
        return
    raw=(args.root/'data/market-price-index.json').read_bytes();payload=json.loads(raw)
    validation=json.loads((args.root/'data/market-price-index-validation.json').read_text(encoding='utf-8'))
    check(validation['dataSha256']==hashlib.sha256(raw).hexdigest(),'Data/report mismatch')
    check(validation['status']=='passed' and validation['marketReady'] is False,'Wrong approval contract')
    check(payload['strictFlags']==validation['strictFlags'] and not any(payload['strictFlags'].values()),'Unverified source promoted to certified market data')
    check(validation['inputFingerprints']==payload['inputFingerprints'],'Different input fingerprints')
    for name,sha in payload['inputFingerprints'].items():
        path=(args.root/name).resolve();check(path.is_relative_to(args.root.resolve()),'Input path escapes workspace')
        check(hashlib.sha256(path.read_bytes()).hexdigest()==sha,'Source changed: '+name)
    live_source=select_overlay(args.root,payload,args.live_overlay)
    source_day=date.fromisoformat(payload['sourceAsOf'])
    prices=read_sources(args.root,source_day,live_source if live_source.exists() else None)
    current_day=date.fromisoformat(payload.get('currentJSTDate',payload['sourceAsOf']))
    complete_through=min(source_day,current_day-timedelta(days=1))
    check(source_day<=current_day,'Source includes future prices')
    if 'todayIncomplete' in payload:
        check(payload['todayIncomplete']==(source_day==current_day),'Provisional source date flag mismatch')
        check(validation.get('todayIncomplete')==payload['todayIncomplete'],'Provisional data/report flags differ')
        expected_week_end=complete_through-timedelta(days=(complete_through.weekday()+1)%7)
        check(payload.get('latestCompleteWeekEnd')==expected_week_end.isoformat(),'Incomplete current week included')
    output={'status':'passed','dataSha256':hashlib.sha256(raw).hexdigest(),'sourceAsOf':payload['sourceAsOf'],'sourceFingerprintsChecked':len(payload['inputFingerprints']),'calculationOnly':True,'marketReady':False,'fits':{}}
    for frequency,key in [('daily','series'),('weekly','weeklySeries')]:
        if key not in payload:continue
        for b,s in payload[key].items():
            output['fits'][frequency+':'+b]=verify_fit(s,panel(prices,b,frequency,complete_through if frequency=='weekly' else source_day))
    check('weeklySeries' in payload,'Weekly series not generated')
    if 'currentJSTDate' in payload:
        for s in payload['series'].values():
            for p in s['points']:check(p.get('provisional')==(p['date']==payload['currentJSTDate']),'Current-day point provisional flag mismatch')
    output['liveSourcePath']=live_source.relative_to(args.root.resolve()).as_posix() if live_source.exists() else None
    evidence_declared=any(key in payload for key in ('priceEvidence','priceEvidenceMethodology')) or 'priceEvidenceMethodId' in validation
    output['priceEvidenceVerified']=evidence_declared
    if evidence_declared:output['priceEvidence']=verify_price_evidence(payload,prices,validation)
    if args.output:
        args.output.parent.mkdir(parents=True,exist_ok=True)
        args.output.write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps(output,ensure_ascii=False))
if __name__=='__main__':main()
