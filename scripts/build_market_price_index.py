"""Build a retrospective SNKRDUNK recorded-price TPD reference index.

Offline only. Price amounts, edition language, representativeness and model
uncertainty are not certified. No stale-price carry, monthly membership gate,
return chaining or trade-frequency/expenditure weights are used.
"""
from __future__ import annotations
import argparse, hashlib, json, math, re, statistics
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
import numpy as np
from scipy.sparse import coo_matrix
from scipy.sparse.linalg import lsqr

ROOT = Path(__file__).resolve().parent.parent
BRANDS = ('pokemon', 'onepiece')
GRADES = ('raw', 'psa10')
BASE_DATE = date(2024, 1, 1)
BASE_VALUE = 100.0
JST = timezone(timedelta(hours=9))
ALLOWED_SOURCES = ('backfill v2', 'card history v3 (grade chart + complete sales pages)')
STRICT_FLAGS = {'priceUnitVerified': False, 'languageVerified': False,
                'representativeMarketIndex': False, 'statisticalConfidenceValidated': False}
FOREIGN_NAME = re.compile(
    r'\[(?:EN|ENG|KR|KOR|KO|ZH|CN|CHN|SC|TC|CH|TW|TWN|FR|FRA|DE|GER|IT|ITA|ES|SPA|PT|POR|TH|THA|ID|IND|VI|VIE)\]|'
    r'\b(?:English|Korean|Chinese|French|German|Italian|Spanish|Portuguese|Thai|Indonesian|Vietnamese)\s+(?:Ver(?:sion)?\.?|Edition)\b|'
    r'(?:英語版|韓国語版|中国語版)', re.I)
FOREIGN_LANGUAGES = {'en','eng','english','英語','英語版','ko','kr','kor','korean','韓国語','韓国語版','zh','cn','chn','tw','twn','chinese','中国語','中国語版','fr','french','de','german','it','italian','es','spanish','pt','portuguese','th','thai','id','indonesian','vi','vietnamese'}
SINGLE_KINDS = {'card','single','single-card','single_card','single card'}
LIVE_OVERLAY_PATH = 'data/market-price-index-live-history.json'
LIVE_CONDITION_CODES = {'raw':18,'psa10':22}
METHOD = {
    'id': 'retrospective-pooled-product-condition-tpd-v1',
    'name': '관측가격 모형 지수',
    'formula': 'log(recorded_amount_product_condition_date) = condition_fixed_effect + date_effect + residual',
    'fittingWindow': 'all-saved-observation-dates; same fit for every UI period',
    'weighting': 'equal-observed-product-per-date; equal-available-repeated-condition-within-product-date',
    'conditionControls': list(GRADES), 'observationsOnly': True,
    'missingPricePolicy': 'not imputed; date effect is estimated from connected observed records',
    'noRecordedPricesDatePolicy': 'null', 'carryDays': 0,
    'membershipGate': None, 'maximumProducts': None, 'quantityWeights': False,
    'minimumConditionDates': 2, 'minimumConditionDatesRole': 'identifiability-only',
    'historicalRevisions': True, 'retrospective': True,
    'statisticalConfidenceValidated': False, 'fixedBasket': False,
    'baseDate': BASE_DATE.isoformat(), 'baseValue': BASE_VALUE,
}
SOURCES = [
    {'title': 'ONS: New index number methods in consumer price statistics', 'url': 'https://www.ons.gov.uk/economy/inflationandpriceindices/articles/newindexnumbermethodsinconsumerpricestatistics/2020-09-01'},
    {'title': 'UN-CEBD: Multilateral price index methods', 'url': 'https://millenniumindicators.un.org/wiki/spaces/GWGSD/pages/240910489/Multilateral%2Bprice%2Bindex%2Bmethods'},
]

def digest(raw): return hashlib.sha256(raw).hexdigest()
def positive(x): return type(x) in (int,float) and math.isfinite(x) and x>0

def foreign(card):
    if FOREIGN_NAME.search(str(card.get('name',''))): return True
    for key in ('language','cardLanguage','editionLanguage'):
        lang=str(card.get(key,'')).casefold().replace('_','-')
        if lang in FOREIGN_LANGUAGES or lang.split('-')[0] in FOREIGN_LANGUAGES:return True
    return False

def extract(payload, completed_day, counters):
    source=payload.get('source')
    if not isinstance(source,str) or not source.startswith(ALLOWED_SOURCES):
        counters['excludedSourceContracts']+=1; return {}
    if payload.get('currency','JPY')!='JPY': counters['excludedCurrencyFiles']+=1;return {}
    if 'currency' not in payload:counters['implicitJPYFiles']+=1
    rows=payload.get('history')
    if not isinstance(rows,list):counters['invalidHistoryLists']+=1;return {}
    legacy=source.startswith('backfill v2') and payload.get('historyTimezone')!='Asia/Tokyo'
    if legacy:counters['legacyDateShiftedFiles']+=1
    result={g:{} for g in GRADES}; conflicts={g:set() for g in GRADES}
    for row in rows:
        if not isinstance(row,dict):counters['invalidRows']+=1;continue
        if row.get('currency','JPY')!='JPY':counters['excludedCurrencyRows']+=1;continue
        try:
            text=row.get('date')
            if not isinstance(text,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',text):raise ValueError('date')
            day=date.fromisoformat(text)+timedelta(days=int(legacy))
        except (ValueError,TypeError,OverflowError):counters['invalidDates']+=1;continue
        if day>completed_day:counters['unfinishedOrFutureRows']+=1;continue
        for grade in GRADES:
            price=row.get(grade+'_price')
            if not positive(price) or day in conflicts[grade]:continue
            if day in result[grade] and result[grade][day]!=price:
                result[grade].pop(day);conflicts[grade].add(day);counters['conflictingConditionDays']+=1
            else:result[grade][day]=float(price)
    return {g:p for g,p in result.items() if p}

def validate_live_scope(payload,admitted):
    rows=payload.get('records');declared=payload.get('scopeSummary')
    if not isinstance(rows,list) or not isinstance(declared,dict):raise ValueError('Invalid live chart scope summary')
    if not all(isinstance(r,dict) for r in rows):raise ValueError('Invalid live chart condition record')
    pairs=[(str(r.get('id')),r.get('grade')) for r in rows]
    if len(set(pairs))!=len(pairs):raise ValueError('Duplicate live chart product-condition record')
    actual={'attemptedProducts':len({cid for cid,g in pairs}),'attemptedConditions':len(rows),
        'succeededConditions':sum(r.get('status')=='ok' for r in rows),
        'failedConditions':sum(r.get('status')=='failed' for r in rows),
        'emptyConditions':sum(r.get('status')=='ok' and isinstance(r.get('history'),list) and not r['history'] for r in rows)}
    if actual['succeededConditions']+actual['failedConditions']!=len(rows):raise ValueError('Unknown live chart record status')
    for key,value in actual.items():
        if key in declared and (type(declared[key]) is not int or declared[key]!=value):raise ValueError('Live chart scope count mismatch: '+key)
    complete=declared.get('complete')
    if type(complete) is not bool:raise ValueError('Live chart collection completeness flag missing')
    if complete:
        expected={(cid,g) for cid in admitted for g in GRADES}
        if set(pairs)!=expected or actual['failedConditions']!=0:raise ValueError('Complete live chart snapshot does not cover the admitted product-condition universe')
        if any(key not in declared for key in actual):raise ValueError('Complete live chart scope counts missing')
    return actual

def merge_live_overlay(payload,admitted,products,catalog_sha,cutoff,counters):
    """Merge successful public grade-chart observations; failed/absent rows never delete old prices."""
    if not isinstance(payload,dict) or any(payload.get(k)!=v for k,v in {
        'schemaVersion':1,'reportKind':'market-price-index-live-history','source':'SNKRDUNK',
        'currency':'JPY','timezone':'Asia/Tokyo',
    }.items()):raise ValueError('Invalid live grade-chart source contract')
    if payload.get('targetFingerprint')!=catalog_sha:raise ValueError('Live grade-chart catalog fingerprint mismatch')
    if payload.get('grades')!=list(GRADES):raise ValueError('Live grade-chart condition scope mismatch')
    rows=payload.get('records')
    if not isinstance(rows,list):raise ValueError('Invalid live grade-chart record list')
    actual_scope=validate_live_scope(payload,admitted)
    collection_date=payload.get('currentDate') or str(payload.get('collectionAsOfJST',''))[:10] or None
    summary={'fetchedAt':payload.get('fetchedAt'),'collectionAsOfJST':payload.get('collectionAsOfJST'),
        'currentDate':collection_date,'scopeSummary':payload.get('scopeSummary',{}),'verifiedScopeCounts':actual_scope,
        'complete':payload.get('scopeSummary',{}).get('complete',False),
        'sourceMode':'public per-condition all-range chart; accepted positive observations overlay matching dates only',
        'attemptedConditions':len(rows),'acceptedConditions':0,'emptyConditions':0,'failedConditions':0,
        'outsideCatalogConditions':0,'addedConditionDays':0,'revisedConditionDays':0,
        'unchangedConditionDays':0,'acceptedConditionDays':0,'latestAcceptedDate':None,
        'currentDayObservedProducts':{brand:0 for brand in BRANDS}}
    latest=None;seen=set();current_products={brand:set() for brand in BRANDS}
    for record in rows:
        if not isinstance(record,dict):raise ValueError('Invalid live grade-chart condition record')
        cid=str(record.get('id'));grade=record.get('grade');key=(cid,grade)
        if grade not in GRADES or record.get('conditionCode')!=LIVE_CONDITION_CODES.get(grade):raise ValueError('Live chart condition code does not match grade')
        if key in seen:raise ValueError('Duplicate live chart product-condition record')
        seen.add(key)
        if record.get('status')=='failed':summary['failedConditions']+=1;continue
        if record.get('status')!='ok':raise ValueError('Unknown live chart record status')
        if cid not in admitted:summary['outsideCatalogConditions']+=1;continue
        if record.get('brand')!=admitted[cid]['brand']:raise ValueError('Live chart brand differs from catalog')
        if record.get('range')!='all':raise ValueError('Unsupported live chart range contract')
        history=record.get('history')
        if not isinstance(history,list):raise ValueError('Invalid live grade-chart history')
        prices={};conflicts=set()
        for row in history:
            if not isinstance(row,dict):counters['invalidLiveRows']+=1;continue
            text=row.get('date');price=row.get('price');stamp=row.get('sourceTimestampMs')
            try:
                if not isinstance(text,str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}',text):raise ValueError('date')
                day=date.fromisoformat(text)
                if type(stamp) not in (int,float) or not math.isfinite(stamp):raise ValueError('timestamp')
                original_day=datetime.fromtimestamp(stamp/1000,timezone.utc).astimezone(JST).date()
                if original_day!=day:raise ValueError('JST date mismatch')
            except (ValueError,TypeError,OverflowError,OSError):counters['invalidLiveDates']+=1;continue
            if day>cutoff:counters['futureLiveRows']+=1;continue
            if not positive(price) or day in conflicts:continue
            if day in prices and prices[day]!=price:
                prices.pop(day);conflicts.add(day);counters['conflictingLiveConditionDays']+=1;continue
            prices[day]=float(price)
        if not prices:summary['emptyConditions']+=1;continue
        summary['acceptedConditions']+=1
        product=products.setdefault(cid,{'brand':admitted[cid]['brand'],'grades':{}})
        previous=product['grades'].setdefault(grade,{})
        for day,price in prices.items():
            if day not in previous:summary['addedConditionDays']+=1
            elif previous[day]!=price:summary['revisedConditionDays']+=1
            else:summary['unchangedConditionDays']+=1
            previous[day]=price;summary['acceptedConditionDays']+=1
            latest=max(latest,day) if latest else day
            if day==cutoff:current_products[product['brand']].add(cid)
    summary['latestAcceptedDate']=latest.isoformat() if latest else None
    summary['currentDayObservedProducts']={brand:len(ids) for brand,ids in current_products.items()}
    return summary

def load_sources(root=ROOT,completed_day=None,overlay_path=None):
    root=Path(root).resolve()
    completed_day=completed_day or datetime.now(JST).date()
    fingerprints={};counts=Counter()
    def read(path):
        raw=path.read_bytes();fingerprints[path.relative_to(root).as_posix()]=digest(raw)
        return json.loads(raw)
    catalog=read(root/'data/cards-meta.json')
    if not isinstance(catalog,dict) or not isinstance(catalog.get('cards'),list):raise ValueError('Invalid catalog')
    groups=defaultdict(list)
    for card in catalog['cards']:
        if isinstance(card,dict) and type(card.get('id')) in (str,int):groups[str(card['id'])].append(card)
    admitted={}
    for cid,rows in groups.items():
        if len(rows)!=1:counts['excludedDuplicateCatalogIDs']+=1;continue
        card=rows[0]
        if card.get('brand') not in BRANDS or str(card.get('kind','')).casefold() not in SINGLE_KINDS:
            counts['excludedCatalogScope']+=1;continue
        if foreign(card):counts['excludedExplicitForeignCatalogProducts']+=1;continue
        admitted[cid]=card
    products={};source_counts=Counter();foreign_files=[]
    for path in sorted((root/'data/history').glob('*.json')):
        counts['historyFilesRead']+=1
        try:payload=read(path)
        except (ValueError,UnicodeError):counts['invalidSourceFiles']+=1;continue
        if not isinstance(payload,dict):counts['invalidSourceFiles']+=1;continue
        source_counts[str(payload.get('source'))]+=1
        cid=path.stem
        if cid not in admitted:
            counts['excludedOutsideAdmittedCatalog']+=1
            if cid in groups and len(groups[cid])==1 and foreign(groups[cid][0]):foreign_files.append(cid)
            continue
        if str(payload.get('id'))!=cid:counts['excludedMismatchedProductID']+=1;continue
        grades=extract(payload,completed_day,counts)
        if not grades:counts['withoutUsableGradePrices']+=1;continue
        products[cid]={'brand':admitted[cid]['brand'],'grades':grades}
    live_summary=None
    live_path=Path(overlay_path) if overlay_path is not None else Path(LIVE_OVERLAY_PATH)
    if not live_path.is_absolute():live_path=root/live_path
    live_path=live_path.resolve()
    try:live_key=live_path.relative_to(root).as_posix()
    except ValueError:raise ValueError('Live grade-chart snapshot must be inside the selected source root')
    if overlay_path is not None and not live_path.is_file():raise ValueError('Selected live grade-chart snapshot does not exist')
    if live_path.exists():
        overlay=read(live_path)
        live_summary=merge_live_overlay(overlay,admitted,products,fingerprints['data/cards-meta.json'],completed_day,counts)
        live_summary['sourcePath']=live_key
        live_summary['sourceSha256']=fingerprints[live_key]
    all_days=[d for p in products.values() for h in p['grades'].values() for d in h]
    if not all_days:raise ValueError('No usable observed prices')
    return products,max(all_days),fingerprints,{
        **dict(counts),'sourceCounts':dict(source_counts),
        'catalogAsOf':catalog.get('fetchedAt'),'admittedCatalogProducts':len(admitted),
        'savedPriceProducts':len(products),'explicitForeignHistoryIDs':foreign_files,
        'sourceNormalization':{'timezone':'Asia/Tokyo','backfillV2LegacyShiftDays':1,'currency':'JPY assumed where known collector omitted currency'},
        'knownSourceContracts':list(ALLOWED_SOURCES),'excludedDailySalesHistoryContract':True,
        'latest60CacheMixed':False,'observationCutoffDate':completed_day.isoformat(),
        'currentDayPolicy':'actual recorded current-day prices included as provisional; future dates excluded',
        'liveCollection':live_summary,
    }

def prepare_records(products):
    records={};singletons=0
    for cid,p in sorted(products.items()):
        recurring={g:h for g,h in p['grades'].items() if len(h)>=2}
        singletons+=sum(len(h)<2 for h in p['grades'].values())
        count_by_day=Counter(d for h in recurring.values() for d in h)
        for grade,prices in sorted(recurring.items()):
            records[cid+':'+grade]={'productId':cid,'grade':grade,'prices':prices,
                'weights':{d:1/count_by_day[d] for d in prices}}
    return records,singletons

def fit_records(records,base_date=BASE_DATE):
    """Fit one connected condition/date graph. No chaining or artificial dates."""
    records={k:r for k,r in records.items() if len(r['prices'])>=2}
    all_days=sorted({d for r in records.values() for d in r['prices']})
    if base_date not in all_days:raise ValueError('Base date has no repeated-condition observations')
    di={d:i for i,d in enumerate(all_days)};parents=list(range(len(all_days)))
    def find(i):
        while parents[i]!=i:parents[i]=parents[parents[i]];i=parents[i]
        return i
    def union(a,b):
        a,b=find(a),find(b)
        if a!=b:parents[b]=a
    for r in records.values():
        ids=[di[d] for d in r['prices']]
        for i in ids[1:]:union(ids[0],i)
    components=defaultdict(list)
    for d in all_days:components[find(di[d])].append(d)
    groups=sorted(components.values(),key=lambda ds:ds[0]);component_by_day={d:i+1 for i,ds in enumerate(groups) for d in ds}
    active_id=component_by_day[base_date];days=groups[active_id-1];day_set=set(days)
    records={k:r for k,r in records.items() if any(d in day_set for d in r['prices'])}
    items=sorted(records);di={d:i for i,d in enumerate(days)};nonbase=[d for d in days if d!=base_date];ti={d:i for i,d in enumerate(nonbase)}
    # Whole-catalog refresh can contain millions of records. Allocate numeric
    # arrays directly instead of retaining several Python lists per record.
    observation_count=sum(sum(d in day_set for d in r['prices']) for r in records.values())
    rows=np.empty(2*observation_count,dtype=np.int32);cols=np.empty(2*observation_count,dtype=np.int32)
    values=np.empty(2*observation_count,dtype=np.float64);target=np.empty(observation_count,dtype=np.float64)
    row=position=0;total_weight=0.0
    for j,item in enumerate(items):
        record=records[item]
        for d,p in sorted(record['prices'].items()):
            if d not in day_set:continue
            w=record['weights'][d];sw=math.sqrt(w)
            rows[position]=row;cols[position]=j;values[position]=sw;position+=1
            if d!=base_date:
                rows[position]=row;cols[position]=len(items)+ti[d];values[position]=sw;position+=1
            target[row]=math.log(p)*sw;total_weight+=w;row+=1
    matrix=coo_matrix((values[:position],(rows[:position],cols[:position])),shape=(observation_count,len(items)+len(days)-1)).tocsr()
    result=lsqr(matrix,target,atol=1e-12,btol=1e-12,iter_lim=5000)
    coefficients=result[0]
    if result[1] not in (1,2):raise ValueError('TPD numerical solver did not converge')
    if not np.all(np.isfinite(coefficients)):raise ValueError('Nonfinite fitted coefficients')
    residual=matrix@coefficients-target;gradient=matrix.T@residual
    score_ratio=float(np.linalg.norm(gradient)/max(1,float(np.linalg.norm(matrix.T@target))))
    if score_ratio>1e-10:raise ValueError('TPD normal-equation residual exceeds tolerance')
    beta={d:(0.0 if d==base_date else float(coefficients[len(items)+ti[d]])) for d in days}
    condition_effects={item:float(coefficients[i]) for i,item in enumerate(items)}
    diagnostics={
        'converged':True,'stopCode':int(result[1]),'iterations':int(result[2]),
        'weightedLogRMSE':float(math.sqrt(float(residual@residual)/total_weight)),
        'normalEquationRelativeResidual':score_ratio,'normalEquationMaxAbsoluteResidual':float(np.max(np.abs(gradient))),
        'fittedObservations':observation_count,'fittedConditions':len(items),
        'fittedProducts':len({r['productId'] for r in records.values()}),
        'fittedDates':len(days),'componentCount':len(groups),'baseComponentId':active_id,
        'components':[{'id':i+1,'firstDate':ds[0].isoformat(),'lastDate':ds[-1].isoformat(),'observedDates':len(ds)} for i,ds in enumerate(groups)],
        'uncertaintyMeaning':'RMSE is model mismatch, not verified sampling confidence; no confidence interval certified',
    }
    return beta,condition_effects,diagnostics,records,component_by_day

def daily_breadth(records, step_days=1):
    by_day=defaultdict(lambda:defaultdict(dict));first={}
    for item,r in records.items():
        cid=r['productId'];first[cid]=min(first.get(cid,min(r['prices'])),min(r['prices']))
        for d,p in r['prices'].items():by_day[d][cid][r['grade']]=p
    output={}
    for d,products in by_day.items():
        before=by_day.get(d-timedelta(days=step_days),{});up=down=flat=matched=conditions=0
        for cid,prices in products.items():
            prior=before.get(cid,{})
            logs=[math.log(p)-math.log(prior[g]) for g,p in prices.items() if g in prior]
            if not logs:continue
            matched+=1;conditions+=len(logs);change=math.fsum(logs)/len(logs)
            if abs(change)<1e-12:flat+=1
            elif change>0:up+=1
            else:down+=1
        n=len(products)
        output[d]={'observedProducts':n,'observedConditions':sum(len(g) for g in products.values()),
            'matchedProducts':matched,'matchedConditions':conditions,'up':up,'down':down,'flat':flat,
            'newObservedProducts':sum(first[cid]==d for cid in products),
            'unpairedProducts':n-matched,'upRatio':up/matched if matched else None,
            'pairCoverageRatio':matched/n if n else None,
            'basis':('same product and condition observed in exact preceding complete week; no carried prices' if step_days==7 else 'same product and condition observed on exact preceding calendar date; no carried prices')}
    return output

def build_brand(brand,products,source_as_of,current_day=None):
    subset={i:p for i,p in products.items() if p['brand']==brand}
    all_observed=defaultdict(set)
    for cid,p in subset.items():
        for h in p['grades'].values():
            for d in h:all_observed[d].add(cid)
    records,singletons=prepare_records(subset)
    beta,effects,diagnostics,used,components=fit_records(records)
    breadth=daily_breadth(used);points=[];first=min(all_observed);day=first
    while day<=source_as_of:
        log_index=beta.get(day);previous=beta.get(day-timedelta(days=1))
        point={'date':day.isoformat(),'provisional':day==current_day,'value':round(BASE_VALUE*math.exp(log_index),8) if log_index is not None else None,
            'logIndex':log_index,'dailyReturn':round(math.expm1(log_index-previous)*100,8) if log_index is not None and previous is not None else None,
            'componentId':components.get(day),'sourceObservedProducts':len(all_observed.get(day,set())),
            'status':'estimated-observed-date' if log_index is not None else ('disconnected-observations' if components.get(day) else 'no-repeated-condition-observations'),
            **breadth.get(day,{'observedProducts':0,'observedConditions':0,'matchedProducts':0,'matchedConditions':0,'up':0,'down':0,'flat':0,'newObservedProducts':0,'unpairedProducts':0,'upRatio':None,'pairCoverageRatio':None,'basis':'no comparable observed prices'})}
        points.append(point);day+=timedelta(days=1)
    return {'brand':brand,'label':'포켓몬' if brand=='pokemon' else '원피스','baseDate':BASE_DATE.isoformat(),'baseValue':BASE_VALUE,
        'firstRecordedDate':first.isoformat(),'lastRecordedDate':max(all_observed).isoformat(),
        'todayIncomplete':current_day in beta if current_day else False,
        'firstCalculatedDate':min(beta).isoformat(),'lastCalculatedDate':max(beta).isoformat(),
        'availableProducts':len(subset),'excludedSingletonConditions':singletons,
        'diagnostics':diagnostics,'conditionEffects':effects,'points':points}

def numerical_gates(step_days=1, base_date=BASE_DATE):
    def make(prices):
        records={}
        for item,history in prices.items():
            records[item]={'productId':item.split(':')[0],'grade':item.split(':')[-1],'prices':{base_date+timedelta(days=(int(d)-1)*step_days):p for d,p in history.items()},'weights':{base_date+timedelta(days=(int(d)-1)*step_days):1.0 for d in history}}
        return records
    cases={
        'closed-price-cycle-with-intermediate-gaps':(make({'a:raw':{1:100,2:180,4:100},'b:raw':{1:200,3:70,4:200}}),0.0),
        'constant-prices-with-product-entries-and-exits':(make({'a:raw':{1:100,2:100},'b:raw':{2:500,3:500},'c:raw':{3:20,4:20}}),0.0),
        'balanced-panel-equals-direct-geometric-relative':(make({'a:raw':{1:100,2:120,3:80},'b:raw':{1:500,2:500,3:600}}),math.sqrt(.8*1.2)-1),
        'common-proportional-change-with-sparse-records':(make({'a:raw':{1:100,2:80},'b:raw':{2:800,3:600},'c:raw':{1:200,3:120}}),-.4),
        'constant-quality-conditions-are-separated':(make({'a:raw':{1:100,2:100},'a:psa10':{2:1000,3:1000},'b:raw':{1:20,3:20}}),0.0),
    }
    tests=[]
    for name,(records,expected) in cases.items():
        beta,*_=fit_records(records,base_date);result=math.expm1(beta[max(beta)]-beta[min(beta)])
        error=abs(result-expected)
        if error>1e-8:raise ValueError('Economic numerical gate failed: '+name)
        tests.append({'id':('weekly-'+name if step_days==7 else name),'passed':True,'resultPercent':result*100,'expectedPercent':expected*100,'absoluteRatioError':error})
    return tests

WEEKLY_BASE_DATE = date(2024, 1, 7)
WEEKLY_METHOD = {
    **METHOD, 'id': 'retrospective-pooled-product-condition-weekly-tpd-v1',
    'frequency': 'weekly', 'baseDate': WEEKLY_BASE_DATE.isoformat(),
    'basePeriod': {'start': '2024-01-01', 'end': '2024-01-07'},
    'period': 'Monday through Sunday; complete source calendar weeks only',
    'aggregation': 'geometric mean of actual recorded condition prices within each complete week, then pooled TPD fit',
    'smoothing': False, 'partialLatestWeekIncluded': False,
    'minimumConditionDates': 2,
    'minimumConditionDatesRole': 'at least two observed weeks for temporal identifiability only',
}

def aggregate_complete_weeks(products,source_as_of,current_day=None):
    complete_through=min(source_as_of,current_day-timedelta(days=1)) if current_day else source_as_of
    last_sunday=complete_through-timedelta(days=(complete_through.weekday()+1)%7)
    weekly={}
    for cid,product in products.items():
        grades={}
        for grade,history in product['grades'].items():
            grouped=defaultdict(list)
            for d,p in history.items():
                end=d+timedelta(days=6-d.weekday())
                if end<=last_sunday:grouped[end].append(math.log(p))
            prices={end:math.exp(math.fsum(logs)/len(logs)) for end,logs in grouped.items()}
            if prices:grades[grade]=prices
        if grades:weekly[cid]={'brand':product['brand'],'grades':grades,'firstRecordedDate':min(d for h in product['grades'].values() for d in h).isoformat()}
    return weekly,last_sunday

def build_weekly_brand(brand,weekly_products,source_as_of):
    subset={i:p for i,p in weekly_products.items() if p['brand']==brand}
    all_observed=defaultdict(set)
    for cid,p in subset.items():
        for h in p['grades'].values():
            for d in h:all_observed[d].add(cid)
    records,singletons=prepare_records(subset)
    beta,effects,diagnostics,used,components=fit_records(records,WEEKLY_BASE_DATE)
    breadth=daily_breadth(used,7);points=[];first=min(all_observed);day=first
    while day<=source_as_of:
        log_index=beta.get(day);previous=beta.get(day-timedelta(days=7))
        point={'date':day.isoformat(),'periodStart':(day-timedelta(days=6)).isoformat(),'periodEnd':day.isoformat(),
            'value':round(BASE_VALUE*math.exp(log_index),8) if log_index is not None else None,
            'logIndex':log_index,'weeklyReturn':round(math.expm1(log_index-previous)*100,8) if log_index is not None and previous is not None else None,
            'dailyReturn':None,'componentId':components.get(day),'sourceObservedProducts':len(all_observed.get(day,set())),
            'status':'estimated-observed-week' if log_index is not None else ('disconnected-observations' if components.get(day) else 'no-repeated-condition-observations'),
            **breadth.get(day,{'observedProducts':0,'observedConditions':0,'matchedProducts':0,'matchedConditions':0,'up':0,'down':0,'flat':0,'newObservedProducts':0,'unpairedProducts':0,'upRatio':None,'pairCoverageRatio':None,'basis':'no comparable weekly observed prices'})}
        points.append(point);day+=timedelta(days=7)
    return {'brand':brand,'label':'포켓몬' if brand=='pokemon' else '원피스','methodology':WEEKLY_METHOD,
        'baseDate':WEEKLY_BASE_DATE.isoformat(),'basePeriod':WEEKLY_METHOD['basePeriod'],'baseValue':BASE_VALUE,
        'firstRecordedDate':min(p.get('firstRecordedDate',first.isoformat()) for p in subset.values()),'firstCalculatedDate':min(beta).isoformat(),'lastCalculatedDate':max(beta).isoformat(),
        'availableProducts':len(subset),'excludedSingletonConditions':singletons,
        'diagnostics':diagnostics,'conditionEffects':effects,'points':points}

PRICE_EVIDENCE_METHOD = {
    'id':'same-product-fixed-baseline-condition-30day-median-price-relative-v1',
    'windowDays':30,'windowBounds':'inclusive endpoint minus 29 calendar days through endpoint',
    'conditionPrice':'median of positive actual recorded prices within each window',
    'productMultiple':'arithmetic mean of recent/baseline condition-price ratios; equal weights among that product\'s baseline-observed conditions',
    'arithmeticMultiple':'arithmetic mean of compared product multiples; equal initial amount per product',
    'medianMultiple':'median of compared product multiples',
    'geometricMultiple':'exponential of mean log compared product multiple',
    'comparisonScope':'all baseline-observed products; compare only products with every baseline-observed condition also actually observed in recent window',
    'missingPricePolicy':'exclude incomplete products from this endpoint comparison; never zero, carry or chain returns',
    'newConditionsPolicy':'conditions absent from baseline window do not enter the comparison',
    'flatRatioTolerance':1e-12,'observationsOnly':True,'carryDays':0,
    'quantityWeights':False,'fullFixedBasketPerformance':False,'representativeMarketPerformance':False,
    'selectionLimitation':'endpoint observation availability can select surviving products; coverage is disclosed, not a full-market return',
    'peakSelection':'highest actual daily model index point on or after 2024-01-01; earliest date breaks ties',
    'indexPathMeaning':'existing daily TPD model points; not a direct-price arithmetic or median time series',
    'historicalRevisions':True,
}

def compare_price_windows(brand,products,baseline_end,recent_end,window_days=30):
    """Direct endpoint evidence with product/condition identity held fixed.

    Missing baseline conditions exclude the entire product from the endpoint
    comparison. This intentionally does not construct a changing-member series.
    """
    baseline_start=baseline_end-timedelta(days=window_days-1)
    recent_start=recent_end-timedelta(days=window_days-1)
    original_products=original_conditions=compared_conditions=0;multiples=[]
    for cid,product in sorted(products.items()):
        if product['brand']!=brand:continue
        initial={}
        for grade,history in sorted(product['grades'].items()):
            prices=[p for d,p in history.items() if baseline_start<=d<=baseline_end and positive(p)]
            if prices:initial[grade]=statistics.median(prices)
        if not initial:continue
        original_products+=1;original_conditions+=len(initial);ratios=[]
        for grade,price in initial.items():
            prices=[p for d,p in product['grades'][grade].items() if recent_start<=d<=recent_end and positive(p)]
            if not prices:break
            ratios.append(statistics.median(prices)/price)
        if len(ratios)!=len(initial):continue
        ratio=math.fsum(ratios)/len(ratios)
        if not positive(ratio):raise ValueError('Nonfinite direct product price multiple')
        if math.isclose(ratio,1.0,rel_tol=0.0,abs_tol=PRICE_EVIDENCE_METHOD['flatRatioTolerance']):ratio=1.0
        multiples.append(ratio);compared_conditions+=len(initial)
    bins={k:0 for k in ('below1','oneTo2','twoTo5','fiveTo10','tenTo20','twentyOrMore')}
    for ratio in multiples:
        key=('below1' if ratio<1 else 'oneTo2' if ratio<2 else 'twoTo5' if ratio<5 else
             'fiveTo10' if ratio<10 else 'tenTo20' if ratio<20 else 'twentyOrMore')
        bins[key]+=1
    count=len(multiples)
    return {'windows':{'baseline':{'start':baseline_start.isoformat(),'end':baseline_end.isoformat()},
                       'recent':{'start':recent_start.isoformat(),'end':recent_end.isoformat()}},
        'originalProducts':original_products,'originalConditions':original_conditions,
        'comparedProducts':count,'comparedConditions':compared_conditions,
        'excludedProducts':original_products-count,'coveragePct':count/original_products*100 if original_products else 0.0,
        'arithmeticMultiple':math.fsum(multiples)/count if count else None,
        'medianMultiple':statistics.median(multiples) if count else None,
        'geometricMultiple':math.exp(math.fsum(math.log(x) for x in multiples)/count) if count else None,
        'up':sum(x>1 for x in multiples),'down':sum(x<1 for x in multiples),'flat':sum(x==1 for x in multiples),
        'belowHalfCount':sum(x<.5 for x in multiples),'bins':bins}

def build_price_evidence(products,series,source_as_of):
    evidence={}
    for brand in BRANDS:
        points=[p for p in series[brand]['points'] if p['date']>=BASE_DATE.isoformat() and positive(p['value'])]
        if not points:raise ValueError('No post-base daily points for direct-price evidence')
        peak=min(points,key=lambda p:(-p['value'],p['date']));current=max(points,key=lambda p:p['date'])
        base=next((p for p in points if p['date']==BASE_DATE.isoformat()),None)
        if base is None:raise ValueError('Missing actual base index point')
        def point_fields(point):
            return {k:point[k] for k in ('date','value','observedProducts','observedConditions','provisional')}
        evidence[brand]={
            'baseline':compare_price_windows(brand,products,BASE_DATE,source_as_of),
            'peakComparison':compare_price_windows(brand,products,date.fromisoformat(peak['date']),source_as_of),
            'indexPath':{'base':{'date':base['date'],'value':base['value']},
                'peak':point_fields(peak),'current':point_fields(current),
                'drawdownPct':(current['value']/peak['value']-1)*100,
                'sinceBasePct':(current['value']/base['value']-1)*100,'peakPeriod':'since-2024-base'}}
    return evidence

def validate_price_evidence(evidence,series,source_as_of):
    checks=[]
    for brand in BRANDS:
        for kind in ('baseline','peakComparison'):
            x=evidence[brand][kind];n=x['comparedProducts'];original=x['originalProducts']
            if not (0<=n<=original and x['excludedProducts']==original-n and
                    n<=x['comparedConditions']<=x['originalConditions'] and
                    x['up']+x['down']+x['flat']==n and sum(x['bins'].values())==n and
                    0<=x['belowHalfCount']<=x['down'] and x['bins']['below1']==x['down']):
                raise ValueError('Direct-price evidence count consistency failed')
            expected=n/original*100 if original else 0.0
            if x['coveragePct']!=expected:raise ValueError('Direct-price evidence coverage mismatch')
            for field in ('arithmeticMultiple','medianMultiple','geometricMultiple'):
                if (n and not positive(x[field])) or (not n and x[field] is not None):
                    raise ValueError('Direct-price evidence undefined multiple contract failed')
            for window in x['windows'].values():
                if (date.fromisoformat(window['end'])-date.fromisoformat(window['start'])).days!=29:
                    raise ValueError('Direct-price evidence window is not 30 inclusive days')
            if x['windows']['recent']['end']!=source_as_of.isoformat():raise ValueError('Direct-price evidence source endpoint mismatch')
            expected_start=BASE_DATE.isoformat() if kind=='baseline' else evidence[brand]['indexPath']['peak']['date']
            if x['windows']['baseline']['end']!=expected_start:raise ValueError('Direct-price evidence baseline endpoint mismatch')
            checks.append({'id':f'price-evidence-{brand}-{kind}','passed':True})
        path=evidence[brand]['indexPath'];actual={p['date']:p for p in series[brand]['points'] if p['date']>=BASE_DATE.isoformat() and positive(p['value'])}
        peak=min(actual.values(),key=lambda p:(-p['value'],p['date']));current=max(actual.values(),key=lambda p:p['date'])
        if path['base']!={'date':BASE_DATE.isoformat(),'value':actual[BASE_DATE.isoformat()]['value']}:
            raise ValueError('Direct-price evidence index base mismatch')
        for key,point in (('peak',peak),('current',current)):
            if path[key]!={k:point[k] for k in ('date','value','observedProducts','observedConditions','provisional')}:
                raise ValueError('Direct-price evidence model index endpoint mismatch')
        if (path['drawdownPct']!=(current['value']/peak['value']-1)*100 or
                path['sinceBasePct']!=(current['value']/path['base']['value']-1)*100):
            raise ValueError('Direct-price evidence model index return mismatch')
        checks.append({'id':f'price-evidence-{brand}-indexPath','passed':True})
    return checks

def build(root=ROOT,generated_at=None,overlay_path=None):
    products,as_of,fingerprints,summary=load_sources(root,overlay_path=overlay_path)
    current_day=date.fromisoformat(summary['observationCutoffDate'])
    series={b:build_brand(b,products,as_of,current_day) for b in BRANDS}
    weekly_products,week_end=aggregate_complete_weeks(products,as_of,current_day)
    weekly_series={b:build_weekly_brand(b,weekly_products,week_end) for b in BRANDS}
    price_evidence=build_price_evidence(products,series,as_of)
    evidence_checks=validate_price_evidence(price_evidence,series,as_of)
    payload={'schemaVersion':1,'reportKind':'market-price-index','generatedAt':generated_at or datetime.now(JST).isoformat(),
        'source':'SNKRDUNK','currency':'JPY','targetLanguage':'ja','sourceAsOf':as_of.isoformat(),
        'baseDate':BASE_DATE.isoformat(),'baseValue':BASE_VALUE,'methodology':METHOD,'strictFlags':STRICT_FLAGS,
        'frequencyOptions':['weekly','daily'],'defaultFrequency':'daily','weeklyMethodology':WEEKLY_METHOD,'weeklySeries':weekly_series,
        'referenceOnly':True,'currentJSTDate':current_day.isoformat(),'todayIncomplete':as_of==current_day,
        'latestCompleteWeekEnd':week_end.isoformat(),'sourceSummary':summary,'inputFingerprints':fingerprints,'series':series,
        'priceEvidenceMethodology':PRICE_EVIDENCE_METHOD,'priceEvidence':price_evidence,
        'limitations':[
            'Saved SNKRDUNK price amounts are not independently verified per-card unit prices.',
            'Explicit foreign editions are excluded, but all admitted Japanese editions are not verified.',
            'This is an equal-observed-product statistical price model, not trade-value weighting or a fixed basket.',
            'All saved dates are estimated together; new observations can revise historical values.',
            'Sparse-date and nonrandom-observation selection may affect the estimates; model confidence is not certified.',
            'Current-day observations are provisional and incomplete; sourceAsOf is the latest accepted recorded price date, not a fabricated collection-day value.',
            'Source history is not current beyond sourceAsOf; no latest 60-product cache is blended.',
            'Direct-price evidence compares only products with all baseline conditions observed in both 30-day windows; excluded products are unknown, so this is not full-market or full-basket performance.',
        ],'methodSources':SOURCES}
    raw=(json.dumps(payload,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n').encode('utf-8')
    tests=numerical_gates()+numerical_gates(7,WEEKLY_BASE_DATE)
    validation={'schemaVersion':1,'reportKind':'market-price-index-validation','status':'passed','checkedAt':datetime.now(JST).isoformat(),
        'sourceAsOf':as_of.isoformat(),'dataSha256':digest(raw),'methodId':METHOD['id'],'calculationOnly':True,
        'strictFlags':STRICT_FLAGS,'marketReady':False,'inputFingerprints':fingerprints,
        'numericalGates':tests,'priceEvidenceMethodId':PRICE_EVIDENCE_METHOD['id'],'priceEvidenceChecks':evidence_checks,
        'checksPassed':len(tests)+len(evidence_checks)+sum(len(s['points']) for s in [*series.values(),*weekly_series.values()]),'errors':[],
        'defaultFrequency':'daily','currentJSTDate':current_day.isoformat(),'todayIncomplete':as_of==current_day,
        'latestCompleteWeekEnd':week_end.isoformat(),'liveCollection':summary.get('liveCollection'),'weeklyMethodId':WEEKLY_METHOD['id'],
        'seriesDiagnostics':{b:s['diagnostics'] for b,s in series.items()},
        'weeklySeriesDiagnostics':{b:s['diagnostics'] for b,s in weekly_series.items()},
        'validationMeaning':'Numerical convergence, recorded-input integrity and economic fixture tests; not market representation, unit-price or statistical-confidence certification.'}
    return payload,raw,validation

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--root',type=Path,default=ROOT)
    parser.add_argument('--live-overlay',type=Path,help='Select a live snapshot inside source root instead of the default alias')
    args=parser.parse_args()
    payload,raw,validation=build(args.root,overlay_path=args.live_overlay)
    (args.root/'data/market-price-index.json').write_bytes(raw)
    (args.root/'data/market-price-index-validation.json').write_text(json.dumps(validation,ensure_ascii=False,separators=(',',':'),allow_nan=False)+'\n',encoding='utf-8')
    for b,s in payload['series'].items():
        values={p['date']:p['value'] for p in s['points'] if p['value'] is not None}
        latest=s['lastCalculatedDate']
        print(b,'products',s['diagnostics']['fittedProducts'],'conditions',s['diagnostics']['fittedConditions'],'observations',s['diagnostics']['fittedObservations'],'first',s['firstCalculatedDate'],'last',latest,'latestIndex',values[latest])
    for b,s in payload['weeklySeries'].items():
        values={p['date']:p['value'] for p in s['points'] if p['value'] is not None}
        latest=s['lastCalculatedDate']
        print(b,'weekly products',s['diagnostics']['fittedProducts'],'weeks',s['diagnostics']['fittedDates'],'lastCompleteWeek',latest,'latestIndex',values[latest])
    print('Numerical gates',len(validation['numericalGates']),'passed; marketReady false')
if __name__=='__main__':main()
