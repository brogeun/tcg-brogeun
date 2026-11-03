"""Collect the rendered KREAM trade drawer using an owner-supplied login session.

Every product must reach its bottom and retain all previous trade multiplicities.
Any access, login, parsing or completeness failure preserves all successful data.
"""
from __future__ import annotations
import argparse
import copy
from collections import Counter
from datetime import datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tempfile
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

IDS = ('1096144', '893073', '998016', '998022', '937106', '934334', '508949')
KST = ZoneInfo('Asia/Seoul')
SESSION_STORAGE_ORIGINS = ('https://kream.co.kr', 'https://www.kream.co.kr')

class CollectionError(RuntimeError):
    """A fixed, credential-free failure suitable for the public health file."""
    def __init__(self, code, message, **details):
        super().__init__(message)
        self.code, self.details = code, details

def kream_host(host):
    host = (host or '').lstrip('.').lower()
    return host == 'kream.co.kr' or host.endswith('.kream.co.kr')

def session_state(value):
    # Never include parser/Playwright errors or session contents in logs/health.
    if not value or not value.strip():
        raise CollectionError('session_missing', 'KREAM login session is not configured (KREAM_STORAGE_STATE).')
    try:
        state = json.loads(value)
        cookies, origins = state.get('cookies', []), state.get('origins', [])
        if not isinstance(cookies, list) or not isinstance(origins, list):
            raise ValueError()
        cookies = [c for c in cookies if kream_host(c.get('domain'))]
        origins = [o for o in origins if urlparse(o.get('origin', '')).scheme == 'https'
                   and kream_host(urlparse(o.get('origin', '')).hostname)]
        result = {'cookies': cookies, 'origins': origins}
        if 'sessionStorage' in state:
            supplied = state['sessionStorage']
            if not isinstance(supplied, dict):
                raise ValueError()
            scoped = {}
            for origin, entries in supplied.items():
                if origin not in SESSION_STORAGE_ORIGINS:
                    continue
                if not isinstance(entries, dict) or any(
                        not isinstance(key, str) or not isinstance(value, str)
                        for key, value in entries.items()):
                    raise ValueError()
                scoped[origin] = entries
            result['sessionStorage'] = scoped
        if (not cookies and not any(o.get('localStorage') or o.get('indexedDB') for o in origins)
                and not any(result.get('sessionStorage', {}).values())):
            raise ValueError()
        return result
    except (ValueError, TypeError, AttributeError):
        raise CollectionError('session_invalid', 'KREAM login session is invalid; reconnect it using the setup script.') from None

def browser_context_for_session(browser, state, **options):
    """Restore native state and optional first-party tab storage without logging it."""
    state = session_state(json.dumps(state))
    native = {key: state[key] for key in ('cookies', 'origins')}
    context = None
    try:
        context = browser.new_context(storage_state=native, **options)
        tab_storage = state.get('sessionStorage', {})
        if any(tab_storage.values()):
            # Parse JSON data rather than interpolating keys/values as executable JS.
            # A JSON string literal also safely preserves quotes, backslashes and
            # Unicode separators, including an entry named __proto__.
            payload = json.dumps(json.dumps(tab_storage, ensure_ascii=True, separators=(',', ':')),
                                 ensure_ascii=True)
            script = """(() => {
  const origins = JSON.parse(""" + payload + """);
  if (!Object.prototype.hasOwnProperty.call(origins, window.location.origin)) return;
  const entries = origins[window.location.origin];
  for (const [key, value] of Object.entries(entries)) {
    if (window.sessionStorage.getItem(key) === null) {
      window.sessionStorage.setItem(key, value);
    }
  }
})();"""
            # The caller creates its first page only after this script is installed.
            context.add_init_script(script=script)
        return context
    except Exception:
        if context is not None:
            try:
                context.close()
            except Exception:
                pass
        raise CollectionError('session_invalid', 'KREAM login session could not be restored; reconnect it.') from None

def require_login_access(page):
    if re.search(r'/(?:login|signin)(?:[/?#]|$)', page.url):
        raise CollectionError('session_expired', 'KREAM requires login; reconnect the saved session.')
    gate = page.get_by_text(re.compile(r'모든\s*시세는\s*로그인|로그인\s*후\s*확인\s*가능'))
    if any(node.is_visible() for node in gate.all()):
        raise CollectionError('session_expired', 'KREAM requires login for full trade history; reconnect the saved session.')

def full_history_button(page):
    # Hidden responsive copies precede the visible desktop control on KREAM.
    return page.get_by_role('button', name=re.compile(r'(?:체결|거래)\s*내역\s*더보기')).filter(visible=True).first

def open_history_drawer(page):
    """Open the read-only drawer, retrying one ignored pre-hydration click."""
    drawer = page.locator('.drawer').filter(visible=True).first
    for attempt in range(2):
        require_login_access(page)
        if attempt and drawer.is_visible():
            return drawer
        try:
            button = full_history_button(page)
            button.wait_for(state='visible', timeout=20000)
            button.click()
        except Exception as error:
            if type(error).__name__ != 'TimeoutError':
                raise
            require_login_access(page)
            raise CollectionError('trade_drawer_unavailable', 'Full trade history control is unavailable; prior trades retained.') from None
        require_login_access(page)
        try:
            drawer.wait_for(state='visible', timeout=5000 if attempt == 0 else 15000)
        except Exception as error:
            if type(error).__name__ != 'TimeoutError':
                raise
            require_login_access(page)
            if attempt:
                raise CollectionError('trade_drawer_unavailable', 'Full trade history drawer did not open; prior trades retained.') from None
            try:
                page.wait_for_load_state('load', timeout=45000)
            except Exception as error:
                if type(error).__name__ != 'TimeoutError':
                    raise
                require_login_access(page)
                raise CollectionError('trade_drawer_unavailable', 'KREAM product page did not finish loading; prior trades retained.') from None
            continue
        require_login_access(page)
        return drawer

def open_product(page, card):
    # Retry transient server errors only, in the same normal browser context.
    # Authentication, permission and rate-limit responses stop immediately.
    for attempt in range(3):
        response = page.goto(card['source_url'], wait_until='domcontentloaded', timeout=45000)
        status = response.status if response else 0
        if status in (500, 502, 503, 504) and attempt < 2:
            page.wait_for_timeout((5, 15)[attempt] * 1000)
            continue
        if status >= 400:
            code = 'access_denied' if status in (401, 403, 429) else 'source_http_error'
            raise CollectionError(code, 'KREAM product page HTTP '+str(status), http_status=status)
        require_login_access(page)
        if not re.search(r'^https://(?:www\.)?kream\.co\.kr/products/'+card['id']+r'(?:[/?#]|$)', page.url):
            raise CollectionError('unexpected_redirect', 'KREAM redirected away from the requested product.')
        return

def already_collected_today(manifest, health, now):
    # A failed later attempt must still be retried by the fallback schedule.
    try:
        success = datetime.fromisoformat(manifest['last_success_at'].replace('Z', '+00:00')).astimezone(KST)
        return (health.get('status') == 'success' and health.get('last_success_at') == manifest['last_success_at']
                and now >= success >= now.replace(hour=6, minute=10, second=0, microsecond=0))
    except (KeyError, TypeError, ValueError):
        return False

def encoded(data):
    return (json.dumps(data, ensure_ascii=False, separators=(',', ':')) + '\n').encode()

def signature(row):
    return (row['date'], row['option'], row['price_krw'], bool(row['express_shipping']))

def unpack_history(data):
    if data.get('rowEncoding') != 'indexed-v1':
        return data
    result={k:v for k,v in data.items() if k not in ('rowEncoding','dates','options','dateLabels')}
    result['rows']=[{'date':data['dates'][r[0]],'option':data['options'][r[1]],'price_krw':r[2],
        'express_shipping':bool(r[3]),'date_raw':data['dateLabels'][r[4]],'date_from_relative_label':bool(r[5]),
        'date_precision':'day','source_rank':i,'product_id':data['id'],'source_url':data['source_url']}
        for i,r in enumerate(data['rows'])]
    return result

def pack_history(data):
    data=unpack_history(data)
    dates=list(dict.fromkeys(r['date'] for r in data['rows']))
    options=list(dict.fromkeys(r['option'] for r in data['rows']))
    labels=list(dict.fromkeys(r['date_raw'] for r in data['rows']))
    di={v:i for i,v in enumerate(dates)};oi={v:i for i,v in enumerate(options)};li={v:i for i,v in enumerate(labels)}
    result=dict(data)
    result.update(rowEncoding='indexed-v1',dates=dates,options=options,dateLabels=labels,
        rows=[[di[r['date']],oi[r['option']],r['price_krw'],int(r['express_shipping']),li[r['date_raw']],int(r.get('date_from_relative_label',False))] for r in data['rows']])
    return result

def parse_row(raw, anchor):
    date_raw = raw['date_raw']
    match = re.search(r'(\d{2})/(\d{2})/(\d{2})', date_raw)
    relative = not bool(match)
    if match:
        day = datetime.strptime(match.group(), '%y/%m/%d').date()
    elif '어제' in date_raw:
        day = (anchor - timedelta(days=1)).date()
    elif '오늘' in date_raw or '방금' in date_raw:
        day = anchor.date()
    else:
        match = re.search(r'(\d+)\s*(초|분|시간|일)\s*전', date_raw)
        if not match:
            raise ValueError('Unknown source date label')
        number, unit = int(match[1]), match[2]
        delta = timedelta(**{{'초':'seconds', '분':'minutes', '시간':'hours', '일':'days'}[unit]: number})
        day = (anchor-delta).date()
    price = int(re.sub(r'[^\d]', '', raw['price']))
    if price <= 0 or not raw['option'] or day > anchor.date():
        raise ValueError('Invalid source row')
    return {'date': day.isoformat(), 'date_raw': date_raw,
            'date_precision':'day', 'date_from_relative_label':relative,
            'option':raw['option'].strip(), 'price_krw':price,
            'express_shipping':bool(raw['express_shipping'])}

def validate_history(data, ident):
    data=unpack_history(data)
    if data.get('schemaVersion') != 1 or data.get('id') != ident or data.get('complete') is not True:
        raise ValueError('Wrong product or incomplete history')
    rows = data['rows']
    if not rows or len(rows) != data['collected_count']:
        raise ValueError('Trade count mismatch')
    previous = '9999'
    for row in rows:
        datetime.strptime(row['date'], '%Y-%m-%d')
        if row['date'] > previous or type(row['price_krw']) is not int or row['price_krw'] <= 0 or not row['option']:
            raise ValueError('Unsorted or invalid trade')
        previous = row['date']
    if dict(Counter(r['option'] for r in rows)) != data['counts_by_exact_option']:
        raise ValueError('Option counts mismatch')
    return data

def validate_bundle(root):
    manifest = json.loads((root/'data/korean-promos.json').read_bytes())
    if manifest.get('schemaVersion') != 1 or tuple(c['id'] for c in manifest['cards']) != IDS:
        raise ValueError('Wrong Korean promo selection or order')
    total = 0
    for card in manifest['cards']:
        ident = card['id']
        if card['file'] != '/data/korean-promos/'+ident+'.json':
            raise ValueError('Unsafe trade path')
        raw = (root/card['file'].lstrip('/')).read_bytes()
        data = validate_history(json.loads(raw), ident)
        if hashlib.sha256(raw).hexdigest()[:16] != card['version'] or card['collected_count'] != len(data['rows']) or card['counts_by_exact_option'] != data['counts_by_exact_option']:
            raise ValueError('Catalogue and history generation differ')
        total += len(data['rows'])
    if total != manifest['collected_trade_count']:
        raise ValueError('Combined count mismatch')
    health_path=root/'data/korean-promos-health.json'
    if health_path.exists():
        health=json.loads(health_path.read_bytes())
        if health.get('status') not in ('success','failed') or health.get('last_success_at') != manifest['last_success_at']:
            raise ValueError('Health and history generation differ')
        if health['status']=='success' and health.get('trades',total) != total:
            raise ValueError('Health and history counts differ')
    return manifest

def validate_new_rows(old, rows):
    # Repeated identical-looking transactions are a multiset, never a set.
    # A truncated drawer or filtered option must never replace a full snapshot.
    missing = Counter(signature(r) for r in old['rows']) - Counter(signature(r) for r in rows)
    if missing:
        raise ValueError('Source snapshot is incomplete or historical trades changed; preserved prior data')
    if any(a['date'] < b['date'] for a,b in zip(rows, rows[1:])):
        raise ValueError('Source trade order is not newest first')

def replace_file(path, raw):
    with tempfile.NamedTemporaryFile(dir=path.parent, prefix='.'+path.name, delete=False) as tmp:
        name=Path(tmp.name)
        try:
            tmp.write(raw)
            tmp.flush()
            os.fsync(tmp.fileno())
        except BaseException:
            name.unlink(missing_ok=True)
            raise
    try:
        os.replace(name,path)
    finally:
        name.unlink(missing_ok=True)

def publish_generation(root, original_manifest, staged, attempted):
    manifest=copy.deepcopy(original_manifest)
    payloads={}
    for card in manifest['cards']:
        data=validate_history(staged[card['id']],card['id'])
        old=unpack_history(json.loads((root/card['file'].lstrip('/')).read_bytes()))
        validate_new_rows(old,data['rows'])
        raw=encoded(pack_history(data))
        payloads[card['file'].lstrip('/')]=raw
        for key in ('collected_count','counts_by_exact_option','last_observed_at','snapshot_started_at','earliest_date','latest_date'):
            card[key]=data[key]
        card['version']=hashlib.sha256(raw).hexdigest()[:16]
        card['latest_price_by_option']={}
        for row in data['rows']:
            card['latest_price_by_option'].setdefault(row['option'],{'date':row['date'],'price_krw':row['price_krw']})
    success=datetime.now(KST).isoformat()
    manifest.update(last_success_at=success,collected_trade_count=sum(c['collected_count'] for c in manifest['cards']))
    manifest['refresh'].update(status='success',last_attempt_at=attempted)
    payloads['data/korean-promos.json']=encoded(manifest)
    payloads['data/korean-promos-health.json']=encoded({'schemaVersion':1,'status':'success',
        'last_attempt_at':attempted,'last_success_at':success,'trades':manifest['collected_trade_count']})
    # Verify the entire candidate before touching any previous file.
    with tempfile.TemporaryDirectory(prefix='kream-generation-') as directory:
        candidate=Path(directory)
        for rel,raw in payloads.items():
            target=candidate/rel;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        validate_bundle(candidate)
    backups={rel:(root/rel).read_bytes() for rel in payloads}
    try:
        for rel,raw in payloads.items():replace_file(root/rel,raw)
    except Exception:
        for rel,raw in backups.items():replace_file(root/rel,raw)
        raise
    return manifest

def collect(page, card, old):
    anchor = datetime.now(KST)
    open_product(page, card)
    open_history_drawer(page)
    rows_locator = page.locator('.drawer .tab_content.show .price_body .body_list')
    rows_locator.first.wait_for(state='visible', timeout=15000)
    count_before, stable = 0, 0
    for _ in range(650):
        require_login_access(page)
        count = rows_locator.count()
        if count == count_before:
            stable += 1
        else:
            stable = 0
        count_before = count
        bottom = rows_locator.last.evaluate('''el => {
          for(let p=el.parentElement;p;p=p.parentElement){
            if(p.scrollHeight>p.clientHeight+20 && ['auto','scroll'].includes(getComputedStyle(p).overflowY)){
              p.scrollTop=p.scrollHeight;return {atBottom:p.scrollTop+p.clientHeight>=p.scrollHeight-2};
            }
          } return {atBottom:false};
        }''')
        if stable >= 4 and bottom['atBottom']:
            break
        page.wait_for_timeout(1000 if stable == 0 else 1800)
    else:
        raise ValueError('Drawer did not reach its end')
    raw = rows_locator.evaluate_all('''nodes => nodes.map(r=>({
      option:r.children[0]?.textContent.trim()||'',
      price:r.children[1]?.textContent.trim()||'',
      date_raw:r.children[2]?.textContent.trim()||'',
      express_shipping:r.textContent.includes('빠른배송')
    }))''')
    rows = [parse_row(r, anchor) for r in raw]
    require_login_access(page)
    validate_new_rows(old, rows)
    for i,row in enumerate(rows):
        row.update(source_rank=i, product_id=card['id'], source_url=card['source_url'])
    data = dict(old)
    data.update(rows=rows, collected_count=len(rows), counts_by_exact_option=dict(Counter(r['option'] for r in rows)),
                earliest_date=rows[-1]['date'], latest_date=rows[0]['date'],
                snapshot_started_at=anchor.isoformat(), last_observed_at=datetime.now(KST).isoformat(),
                target_count=len(rows), complete=True)
    return validate_history(data, card['id'])

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root',type=Path,default=Path(__file__).resolve().parents[1])
    parser.add_argument('--validate-only',action='store_true')
    parser.add_argument('--preflight',action='store_true',help='Check the session without starting a browser')
    parser.add_argument('--scheduled',action='store_true',help='Skip a second scheduled collection after today succeeded')
    args=parser.parse_args();root=args.root.resolve()
    manifest=validate_bundle(root)
    if args.validate_only:
        print(json.dumps({'cards':7,'trades':manifest['collected_trade_count'],'valid':True}));return 0
    attempted=datetime.now(KST).isoformat()
    health={'schemaVersion':1,'status':'failed','last_attempt_at':attempted,'last_success_at':manifest['last_success_at']}
    staged={}
    active_product=None
    try:
        if args.scheduled:
            previous_health=json.loads((root/'data/korean-promos-health.json').read_bytes())
            if already_collected_today(manifest,previous_health,datetime.now(KST)):
                if args.preflight and os.environ.get('GITHUB_OUTPUT'):
                    with open(os.environ['GITHUB_OUTPUT'],'a') as output:output.write('needed=false\n')
                # Preserve the existing success health and original observation time.
                health=previous_health
                print(json.dumps({'status':'already_collected_today','trades':manifest['collected_trade_count']}))
                return 0
        state=session_state(os.environ.get('KREAM_STORAGE_STATE'))
        if args.preflight:
            if os.environ.get('GITHUB_OUTPUT'):
                with open(os.environ['GITHUB_OUTPUT'],'a') as output:output.write('needed=true\n')
            # Preflight is not a successful source observation.
            health=None
            print(json.dumps({'session_configured':True,'source_verified':False}))
            return 0
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            browser=pw.chromium.launch(headless=True)
            try:
                context=browser_context_for_session(browser,state,locale='ko-KR',timezone_id='Asia/Seoul',viewport={'width':1440,'height':1080})
            except Exception:
                raise CollectionError('session_invalid','KREAM login session could not be loaded; reconnect it.') from None
            page=context.new_page()
            for card in manifest['cards']:
                active_product=card['id']
                old=unpack_history(json.loads((root/card['file'].lstrip('/')).read_bytes()))
                data=collect(page,card,old);staged[card['id']]=data
                print(json.dumps({'product_id':card['id'],'rows':len(data['rows']),'complete':True}),flush=True)
            browser.close()
        manifest=publish_generation(root,manifest,staged,attempted)
        # Success health is part of the same validated, rollback-protected write.
        health=None
        return 0
    except Exception as error:
        if isinstance(error,CollectionError):
            health.update(reason=str(error),failure_code=error.code,**error.details)
        else:
            # Browser exceptions may contain request URLs/storage values. Keep them private.
            health.update(reason='KREAM collection or completeness validation failed; prior trades retained.',failure_code='collection_failed')
        if active_product:health['failed_product_id']=active_product
        print('::warning::KREAM refresh failed; preserved all previous trades: '+health['reason'],file=sys.stderr)
        return 2
    finally:
        if health is not None:
            (root/'data/korean-promos-health.json').write_bytes(encoded(health))

if __name__=='__main__':
    raise SystemExit(main())

